#!/usr/bin/env bash
set -euo pipefail

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must be set}"
: "${DATA_HOST_DIR:?DATA_HOST_DIR must be set}"
: "${IMAGINE_MEDIA_HOST_PORT:?IMAGINE_MEDIA_HOST_PORT must be set}"
: "${APP_PASSWORD:?APP_PASSWORD must be set}"

base_url="http://127.0.0.1:${IMAGINE_MEDIA_HOST_PORT}"
smoke_tmp_dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/imagine-media-smoke.XXXXXXXX")

cleanup_smoke_files() {
  rm -rf -- "$smoke_tmp_dir"
}
trap cleanup_smoke_files EXIT

compose() {
  timeout --foreground "${COMPOSE_TIMEOUT_SECONDS:-180}" docker compose "$@"
}

compose_config_file="$smoke_tmp_dir/compose.json"
compose config --format json > "$compose_config_file"
COMPOSE_CONFIG_FILE="$compose_config_file" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile(process.env.COMPOSE_CONFIG_FILE, 'utf8'));
const services = config?.services;
if (services === null || typeof services !== 'object' || Array.isArray(services)) {
  throw new Error('Compose config has no structured services object.');
}
const names = Object.keys(services).sort();
if (names.length !== 1 || names[0] !== 'imagine-media') {
  throw new Error(`Expected exactly one imagine-media service, received ${JSON.stringify(names)}.`);
}
const service = services['imagine-media'];
if (!Array.isArray(service?.ports) || service.ports.length !== 1) {
  throw new Error('The single service must expose exactly one port mapping.');
}
if (!Array.isArray(service?.volumes) || service.volumes.length !== 1 || service.volumes[0]?.target !== '/data') {
  throw new Error('The single service must mount exactly one /data volume.');
}
NODE

compose up --detach --wait --wait-timeout 120

IFS=$'\t' read -r job_id asset_id collection_id source_id mask_id edit_job_id edit_asset_id backup_id backup_sha256 < <(
  BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;
const authHeader = `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD ?? ''}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, withAuth({
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  }));
  if (response.status !== expectedStatus) {
    const text = await response.text();
    throw new Error(`${options.method ?? 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}: ${text}`);
  }
  return response;
}

async function json(path, options = {}, expectedStatus = 200) {
  return request(path, options, expectedStatus).then((response) => response.json());
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await json(`/internal/jobs/${encodeURIComponent(jobId)}`);
    const status = detail.job?.status;
    if (status === 'completed') return detail;
    if (['failed', 'cancelled', 'rejected', 'expired'].includes(status)) {
      throw new Error(`Mock Job reached terminal status ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Mock Job did not complete before the smoke timeout.');
}

async function uploadPng(base64, role, parentAssetId, expectedStatus = 201) {
  const form = new FormData();
  form.append('role', role);
  if (parentAssetId !== undefined) form.append('parentAssetId', parentAssetId);
  form.append(
    'file',
    new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' }),
    `${role}.png`,
  );
  return json('/internal/assets/upload', { method: 'POST', body: form }, expectedStatus);
}

const providers = await json('/internal/providers?limit=10');
const mockProvider = providers.items.find((provider) => provider.id === 'mock');
assert.ok(mockProvider, 'The reserved Mock Provider DTO was not returned.');
const providerKeys = Object.keys(mockProvider).sort();
assert.deepEqual(providerKeys, [
  'baseUrl',
  'config',
  'createdAt',
  'enabled',
  'hasApiKey',
  'hasCustomHeaders',
  'id',
  'isDefault',
  'name',
  'type',
  'updatedAt',
]);
assert.equal(mockProvider.type, 'mock');
assert.equal(mockProvider.hasApiKey, false);
assert.equal(mockProvider.hasCustomHeaders, false);
assert.ok(!/(encrypted|ciphertext|authorization|apiKey\s*:)/i.test(JSON.stringify(mockProvider)));

const models = await json('/internal/models?providerId=mock&enabled=true');
const mockModel = models.items.find((model) => model.modelId === 'mock-image-v1');
assert.ok(mockModel, 'The Mock image model was not returned.');
assert.equal(mockModel.capabilitySource, 'mock');
assert.ok(mockModel.capabilities.operations.includes('image.generate'));
assert.ok(mockModel.capabilities.operations.includes('image.edit'));
assert.equal(mockModel.capabilities.supportsMask, true);
assert.equal(mockModel.capabilities.maxReferenceImages, 4);

const sourcePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwSpn2HwAEJAIsdtK5/wAAAABJRU5ErkJggg==';
const nonEmptyMaskPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwSpnGAAADJQEt7A6dOAAAAABJRU5ErkJggg==';
const dimensionMismatchMaskPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwSpnGYJQy7T8AC/gDWANOkGUAAAAASUVORK5CYII=';

const source = (await uploadPng(sourcePng, 'upload')).asset;
assert.equal(source.width, 1);
assert.equal(source.height, 1);
assert.equal(source.mimeType, 'image/png');

const emptyMaskError = await uploadPng(sourcePng, 'mask', source.id, 400);
assert.equal(emptyMaskError.error, 'invalid_media_upload');
assert.match(emptyMaskError.message ?? '', /at least one edited pixel/i);
const dimensionError = await uploadPng(dimensionMismatchMaskPng, 'mask', source.id, 400);
assert.equal(dimensionError.error, 'invalid_media_upload');
assert.match(dimensionError.message ?? '', /dimensions must exactly match/i);

const mask = (await uploadPng(nonEmptyMaskPng, 'mask', source.id)).asset;
assert.equal(mask.role, 'mask');
assert.equal(mask.parentAssetId, source.id);
assert.equal(mask.width, source.width);
assert.equal(mask.height, source.height);
assert.equal(mask.thumbnailUrl, null);

const defaultAssets = await json('/internal/assets?limit=100');
assert.ok(defaultAssets.items.some((candidate) => candidate.id === source.id));
assert.ok(!defaultAssets.items.some((candidate) => candidate.id === mask.id));
const maskAssets = await json('/internal/assets?role=mask&limit=100');
assert.ok(maskAssets.items.some((candidate) => candidate.id === mask.id));

const acceptedEdit = await json(
  '/internal/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'image.edit',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'Docker PR 3 edit smoke fixture',
      inputs: [
        { assetId: source.id, role: 'source' },
        { assetId: mask.id, role: 'mask' },
      ],
    }),
  },
  202,
);
const editJobId = acceptedEdit.job.id;
const editDetail = await waitForJob(editJobId);
assert.equal(editDetail.inputs.length, 2);
assert.deepEqual(
  new Map(editDetail.inputs.map((input) => [input.role, input.assetId])),
  new Map([['mask', mask.id], ['source', source.id]]),
);
assert.equal(editDetail.assets.length, 1);
const editAsset = editDetail.assets[0];
assert.equal(editAsset.parentAssetId, source.id);
assert.equal(editAsset.role, 'output');

const accepted = await json(
  '/internal/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'image.generate',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'Docker PR 2 smoke fixture',
      inputs: [],
    }),
  },
  202,
);
const jobId = accepted.job.id;
const detail = await waitForJob(jobId);
assert.equal(detail.assets.length, 1);
const asset = detail.assets[0];
assert.equal(asset.type, 'image');
assert.equal(asset.mimeType, 'image/png');
assert.ok(asset.fileSize >= 8);

const head = await request(asset.contentUrl, { method: 'HEAD' });
assert.equal(head.headers.get('content-type'), 'image/png');
assert.equal(Number(head.headers.get('content-length')), asset.fileSize);
assert.equal(head.headers.get('accept-ranges'), 'bytes');
assert.equal(head.headers.get('x-content-type-options'), 'nosniff');

const range = await request(
  asset.contentUrl,
  { headers: { range: 'bytes=0-7' } },
  206,
);
assert.equal(range.headers.get('content-range'), `bytes 0-7/${asset.fileSize}`);
const firstBytes = Buffer.from(await range.arrayBuffer());
assert.deepEqual(firstBytes, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const favorite = await json(`/internal/assets/${encodeURIComponent(asset.id)}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ favorite: true }),
});
assert.equal(favorite.asset.favorite, true);
const favorites = await json('/internal/assets?favorite=true&limit=10');
assert.ok(favorites.items.some((candidate) => candidate.id === asset.id));

const createdCollection = await json(
  '/internal/collections',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Docker smoke collection' }),
  },
  201,
);
const collectionId = createdCollection.collection.id;
const membership = await json(`/internal/collections/${encodeURIComponent(collectionId)}/assets`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ assetIds: [asset.id] }),
});
assert.equal(membership.added, 1);
assert.equal(membership.collection.itemCount, 1);
const withCollection = await json(`/internal/assets/${encodeURIComponent(asset.id)}`);
assert.ok(withCollection.asset.collectionIds.includes(collectionId));

const integrityResponse = await request('/internal/maintenance/integrity');
const integrityText = await integrityResponse.text();
assert.equal(/schema_migrations|\/data|app\.db|path|filename/i.test(integrityText), false);
assert.equal(integrityText.includes(process.env.APP_PASSWORD ?? ''), false);
const integrity = JSON.parse(integrityText);
assert.equal(integrity.integrity?.ok, true);
assert.equal(integrity.integrity?.foreignKeyCheck?.ok, true);
assert.equal(integrity.integrity?.integrityCheck?.ok, true);

const backupResponse = await request('/internal/maintenance/backups', { method: 'POST' }, 201);
const backupText = await backupResponse.text();
assert.equal(/\/data|app\.db|path|filename/i.test(backupText), false);
assert.equal(backupText.includes(process.env.APP_PASSWORD ?? ''), false);
const backupEnvelope = JSON.parse(backupText);
assert.deepEqual(Object.keys(backupEnvelope).sort(), ['backup']);
assert.deepEqual(Object.keys(backupEnvelope.backup ?? {}).sort(), [
  'createdAt',
  'id',
  'sha256',
  'size',
]);
const backup = backupEnvelope.backup;
assert.match(backup.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
assert.equal(Number.isSafeInteger(backup.size), true);
assert.ok(backup.size > 0);
assert.match(backup.sha256, /^[a-f0-9]{64}$/);
assert.match(backup.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

process.stdout.write(
  `${jobId}\t${asset.id}\t${collectionId}\t${source.id}\t${mask.id}\t${editJobId}\t${editAsset.id}\t${backup.id}\t${backup.sha256}\n`,
);
NODE
)

test -n "$job_id"
test -n "$asset_id"
test -n "$collection_id"
test -n "$source_id"
test -n "$mask_id"
test -n "$edit_job_id"
test -n "$edit_asset_id"
test -n "$backup_id"
test -n "$backup_sha256"
test -s "$DATA_HOST_DIR/app.db"
test -n "$(find "$DATA_HOST_DIR/media/originals" -maxdepth 1 -type f -print -quit)"
test "$(find "$DATA_HOST_DIR/media/masks" -maxdepth 1 -type f | wc -l | tr -d ' ')" = "1"

IFS=$'\t' read -r video_job_id video_asset_id < <(
  BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;
const authHeader = `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD ?? ''}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, withAuth({
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  }));
  if (response.status !== expectedStatus) {
    await response.arrayBuffer();
    throw new Error(`${options.method ?? 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}`);
  }
  return response;
}

async function json(path, options = {}, expectedStatus = 200) {
  return request(path, options, expectedStatus).then((response) => response.json());
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await json(`/internal/jobs/${encodeURIComponent(jobId)}`);
    if (detail.job?.status === 'completed') return detail;
    if (['failed', 'cancelled', 'rejected', 'expired'].includes(detail.job?.status)) {
      throw new Error(`Mock video Job reached terminal status ${detail.job.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Mock video Job did not complete before the smoke timeout.');
}

const accepted = await json(
  '/internal/jobs',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operation: 'video.generate',
      providerId: 'mock',
      modelId: 'mock-video-v1',
      prompt: 'Docker PR 5 video smoke fixture',
      inputs: [],
      count: 1,
      durationSeconds: 1,
      aspectRatio: '16:9',
      resolution: '720p',
    }),
  },
  202,
);
const jobId = accepted.job.id;
const detail = await waitForJob(jobId);
assert.equal(detail.assets.length, 1);
const asset = detail.assets[0];
assert.equal(asset.type, 'video');
assert.equal(asset.mimeType, 'video/mp4');
assert.ok(asset.posterUrl);
assert.ok(asset.fileSize > 8);

const head = await request(asset.contentUrl, { method: 'HEAD' });
assert.equal(head.headers.get('content-type'), 'video/mp4');
assert.equal(Number(head.headers.get('content-length')), asset.fileSize);
assert.equal(head.headers.get('accept-ranges'), 'bytes');
assert.equal((await head.arrayBuffer()).byteLength, 0);

const range = await request(asset.contentUrl, { headers: { range: 'bytes=0-7' } }, 206);
assert.equal(range.headers.get('content-range'), `bytes 0-7/${asset.fileSize}`);
assert.equal((await range.arrayBuffer()).byteLength, 8);

const staleIfRange = await request(
  asset.contentUrl,
  { headers: { range: 'bytes=0-7', 'if-range': '"stale-etag"' } },
);
assert.equal(staleIfRange.status, 200);
assert.equal((await staleIfRange.arrayBuffer()).byteLength, asset.fileSize);

const unsatisfiable = await request(
  asset.contentUrl,
  { headers: { range: `bytes=${asset.fileSize}-` } },
  416,
);
assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${asset.fileSize}`);
await unsatisfiable.arrayBuffer();

const poster = await request(asset.posterUrl);
assert.equal(poster.headers.get('content-type'), 'image/jpeg');
assert.ok((await poster.arrayBuffer()).byteLength > 0);

process.stdout.write(`${jobId}\t${asset.id}\n`);
NODE
)

test -n "$video_job_id"
test -n "$video_asset_id"
test -n "$(find "$DATA_HOST_DIR/media/posters" -maxdepth 1 -type f -print -quit)"

JOB_ID="$job_id" ASSET_ID="$asset_id" COLLECTION_ID="$collection_id" \
SOURCE_ID="$source_id" MASK_ID="$mask_id" EDIT_JOB_ID="$edit_job_id" \
EDIT_ASSET_ID="$edit_asset_id" VIDEO_JOB_ID="$video_job_id" VIDEO_ASSET_ID="$video_asset_id" \
BACKUP_ID="$backup_id" BACKUP_SHA256="$backup_sha256" \
  compose exec --no-TTY \
  -e JOB_ID -e ASSET_ID -e COLLECTION_ID -e SOURCE_ID -e MASK_ID -e EDIT_JOB_ID \
  -e EDIT_ASSET_ID -e VIDEO_JOB_ID -e VIDEO_ASSET_ID -e BACKUP_ID -e BACKUP_SHA256 \
  imagine-media node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migrations = database
  .prepare('SELECT version FROM schema_migrations ORDER BY version')
  .all()
  .map((row) => row.version);
const migrationChecksums = database
  .prepare('SELECT checksum_sha256 AS checksum FROM schema_migrations ORDER BY version')
  .all();
const migrationLock = database
  .prepare('SELECT checksums_locked_at AS lockedAt FROM schema_migration_integrity WHERE id = 1')
  .get();
const job = database
  .prepare('SELECT status, submit_attempt AS submitAttempt FROM jobs WHERE id = ?')
  .get(process.env.JOB_ID);
const outputs = database
  .prepare('SELECT slot, asset_id AS assetId FROM job_outputs WHERE job_id = ? ORDER BY slot')
  .all(process.env.JOB_ID);
const asset = database
  .prepare(
    'SELECT file_path AS filePath, mime_type AS mimeType, file_size AS fileSize, sha256, favorite FROM assets WHERE id = ?',
  )
  .get(process.env.ASSET_ID);
const membership = database
  .prepare('SELECT 1 AS present FROM collection_assets WHERE collection_id = ? AND asset_id = ?')
  .get(process.env.COLLECTION_ID, process.env.ASSET_ID);
const eventCount = database
  .prepare('SELECT COUNT(*) AS count FROM change_events WHERE aggregate_id IN (?, ?, ?)')
  .get(process.env.JOB_ID, process.env.ASSET_ID, process.env.COLLECTION_ID).count;
const editJob = database
  .prepare('SELECT status, submit_attempt AS submitAttempt FROM jobs WHERE id = ?')
  .get(process.env.EDIT_JOB_ID);
const editInputs = database
  .prepare('SELECT asset_id AS assetId, role, sort_order AS sortOrder FROM job_inputs WHERE job_id = ? ORDER BY role, sort_order')
  .all(process.env.EDIT_JOB_ID);
const source = database
  .prepare('SELECT id, type, role, width, height, deleted_at AS deletedAt FROM assets WHERE id = ?')
  .get(process.env.SOURCE_ID);
const masks = database
  .prepare("SELECT id, parent_asset_id AS parentAssetId, type, role, mime_type AS mimeType, width, height, thumbnail_path AS thumbnailPath FROM assets WHERE role = 'mask'")
  .all();
const editAsset = database
  .prepare('SELECT id, job_id AS jobId, parent_asset_id AS parentAssetId, role FROM assets WHERE id = ?')
  .get(process.env.EDIT_ASSET_ID);
const videoJob = database
  .prepare('SELECT status, submit_attempt AS submitAttempt FROM jobs WHERE id = ?')
  .get(process.env.VIDEO_JOB_ID);
const videoAsset = database
  .prepare(
    'SELECT type, mime_type AS mimeType, file_path AS filePath, poster_path AS posterPath, file_size AS fileSize FROM assets WHERE id = ?',
  )
  .get(process.env.VIDEO_ASSET_ID);

if (!migrations.includes('0000_pr0.sql') || !migrations.includes('0001_pr2_core.sql')) {
  throw new Error(`Expected both PR 0 and PR 2 migrations, received ${migrations.join(', ')}`);
}
if (!migrations.includes('0006_pr8_migration_checksums.sql')) {
  throw new Error('Expected the PR 8 migration checksum migration.');
}
if (!migrations.includes('0007_pr8_media_repair_queue.sql')) {
  throw new Error('Expected the PR 8 media repair queue migration.');
}
const queueTable = database
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_repair_queue'")
  .get();
if (typeof queueTable?.sql !== 'string' || !queueTable.sql.includes('media_repair_queue')) {
  throw new Error('Expected the PR 8 media repair queue table.');
}
const queueIndexes = new Set(
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_repair_queue'")
    .all()
    .map((row) => row.name),
);
for (const index of [
  'media_repair_queue_issue_key_idx',
  'media_repair_queue_due_idx',
  'media_repair_queue_lease_idx',
  'media_repair_queue_asset_idx',
  'media_repair_queue_job_idx',
  'media_repair_queue_seen_idx',
]) {
  if (!queueIndexes.has(index)) throw new Error(`Expected media repair queue index ${index}.`);
}
database.close();
if (
  migrationChecksums.length === 0 ||
  migrationChecksums.some((row) => typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum))
) {
  throw new Error('Every applied migration must have a non-null SHA-256 checksum.');
}
if (migrationLock?.lockedAt === null || migrationLock?.lockedAt === undefined) {
  throw new Error('Migration checksum lock was not persisted.');
}
if (job?.status !== 'completed' || job.submitAttempt !== 1) {
  throw new Error('Mock Job state or submit attempt was not persisted correctly.');
}
if (outputs.length !== 1 || outputs[0].assetId !== process.env.ASSET_ID) {
  throw new Error('The finalized Job output slot is not bound to its asset.');
}
if (!asset || asset.favorite !== 1 || !membership?.present || eventCount < 3) {
  throw new Error('Asset favorite, Collection membership, or outbox events were not persisted.');
}
if (editJob?.status !== 'completed' || editJob.submitAttempt !== 1) {
  throw new Error('Mock image.edit Job state was not persisted correctly.');
}
if (
  editInputs.length !== 2 ||
  !editInputs.some((input) => input.role === 'source' && input.assetId === process.env.SOURCE_ID) ||
  !editInputs.some((input) => input.role === 'mask' && input.assetId === process.env.MASK_ID)
) {
  throw new Error('Durable image.edit inputs do not match the uploaded source and mask.');
}
if (
  source?.type !== 'image' ||
  source.role !== 'upload' ||
  source.width !== 1 ||
  source.height !== 1 ||
  source.deletedAt !== null
) {
  throw new Error('The uploaded source image metadata was not persisted correctly.');
}
if (
  masks.length !== 1 ||
  masks[0].id !== process.env.MASK_ID ||
  masks[0].parentAssetId !== process.env.SOURCE_ID ||
  masks[0].type !== 'image' ||
  masks[0].mimeType !== 'image/png' ||
  masks[0].width !== 1 ||
  masks[0].height !== 1 ||
  masks[0].thumbnailPath !== null
) {
  throw new Error('Exactly one canonical mask with the source relationship must be persisted.');
}
if (
  editAsset?.jobId !== process.env.EDIT_JOB_ID ||
  editAsset.parentAssetId !== process.env.SOURCE_ID ||
  editAsset.role !== 'output'
) {
  throw new Error('The image.edit output did not persist its source parent relationship.');
}
if (videoJob?.status !== 'completed' || videoJob.submitAttempt !== 1) {
  throw new Error('Mock video Job state or submit attempt was not persisted correctly.');
}
if (
  videoAsset?.type !== 'video' ||
  videoAsset.mimeType !== 'video/mp4' ||
  videoAsset.fileSize <= 8 ||
  typeof videoAsset.posterPath !== 'string' ||
  videoAsset.posterPath.length === 0
) {
  throw new Error('Mock video metadata was not persisted correctly.');
}
const videoPath = resolve('/data', videoAsset.filePath);
const posterPath = resolve('/data', videoAsset.posterPath);
if (!videoPath.startsWith('/data/media/originals/') || !posterPath.startsWith('/data/media/posters/')) {
  throw new Error('Mock video or poster path escaped the expected /data media directories.');
}
const videoBytes = await readFile(videoPath);
const posterBytes = await readFile(posterPath);
if (videoBytes.length !== videoAsset.fileSize || videoBytes.length <= 8 || posterBytes.length === 0) {
  throw new Error('Mock video or poster file size did not match persisted metadata.');
}

const absolutePath = resolve('/data', asset.filePath);
if (!absolutePath.startsWith('/data/media/originals/')) {
  throw new Error('Mock asset path escaped /data/media/originals.');
}
const bytes = await readFile(absolutePath);
const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (bytes.length === 0 || !bytes.subarray(0, signature.length).equals(signature)) {
  throw new Error('Mock asset is not a non-empty PNG.');
}
if (asset.mimeType !== 'image/png' || asset.fileSize !== bytes.length) {
  throw new Error('Mock asset metadata does not match the persisted file.');
}
if (asset.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
  throw new Error('Mock asset checksum does not match the persisted file.');
}

const backupId = process.env.BACKUP_ID;
const backupSha256 = process.env.BACKUP_SHA256;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(backupId ?? '') || !/^[a-f0-9]{64}$/.test(backupSha256 ?? '')) {
  throw new Error('The maintenance backup identifiers were not valid.');
}
const backupPath = `/data/backups/${backupId}.db`;
const backupStats = await stat(backupPath);
if (!backupStats.isFile() || (backupStats.mode & 0o777) !== 0o600) {
  throw new Error('The database backup must be a regular mode 0600 file.');
}
const backupBytes = await readFile(backupPath);
if (backupBytes.length !== backupStats.size || createHash('sha256').update(backupBytes).digest('hex') !== backupSha256) {
  throw new Error('The database backup checksum or size did not match its response metadata.');
}
const backupDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
backupDatabase.pragma('foreign_keys = ON');
const backupIntegrity = backupDatabase.prepare('PRAGMA integrity_check').get();
const backupForeignKeys = backupDatabase.prepare('PRAGMA foreign_key_check').all();
const backupJob = backupDatabase.prepare('SELECT 1 AS present FROM jobs WHERE id = ?').get(process.env.JOB_ID);
const backupAsset = backupDatabase.prepare('SELECT 1 AS present FROM assets WHERE id = ?').get(process.env.ASSET_ID);
backupDatabase.close();
if (backupIntegrity?.integrity_check !== 'ok' || backupForeignKeys.length !== 0) {
  throw new Error('The database backup failed SQLite integrity or foreign-key validation.');
}
if (!backupJob?.present || !backupAsset?.present) {
  throw new Error('The database backup did not contain the existing Job and Asset.');
}
NODE

IFS=$'\t' read -r custom_provider_id custom_adapter_id custom_v1 custom_digest_v1 custom_v2 custom_digest_v2 custom_job_id trusted_provider_id trusted_adapter_id trusted_version trusted_digest < <(
  BASE_URL="$base_url" APP_PASSWORD="$APP_PASSWORD" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.BASE_URL;
const appPassword = process.env.APP_PASSWORD ?? '';
const customSecret = 'pr6-custom-http-static-secret';
const fixtureDirectory = resolve(process.cwd(), 'fixtures/adapters/trusted-fixture-v1');
const trustedManifestText = await readFile(resolve(fixtureDirectory, 'manifest.json'), 'utf8');
const trustedSourceText = await readFile(resolve(fixtureDirectory, 'adapter.mjs'), 'utf8');
const trustedManifest = JSON.parse(trustedManifestText);
const trustedSource = new TextEncoder().encode(trustedSourceText);
const authHeader = `Basic ${Buffer.from(`studio:${appPassword}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, withAuth({
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  }));
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}: ${text}`);
  assert.equal(text.includes(customSecret), false, `${path} leaked the custom provider secret.`);
  assert.equal(text.includes(appPassword), false, `${path} leaked the application password.`);
  assert.equal(text.includes(trustedSourceText), false, `${path} leaked the trusted adapter source.`);
  return { response, text };
}

async function json(path, options = {}, expectedStatus = 200) {
  const result = await request(path, options, expectedStatus);
  return JSON.parse(result.text);
}

function jsonOptions(value) {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

const definition = JSON.parse(
  await readFile(resolve(process.cwd(), 'fixtures/providers/custom-http/sync-image/adapter.json'), 'utf8'),
);
const provider = (await json('/internal/providers', {
  method: 'POST',
  ...jsonOptions({
    name: 'PR6 Custom HTTP Smoke',
    type: 'custom-http-v1',
    baseUrl: 'https://192.0.2.1',
    apiKey: customSecret,
    config: {},
  }),
}, 201)).provider;
assert.equal(provider.type, 'custom-http-v1');
assert.equal(provider.hasApiKey, true);
assert.equal(provider.baseUrl, 'https://192.0.2.1');
const providerId = provider.id;
const adapterPath = `/internal/providers/${encodeURIComponent(providerId)}/adapter`;

const jsonEnvelope = {
  schemaVersion: 1,
  version: '1.0.0',
  definition,
};
const imported = await json(adapterPath, {
  method: 'PUT',
  ...jsonOptions(jsonEnvelope),
});
assert.equal(imported.definition.ref.kind, 'declarative-http');
assert.equal(imported.definition.ref.adapterId, definition.id);
assert.equal(imported.definition.ref.version, '1.0.0');
const customV1 = imported.definition.ref;

const validated = await json(`${adapterPath}/validate`, {
  method: 'POST',
  ...jsonOptions({ document: definition, format: 'json' }),
});
assert.equal(validated.valid, true);
assert.equal(validated.adapterId, definition.id);

const exportedJsonResponse = await request(`${adapterPath}/export?format=json`);
const exportedJson = JSON.parse(exportedJsonResponse.text);
assert.deepEqual(Object.keys(exportedJson).sort(), ['definition', 'schemaVersion', 'version']);
assert.equal(exportedJson.schemaVersion, 1);
assert.equal(exportedJson.version, '1.0.0');
assert.equal(exportedJson.definition.id, definition.id);

const exportedYamlResponse = await request(`${adapterPath}/export?format=yaml`);
assert.match(exportedYamlResponse.response.headers.get('content-type') ?? '', /^application\/yaml/);
assert.match(exportedYamlResponse.text, /^schemaVersion:\s+1/m);
const yamlImported = await request(adapterPath, {
  method: 'PUT',
  headers: { 'content-type': 'application/yaml' },
  body: exportedYamlResponse.text,
});
assert.equal(JSON.parse(yamlImported.text).definition.ref.version, '1.0.0');

const second = await json(`${adapterPath}?version=2.0.0`, {
  method: 'PUT',
  ...jsonOptions(definition),
});
const customV2 = second.definition.ref;
assert.equal(customV2.adapterId, definition.id);
assert.equal(customV2.version, '2.0.0');
assert.equal(customV2.kind, 'declarative-http');
assert.match(customV2.digest, /^[a-f0-9]{64}$/);
const current = (await json(adapterPath)).definition;
assert.deepEqual(current.ref, customV2);
const revisions = await json(`${adapterPath}/revisions?limit=100`);
assert.deepEqual(revisions.items.map((item) => item.ref.version).sort(), ['1.0.0', '2.0.0']);

const generationRequest = {
  operation: 'image.generate',
  providerId,
  modelId: 'image-model',
  prompt: 'PR6 custom HTTP smoke',
  inputs: [],
  extra: { style: 'editorial' },
};
const preview = await json(`${adapterPath}/preview`, {
  method: 'POST',
  ...jsonOptions({ request: generationRequest }),
});
assert.equal(preview.endpoint, 'submit');
assert.equal(preview.method, 'POST');
assert.equal(preview.headers.Authorization, '[REDACTED]');
assert.equal(JSON.stringify(preview).includes(customSecret), false);

const dryRun = await json(`${adapterPath}/dry-run`, {
  method: 'POST',
  ...jsonOptions({ request: generationRequest }),
});
assert.equal(dryRun.network, false);
assert.equal(dryRun.performed, false);
assert.equal(dryRun.request.headers.Authorization, '[REDACTED]');

const simulated = await json(`${adapterPath}/simulate`, {
  method: 'POST',
  ...jsonOptions({
    response: { status: 200, json: { data: [{ id: 'simulated-image', b64_json: 'aGVsbG8=' }] } },
  }),
});
assert.equal(simulated.state, 'completed');
assert.equal(simulated.assets.length, 1);
assert.equal(simulated.assets[0].resultId, 'simulated-image');
assert.equal(Object.hasOwn(simulated.assets[0], 'source'), false);

const pathTest = await json(`${adapterPath}/path-test`, {
  method: 'POST',
  ...jsonOptions({ path: '/data/0/id', json: { data: [{ id: 'path-result' }] } }),
});
assert.deepEqual(pathTest, { path: '/data/0/id', found: true, value: 'path-result' });

const capabilityPreview = await json(`${adapterPath}/capabilities-preview`, {
  method: 'POST',
  ...jsonOptions({}),
});
assert.equal(capabilityPreview.capabilities.providerType, 'custom-http-v1');
assert.equal(capabilityPreview.capabilities.models[0].id, 'image-model');
assert.ok(capabilityPreview.capabilities.models[0].capabilities.operations.includes('image.generate'));

const refreshed = await json(`/internal/providers/${encodeURIComponent(providerId)}/models/refresh`, { method: 'POST' });
assert.ok(refreshed.items.some((model) => model.modelId === 'image-model'));
const acceptedJob = await json('/internal/jobs', {
  method: 'POST',
  ...jsonOptions(generationRequest),
}, 202);
const customJobId = acceptedJob.job.id;
assert.equal(typeof customJobId, 'string');

const trustedProvider = (await json('/internal/providers', {
  method: 'POST',
  ...jsonOptions({ name: 'PR6 Trusted JS Smoke', type: 'custom-js-v1', config: {} }),
}, 201)).provider;
const trustedProviderId = trustedProvider.id;
const form = new FormData();
form.append('manifest', trustedManifestText);
form.append('source', new Blob([trustedSource], { type: 'application/javascript' }), 'adapter.mjs');
const installed = await json('/internal/adapters/trusted-javascript', { method: 'POST', body: form }, 201);
const trusted = installed.adapter;
assert.equal(trusted.ref.kind, 'trusted-javascript');
assert.equal(trusted.ref.adapterId, trustedManifest.id);
assert.equal(trusted.ref.version, trustedManifest.version);
assert.equal(trusted.ref.digest, trustedManifest.sha256);
assert.equal(Object.hasOwn(trusted, 'source'), false);

const listed = await json('/internal/adapters');
assert.ok(listed.items.some((item) => item.ref.adapterId === trusted.ref.adapterId));
const fetched = await json(`/internal/adapters/${encodeURIComponent(trusted.ref.adapterId)}`);
assert.deepEqual(fetched.adapter.ref, trusted.ref);
const trustedBindingPath = `/internal/providers/${encodeURIComponent(trustedProviderId)}/adapter/trusted-javascript`;
await json(trustedBindingPath, {
  method: 'POST',
  ...jsonOptions({ ref: trusted.ref }),
}, 201);
const binding = (await json(trustedBindingPath)).binding;
assert.equal(binding.providerId, trustedProviderId);
assert.deepEqual(binding.adapter.ref, trusted.ref);
assert.equal(binding.disabled, false);
const bindingHistory = await json(`${trustedBindingPath}/revisions?limit=100`);
assert.ok(bindingHistory.items.some((item) => item.adapter.ref.adapterId === trusted.ref.adapterId));

process.stdout.write([
  providerId,
  definition.id,
  customV1.version,
  customV1.digest,
  customV2.version,
  customV2.digest,
  customJobId,
  trustedProviderId,
  trusted.ref.adapterId,
  trusted.ref.version,
  trusted.ref.digest,
].join('\t') + '\n');
NODE
)

for value in "$custom_provider_id" "$custom_adapter_id" "$custom_v1" "$custom_digest_v1" "$custom_v2" "$custom_digest_v2" "$custom_job_id" "$trusted_provider_id" "$trusted_adapter_id" "$trusted_version" "$trusted_digest"; do
  test -n "$value"
done

CUSTOM_PROVIDER_ID="$custom_provider_id" CUSTOM_JOB_ID="$custom_job_id" \
CUSTOM_ADAPTER_ID="$custom_adapter_id" CUSTOM_ADAPTER_VERSION="$custom_v2" CUSTOM_ADAPTER_DIGEST="$custom_digest_v2" \
CUSTOM_SECRET='pr6-custom-http-static-secret' \
  compose exec --no-TTY \
  -e CUSTOM_PROVIDER_ID -e CUSTOM_JOB_ID -e CUSTOM_ADAPTER_ID \
  -e CUSTOM_ADAPTER_VERSION -e CUSTOM_ADAPTER_DIGEST -e CUSTOM_SECRET \
  imagine-media node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migrations = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
const job = database.prepare(`
  SELECT provider_id AS providerId, adapter_kind AS adapterKind, adapter_id AS adapterId,
    adapter_version AS adapterVersion, adapter_digest AS adapterDigest,
    request_json AS requestJson, provider_request_redacted_json AS redacted
  FROM jobs WHERE id = ?
`).get(process.env.CUSTOM_JOB_ID);
database.close();

assert.ok(migrations.includes('0004_pr6_custom_adapters.sql'));
assert.ok(migrations.includes('0005_pr6_trusted_adapter_tombstones.sql'));
assert.equal(job?.providerId, process.env.CUSTOM_PROVIDER_ID);
assert.equal(job?.adapterKind, 'declarative-http');
assert.equal(job?.adapterId, process.env.CUSTOM_ADAPTER_ID);
assert.equal(job?.adapterVersion, process.env.CUSTOM_ADAPTER_VERSION);
assert.equal(job?.adapterDigest, process.env.CUSTOM_ADAPTER_DIGEST);
assert.equal(JSON.stringify(job).includes(process.env.CUSTOM_SECRET), false);
NODE

latest_event_id=$(compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const latest = database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM change_events').get().id;
database.close();
process.stdout.write(String(latest));
NODE
)

ASSET_ID="$asset_id" LAST_EVENT_ID="$latest_event_id" BASE_URL="$base_url" \
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;
const assetPath = `/internal/assets/${encodeURIComponent(process.env.ASSET_ID)}`;
const authHeader = `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD ?? ''}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  const response = await fetch(baseUrl + '/internal/events', withAuth({
    headers: {
      accept: 'text/event-stream',
      'last-event-id': process.env.LAST_EVENT_ID,
    },
    signal: controller.signal,
  }));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const liveEvent = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Live SSE stream ended before the Asset mutation event.');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.entityId === process.env.ASSET_ID && event.type === 'asset.updated') return event;
      }
    }
  })();

  const mutation = await fetch(baseUrl + assetPath, withAuth({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite: false }),
    signal: AbortSignal.timeout(10_000),
  }));
  assert.equal(mutation.status, 200);
  const event = await liveEvent;
  assert.ok(event.id > Number(process.env.LAST_EVENT_ID));
  await reader.cancel();

  const restore = await fetch(baseUrl + assetPath, withAuth({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite: true }),
    signal: AbortSignal.timeout(10_000),
  }));
  assert.equal(restore.status, 200);
} finally {
  clearTimeout(timeout);
}
NODE

queued_job_id=$(compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

const id = randomUUID();
const now = Date.now();
const request = {
  operation: 'image.generate',
  providerId: 'mock',
  modelId: 'mock-image-v1',
  prompt: 'Queued Docker restart recovery fixture',
  inputs: [],
};
const requestJson = JSON.stringify(request);
const database = new Database('/data/app.db');
database
  .prepare(
    `INSERT INTO jobs (
      id, operation, provider_id, model_id, prompt, request_json, status, stage,
      idempotency_key, request_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    id,
    request.operation,
    request.providerId,
    request.modelId,
    request.prompt,
    requestJson,
    'queued',
    'queued',
    randomUUID(),
    createHash('sha256').update(requestJson).digest('hex'),
    now,
    now,
  );
database.close();
process.stdout.write(id);
NODE
)

# Seed valid durable remote states so restart recovery is asserted without timing races.
IFS=$'\t' read -r async_pending_job_id async_running_job_id < <(
  compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

const now = Date.now();
const request = {
  operation: 'video.generate',
  providerId: 'mock',
  modelId: 'mock-video-v1',
  prompt: 'Durable Mock video restart recovery fixture',
  inputs: [],
  count: 1,
  durationSeconds: 1,
  aspectRatio: '16:9',
  resolution: '720p',
};
const requestJson = JSON.stringify(request);
const database = new Database('/data/app.db');
const insert = (status) => {
  const id = randomUUID();
  const idempotencyKey = randomUUID();
  const createdAt = now - 1_000;
  const digest = createHash('sha256')
    .update('mock-video-v1\\0' + idempotencyKey)
    .digest('hex')
    .slice(0, 32);
  const remoteJobId = `mock-video-success-${createdAt.toString(36)}-${digest}`;
  const jobColumns = [
    'id', 'operation', 'provider_id', 'model_id', 'prompt', 'request_json',
    'provider_request_redacted_json', 'status', 'stage', 'progress', 'remote_job_id',
    'remote_deadline_at', 'result_expires_at', 'idempotency_key', 'error_code',
    'error_message', 'retry_count', 'submit_attempt', 'stage_retry_counts_json',
    'poll_after_at', 'created_at', 'updated_at', 'completed_at', 'revision',
    'result_manifest_json', 'retry_of_job_id', 'root_job_id', 'cancel_requested_at',
    'request_sha256', 'deleted_at',
  ];
  const jobValues = [
    id,
    request.operation,
    request.providerId,
    request.modelId,
    request.prompt,
    requestJson,
    '{}',
    status,
    status,
    status === 'remote_running' ? 50 : 0,
    remoteJobId,
    now + 600_000,
    null,
    idempotencyKey,
    null,
    null,
    0,
    1,
    '{}',
    now,
    createdAt,
    now,
    null,
    1,
    '[]',
    null,
    id,
    null,
    createHash('sha256').update(requestJson).digest('hex'),
    null,
  ];
  if (jobColumns.length !== jobValues.length || jobColumns.length !== 30) {
    throw new Error(`Mock video jobs fixture column/value drift: ${jobColumns.length}/${jobValues.length}`);
  }
  database
    .prepare(
      `INSERT INTO jobs (${jobColumns.join(', ')}) VALUES (${jobColumns.map(() => '?').join(', ')})`,
    )
    .run(...jobValues);
  database
    .prepare('INSERT INTO job_outputs (job_id, slot, asset_id, created_at, updated_at) VALUES (?, 0, NULL, ?, ?)')
    .run(id, now, now);
  return id;
};
const pendingId = insert('remote_pending');
const runningId = insert('remote_running');
database.close();
process.stdout.write(`${pendingId}\t${runningId}\n`);
NODE
)

test -n "$async_pending_job_id"
test -n "$async_running_job_id"

ASYNC_PENDING_JOB_ID="$async_pending_job_id" ASYNC_RUNNING_JOB_ID="$async_running_job_id" BASE_URL="$base_url" \
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;
const authHeader = `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD ?? ''}`).toString('base64')}`;
const headers = new Headers({ authorization: authHeader });
for (const [name, expectedStatus] of [
  ['ASYNC_PENDING_JOB_ID', 'remote_pending'],
  ['ASYNC_RUNNING_JOB_ID', 'remote_running'],
]) {
  const response = await fetch(baseUrl + `/internal/jobs/${encodeURIComponent(process.env[name])}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.job.status, expectedStatus);
  assert.equal(detail.job.operation, 'video.generate');
  assert.equal(detail.job.modelId, 'mock-video-v1');
}
NODE

compose restart imagine-media
compose up --detach --wait --wait-timeout 120

JOB_ID="$job_id" ASSET_ID="$asset_id" COLLECTION_ID="$collection_id" \
SOURCE_ID="$source_id" MASK_ID="$mask_id" EDIT_JOB_ID="$edit_job_id" \
EDIT_ASSET_ID="$edit_asset_id" VIDEO_JOB_ID="$video_job_id" VIDEO_ASSET_ID="$video_asset_id" \
ASYNC_PENDING_JOB_ID="$async_pending_job_id" ASYNC_RUNNING_JOB_ID="$async_running_job_id" \
  QUEUED_JOB_ID="$queued_job_id" BASE_URL="$base_url" \
  CUSTOM_PROVIDER_ID="$custom_provider_id" CUSTOM_JOB_ID="$custom_job_id" \
  CUSTOM_ADAPTER_ID="$custom_adapter_id" CUSTOM_V1="$custom_v1" CUSTOM_DIGEST_V1="$custom_digest_v1" \
  CUSTOM_V2="$custom_v2" CUSTOM_DIGEST_V2="$custom_digest_v2" \
  TRUSTED_PROVIDER_ID="$trusted_provider_id" TRUSTED_ADAPTER_ID="$trusted_adapter_id" \
  TRUSTED_VERSION="$trusted_version" TRUSTED_DIGEST="$trusted_digest" \
  node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;
const MOCK_VIDEO_SHA256 = '4d240737eeba324e5b3efcdc82738ba9555386f6d383d9fa233c6fae1db47361';
const authHeader = `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD ?? ''}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

async function json(path) {
  const response = await fetch(baseUrl + path, withAuth({ signal: AbortSignal.timeout(10_000) }));
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  return response.json();
}

async function waitForCompletedVideo(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const detail = await json(`/internal/jobs/${encodeURIComponent(jobId)}`);
    if (detail.job?.status === 'completed') return detail;
    if (['failed', 'cancelled', 'rejected', 'expired'].includes(detail.job?.status)) {
      throw new Error(`Recovered video Job reached ${detail.job.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Recovered video Job did not complete before the smoke timeout.');
}

async function assertVideoOutput(detail) {
  assert.equal(detail.job.status, 'completed');
  assert.equal(detail.assets.length, 1);
  const asset = detail.assets[0];
  assert.equal(typeof asset.id, 'string');
  assert.ok(asset.id.length > 0);
  assert.equal(asset.type, 'video');
  assert.equal(asset.mimeType, 'video/mp4');
  assert.equal(asset.sha256, MOCK_VIDEO_SHA256);
  assert.equal(typeof asset.posterUrl, 'string');
  const content = await fetch(baseUrl + asset.contentUrl, withAuth({ signal: AbortSignal.timeout(10_000) }));
  assert.equal(content.status, 200);
  const bytes = Buffer.from(await content.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MOCK_VIDEO_SHA256);
  const poster = await fetch(baseUrl + asset.posterUrl, withAuth({ signal: AbortSignal.timeout(10_000) }));
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.ok((await poster.arrayBuffer()).byteLength > 0);
}

const deadline = Date.now() + 30_000;
let recovered;
while (Date.now() < deadline) {
  recovered = (await json(`/internal/jobs/${process.env.QUEUED_JOB_ID}`)).job;
  if (recovered?.status === 'completed') break;
  if (['failed', 'cancelled', 'rejected', 'expired'].includes(recovered?.status)) {
    throw new Error(`Recovered queued Job reached ${recovered.status}.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.equal(recovered?.status, 'completed', 'Queued Job was not recovered after restart.');

const completed = await json(`/internal/jobs/${process.env.JOB_ID}`);
assert.equal(completed.job.status, 'completed');
assert.equal(completed.assets[0]?.id, process.env.ASSET_ID);
const completedVideo = await json(`/internal/jobs/${process.env.VIDEO_JOB_ID}`);
assert.equal(completedVideo.job.status, 'completed');
assert.equal(completedVideo.assets[0]?.id, process.env.VIDEO_ASSET_ID);
const videoOutput = completedVideo.assets[0];
assert.equal(videoOutput.type, 'video');
assert.equal(videoOutput.mimeType, 'video/mp4');
const videoRange = await fetch(baseUrl + videoOutput.contentUrl, withAuth({
  headers: { range: 'bytes=0-7' },
  signal: AbortSignal.timeout(10_000),
}));
assert.equal(videoRange.status, 206);
assert.equal((await videoRange.arrayBuffer()).byteLength, 8);
const videoPoster = await fetch(baseUrl + videoOutput.posterUrl, withAuth({
  signal: AbortSignal.timeout(10_000),
}));
assert.equal(videoPoster.status, 200);
assert.equal(videoPoster.headers.get('content-type'), 'image/jpeg');
assert.ok((await videoPoster.arrayBuffer()).byteLength > 0);
const recoveredPendingVideo = await waitForCompletedVideo(process.env.ASYNC_PENDING_JOB_ID);
const recoveredRunningVideo = await waitForCompletedVideo(process.env.ASYNC_RUNNING_JOB_ID);
await assertVideoOutput(recoveredPendingVideo);
await assertVideoOutput(recoveredRunningVideo);
const asset = (await json(`/internal/assets/${process.env.ASSET_ID}`)).asset;
assert.equal(asset.favorite, true);
assert.ok(asset.collectionIds.includes(process.env.COLLECTION_ID));
const collections = await json('/internal/collections?limit=10');
assert.ok(
  collections.items.some(
    (collection) => collection.id === process.env.COLLECTION_ID && collection.itemCount === 1,
  ),
);

const edit = await json(`/internal/jobs/${process.env.EDIT_JOB_ID}`);
assert.equal(edit.job.status, 'completed');
assert.deepEqual(
  new Map(edit.inputs.map((input) => [input.role, input.assetId])),
  new Map([['mask', process.env.MASK_ID], ['source', process.env.SOURCE_ID]]),
);
assert.equal(edit.assets.length, 1);
assert.equal(edit.assets[0].id, process.env.EDIT_ASSET_ID);
assert.equal(edit.assets[0].parentAssetId, process.env.SOURCE_ID);

const persistedSource = (await json(`/internal/assets/${process.env.SOURCE_ID}`)).asset;
assert.equal(persistedSource.role, 'upload');
assert.equal(persistedSource.width, 1);
assert.equal(persistedSource.height, 1);
const persistedMask = (await json(`/internal/assets/${process.env.MASK_ID}`)).asset;
assert.equal(persistedMask.role, 'mask');
assert.equal(persistedMask.parentAssetId, process.env.SOURCE_ID);
const defaultAssets = await json('/internal/assets?limit=100');
assert.ok(!defaultAssets.items.some((candidate) => candidate.id === process.env.MASK_ID));
const masks = await json('/internal/assets?role=mask&limit=100');
assert.ok(masks.items.some((candidate) => candidate.id === process.env.MASK_ID));

const ranged = await fetch(baseUrl + asset.contentUrl, withAuth({
  headers: { range: 'bytes=0-7' },
  signal: AbortSignal.timeout(10_000),
}));
assert.equal(ranged.status, 206);
assert.equal((await ranged.arrayBuffer()).byteLength, 8);

const targets = new Set([
  process.env.JOB_ID,
  process.env.ASSET_ID,
  process.env.COLLECTION_ID,
]);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);
try {
  const response = await fetch(baseUrl + '/internal/events', withAuth({
    headers: { accept: 'text/event-stream', 'last-event-id': '0' },
    signal: controller.signal,
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (targets.size > 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) targets.delete(JSON.parse(data).entityId);
    }
  }
  await reader.cancel();
} finally {
  clearTimeout(timeout);
}
assert.deepEqual([...targets], [], 'SSE replay did not include persisted Job, Asset, and Collection events.');
NODE

BASE_URL="$base_url" APP_PASSWORD="$APP_PASSWORD" \
CUSTOM_PROVIDER_ID="$custom_provider_id" CUSTOM_JOB_ID="$custom_job_id" \
CUSTOM_ADAPTER_ID="$custom_adapter_id" CUSTOM_V1="$custom_v1" CUSTOM_DIGEST_V1="$custom_digest_v1" \
CUSTOM_V2="$custom_v2" CUSTOM_DIGEST_V2="$custom_digest_v2" \
TRUSTED_PROVIDER_ID="$trusted_provider_id" TRUSTED_ADAPTER_ID="$trusted_adapter_id" \
TRUSTED_VERSION="$trusted_version" TRUSTED_DIGEST="$trusted_digest" \
  node .github/scripts/pr6-adapter-lifecycle.mjs

test ! -e "$DATA_HOST_DIR/adapters/$trusted_adapter_id"

compose restart imagine-media
compose up --detach --wait --wait-timeout 120

CUSTOM_PROVIDER_ID="$custom_provider_id" CUSTOM_JOB_ID="$custom_job_id" \
CUSTOM_ADAPTER_ID="$custom_adapter_id" CUSTOM_V2="$custom_v2" CUSTOM_DIGEST_V2="$custom_digest_v2" \
TRUSTED_ADAPTER_ID="$trusted_adapter_id" TRUSTED_VERSION="$trusted_version" TRUSTED_DIGEST="$trusted_digest" \
BACKUP_ID="$backup_id" BACKUP_SHA256="$backup_sha256" \
CUSTOM_SECRET='pr6-custom-http-static-secret' \
  compose exec --no-TTY \
  -e CUSTOM_PROVIDER_ID -e CUSTOM_JOB_ID -e CUSTOM_ADAPTER_ID -e CUSTOM_V2 -e CUSTOM_DIGEST_V2 \
  -e TRUSTED_ADAPTER_ID -e TRUSTED_VERSION -e TRUSTED_DIGEST -e BACKUP_ID -e BACKUP_SHA256 -e CUSTOM_SECRET \
  imagine-media node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migrations = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
const tombstone = database.prepare('SELECT adapter_id AS adapterId, version, digest FROM trusted_adapter_tombstones WHERE adapter_id = ?').get(process.env.TRUSTED_ADAPTER_ID);
const installation = database.prepare('SELECT adapter_id FROM trusted_adapter_installations WHERE adapter_id = ?').get(process.env.TRUSTED_ADAPTER_ID);
const job = database.prepare('SELECT provider_id AS providerId, adapter_kind AS adapterKind, adapter_id AS adapterId, adapter_version AS adapterVersion, adapter_digest AS adapterDigest, provider_request_redacted_json AS redacted FROM jobs WHERE id = ?').get(process.env.CUSTOM_JOB_ID);
database.close();

assert.ok(migrations.includes('0005_pr6_trusted_adapter_tombstones.sql'));
assert.deepEqual(tombstone, { adapterId: process.env.TRUSTED_ADAPTER_ID, version: process.env.TRUSTED_VERSION, digest: process.env.TRUSTED_DIGEST });
assert.equal(installation, undefined);
assert.equal(job?.providerId, process.env.CUSTOM_PROVIDER_ID);
assert.equal(job?.adapterKind, 'declarative-http');
assert.equal(job?.adapterId, process.env.CUSTOM_ADAPTER_ID);
assert.equal(job?.adapterVersion, process.env.CUSTOM_V2);
assert.equal(job?.adapterDigest, process.env.CUSTOM_DIGEST_V2);
assert.equal(JSON.stringify(job).includes(process.env.CUSTOM_SECRET), false);

const backupId = process.env.BACKUP_ID;
const backupSha256 = process.env.BACKUP_SHA256;
assert.match(backupId ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
assert.match(backupSha256 ?? '', /^[a-f0-9]{64}$/);
const backupPath = `/data/backups/${backupId}.db`;
const backupStats = await stat(backupPath);
assert.equal(backupStats.isFile(), true);
assert.equal(backupStats.mode & 0o777, 0o600);
const backupBytes = await readFile(backupPath);
assert.equal(createHash('sha256').update(backupBytes).digest('hex'), backupSha256);
const backupDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
backupDatabase.pragma('foreign_keys = ON');
assert.equal(backupDatabase.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
assert.deepEqual(backupDatabase.prepare('PRAGMA foreign_key_check').all(), []);
backupDatabase.close();
NODE

BASE_URL="$base_url" APP_PASSWORD="$APP_PASSWORD" TRUSTED_ADAPTER_ID="$trusted_adapter_id" \
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const response = await fetch(`${process.env.BASE_URL}/internal/adapters/${encodeURIComponent(process.env.TRUSTED_ADAPTER_ID)}`, {
  headers: { authorization: `Basic ${Buffer.from(`studio:${process.env.APP_PASSWORD}`).toString('base64')}` },
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 404);
assert.equal((await response.text()).includes(process.env.APP_PASSWORD), false);
NODE

compose_logs_file="$smoke_tmp_dir/compose.log"
compose logs --no-color > "$compose_logs_file"
COMPOSE_LOGS_FILE="$compose_logs_file" CUSTOM_SECRET='pr6-custom-http-static-secret' APP_PASSWORD="$APP_PASSWORD" \
  node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const logs = await readFile(process.env.COMPOSE_LOGS_FILE, 'utf8');
const source = await readFile(resolve(process.cwd(), 'fixtures/adapters/trusted-fixture-v1/adapter.mjs'), 'utf8');
for (const forbidden of [process.env.CUSTOM_SECRET, process.env.APP_PASSWORD, source]) {
  assert.equal(logs.includes(forbidden), false, 'Compose logs contain a provider secret, app password, or trusted source.');
}
NODE
