#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_FILE="$PWD/docker-compose.yml"
export SMOKE_TASK_ROOT
SMOKE_TASK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/imagine-media-ci.XXXXXXXX")
chmod 0700 "$SMOKE_TASK_ROOT"
export DATA_HOST_DIR="$SMOKE_TASK_ROOT/live-data"
mkdir -m 0700 "$DATA_HOST_DIR"
export COMPOSE_PROJECT_NAME="imagine-ci-$(basename "$SMOKE_TASK_ROOT" | tr '[:upper:].' '[:lower:]-')"
export BUILDX_CONFIG="$SMOKE_TASK_ROOT/buildx"
export APP_SECRET=isolated-ci-fixture-secret-not-for-production
export APP_PASSWORD=isolated-ci-fixture-password
export MOCK_PROVIDER_ENABLED=true APP_PORT=3030
export PUID="$(id -u)" PGID="$(id -g)"
export IMAGINE_MEDIA_HOST_PORT
IMAGINE_MEDIA_HOST_PORT=$(node --input-type=module <<'NODE'
import { createServer } from 'node:net';
const server = createServer();
server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port)); server.close(); });
NODE
)
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    timeout 60 docker compose ps --all || true
    timeout 60 docker compose logs --no-color || true
  fi
  timeout 180 docker compose down --volumes --remove-orphans || status=1
  docker image rm "${COMPOSE_PROJECT_NAME}-imagine-media" >/dev/null 2>&1 || true
  rm -rf -- "$SMOKE_TASK_ROOT"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout 60 docker compose config --format json > "$SMOKE_TASK_ROOT/compose.json"
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync(`${process.env.SMOKE_TASK_ROOT}/compose.json`, 'utf8'));
if (JSON.stringify(Object.keys(config.services)) !== '["imagine-media"]') throw new Error('CI requires exactly one imagine-media service.');
NODE
timeout --foreground 900 docker compose build
bash .github/scripts/docker-smoke.sh
