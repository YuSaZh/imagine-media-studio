#!/usr/bin/env bash
set -euo pipefail

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must be set}"
: "${DATA_HOST_DIR:?DATA_HOST_DIR must be set}"
: "${IMAGINE_MEDIA_HOST_PORT:?IMAGINE_MEDIA_HOST_PORT must be set}"

base_url="http://127.0.0.1:${IMAGINE_MEDIA_HOST_PORT}"

compose() {
  timeout --foreground "${COMPOSE_TIMEOUT_SECONDS:-180}" docker compose "$@"
}

service_count=$(compose config --services | wc -l | tr -d ' ')
test "$service_count" = "1"
test "$(compose config --services)" = "imagine-media"

compose up --detach --wait --wait-timeout 120

IFS=$'\t' read -r job_id asset_id collection_id < <(
  BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;

async function request(path, options = {}, expectedStatus = 200) {
  const response = await fetch(baseUrl + path, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
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
      throw new Error(`Mock Job reached terminal status ${status}: ${detail.job?.errorMessage ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Mock Job did not complete before the smoke timeout.');
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

process.stdout.write(`${jobId}\t${asset.id}\t${collectionId}\n`);
NODE
)

test -n "$job_id"
test -n "$asset_id"
test -n "$collection_id"
test -s "$DATA_HOST_DIR/app.db"
test -n "$(find "$DATA_HOST_DIR/media/originals" -maxdepth 1 -type f -print -quit)"

JOB_ID="$job_id" ASSET_ID="$asset_id" COLLECTION_ID="$collection_id" \
  compose exec --no-TTY \
  -e JOB_ID -e ASSET_ID -e COLLECTION_ID imagine-media node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migrations = database
  .prepare('SELECT version FROM schema_migrations ORDER BY version')
  .all()
  .map((row) => row.version);
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
database.close();

if (!migrations.includes('0000_pr0.sql') || !migrations.includes('0001_pr2_core.sql')) {
  throw new Error(`Expected both PR 0 and PR 2 migrations, received ${migrations.join(', ')}`);
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
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);
try {
  const response = await fetch(baseUrl + '/internal/events', {
    headers: {
      accept: 'text/event-stream',
      'last-event-id': process.env.LAST_EVENT_ID,
    },
    signal: controller.signal,
  });
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

  const mutation = await fetch(baseUrl + assetPath, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite: false }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(mutation.status, 200);
  const event = await liveEvent;
  assert.ok(event.id > Number(process.env.LAST_EVENT_ID));
  await reader.cancel();

  const restore = await fetch(baseUrl + assetPath, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite: true }),
    signal: AbortSignal.timeout(10_000),
  });
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

compose restart imagine-media
compose up --detach --wait --wait-timeout 120

JOB_ID="$job_id" ASSET_ID="$asset_id" COLLECTION_ID="$collection_id" \
QUEUED_JOB_ID="$queued_job_id" BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';

const baseUrl = process.env.BASE_URL;

async function json(path) {
  const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  return response.json();
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
const asset = (await json(`/internal/assets/${process.env.ASSET_ID}`)).asset;
assert.equal(asset.favorite, true);
assert.ok(asset.collectionIds.includes(process.env.COLLECTION_ID));
const collections = await json('/internal/collections?limit=10');
assert.ok(
  collections.items.some(
    (collection) => collection.id === process.env.COLLECTION_ID && collection.itemCount === 1,
  ),
);

const ranged = await fetch(baseUrl + asset.contentUrl, {
  headers: { range: 'bytes=0-7' },
  signal: AbortSignal.timeout(10_000),
});
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
  const response = await fetch(baseUrl + '/internal/events', {
    headers: { accept: 'text/event-stream', 'last-event-id': '0' },
    signal: controller.signal,
  });
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
