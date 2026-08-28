ALTER TABLE schema_migrations ADD COLUMN checksum_sha256 TEXT;

CREATE TABLE schema_migration_integrity (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  checksums_locked_at INTEGER
);

INSERT INTO schema_migration_integrity (id, checksums_locked_at)
VALUES (1, NULL);

CREATE TRIGGER schema_migrations_checksum_immutable
BEFORE UPDATE OF version, applied_at, checksum_sha256 ON schema_migrations
WHEN OLD.checksum_sha256 IS NOT NULL
  AND (
    NEW.version <> OLD.version
    OR NEW.applied_at <> OLD.applied_at
    OR NEW.checksum_sha256 IS NULL
    OR NEW.checksum_sha256 <> OLD.checksum_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'applied migration checksum is immutable');
END;

CREATE TRIGGER schema_migrations_row_immutable
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'applied migration row is immutable');
END;

CREATE TRIGGER schema_migration_integrity_lock_immutable
BEFORE UPDATE ON schema_migration_integrity
WHEN OLD.checksums_locked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'migration checksum lock is immutable');
END;

CREATE TRIGGER schema_migration_integrity_row_immutable
BEFORE DELETE ON schema_migration_integrity
BEGIN
  SELECT RAISE(ABORT, 'migration checksum lock row is immutable');
END;
