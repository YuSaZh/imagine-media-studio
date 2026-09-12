CREATE TABLE job_generation_batches (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL
);
CREATE INDEX job_generation_batches_batch_idx ON job_generation_batches(batch_id);
