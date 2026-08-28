import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseClient {
  orm: AppDatabase;
  sqlite: Database.Database;
}

export class DatabaseMigrationError extends Error {
  public override readonly name = 'DatabaseMigrationError';
}

interface MigrationFile {
  readonly checksum: string;
  readonly name: string;
  readonly sequence: number;
  readonly source: string;
}

interface AppliedMigration {
  readonly appliedAt: number;
  readonly checksum: string | null;
  readonly name: string;
  readonly sequence: number;
}

interface MigrationState {
  readonly checksumsLockedAt: number | null;
}

interface ProtectedSchemaObject {
  readonly name: string;
  readonly sql: string;
  readonly tableName: string;
  readonly type: 'table' | 'trigger';
}

interface MigrationFrameworkSnapshot {
  readonly applied: readonly AppliedMigration[];
  readonly lock: number | null;
  readonly objects: readonly ProtectedSchemaObject[];
}

interface MigrationManifest {
  readonly migrations: Readonly<Record<string, string>>;
  readonly version: 1;
}

const MIGRATION_FILENAME = /^(?<sequence>[0-9]{4})_[a-z0-9][a-z0-9_-]*\.sql$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MIGRATION_STATE_TABLE = 'schema_migration_integrity';
const CHECKSUM_MIGRATION_SEQUENCE = 6;
const MIGRATION_MANIFEST_FILENAME = 'manifest.json';
const MIGRATION_MANIFEST_VERSION = 1 as const;
const REQUIRED_MANIFEST_MIGRATIONS = new Set([
  '0000_pr0.sql',
  '0001_pr2_core.sql',
  '0002_pr4_runtime_safety.sql',
  '0003_pr5_video_runtime.sql',
  '0004_pr6_custom_adapters.sql',
  '0005_pr6_trusted_adapter_tombstones.sql',
  '0006_pr8_migration_checksums.sql',
]);
const MAX_MIGRATION_MANIFEST_BYTES = 128 * 1024;
const PROTECTED_SCHEMA_OBJECTS = new Map<string, {
  readonly tableName: string;
  readonly type: ProtectedSchemaObject['type'];
}>([
  ['table\u0000schema_migrations', { tableName: 'schema_migrations', type: 'table' }],
  ['table\u0000schema_migration_integrity', { tableName: 'schema_migration_integrity', type: 'table' }],
  ['trigger\u0000schema_migrations_checksum_immutable', { tableName: 'schema_migrations', type: 'trigger' }],
  ['trigger\u0000schema_migrations_row_immutable', { tableName: 'schema_migrations', type: 'trigger' }],
  ['trigger\u0000schema_migration_integrity_lock_immutable', { tableName: 'schema_migration_integrity', type: 'trigger' }],
  ['trigger\u0000schema_migration_integrity_row_immutable', { tableName: 'schema_migration_integrity', type: 'trigger' }],
]);

function migrationError(message: string): DatabaseMigrationError {
  return new DatabaseMigrationError(message);
}

function sha256(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function migrationSequence(name: string): number {
  const match = MIGRATION_FILENAME.exec(name);
  if (match === null || match.groups?.sequence === undefined) {
    throw migrationError(`Migration filename '${name}' is invalid.`);
  }
  const sequence = Number(match.groups.sequence);
  if (!Number.isSafeInteger(sequence)) {
    throw migrationError(`Migration filename '${name}' has an invalid numeric prefix.`);
  }
  return sequence;
}

function readMigrationFiles(directory: string): readonly MigrationFile[] {
  const files: MigrationFile[] = [];
  const sequences = new Map<number, string>();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.sql')) continue;
    const sequence = migrationSequence(name);
    const previous = sequences.get(sequence);
    if (previous !== undefined) {
      throw migrationError(
        `Migration sequence ${String(sequence).padStart(4, '0')} is duplicated by '${previous}' and '${name}'.`,
      );
    }
    const path = resolve(directory, name);
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw migrationError(`Migration file '${name}' must be a regular file.`);
    }
    const bytes = readFileSync(path);
    sequences.set(sequence, name);
    files.push({
      checksum: sha256(bytes),
      name,
      sequence,
      source: bytes.toString('utf8'),
    });
  }
  files.sort((left, right) => left.sequence - right.sequence);
  return files;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMigrationManifest(
  directory: string,
  files: readonly MigrationFile[],
): MigrationManifest | null {
  const maxSequence = files.reduce(
    (maximum, file) => Math.max(maximum, file.sequence),
    -1,
  );
  const manifestPath = resolve(directory, MIGRATION_MANIFEST_FILENAME);
  let bytes: Buffer;
  try {
    const stats = lstatSync(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MIGRATION_MANIFEST_BYTES) {
      throw migrationError('Migration manifest must be a bounded regular file.');
    }
    bytes = readFileSync(manifestPath);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      maxSequence < CHECKSUM_MIGRATION_SEQUENCE
    ) {
      return null;
    }
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw migrationError('Migration manifest is required for PR8 migrations.');
    }
    if (error instanceof DatabaseMigrationError) throw error;
    throw migrationError('Migration manifest could not be read.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw migrationError('Migration manifest is not valid JSON.');
  }
  if (!isRecord(parsed)) throw migrationError('Migration manifest has an invalid shape.');
  const topLevelKeys = Object.keys(parsed).sort();
  if (topLevelKeys.length !== 2 || topLevelKeys[0] !== 'migrations' || topLevelKeys[1] !== 'version') {
    throw migrationError('Migration manifest has an invalid shape.');
  }
  if (parsed.version !== MIGRATION_MANIFEST_VERSION || !isRecord(parsed.migrations)) {
    throw migrationError('Migration manifest has an invalid shape.');
  }
  const migrationEntries = parsed.migrations;
  const fileNames = new Set(files.map((file) => file.name));
  const manifestNames = new Set(Object.keys(migrationEntries));
  for (const required of REQUIRED_MANIFEST_MIGRATIONS) {
    if (!manifestNames.has(required)) {
      throw migrationError(`Migration manifest is missing '${required}'.`);
    }
  }
  if (manifestNames.size !== fileNames.size || [...manifestNames].some((name) => !fileNames.has(name))) {
    throw migrationError('Migration manifest does not match the SQL file set.');
  }
  const filesByName = new Map(files.map((file) => [file.name, file]));
  for (const [name, value] of Object.entries(migrationEntries)) {
    if (typeof value !== 'string' || !SHA256.test(value)) {
      throw migrationError(`Migration manifest entry '${name}' has an invalid checksum.`);
    }
    if (filesByName.get(name)?.checksum !== value) {
      throw migrationError(`Migration manifest entry '${name}' checksum mismatch.`);
    }
  }
  return {
    migrations: Object.fromEntries(
      Object.entries(migrationEntries).map(([name, value]) => [name, value as string]),
    ),
    version: MIGRATION_MANIFEST_VERSION,
  };
}

function tableColumns(sqlite: Database.Database, table: string): ReadonlySet<string> {
  let rows: unknown[];
  try {
    rows = sqlite.prepare(`PRAGMA table_info('${table}')`).all() as unknown[];
  } catch {
    throw migrationError(`SQLite table '${table}' could not be inspected.`);
  }
  if (!Array.isArray(rows)) {
    throw migrationError(`SQLite table '${table}' returned an invalid description.`);
  }
  const columns = new Set<string>();
  for (const row of rows) {
    if (
      row === null ||
      typeof row !== 'object' ||
      typeof (row as { readonly name?: unknown }).name !== 'string'
    ) {
      throw migrationError(`SQLite table '${table}' returned an invalid description.`);
    }
    columns.add((row as { readonly name: string }).name);
  }
  return columns;
}

function hasTable(sqlite: Database.Database, table: string): boolean {
  try {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { readonly name?: unknown } | undefined;
    return row?.name === table;
  } catch {
    throw migrationError(`SQLite table '${table}' could not be inspected.`);
  }
}

function ensureMigrationTable(sqlite: Database.Database): boolean {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const columns = tableColumns(sqlite, 'schema_migrations');
  if (!columns.has('version') || !columns.has('applied_at')) {
    throw migrationError('SQLite schema_migrations has an invalid shape.');
  }
  return columns.has('checksum_sha256');
}

function appliedMigrations(
  sqlite: Database.Database,
  hasChecksumColumn: boolean,
): readonly AppliedMigration[] {
  const statement = hasChecksumColumn
    ? 'SELECT version, applied_at, checksum_sha256 FROM schema_migrations'
    : 'SELECT version, applied_at, NULL AS checksum_sha256 FROM schema_migrations';
  let rows: unknown[];
  try {
    rows = sqlite.prepare(statement).all() as unknown[];
  } catch {
    throw migrationError('SQLite schema_migrations could not be read.');
  }
  if (!Array.isArray(rows)) throw migrationError('SQLite schema_migrations returned an invalid shape.');

  const names = new Set<string>();
  const sequences = new Set<number>();
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') {
      throw migrationError('SQLite schema_migrations returned an invalid row.');
    }
    const value = row as {
      readonly applied_at?: unknown;
      readonly checksum_sha256?: unknown;
      readonly version?: unknown;
    };
    const appliedAt = value.applied_at;
    if (
      typeof value.version !== 'string' ||
      typeof appliedAt !== 'number' ||
      !Number.isSafeInteger(appliedAt) ||
      appliedAt < 0 ||
      (value.checksum_sha256 !== null && typeof value.checksum_sha256 !== 'string')
    ) {
      throw migrationError('SQLite schema_migrations returned an invalid row.');
    }
    const sequence = migrationSequence(value.version);
    if (names.has(value.version) || sequences.has(sequence)) {
      throw migrationError(`SQLite schema_migrations contains duplicate migration sequence ${String(sequence).padStart(4, '0')}.`);
    }
    if (value.checksum_sha256 !== null && !SHA256.test(value.checksum_sha256)) {
      throw migrationError(`SQLite migration '${value.version}' has an invalid checksum.`);
    }
    names.add(value.version);
    sequences.add(sequence);
    return {
      appliedAt,
      checksum: value.checksum_sha256 ?? null,
      name: value.version,
      sequence,
    };
  });
}

function validateMigrationHistory(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  const filesByName = new Map(files.map((file) => [file.name, file]));
  const appliedNames = new Set<string>();
  let highestApplied = -1;
  for (const migration of applied) {
    if (!filesByName.has(migration.name)) {
      throw migrationError(`Applied migration file '${migration.name}' is missing.`);
    }
    appliedNames.add(migration.name);
    highestApplied = Math.max(highestApplied, migration.sequence);
  }
  for (const file of files) {
    if (file.sequence <= highestApplied && !appliedNames.has(file.name)) {
      throw migrationError(
        `Migration '${file.name}' was inserted before the highest applied migration.`,
      );
    }
  }
}

function recordMigration(sqlite: Database.Database, file: MigrationFile, hasChecksumColumn: boolean): void {
  if (hasChecksumColumn) {
    sqlite
      .prepare(
        'INSERT INTO schema_migrations (version, applied_at, checksum_sha256) VALUES (?, ?, ?)',
      )
      .run(file.name, Date.now(), file.checksum);
    return;
  }
  sqlite
    .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(file.name, Date.now());
}

function migrationState(sqlite: Database.Database): MigrationState {
  if (!hasTable(sqlite, MIGRATION_STATE_TABLE)) {
    throw migrationError('SQLite migration checksum state is missing.');
  }
  const columns = tableColumns(sqlite, MIGRATION_STATE_TABLE);
  if (!columns.has('id') || !columns.has('checksums_locked_at')) {
    throw migrationError('SQLite migration checksum state has an invalid shape.');
  }
  let rows: unknown[];
  try {
    rows = sqlite.prepare(
      `SELECT id, checksums_locked_at FROM ${MIGRATION_STATE_TABLE}`,
    ).all() as unknown[];
  } catch {
    throw migrationError('SQLite migration checksum state could not be read.');
  }
  if (rows.length !== 1) throw migrationError('SQLite migration checksum state has an invalid shape.');
  const row = rows[0];
  if (row === null || typeof row !== 'object') {
    throw migrationError('SQLite migration checksum state has an invalid shape.');
  }
  const value = row as { readonly id?: unknown; readonly checksums_locked_at?: unknown };
  const lockedAt = value.checksums_locked_at;
  if (
    value.id !== 1 ||
    lockedAt === undefined ||
    (lockedAt !== null &&
      (typeof lockedAt !== 'number' || !Number.isSafeInteger(lockedAt) || lockedAt < 0))
  ) {
    throw migrationError('SQLite migration checksum state has an invalid shape.');
  }
  return { checksumsLockedAt: lockedAt === null ? null : lockedAt };
}

function protectedSchemaSnapshot(sqlite: Database.Database): MigrationFrameworkSnapshot {
  let rows: unknown[];
  try {
    rows = sqlite.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE (type = 'table' AND name IN ('schema_migrations', 'schema_migration_integrity'))
          OR (type = 'trigger' AND name IN (
            'schema_migrations_checksum_immutable',
            'schema_migrations_row_immutable',
            'schema_migration_integrity_lock_immutable',
            'schema_migration_integrity_row_immutable'
          ))
       ORDER BY type, name`,
    ).all() as unknown[];
  } catch {
    throw migrationError('SQLite migration framework objects could not be inspected.');
  }
  if (!Array.isArray(rows)) {
    throw migrationError('SQLite migration framework objects returned an invalid shape.');
  }
  const objects: ProtectedSchemaObject[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      throw migrationError('SQLite migration framework objects returned an invalid row.');
    }
    const value = row as {
      readonly name?: unknown;
      readonly sql?: unknown;
      readonly tbl_name?: unknown;
      readonly type?: unknown;
    };
    if (
      (value.type !== 'table' && value.type !== 'trigger') ||
      typeof value.name !== 'string' ||
      typeof value.tbl_name !== 'string' ||
      typeof value.sql !== 'string' ||
      value.name.length === 0 ||
      value.tbl_name.length === 0 ||
      value.sql.trim().length === 0
    ) {
      throw migrationError('SQLite migration framework objects returned an invalid row.');
    }
    const key = `${value.type}\u0000${value.name}`;
    const expected = PROTECTED_SCHEMA_OBJECTS.get(key);
    if (
      seen.has(key) ||
      expected === undefined ||
      expected.type !== value.type ||
      expected.tableName !== value.tbl_name
    ) {
      throw migrationError('SQLite migration framework object set is invalid.');
    }
    seen.add(key);
    objects.push({
      name: value.name,
      sql: value.sql,
      tableName: value.tbl_name,
      type: value.type,
    });
  }
  if (seen.size !== PROTECTED_SCHEMA_OBJECTS.size) {
    throw migrationError('SQLite migration framework object set is incomplete.');
  }
  let applied = appliedMigrations(sqlite, true);
  applied = [...applied].sort((left, right) => left.sequence - right.sequence);
  const state = migrationState(sqlite);
  return { applied, lock: state.checksumsLockedAt, objects };
}

function equalFrameworkSnapshots(
  left: MigrationFrameworkSnapshot,
  right: MigrationFrameworkSnapshot,
): boolean {
  if (left.lock !== right.lock || left.objects.length !== right.objects.length || left.applied.length !== right.applied.length) {
    return false;
  }
  for (const [index, object] of left.objects.entries()) {
    const other = right.objects[index];
    if (
      other === undefined ||
      object.type !== other.type ||
      object.name !== other.name ||
      object.tableName !== other.tableName ||
      object.sql !== other.sql
    ) {
      return false;
    }
  }
  for (const [index, migration] of left.applied.entries()) {
    const other = right.applied[index];
    if (
      other === undefined ||
      migration.name !== other.name ||
      migration.sequence !== other.sequence ||
      migration.appliedAt !== other.appliedAt ||
      migration.checksum !== other.checksum
    ) {
      return false;
    }
  }
  return true;
}

function validateMigrationChecksums(
  sqlite: Database.Database,
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  const filesByName = new Map(files.map((file) => [file.name, file]));
  for (const migration of applied) {
    const file = filesByName.get(migration.name);
    if (file === undefined) {
      throw migrationError(`Applied migration file '${migration.name}' is missing.`);
    }
    if (migration.checksum !== null && migration.checksum !== file.checksum) {
      throw migrationError(`Applied migration '${migration.name}' checksum mismatch.`);
    }
  }

  const state = migrationState(sqlite);
  const missing = applied.filter((migration) => migration.checksum === null);
  if (state.checksumsLockedAt !== null) {
    if (missing.length > 0) {
      throw migrationError('SQLite migration checksums are locked but one or more checksums are missing.');
    }
    return;
  }

  sqlite.transaction(() => {
    const update = sqlite.prepare(
      'UPDATE schema_migrations SET checksum_sha256 = ? WHERE version = ? AND checksum_sha256 IS NULL',
    );
    for (const migration of missing) {
      const file = filesByName.get(migration.name);
      if (file === undefined) {
        throw migrationError(`Applied migration file '${migration.name}' is missing.`);
      }
      update.run(file.checksum, migration.name);
    }
    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE checksum_sha256 IS NULL')
      .get() as { readonly count?: unknown } | undefined;
    if (remaining?.count !== 0) {
      throw migrationError('SQLite migration checksums could not be backfilled.');
    }
    const lockedAt = Date.now();
    const locked = sqlite
      .prepare(
        `UPDATE ${MIGRATION_STATE_TABLE} SET checksums_locked_at = ? WHERE id = 1 AND checksums_locked_at IS NULL`,
      )
      .run(lockedAt);
    if (locked.changes !== 1) {
      throw migrationError('SQLite migration checksum state could not be locked.');
    }
  })();
}

function applyMigrations(sqlite: Database.Database, migrationsDirectory?: string): void {
  const directory = resolveMigrationsDirectory(migrationsDirectory);
  const files = readMigrationFiles(directory);
  // Verify the release manifest before touching the database. This is the
  // trust anchor for the first checksum backfill performed on legacy stores.
  readMigrationManifest(directory, files);
  let hasChecksumColumn = ensureMigrationTable(sqlite);
  let applied = appliedMigrations(sqlite, hasChecksumColumn);
  if (
    !hasChecksumColumn &&
    (applied.some((migration) => migration.sequence >= CHECKSUM_MIGRATION_SEQUENCE) ||
      hasTable(sqlite, MIGRATION_STATE_TABLE))
  ) {
    throw migrationError('SQLite migration checksum metadata is missing.');
  }
  validateMigrationHistory(files, applied);
  if (hasChecksumColumn) {
    if (!applied.some((migration) => migration.sequence >= CHECKSUM_MIGRATION_SEQUENCE)) {
      throw migrationError('SQLite migration checksum history is incomplete.');
    }
    // A checksum drift must stop startup before any newer migration can alter
    // the database. Legacy databases defer this check until 0006 adds the
    // checksum column and state table below.
    validateMigrationChecksums(sqlite, files, applied);
  }
  let frameworkSnapshot: MigrationFrameworkSnapshot | null = hasChecksumColumn
    ? protectedSchemaSnapshot(sqlite)
    : null;

  const appliedNames = new Set(applied.map((migration) => migration.name));
  for (const file of files) {
    if (appliedNames.has(file.name)) continue;

    const previousHasChecksumColumn = hasChecksumColumn;
    let nextFrameworkSnapshot: MigrationFrameworkSnapshot | null = null;
    sqlite.transaction(() => {
      sqlite.exec(file.source);
      const nextHasChecksumColumn = ensureMigrationTable(sqlite);
      if (previousHasChecksumColumn && !nextHasChecksumColumn) {
        throw migrationError('A migration removed the checksum column.');
      }
      if (nextHasChecksumColumn) {
        // Validate protected objects and all existing applied rows before the
        // client records this migration. Any mutation is rolled back with the
        // migration transaction, including forged history rows or applied_at.
        const afterSqlSnapshot = protectedSchemaSnapshot(sqlite);
        if (
          frameworkSnapshot !== null &&
          !equalFrameworkSnapshots(frameworkSnapshot, afterSqlSnapshot)
        ) {
          throw migrationError('A migration changed protected SQLite migration metadata.');
        }
        nextFrameworkSnapshot = afterSqlSnapshot;
      }
      hasChecksumColumn = nextHasChecksumColumn;
      recordMigration(sqlite, file, nextHasChecksumColumn);
      if (nextHasChecksumColumn) {
        // Establish the next baseline only after the client-owned row has
        // been recorded, still before the transaction can commit.
        nextFrameworkSnapshot = protectedSchemaSnapshot(sqlite);
      }
    })();
    frameworkSnapshot = nextFrameworkSnapshot;
    appliedNames.add(file.name);
  }

  if (!hasChecksumColumn) return;
  applied = appliedMigrations(sqlite, hasChecksumColumn);
  validateMigrationHistory(files, applied);
  validateMigrationChecksums(sqlite, files, applied);
}

function resolveMigrationsDirectory(explicitDirectory?: string): string {
  if (explicitDirectory) {
    return resolve(explicitDirectory);
  }

  const candidates = [
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'apps/server/migrations'),
    resolve(process.cwd(), 'dist/migrations'),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));

  if (!directory) {
    throw new Error('Unable to locate the database migrations directory.');
  }

  return directory;
}

export function createDatabase(
  databasePath: string,
  migrationsDirectory?: string,
): DatabaseClient {
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('busy_timeout = 5000');
    applyMigrations(sqlite, migrationsDirectory);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure when cleanup itself fails.
    }
    throw error;
  }

  return {
    orm: drizzle(sqlite, { schema }),
    sqlite,
  };
}
