CREATE TABLE trusted_adapter_tombstones (
  adapter_id TEXT PRIMARY KEY NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  removed_at INTEGER NOT NULL
);

CREATE INDEX provider_adapter_definitions_adapter_idx
ON provider_adapter_definitions(adapter_id, kind, is_current, disabled);

CREATE INDEX jobs_adapter_retained_idx
ON jobs(adapter_id, deleted_at)
WHERE adapter_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER provider_adapter_definitions_trusted_tombstone_insert
BEFORE INSERT ON provider_adapter_definitions
WHEN NEW.kind = 'trusted-javascript'
  AND EXISTS (
    SELECT 1 FROM trusted_adapter_tombstones
    WHERE adapter_id = NEW.adapter_id
  )
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TRIGGER provider_adapter_definitions_trusted_tombstone_update
BEFORE UPDATE OF kind, adapter_id ON provider_adapter_definitions
WHEN NEW.kind = 'trusted-javascript'
  AND EXISTS (
    SELECT 1 FROM trusted_adapter_tombstones
    WHERE adapter_id = NEW.adapter_id
  )
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TRIGGER jobs_trusted_adapter_tombstone_insert
BEFORE INSERT ON jobs
WHEN NEW.adapter_kind = 'trusted-javascript'
  AND EXISTS (
    SELECT 1 FROM trusted_adapter_tombstones
    WHERE adapter_id = NEW.adapter_id
  )
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TRIGGER jobs_trusted_adapter_tombstone_update
BEFORE UPDATE OF adapter_kind, adapter_id ON jobs
WHEN NEW.adapter_kind = 'trusted-javascript'
  AND EXISTS (
    SELECT 1 FROM trusted_adapter_tombstones
    WHERE adapter_id = NEW.adapter_id
  )
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TABLE trusted_adapter_installations (
  adapter_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(adapter_id) BETWEEN 1 AND 63),
  version TEXT NOT NULL
    CHECK (length(version) BETWEEN 1 AND 64),
  digest TEXT NOT NULL
    CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
    CHECK (updated_at >= created_at)
);

CREATE INDEX trusted_adapter_installations_updated_idx
ON trusted_adapter_installations(updated_at, adapter_id);

CREATE TRIGGER trusted_adapter_installations_tombstone_insert
BEFORE INSERT ON trusted_adapter_installations
WHEN EXISTS (
  SELECT 1 FROM trusted_adapter_tombstones
  WHERE adapter_id = NEW.adapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TRIGGER trusted_adapter_installations_tombstone_update
BEFORE UPDATE OF adapter_id ON trusted_adapter_installations
WHEN EXISTS (
  SELECT 1 FROM trusted_adapter_tombstones
  WHERE adapter_id = NEW.adapter_id
)
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter id is tombstoned');
END;

CREATE TRIGGER trusted_adapter_installations_content_immutable
BEFORE UPDATE OF adapter_id, version, digest, created_at ON trusted_adapter_installations
BEGIN
  SELECT RAISE(ABORT, 'trusted adapter installation content is immutable');
END;
