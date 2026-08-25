ALTER TABLE jobs ADD COLUMN stage_retry_counts_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(stage_retry_counts_json));
