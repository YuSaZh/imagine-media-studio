PRAGMA defer_foreign_keys = ON;

CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL,
  base_url TEXT,
  encrypted_api_key TEXT,
  headers_encrypted_json TEXT,
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX providers_name_idx ON providers(name COLLATE NOCASE);
CREATE INDEX providers_type_idx ON providers(type);
CREATE INDEX providers_updated_at_idx ON providers(updated_at DESC, id DESC);
CREATE UNIQUE INDEX providers_single_default_idx ON providers(is_default) WHERE is_default = 1;

CREATE TABLE models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  capability_source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX models_provider_model_idx ON models(provider_id, model_id);
CREATE INDEX models_updated_at_idx ON models(updated_at DESC, id DESC);
CREATE INDEX models_enabled_idx ON models(enabled, provider_id);

ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN submit_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN result_manifest_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN retry_of_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN root_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE jobs ADD COLUMN request_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN deleted_at INTEGER;

CREATE INDEX jobs_page_idx ON jobs(deleted_at, created_at DESC, id DESC);
CREATE INDEX jobs_provider_model_idx ON jobs(provider_id, model_id);
CREATE INDEX jobs_retry_of_idx ON jobs(retry_of_job_id);
CREATE INDEX jobs_root_idx ON jobs(root_job_id);

UPDATE jobs SET root_job_id = id WHERE root_job_id IS NULL;

CREATE TABLE assets_pr2 (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  parent_asset_id TEXT REFERENCES assets_pr2(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  role TEXT NOT NULL,
  file_path TEXT NOT NULL,
  thumbnail_path TEXT,
  poster_path TEXT,
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

INSERT INTO assets_pr2 (
  id,
  job_id,
  parent_asset_id,
  type,
  role,
  file_path,
  thumbnail_path,
  poster_path,
  original_filename,
  mime_type,
  width,
  height,
  duration_ms,
  file_size,
  sha256,
  metadata_json,
  favorite,
  created_at,
  deleted_at
)
SELECT
  id,
  job_id,
  NULL,
  type,
  role,
  file_path,
  NULL,
  NULL,
  NULL,
  mime_type,
  NULL,
  NULL,
  NULL,
  file_size,
  sha256,
  '{}',
  0,
  created_at,
  NULL
FROM assets;

DROP TABLE assets;
ALTER TABLE assets_pr2 RENAME TO assets;

CREATE INDEX assets_job_id_idx ON assets(job_id);
CREATE INDEX assets_parent_asset_id_idx ON assets(parent_asset_id);
CREATE UNIQUE INDEX assets_file_path_idx ON assets(file_path);
CREATE INDEX assets_gallery_page_idx ON assets(deleted_at, created_at DESC, id DESC);
CREATE INDEX assets_favorite_idx ON assets(favorite, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_sha256_idx ON assets(sha256);

CREATE TABLE job_inputs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  PRIMARY KEY (job_id, role, sort_order)
);

CREATE UNIQUE INDEX job_inputs_job_asset_role_idx ON job_inputs(job_id, asset_id, role);
CREATE INDEX job_inputs_asset_id_idx ON job_inputs(asset_id);

CREATE TABLE job_outputs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, slot)
);

CREATE UNIQUE INDEX job_outputs_asset_id_idx ON job_outputs(asset_id);

INSERT INTO job_outputs (job_id, slot, asset_id, created_at, updated_at)
SELECT
  job_id,
  ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY created_at, id) - 1,
  id,
  created_at,
  created_at
FROM assets
WHERE job_id IS NOT NULL AND role = 'output';

UPDATE jobs
SET result_manifest_json = COALESCE(
  (
    SELECT json_group_array(json_object('slot', slot, 'assetId', asset_id))
    FROM (
      SELECT slot, asset_id
      FROM job_outputs
      WHERE job_outputs.job_id = jobs.id
      ORDER BY slot
    ) AS ordered_outputs
  ),
  '[]'
);

CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX collections_name_idx ON collections(name COLLATE NOCASE);
CREATE INDEX collections_updated_at_idx ON collections(updated_at DESC, id DESC);

CREATE TABLE collection_assets (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection_id, asset_id)
);

CREATE INDEX collection_assets_asset_id_idx ON collection_assets(asset_id);

CREATE TABLE change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX change_events_aggregate_idx ON change_events(aggregate_type, aggregate_id, id);
CREATE INDEX change_events_created_at_idx ON change_events(created_at, id);
