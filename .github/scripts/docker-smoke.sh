#!/usr/bin/env bash
set -euo pipefail

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must be set}"
: "${DATA_HOST_DIR:?DATA_HOST_DIR must be set}"

base_url="http://127.0.0.1:${IMAGINE_MEDIA_HOST_PORT:-3030}"

service_count=$(docker compose config --services | wc -l | tr -d ' ')
test "$service_count" = "1"

docker compose up --detach --wait

job_id=$(BASE_URL="$base_url" node --input-type=module <<'NODE'
const response = await fetch(`${process.env.BASE_URL}/internal/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    operation: 'image.generate',
    providerId: 'mock',
    modelId: 'mock-image-v1',
    prompt: 'Docker smoke fixture',
    inputs: [],
  }),
});
if (response.status !== 202) throw new Error(`Unexpected status ${response.status}`);
const body = await response.json();
process.stdout.write(body.job.id);
NODE
)

JOB_ID="$job_id" BASE_URL="$base_url" node --input-type=module <<'NODE'
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const response = await fetch(`${process.env.BASE_URL}/internal/jobs/${process.env.JOB_ID}`);
  const body = await response.json();
  if (body.job?.status === 'completed') process.exit(0);
  if (body.job?.status === 'failed') throw new Error(body.job.errorMessage ?? 'Mock Job failed');
  await new Promise((resolve) => setTimeout(resolve, 200));
}
throw new Error('Mock Job did not complete before the smoke timeout.');
NODE

test -s "$DATA_HOST_DIR/app.db"
test -n "$(find "$DATA_HOST_DIR/media/originals" -maxdepth 1 -type f -name '*.png' -print -quit)"

docker compose exec --no-TTY -e JOB_ID="$job_id" imagine-media node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migration = database
  .prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
  .get();
const job = database.prepare('SELECT status FROM jobs WHERE id = ?').get(process.env.JOB_ID);
const assets = database
  .prepare(
    'SELECT file_path AS filePath, mime_type AS mimeType, file_size AS fileSize, sha256 FROM assets WHERE job_id = ?',
  )
  .all(process.env.JOB_ID);
database.close();

if (migration?.version !== '0000_pr0.sql') throw new Error('PR 0 migration was not recorded.');
if (job?.status !== 'completed') throw new Error('Mock Job was not persisted as completed.');
if (assets.length !== 1) throw new Error('Exactly one Mock asset row must be persisted.');

const asset = assets[0];
const absolutePath = resolve('/data', asset.filePath);
if (!absolutePath.startsWith('/data/media/originals/')) {
  throw new Error('Mock asset path escaped /data/media/originals.');
}
const bytes = await readFile(absolutePath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (bytes.length === 0 || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
  throw new Error('Mock asset is not a non-empty PNG.');
}
if (asset.mimeType !== 'image/png' || asset.fileSize !== bytes.length) {
  throw new Error('Mock asset metadata does not match the persisted file.');
}
if (asset.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
  throw new Error('Mock asset checksum does not match the persisted file.');
}
NODE

queued_job_id=$(docker compose exec --no-TTY imagine-media node --input-type=module <<'NODE'
import { randomUUID } from 'node:crypto';

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
const database = new Database('/data/app.db');
database
  .prepare(
    'INSERT INTO jobs (id, operation, provider_id, model_id, prompt, request_json, status, stage, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  .run(
    id,
    request.operation,
    request.providerId,
    request.modelId,
    request.prompt,
    JSON.stringify(request),
    'queued',
    'queued',
    randomUUID(),
    now,
    now,
  );
database.close();
process.stdout.write(id);
NODE
)

docker compose restart imagine-media
docker compose up --detach --wait

JOB_ID="$job_id" QUEUED_JOB_ID="$queued_job_id" BASE_URL="$base_url" node --input-type=module <<'NODE'
async function readJob(jobId) {
  const response = await fetch(process.env.BASE_URL + '/internal/jobs/' + jobId);
  return (await response.json()).job;
}

const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const queued = await readJob(process.env.QUEUED_JOB_ID);
  if (queued?.status === 'completed') break;
  if (queued?.status === 'failed') {
    throw new Error(queued.errorMessage ?? 'Recovered queued Mock Job failed.');
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const completed = await readJob(process.env.JOB_ID);
const recovered = await readJob(process.env.QUEUED_JOB_ID);
if (completed?.status !== 'completed') {
  throw new Error('Completed Mock Job did not survive the container restart.');
}
if (recovered?.status !== 'completed') {
  throw new Error('Queued Mock Job was not recovered after the container restart.');
}
NODE
