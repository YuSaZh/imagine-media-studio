CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
ALTER TABLE assets ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE jobs ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE collections ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'admin';
CREATE INDEX assets_owner_page_idx ON assets(owner_id, deleted_at, created_at, id);
CREATE INDEX jobs_owner_page_idx ON jobs(owner_id, deleted_at, created_at, id);
DROP INDEX collections_name_idx;
CREATE UNIQUE INDEX collections_name_idx ON collections(owner_id, name);
CREATE TABLE account_settings (
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, key)
);
