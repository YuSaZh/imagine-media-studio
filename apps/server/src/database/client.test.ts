import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';

const temporaryDirectories: string[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

async function copyMigrations(destination: string, names?: readonly string[]): Promise<void> {
  await mkdir(destination, { recursive: true });
  const selected = names ?? (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql'));
  await Promise.all(selected.map((name) => copyFile(
    resolve(migrationsDirectory, name),
    resolve(destination, name),
  )));
  if (selected.includes('0006_pr8_migration_checksums.sql')) {
    await copyFile(
      resolve(migrationsDirectory, 'manifest.json'),
      resolve(destination, 'manifest.json'),
    );
  }
}

async function addManifestEntry(
  migrations: string,
  name: string,
): Promise<void> {
  const manifestPath = resolve(migrations, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    migrations: Record<string, string>;
    version: number;
  };
  const source = await readFile(resolve(migrations, name));
  manifest.migrations[name] = createHash('sha256').update(source).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function databaseFixture(prefix: string): Promise<{
  readonly dataDir: string;
  readonly databasePath: string;
  readonly migrations: string;
}> {
  const dataDir = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(dataDir);
  const migrations = resolve(dataDir, 'migrations');
  await copyMigrations(migrations);
  return { dataDir, databasePath: resolve(dataDir, 'app.db'), migrations };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('SQLite initialization', () => {
  it('applies the committed migrations exactly once and configures required pragmas', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-database-test-'));
    temporaryDirectories.push(dataDir);
    const databasePath = resolve(dataDir, 'app.db');

    const first = createDatabase(databasePath, migrationsDirectory);
    expect(
      first.sqlite.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([
      { version: '0000_pr0.sql' },
      { version: '0001_pr2_core.sql' },
      { version: '0002_pr4_runtime_safety.sql' },
      { version: '0003_pr5_video_runtime.sql' },
      { version: '0004_pr6_custom_adapters.sql' },
      { version: '0005_pr6_trusted_adapter_tombstones.sql' },
      { version: '0006_pr8_migration_checksums.sql' },
      { version: '0007_pr8_media_repair_queue.sql' },
      { version: '0008_accounts.sql' },
    ]);
    expect(first.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    first.sqlite.close();

    const second = createDatabase(databasePath, migrationsDirectory);
    expect(
      second.sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 9 });
    expect(
      second.sqlite
        .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE checksum_sha256 IS NULL')
        .get(),
    ).toEqual({ count: 0 });
    expect(
      second.sqlite.prepare('SELECT checksums_locked_at FROM schema_migration_integrity').get(),
    ).toMatchObject({ checksums_locked_at: expect.any(Number) });
    const definitionIndexes = second.sqlite
      .prepare("PRAGMA index_list('provider_adapter_definitions')")
      .all() as Array<{ readonly name: string }>;
    expect(definitionIndexes.map((index) => index.name)).toContain(
      'provider_adapter_definitions_adapter_idx',
    );
    const jobIndexes = second.sqlite
      .prepare("PRAGMA index_list('jobs')")
      .all() as Array<{ readonly name: string }>;
    expect(jobIndexes.map((index) => index.name)).toContain('jobs_adapter_retained_idx');
    const definitionPlan = second.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM provider_adapter_definitions WHERE adapter_id = ?',
      )
      .all('adapter') as Array<{ readonly detail: string }>;
    expect(definitionPlan.some(({ detail }) =>
      detail.includes('SEARCH') && detail.includes('provider_adapter_definitions_adapter_idx')),
    ).toBe(true);
    expect(definitionPlan.every(({ detail }) => !detail.includes('SCAN provider_adapter_definitions'))).toBe(true);
    const retainedJobPlan = second.sqlite
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM jobs WHERE adapter_id = ? AND deleted_at IS NULL',
      )
      .all('adapter') as Array<{ readonly detail: string }>;
    expect(retainedJobPlan.some(({ detail }) =>
      detail.includes('SEARCH') && detail.includes('jobs_adapter_retained_idx')),
    ).toBe(true);
    expect(retainedJobPlan.every(({ detail }) => !detail.includes('SCAN jobs'))).toBe(true);
    second.sqlite.close();
  });

  it('upgrades a populated PR 0 database without losing jobs or assets', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-database-upgrade-test-'));
    temporaryDirectories.push(dataDir);
    const legacyMigrations = resolve(dataDir, 'legacy-migrations');
    await mkdir(legacyMigrations);
    await copyFile(
      resolve(migrationsDirectory, '0000_pr0.sql'),
      resolve(legacyMigrations, '0000_pr0.sql'),
    );
    const databasePath = resolve(dataDir, 'app.db');
    const legacy = createDatabase(databasePath, legacyMigrations);
    legacy.sqlite
      .prepare(
        `INSERT INTO jobs (
          id, operation, provider_id, model_id, prompt, request_json, status, stage,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-job',
        'image.generate',
        'mock',
        'mock-image-v1',
        'Legacy fixture',
        JSON.stringify({
          operation: 'image.generate',
          providerId: 'mock',
          modelId: 'mock-image-v1',
          prompt: 'Legacy fixture',
          inputs: [],
        }),
        'completed',
        'completed',
        'legacy-key',
        1_700_000_000_000,
        1_700_000_000_000,
      );
    legacy.sqlite
      .prepare(
        `INSERT INTO assets (
          id, job_id, type, role, file_path, mime_type, file_size, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-asset',
        'legacy-job',
        'image',
        'output',
        'media/originals/legacy.png',
        'image/png',
        10,
        'legacy-sha',
        1_700_000_000_000,
      );
    legacy.sqlite.close();

    const upgraded = createDatabase(databasePath, migrationsDirectory);
    expect(upgraded.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: '0000_pr0.sql' },
      { version: '0001_pr2_core.sql' },
      { version: '0002_pr4_runtime_safety.sql' },
      { version: '0003_pr5_video_runtime.sql' },
      { version: '0004_pr6_custom_adapters.sql' },
      { version: '0005_pr6_trusted_adapter_tombstones.sql' },
      { version: '0006_pr8_migration_checksums.sql' },
      { version: '0007_pr8_media_repair_queue.sql' },
      { version: '0008_accounts.sql' },
    ]);
    expect(
      upgraded.sqlite
        .prepare(
          `SELECT id, job_id, parent_asset_id, metadata_json, favorite, deleted_at
           FROM assets WHERE id = ?`,
        )
        .get('legacy-asset'),
    ).toEqual({
      id: 'legacy-asset',
      job_id: 'legacy-job',
      parent_asset_id: null,
      metadata_json: '{}',
      favorite: 0,
      deleted_at: null,
    });
    expect(upgraded.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      upgraded.sqlite
        .prepare('SELECT job_id, slot, asset_id FROM job_outputs WHERE job_id = ?')
        .get('legacy-job'),
    ).toEqual({ job_id: 'legacy-job', slot: 0, asset_id: 'legacy-asset' });
    expect(
      upgraded.sqlite
        .prepare('SELECT root_job_id, submit_attempt FROM jobs WHERE id = ?')
        .get('legacy-job'),
    ).toEqual({ root_job_id: 'legacy-job', submit_attempt: 0 });
    expect(
      (upgraded.sqlite
        .prepare("PRAGMA index_list('provider_adapter_definitions')")
        .all() as Array<{ readonly name: string }>).map((index) => index.name),
    ).toContain('provider_adapter_definitions_adapter_idx');
    expect(
      (upgraded.sqlite
        .prepare("PRAGMA index_list('jobs')")
        .all() as Array<{ readonly name: string }>).map((index) => index.name),
    ).toContain('jobs_adapter_retained_idx');
    expect(() =>
      upgraded.sqlite
        .prepare(
          `INSERT INTO assets (
            id, job_id, type, role, file_path, mime_type, file_size, sha256,
            metadata_json, favorite, created_at
          ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, '{}', 0, ?)`,
        )
        .run(
          'duplicate-path-asset',
          'image',
          'upload',
          'media/originals/legacy.png',
          'image/png',
          10,
          'duplicate-sha',
          1_700_000_000_001,
        ),
    ).toThrow();
    upgraded.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run('legacy-job');
    expect(
      upgraded.sqlite.prepare('SELECT job_id FROM assets WHERE id = ?').get('legacy-asset'),
    ).toEqual({ job_id: null });
    upgraded.sqlite.close();
    const reopened = createDatabase(databasePath, migrationsDirectory);
    expect(
      (reopened.sqlite
        .prepare("PRAGMA index_list('provider_adapter_definitions')")
        .all() as Array<{ readonly name: string }>).map((index) => index.name),
    ).toContain('provider_adapter_definitions_adapter_idx');
    expect(
      (reopened.sqlite
        .prepare("PRAGMA index_list('jobs')")
        .all() as Array<{ readonly name: string }>).map((index) => index.name),
    ).toContain('jobs_adapter_retained_idx');
    reopened.sqlite.close();
  });

  it('requires a strict release manifest for PR8 and later migration directories', async () => {
    const missing = await databaseFixture('imagine-database-missing-manifest-test-');
    await rm(resolve(missing.migrations, 'manifest.json'));
    expect(() => createDatabase(missing.databasePath, missing.migrations)).toThrow(
      'manifest is required',
    );

    const wrongHash = await databaseFixture('imagine-database-wrong-manifest-hash-test-');
    const wrongManifest = JSON.parse(
      await readFile(resolve(wrongHash.migrations, 'manifest.json'), 'utf8'),
    ) as { migrations: Record<string, string>; version: number };
    wrongManifest.migrations['0000_pr0.sql'] = '0'.repeat(64);
    await writeFile(
      resolve(wrongHash.migrations, 'manifest.json'),
      `${JSON.stringify(wrongManifest, null, 2)}\n`,
    );
    expect(() => createDatabase(wrongHash.databasePath, wrongHash.migrations)).toThrow(
      'checksum mismatch',
    );

    const missingEntry = await databaseFixture('imagine-database-missing-manifest-entry-test-');
    const missingEntryManifest = JSON.parse(
      await readFile(resolve(missingEntry.migrations, 'manifest.json'), 'utf8'),
    ) as { migrations: Record<string, string>; version: number };
    delete missingEntryManifest.migrations['0005_pr6_trusted_adapter_tombstones.sql'];
    await writeFile(
      resolve(missingEntry.migrations, 'manifest.json'),
      `${JSON.stringify(missingEntryManifest, null, 2)}\n`,
    );
    expect(() => createDatabase(missingEntry.databasePath, missingEntry.migrations)).toThrow(
      'manifest is missing',
    );

    const extraEntry = await databaseFixture('imagine-database-extra-manifest-entry-test-');
    const extraManifest = JSON.parse(
      await readFile(resolve(extraEntry.migrations, 'manifest.json'), 'utf8'),
    ) as { migrations: Record<string, string>; version: number };
    extraManifest.migrations['9999_extra.sql'] = '0'.repeat(64);
    await writeFile(
      resolve(extraEntry.migrations, 'manifest.json'),
      `${JSON.stringify(extraManifest, null, 2)}\n`,
    );
    expect(() => createDatabase(extraEntry.databasePath, extraEntry.migrations)).toThrow(
      'SQL file set',
    );
  });

  it('rejects legacy upgrade before checksum backfill when a committed SQL file drifts', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-database-legacy-drift-test-'));
    temporaryDirectories.push(dataDir);
    const legacyMigrations = resolve(dataDir, 'legacy-migrations');
    await copyMigrations(legacyMigrations, [
      '0000_pr0.sql',
      '0001_pr2_core.sql',
      '0002_pr4_runtime_safety.sql',
      '0003_pr5_video_runtime.sql',
      '0004_pr6_custom_adapters.sql',
      '0005_pr6_trusted_adapter_tombstones.sql',
    ]);
    const databasePath = resolve(dataDir, 'app.db');
    const legacy = createDatabase(databasePath, legacyMigrations);
    legacy.sqlite.close();

    const upgradeMigrations = resolve(dataDir, 'upgrade-migrations');
    await copyMigrations(upgradeMigrations);
    const driftPath = resolve(upgradeMigrations, '0005_pr6_trusted_adapter_tombstones.sql');
    await writeFile(driftPath, `${await readFile(driftPath, 'utf8')}\n-- drift\n`);

    expect(() => createDatabase(databasePath, upgradeMigrations)).toThrow(
      'Migration manifest entry',
    );
    const sqlite = new Database(databasePath);
    expect(
      (sqlite.prepare("PRAGMA table_info('schema_migrations')").all() as Array<{ readonly name: string }>)
        .map((column) => column.name),
    ).not.toContain('checksum_sha256');
    sqlite.close();
  });

  it('rejects a directory that skips 0006 while claiming a later migration', async () => {
    const fixture = await databaseFixture('imagine-database-missing-0006-test-');
    await rm(resolve(fixture.migrations, '0006_pr8_migration_checksums.sql'));
    await writeFile(
      resolve(fixture.migrations, '0009_after_missing-0006.sql'),
      'CREATE TABLE must_not_be_applied_after_missing_0006 (id INTEGER PRIMARY KEY);\n',
    );

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'Migration manifest',
    );
  });

  it('rejects an applied migration whose file has drifted', async () => {
    const fixture = await databaseFixture('imagine-database-drift-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();

    const migrationPath = resolve(fixture.migrations, '0005_pr6_trusted_adapter_tombstones.sql');
    const original = await readFile(migrationPath, 'utf8');
    await writeFile(migrationPath, `${original}\n-- drift\n`);

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'checksum mismatch',
    );
  });

  it('checks drift before applying a newer migration', async () => {
    const fixture = await databaseFixture('imagine-database-drift-order-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();

    const migrationPath = resolve(fixture.migrations, '0005_pr6_trusted_adapter_tombstones.sql');
    const original = await readFile(migrationPath, 'utf8');
    await writeFile(migrationPath, `${original}\n-- drift before pending migration\n`);
    await addManifestEntry(fixture.migrations, '0005_pr6_trusted_adapter_tombstones.sql');
    await writeFile(
      resolve(fixture.migrations, '0009_after_drift.sql'),
      'CREATE TABLE must_not_be_applied (id INTEGER PRIMARY KEY);\n',
    );
    await addManifestEntry(fixture.migrations, '0009_after_drift.sql');

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'checksum mismatch',
    );
    const sqlite = new Database(fixture.databasePath);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_be_applied'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it('rejects a missing applied migration before opening a partially upgraded schema', async () => {
    const fixture = await databaseFixture('imagine-database-missing-migration-test-');
    await rm(fixture.migrations, { recursive: true, force: true });
    await copyMigrations(fixture.migrations, ['0000_pr0.sql', '0001_pr2_core.sql']);
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();
    await rm(resolve(fixture.migrations, '0001_pr2_core.sql'));

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'Applied migration file',
    );
  });

  it('rejects a new migration inserted before the highest applied sequence', async () => {
    const fixture = await databaseFixture('imagine-database-order-test-');
    const names = ['0000_pr0.sql'] as const;
    await rm(fixture.migrations, { recursive: true, force: true });
    await copyMigrations(fixture.migrations, names);
    await writeFile(
      resolve(fixture.migrations, '0002_existing.sql'),
      'CREATE TABLE existing_migration_table (id INTEGER PRIMARY KEY);\n',
    );
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();
    await writeFile(
      resolve(fixture.migrations, '0001_inserted.sql'),
      'CREATE TABLE inserted_migration_table (id INTEGER PRIMARY KEY);\n',
    );

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'inserted before the highest applied migration',
    );
  });

  it('rejects invalid migration names and duplicate numeric prefixes', async () => {
    const invalid = await databaseFixture('imagine-database-invalid-name-test-');
    await writeFile(resolve(invalid.migrations, 'migration.sql'), 'SELECT 1;\n');
    expect(() => createDatabase(invalid.databasePath, invalid.migrations)).toThrow(
      'Migration filename',
    );

    const duplicate = await databaseFixture('imagine-database-duplicate-sequence-test-');
    await writeFile(
      resolve(duplicate.migrations, '0000_duplicate.sql'),
      'SELECT 1;\n',
    );
    expect(() => createDatabase(duplicate.databasePath, duplicate.migrations)).toThrow(
      'is duplicated',
    );
  });

  it('rolls back a failed migration without recording it or leaving its schema behind', async () => {
    const fixture = await databaseFixture('imagine-database-migration-rollback-test-');
    await rm(fixture.migrations, { recursive: true, force: true });
    await copyMigrations(fixture.migrations, ['0000_pr0.sql']);
    await writeFile(
      resolve(fixture.migrations, '0001_broken.sql'),
      'CREATE TABLE should_be_rolled_back (id INTEGER PRIMARY KEY);\nTHIS IS NOT VALID SQL;\n',
    );

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow();
    const sqlite = new Database(fixture.databasePath);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_be_rolled_back'").get(),
    ).toBeUndefined();
    expect(sqlite.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: '0000_pr0.sql' },
    ]);
    sqlite.close();
  });

  it('locks backfilled checksums so later direct edits fail closed', async () => {
    const fixture = await databaseFixture('imagine-database-checksum-lock-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    expect(() => first.sqlite
      .prepare('UPDATE schema_migrations SET checksum_sha256 = NULL WHERE version = ?')
      .run('0005_pr6_trusted_adapter_tombstones.sql')).toThrow('immutable');
    first.sqlite.close();
    const reopened = createDatabase(fixture.databasePath, fixture.migrations);
    reopened.sqlite.close();
  });

  it('rejects a database that claims PR8 migrations without checksum metadata', async () => {
    const fixture = await databaseFixture('imagine-database-missing-checksum-metadata-test-');
    const sqlite = new Database(fixture.databasePath);
    sqlite.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at)
      VALUES ('0006_pr8_migration_checksums.sql', 1);
    `);
    sqlite.close();

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'checksum metadata is missing',
    );
  });

  it('rejects a checksum column whose lock state is missing before pending migrations run', async () => {
    const fixture = await databaseFixture('imagine-database-missing-lock-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.exec('DROP TABLE schema_migration_integrity');
    first.sqlite.close();
    await writeFile(
      resolve(fixture.migrations, '0009_after_missing_lock.sql'),
      'CREATE TABLE must_not_be_applied_without_lock (id INTEGER PRIMARY KEY);\n',
    );
    await addManifestEntry(fixture.migrations, '0009_after_missing_lock.sql');

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'checksum state is missing',
    );
    const sqlite = new Database(fixture.databasePath);
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_be_applied_without_lock'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it('rolls back a pending migration that removes the checksum column', async () => {
    const fixture = await databaseFixture('imagine-database-drop-checksum-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();
    await writeFile(
      resolve(fixture.migrations, '0009_drop_checksum.sql'),
      `DROP TRIGGER schema_migrations_checksum_immutable;
       DROP TRIGGER schema_migrations_row_immutable;
       ALTER TABLE schema_migrations DROP COLUMN checksum_sha256;
       CREATE TABLE must_not_be_applied_after_drop (id INTEGER PRIMARY KEY);\n`,
    );
    await addManifestEntry(fixture.migrations, '0009_drop_checksum.sql');

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'removed the checksum column',
    );
    const sqlite = new Database(fixture.databasePath);
    expect(
      (sqlite.prepare("PRAGMA table_info('schema_migrations')").all() as Array<{ readonly name: string }>)
        .map((column) => column.name),
    ).toContain('checksum_sha256');
    expect(
      sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('0009_drop_checksum.sql'),
    ).toBeUndefined();
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_be_applied_after_drop'").get(),
    ).toBeUndefined();
    sqlite.close();
  });

  it('rolls back a pending migration that forges an applied history row', async () => {
    const fixture = await databaseFixture('imagine-database-forged-history-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.close();
    await writeFile(
      resolve(fixture.migrations, '0009_forge_history.sql'),
      `INSERT INTO schema_migrations (version, applied_at, checksum_sha256)
       VALUES ('9999_forged.sql', 123, '${'0'.repeat(64)}');
       CREATE TABLE must_not_be_applied_after_forged_history (id INTEGER PRIMARY KEY);\n`,
    );
    await addManifestEntry(fixture.migrations, '0009_forge_history.sql');

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'protected SQLite migration metadata',
    );
    const sqlite = new Database(fixture.databasePath);
    expect(
      sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('9999_forged.sql'),
    ).toBeUndefined();
    expect(
      sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('0009_forge_history.sql'),
    ).toBeUndefined();
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_be_applied_after_forged_history'").get(),
    ).toBeUndefined();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 9 });
    sqlite.close();
  });

  it('rolls back a pending migration that recreates the lock table without triggers', async () => {
    const fixture = await databaseFixture('imagine-database-recreated-lock-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    const lock = (first.sqlite
      .prepare('SELECT checksums_locked_at FROM schema_migration_integrity')
      .get() as { readonly checksums_locked_at: number }).checksums_locked_at;
    first.sqlite.close();
    await writeFile(
      resolve(fixture.migrations, '0009_recreate_lock_without_triggers.sql'),
      `DROP TRIGGER schema_migrations_checksum_immutable;
       DROP TRIGGER schema_migrations_row_immutable;
       DROP TRIGGER schema_migration_integrity_lock_immutable;
       DROP TRIGGER schema_migration_integrity_row_immutable;
       DROP TABLE schema_migration_integrity;
       CREATE TABLE schema_migration_integrity (
         id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
         checksums_locked_at INTEGER
       );
       INSERT INTO schema_migration_integrity (id, checksums_locked_at) VALUES (1, ${String(lock)});
       CREATE TABLE must_not_be_applied_after_recreated_lock (id INTEGER PRIMARY KEY);\n`,
    );
    await addManifestEntry(fixture.migrations, '0009_recreate_lock_without_triggers.sql');

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'migration framework object set is incomplete',
    );
    const sqlite = new Database(fixture.databasePath);
    expect(
      sqlite.prepare('SELECT checksums_locked_at FROM schema_migration_integrity').get(),
    ).toEqual({ checksums_locked_at: lock });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('schema_migrations_checksum_immutable', 'schema_migrations_row_immutable', 'schema_migration_integrity_lock_immutable', 'schema_migration_integrity_row_immutable')")
        .get(),
    ).toEqual({ count: 4 });
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_be_applied_after_recreated_lock'").get(),
    ).toBeUndefined();
    expect(
      sqlite.prepare('SELECT version FROM schema_migrations WHERE version = ?').get('0009_recreate_lock_without_triggers.sql'),
    ).toBeUndefined();
    sqlite.close();
  });

  it('rejects startup when a protected PR8 trigger is missing', async () => {
    const fixture = await databaseFixture('imagine-database-missing-trigger-test-');
    const first = createDatabase(fixture.databasePath, fixture.migrations);
    first.sqlite.exec('DROP TRIGGER schema_migrations_row_immutable');
    first.sqlite.close();

    expect(() => createDatabase(fixture.databasePath, fixture.migrations)).toThrow(
      'migration framework object set is incomplete',
    );
  });
});
