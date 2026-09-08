CREATE TABLE asset_video_sources (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  remote_job_id TEXT NOT NULL,
  result_id TEXT,
  expires_at TEXT
);

INSERT INTO asset_video_sources(asset_id, provider_id, model_id, profile, remote_job_id, expires_at)
SELECT a.id, j.provider_id, j.model_id, json_extract(j.request_json, '$.profile'), j.remote_job_id,
  CASE WHEN j.result_expires_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', j.result_expires_at / 1000.0, 'unixepoch') END
FROM assets a JOIN jobs j ON j.id = a.job_id JOIN providers p ON p.id = j.provider_id
WHERE a.type = 'video' AND j.remote_job_id IS NOT NULL
  AND json_valid(j.request_json) AND json_extract(j.request_json, '$.profile') IS NOT NULL;
