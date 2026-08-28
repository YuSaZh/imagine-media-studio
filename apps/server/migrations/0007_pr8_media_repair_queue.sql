CREATE TABLE media_repair_queue (
  issue_key TEXT NOT NULL CHECK (
    length(issue_key) = 64
    AND issue_key NOT GLOB '*[^0-9a-f]*'
  ),
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('hash_mismatch', 'missing', 'orphan', 'size_mismatch', 'unsafe', 'unreadable')
  ),
  stored_path TEXT NOT NULL CHECK (
    stored_path IN ('<unsafe-path>', '<path-too-long>')
    OR (
      length(stored_path) BETWEEN 1 AND 4096
      AND substr(stored_path, 1, 1) <> '/'
      AND stored_path NOT GLOB '[A-Za-z]:*'
      AND instr(stored_path, char(0)) = 0
      AND instr(stored_path, char(92)) = 0
      AND stored_path NOT IN ('.', '..')
      AND stored_path NOT LIKE './%'
      AND stored_path NOT LIKE '../%'
      AND stored_path NOT LIKE '%//%'
      AND stored_path NOT LIKE '%/./%'
      AND stored_path NOT LIKE '%/../%'
      AND stored_path NOT LIKE '%/.'
      AND stored_path NOT LIKE '%/..'
      AND stored_path NOT LIKE '%/'
    )
  ),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'running', 'resolved', 'manual')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000000),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  lease_until INTEGER CHECK (lease_until IS NULL OR lease_until >= 0),
  last_error_code TEXT CHECK (
    last_error_code IS NULL
    OR (
      length(last_error_code) BETWEEN 1 AND 128
      AND instr(last_error_code, char(0)) = 0
      AND instr(last_error_code, char(10)) = 0
      AND instr(last_error_code, char(13)) = 0
    )
  ),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= first_seen_at),
  resolved_at INTEGER CHECK (
    resolved_at IS NULL
    OR (
      resolved_at >= 0
      AND resolved_at >= first_seen_at
      AND resolved_at >= last_seen_at
    )
  ),
  CHECK (
    (state = 'running' AND lease_until IS NOT NULL)
    OR (state <> 'running' AND lease_until IS NULL)
  ),
  CHECK (
    (state = 'resolved' AND resolved_at IS NOT NULL)
    OR (state <> 'resolved' AND resolved_at IS NULL)
  )
);

CREATE UNIQUE INDEX media_repair_queue_issue_key_idx
  ON media_repair_queue(issue_key);
CREATE INDEX media_repair_queue_due_idx
  ON media_repair_queue(state, next_attempt_at, first_seen_at, issue_key)
  WHERE state = 'open';
CREATE INDEX media_repair_queue_lease_idx
  ON media_repair_queue(state, lease_until, issue_key)
  WHERE state = 'running';
CREATE INDEX media_repair_queue_asset_idx
  ON media_repair_queue(asset_id, state, issue_key);
CREATE INDEX media_repair_queue_job_idx
  ON media_repair_queue(job_id, state, issue_key);
CREATE INDEX media_repair_queue_seen_idx
  ON media_repair_queue(last_seen_at, issue_key);
