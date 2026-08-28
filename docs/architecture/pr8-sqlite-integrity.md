# PR 8 SQLite Integrity and Migration Trust

Status: **Local acceptance passed; remote acceptance pending.**

This is the second PR 8 milestone. It establishes immutable migration history
and a bounded SQLite integrity-checking core. It does not yet expose a browser
maintenance API, create online backups, archive media, or repair consistency
issues.

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

The maintenance API and backup service will decide which subset of this core
report is safe to expose to the browser.

## Local evidence

- The committed migration manifest hashes were recomputed and matched.
- Full workspace unit suite: 111 test files / 960 tests passed.
- Workspace lint, typecheck, and production build passed.
- E2E TypeScript compilation and `git diff --check` passed.
- Regression tests cover new and legacy stores, one-time backfill/reopen,
  manifest absence/drift/shape, missing and inserted migrations, duplicate
  sequences, failed DDL rollback, checksum/state corruption, protected-trigger
  loss, protected-table recreation, forged history, bounded integrity results,
  foreign-key violations, disabled enforcement, and malformed pragma output.
