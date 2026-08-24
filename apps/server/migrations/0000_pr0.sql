CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY NOT NULL,
  operation TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  request_json TEXT NOT NULL,
  provider_request_redacted_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  progress INTEGER,
  remote_job_id TEXT,
  idempotency_key TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  poll_after_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key_idx ON jobs(idempotency_key);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS assets_job_id_idx ON assets(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS assets_job_path_idx ON assets(job_id, file_path);
