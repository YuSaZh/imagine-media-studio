#!/usr/bin/env bash
set -euo pipefail

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must be set}"
: "${DATA_HOST_DIR:?DATA_HOST_DIR must be set}"
: "${SMOKE_TASK_ROOT:?SMOKE_TASK_ROOT must be set}"

case "$SMOKE_TASK_ROOT" in
  /*) ;;
  *) echo 'SMOKE_TASK_ROOT must be an absolute path.' >&2; exit 1 ;;
esac
case "$DATA_HOST_DIR" in
  /*) ;;
  *) echo 'DATA_HOST_DIR must be an absolute path.' >&2; exit 1 ;;
esac
seed_task_root=$(realpath -e -- "$SMOKE_TASK_ROOT")
seed_data_root=$(realpath -e -- "$DATA_HOST_DIR")
if [[ "$seed_task_root" != "$SMOKE_TASK_ROOT" || "$seed_data_root" != "$DATA_HOST_DIR" ]]; then
  echo 'Legacy seed roots must use canonical paths.' >&2
  exit 1
fi
case "$seed_data_root" in
  "$seed_task_root"/*) ;;
  *) echo 'DATA_HOST_DIR must be a task-owned child of SMOKE_TASK_ROOT.' >&2; exit 1 ;;
esac
if [[ "$(stat -c '%a' -- "$seed_task_root")" != 700 || "$(stat -c '%a' -- "$seed_data_root")" != 700 ]]; then
  echo 'Legacy seed task and data roots must use mode 0700.' >&2
  exit 1
fi

seed_config_file=$(mktemp "$seed_task_root/.pr8-legacy-seed-config.XXXXXXXX")
cleanup_seed_config() {
  rm -f -- "$seed_config_file"
}
trap cleanup_seed_config EXIT

compose() {
  timeout --foreground "${COMPOSE_TIMEOUT_SECONDS:-180}" docker compose "$@"
}

compose config --format json > "$seed_config_file"
SEED_CONFIG_FILE="$seed_config_file" SEED_DATA_ROOT="$seed_data_root" node --input-type=module <<'NODE'
import { readFile, realpath } from 'node:fs/promises';

const config = JSON.parse(await readFile(process.env.SEED_CONFIG_FILE, 'utf8'));
const services = config?.services;
if (services === null || typeof services !== 'object' || Array.isArray(services)) {
  throw new Error('Legacy seed Compose config has no structured services object.');
}
const names = Object.keys(services).sort();
if (names.length !== 1 || names[0] !== 'imagine-media') {
  throw new Error('Legacy seed requires exactly one imagine-media service.');
}
const volumes = services['imagine-media']?.volumes;
if (!Array.isArray(volumes) || volumes.length !== 1) {
  throw new Error('Legacy seed requires exactly one /data volume.');
}
const volume = volumes[0];
if (
  volume === null ||
  typeof volume !== 'object' ||
  (volume.type !== undefined && volume.type !== 'bind') ||
  volume.target !== '/data' ||
  typeof volume.source !== 'string'
) {
  throw new Error('Legacy seed /data volume must be a structured bind mount.');
}
const [configuredSource, expectedSource] = await Promise.all([
  realpath(volume.source),
  realpath(process.env.SEED_DATA_ROOT),
]);
if (configuredSource !== expectedSource) {
  throw new Error('Legacy seed /data bind source does not match DATA_HOST_DIR.');
}
NODE

if [[ -e "$seed_data_root/app.db" ]]; then
  echo 'Refusing to seed a legacy database over an existing app.db.' >&2
  exit 1
fi

compose run --rm --no-deps --entrypoint node imagine-media --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase } from './dist/database/client.js';
import { ensureStorage, getStoragePaths } from './dist/storage/paths.js';

const LEGACY_ASSET_ID = '00000000-0000-4000-8000-000000000008';
const LEGACY_MIGRATIONS = [
  '0000_pr0.sql',
  '0001_pr2_core.sql',
  '0002_pr4_runtime_safety.sql',
  '0003_pr5_video_runtime.sql',
  '0004_pr6_custom_adapters.sql',
  '0005_pr6_trusted_adapter_tombstones.sql',
];
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwSpn2HwAEJAIsdtK5/wAAAABJRU5ErkJggg==',
  'base64',
);

const paths = getStoragePaths('/data');
await ensureStorage(paths);
const migrations = await mkdtemp(join(tmpdir(), 'imagine-pr8-legacy-migrations-'));
let database;
try {
  for (const name of LEGACY_MIGRATIONS) {
    await copyFile(join('/app/migrations', name), join(migrations, name));
  }
  database = createDatabase(paths.database, migrations);
  const filePath = 'media/uploads/pr8-legacy.png';
  await writeFile(join(paths.root, filePath), PNG, { mode: 0o600 });
  database.sqlite.prepare(
    `INSERT INTO assets (
      id, job_id, type, role, file_path, thumbnail_path, poster_path,
      original_filename, mime_type, width, height, file_size, sha256, created_at
    ) VALUES (?, NULL, 'image', 'upload', ?, NULL, NULL, ?, 'image/png', 1, 1, ?, ?, ?)`,
  ).run(
    LEGACY_ASSET_ID,
    filePath,
    'pr8-legacy.png',
    PNG.byteLength,
    createHash('sha256').update(PNG).digest('hex'),
    Date.now(),
  );
  const applied = database.sqlite
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => row.version);
  assert.deepEqual(applied, LEGACY_MIGRATIONS);
  const columns = database.sqlite.prepare("PRAGMA table_info('schema_migrations')").all();
  assert.equal(columns.some((column) => column.name === 'checksum_sha256'), false);
} finally {
  database?.sqlite.close();
  await rm(migrations, { force: true, recursive: true });
}
NODE

test -s "$DATA_HOST_DIR/app.db"
test -s "$DATA_HOST_DIR/media/uploads/pr8-legacy.png"
