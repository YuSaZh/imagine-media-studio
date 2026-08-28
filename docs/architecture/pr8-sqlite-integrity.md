# PR 8 SQLite Integrity and Migration Trust

Status: **Local and GitHub Actions acceptance passed.**

These PR 8 milestones establish immutable migration history, a bounded SQLite
integrity-checking core, and the database-only maintenance boundary. They do
not archive media, restore data, or repair consistency issues.

## Migration release manifest

[`apps/server/migrations/manifest.json`](../../apps/server/migrations/manifest.json)
is the trust anchor for migration files in a trusted application release. The
server validates it before touching the database when PR 8 or a later migration
is present.

- The manifest format and byte size are bounded and its keys are strict.
- The manifest and SQL file sets must match exactly.
- Migrations `0000` through `0006` are mandatory and each SHA-256 must match.
- Migration filenames use a four-digit sequence and duplicate sequences fail.
- An applied migration file cannot disappear, drift, or be inserted behind the
  highest applied sequence.
- Legacy-only migration directories below `0006` remain available solely for
  upgrade fixtures. A real PR 8 release requires the manifest.

The manifest is not independently signed. Its security boundary is the same as
the trusted application release containing the server code, Docker image, SQL,
and manifest. A party able to replace all of those release files is outside the
migration-drift threat model.

## Durable checksum lock

Migration `0006_pr8_migration_checksums.sql` adds a nullable SHA-256 column,
backfill lock state, and immutable-row/checksum triggers. On a legacy upgrade,
the already manifest-verified hashes are backfilled once and then locked.
Future migrations are recorded with their checksum in the same transaction as
their SQL.

Before any pending SQL runs, the client validates existing checksums. While a
pending migration is executing, the same SQLite transaction protects and
compares:

- `schema_migrations` and every existing applied row;
- `schema_migration_integrity` and its lock value;
- the four immutable triggers and their SQLite definitions; and
- the checksum column itself.

Removing or rebuilding protected state, deleting the checksum column, changing
an applied timestamp/checksum, forging a history row, or failing partway through
DDL rolls back the pending migration and does not record its version.

## Integrity core

`checkSqliteIntegrity()` runs bounded `PRAGMA integrity_check` and
`PRAGMA foreign_key_check` against the live connection. The report contains
health flags, error counts, bounded foreign-key identifiers, and truncation
state. It does not return SQLite error text, SQL, or row contents.

The overall result is unhealthy when:

- SQLite reports an integrity error;
- a foreign-key violation exists;
- foreign-key enforcement is disabled; or
- a pragma returns an unexpected shape.

The maintenance API exposes only the health flags and counts from this core;
it does not expose SQLite messages, SQL, table names, row IDs, or row contents.
The online backup endpoint uses the live SQLite backup API, verifies the
read-only snapshot with this core, and publishes only database metadata. Media
files are outside this milestone.

## Database-only maintenance boundary

- `GET /internal/maintenance/integrity` and
  `POST /internal/maintenance/backups` require a configured and authenticated
  application administrator. When `APP_PASSWORD` is absent, both fail closed.
- Requests cannot supply a path, filename, destination, key, or other option.
  Responses contain only bounded health counts/flags or backup
  `id/size/sha256/createdAt` metadata.
- The backup service uses SQLite's Online Backup API against the live WAL
  database. It never copies `app.db`, `app.db-wal`, or `app.db-shm` directly.
- A random hidden staging file is created with `0600` permissions inside a
  checked `0700` staging directory. The completed snapshot passes read-only
  integrity and foreign-key checks before its final hash is calculated.
- Final publication uses a same-filesystem hard link, which fails rather than
  replacing an existing ID. The staging link is then removed and both parent
  directories are synchronized.
- Symlink traversal, non-canonical paths, relaxed directory modes, collisions,
  concurrent backups, partial results, and raw filesystem/SQLite errors fail
  closed. Cleanup failure is explicit rather than silently claiming success.
- Server shutdown stops new backups and waits for the active backup before
  closing SQLite.

The snapshot is sensitive: it contains application records and encrypted
Provider credential ciphertext. It does not contain `APP_SECRET`,
`APP_PASSWORD`, media files, Trusted Adapter source files, logs, temporary
files, or PWA/browser data.
No download or restore endpoint is exposed in this milestone.

## Remote evidence

The SQLite milestone commit `c0fa70f` passed the recorded GitHub Actions run
`33183142103`. Final commit `4dc4432` passed all 17 jobs in
[GitHub Actions run 33216883872](https://github.com/YuSaZh/imagine-media-studio/actions/runs/33216883872).
Its quality job reran the complete unit/type/build gate, and its isolated
single-container smoke exercised the released migration chain through `0007`,
legacy upgrade, authenticated integrity/backup endpoints, backup permissions and
hashes, full archive verification, target-only restore, restored-server startup,
and post-restart SQLite/media persistence.

## Local evidence

- The committed migration manifest hashes were recomputed and matched.
- Full workspace unit suite: 113 test files / 982 tests passed.
- Workspace lint, typecheck, and production build passed.
- E2E TypeScript compilation and `git diff --check` passed.
- The isolated Docker image build and full `docker-smoke.sh` passed with a
  task-owned Compose project: exactly one `imagine-media` service, one port,
  and one `/data` volume. The authenticated smoke created an online SQLite
  backup, verified its `0600` regular-file mode, response hash/size, read-only
  `integrity_check`/empty foreign-key check, and persisted Job/Asset records;
  after container restart the same backup remained present and readable.
- Regression tests cover new and legacy stores, one-time backfill/reopen,
  manifest absence/drift/shape, missing and inserted migrations, duplicate
  sequences, failed DDL rollback, checksum/state corruption, protected-trigger
  loss, protected-table recreation, forged history, bounded integrity results,
  foreign-key violations, disabled enforcement, malformed pragma output, live
  WAL backup, permissions, path/symlink rejection, collision/no-overwrite,
  staging/sidecar cleanup, injected filesystem failures, administrator and
  same-origin enforcement, strict request/response DTOs, and shutdown ordering.
