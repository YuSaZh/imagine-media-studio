CREATE TABLE provider_adapter_definitions (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('declarative-http', 'trusted-javascript')),
  adapter_id TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  definition_json TEXT,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, kind, adapter_id, version, digest),
  CHECK (
    (kind = 'declarative-http' AND definition_json IS NOT NULL) OR
    (kind = 'trusted-javascript' AND definition_json IS NULL)
  ),
  CHECK (disabled = 0 OR is_current = 0)
);

CREATE UNIQUE INDEX provider_adapter_definitions_current_idx
ON provider_adapter_definitions(provider_id)
WHERE is_current = 1;

CREATE INDEX provider_adapter_definitions_provider_idx
ON provider_adapter_definitions(provider_id);

CREATE TRIGGER provider_adapter_definitions_content_immutable
BEFORE UPDATE OF provider_id, kind, adapter_id, version, digest, definition_json, created_at
ON provider_adapter_definitions
BEGIN
  SELECT RAISE(ABORT, 'provider adapter definition revision content is immutable');
END;

ALTER TABLE jobs ADD COLUMN adapter_kind TEXT CHECK (adapter_kind IS NULL OR adapter_kind IN ('declarative-http', 'trusted-javascript'));
ALTER TABLE jobs ADD COLUMN adapter_id TEXT;
ALTER TABLE jobs ADD COLUMN adapter_version TEXT;
ALTER TABLE jobs ADD COLUMN adapter_digest TEXT;

CREATE TRIGGER jobs_adapter_ref_insert_check
BEFORE INSERT ON jobs
WHEN (NEW.adapter_kind IS NULL) != (NEW.adapter_id IS NULL)
  OR (NEW.adapter_kind IS NULL) != (NEW.adapter_version IS NULL)
  OR (NEW.adapter_kind IS NULL) != (NEW.adapter_digest IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'job adapter reference columns must be all null or all populated');
END;

CREATE TRIGGER jobs_adapter_ref_update_check
BEFORE UPDATE OF adapter_kind, adapter_id, adapter_version, adapter_digest ON jobs
WHEN (NEW.adapter_kind IS NULL) != (NEW.adapter_id IS NULL)
  OR (NEW.adapter_kind IS NULL) != (NEW.adapter_version IS NULL)
  OR (NEW.adapter_kind IS NULL) != (NEW.adapter_digest IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'job adapter reference columns must be all null or all populated');
END;
