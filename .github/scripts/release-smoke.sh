#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_IMAGE:?RELEASE_IMAGE must be set}"
: "${RELEASE_DIGEST:?RELEASE_DIGEST must be set}"
release_smoke_dry_run=${RELEASE_SMOKE_DRY_RUN:-false}
if [[ "$release_smoke_dry_run" != true && "$release_smoke_dry_run" != false ]]; then
  echo 'RELEASE_SMOKE_DRY_RUN must be true or false.' >&2
  exit 1
fi

if [[ ! "$RELEASE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo 'Release digest is not a SHA-256 digest.' >&2
  exit 1
fi
if [[ "$RELEASE_IMAGE" != "ghcr.io/yusazh/imagine-media-studio@${RELEASE_DIGEST}" ]]; then
  echo 'Release image must be the expected GHCR image at the supplied digest.' >&2
  exit 1
fi

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_root=$(cd -- "$script_directory/../.." && pwd)
runner_temp=${RUNNER_TEMP:-/tmp}
case "$runner_temp" in
  /*) ;;
  *) echo 'RUNNER_TEMP must be an absolute directory.' >&2; exit 1 ;;
esac

runtime_directory=$(mktemp -d "${runner_temp%/}/imagine-media-release.XXXXXXXX")
data_directory="$runtime_directory/data"
compose_file="$runtime_directory/compose.json"

run_id=${GITHUB_RUN_ID:-local}
run_attempt=${GITHUB_RUN_ATTEMPT:-1}
if [[ ! "$run_id" =~ ^[a-zA-Z0-9-]+$ ]]; then run_id=local; fi
if [[ ! "$run_attempt" =~ ^[0-9]+$ ]]; then run_attempt=1; fi
compose_project="imagine-release-${run_id}-${run_attempt}-${BASHPID}"
compose_project=$(printf '%s' "$compose_project" | tr '[:upper:]' '[:lower:]')

export COMPOSE_FILE="$compose_file"
export COMPOSE_PROJECT_NAME="$compose_project"
export SMOKE_TASK_ROOT="$runtime_directory"
export DATA_HOST_DIR="$data_directory"
export PUID="$(id -u)"
export PGID="$(id -g)"
export APP_PORT=3030
export APP_SECRET='release-smoke-app-secret-not-for-production'
export APP_PASSWORD='release-smoke-password-not-for-production'

compose() {
  timeout --foreground "${COMPOSE_TIMEOUT_SECONDS:-180}" docker compose "$@"
}

cleanup() {
  local status=$?
  set +e
  if [[ "$release_smoke_dry_run" != true && -f "$compose_file" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || status=$?
  fi
  case "$runtime_directory" in
    "${runner_temp%/}"/imagine-media-release.*) rm -rf -- "$runtime_directory" || status=$? ;;
    *) echo 'Refusing to remove an unexpected release smoke directory.' >&2; status=1 ;;
  esac
  exit "$status"
}
trap cleanup EXIT

mkdir -- "$data_directory"
chmod 0700 "$data_directory"

host_port=$(node --input-type=module <<'NODE'
import { createServer } from 'node:net';

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('Unable to allocate a release smoke port.'));
      return;
    }
    server.close((error) => error === undefined ? resolve(address.port) : reject(error));
  });
});
process.stdout.write(String(port));
NODE
)
export IMAGINE_MEDIA_HOST_PORT="$host_port"

RELEASE_COMPOSE_FILE="$compose_file" RELEASE_IMAGE="$RELEASE_IMAGE" \
DATA_HOST_DIR="$data_directory" HOST_PORT="$host_port" PUID="$PUID" PGID="$PGID" \
APP_SECRET="$APP_SECRET" APP_PASSWORD="$APP_PASSWORD" node --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
};

const compose = {
  services: {
    'imagine-media': {
      image: required('RELEASE_IMAGE'),
      ports: [`${required('HOST_PORT')}:3030`],
      user: `${required('PUID')}:${required('PGID')}`,
      volumes: ['${DATA_HOST_DIR:?DATA_HOST_DIR must be set}:/data'],
      environment: {
        APP_PORT: '3030',
        DATA_DIR: '/data',
        APP_SECRET: required('APP_SECRET'),
        APP_PASSWORD: required('APP_PASSWORD'),
        MOCK_PROVIDER_ENABLED: 'true',
        LOG_LEVEL: 'info',
        ALLOW_HTTP_MEDIA_DOWNLOADS: 'false',
        ALLOW_INSECURE_PROVIDER_HTTP: 'false',
        ALLOW_PRIVATE_NETWORK_ACCESS: 'false',
        MAX_IMAGE_UPLOAD_BYTES: '33554432',
        MAX_VIDEO_UPLOAD_BYTES: '536870912',
        MAX_REMOTE_IMAGE_BYTES: '67108864',
        MAX_REMOTE_VIDEO_BYTES: '1073741824',
        MEDIA_PROCESS_TIMEOUT_MS: '30000',
      },
      restart: 'unless-stopped',
    },
  },
};

await writeFile(process.env.RELEASE_COMPOSE_FILE, `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
NODE

compose config --format json > "$runtime_directory/config.json"
RELEASE_CONFIG_FILE="$runtime_directory/config.json" RELEASE_IMAGE="$RELEASE_IMAGE" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(process.env.RELEASE_CONFIG_FILE, 'utf8'));
const services = config?.services;
assert.ok(services && typeof services === 'object' && !Array.isArray(services));
assert.deepEqual(Object.keys(services), ['imagine-media']);
assert.equal(services['imagine-media']?.image, process.env.RELEASE_IMAGE);
assert.equal(services['imagine-media']?.volumes?.[0]?.target, '/data');
assert.equal(services['imagine-media']?.ports?.length, 1);
NODE

if [[ "$release_smoke_dry_run" == true ]]; then
  exit 0
fi

timeout --foreground 300 docker pull "$RELEASE_IMAGE" >/dev/null
bash "$script_directory/pr8-legacy-seed.sh"
compose up --detach --wait --wait-timeout 120

BASE_URL="http://127.0.0.1:${host_port}" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const response = await fetch(`${process.env.BASE_URL}/internal/health`, {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { database: 'ok', status: 'ok' });
NODE

compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { fileMustExist: true, readonly: true });
try {
  assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
} finally {
  database.close();
}
await writeFile('/data/.release-smoke-marker', 'persisted\n', { mode: 0o600 });
NODE

compose restart imagine-media
compose up --detach --wait --wait-timeout 120

compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import Database from 'better-sqlite3';

assert.equal(await readFile('/data/.release-smoke-marker', 'utf8'), 'persisted\n');
await unlink('/data/.release-smoke-marker');
const database = new Database('/data/app.db', { fileMustExist: true, readonly: true });
try {
  assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
} finally {
  database.close();
}
NODE

bash "$repository_root/.github/scripts/docker-smoke.sh"
