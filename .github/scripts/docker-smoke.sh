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
import Database from 'better-sqlite3';

const database = new Database('/data/app.db', { readonly: true });
const migration = database
  .prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1')
  .get();
const job = database.prepare('SELECT status FROM jobs WHERE id = ?').get(process.env.JOB_ID);
const asset = database.prepare('SELECT COUNT(*) AS count FROM assets WHERE job_id = ?').get(
  process.env.JOB_ID,
);
database.close();

if (migration?.version !== '0000_pr0.sql') throw new Error('PR 0 migration was not recorded.');
if (job?.status !== 'completed') throw new Error('Mock Job was not persisted as completed.');
if (asset?.count !== 1) throw new Error('Mock asset row was not persisted.');
NODE

docker compose restart imagine-media
docker compose up --detach --wait

JOB_ID="$job_id" BASE_URL="$base_url" node --input-type=module <<'NODE'
const response = await fetch(`${process.env.BASE_URL}/internal/jobs/${process.env.JOB_ID}`);
const body = await response.json();
if (body.job?.status !== 'completed') {
  throw new Error('Completed Mock Job did not survive the container restart.');
}
NODE
