import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type DatabaseClient } from './client.js';
import {
  checkSqliteIntegrity,
  SqliteIntegrityError,
} from './integrity.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => {
    try {
      database.sqlite.close();
    } catch {
      // The test may have intentionally closed the connection.
    }
  }));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

async function databaseFixture(prefix: string): Promise<DatabaseClient> {
  const directory = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  return database;
}

describe('SQLite integrity checks', () => {
  it('reports a healthy live database with foreign keys enabled', async () => {
    const database = await databaseFixture('imagine-integrity-healthy-');

    expect(checkSqliteIntegrity(database.sqlite)).toEqual({
      foreignKeyCheck: {
        ok: true,
        truncated: false,
        violations: [],
      },
      foreignKeysEnabled: true,
      integrityCheck: {
        errorCount: 0,
        ok: true,
        truncated: false,
      },
      ok: true,
    });
  });

  it('reports bounded foreign-key violations without exposing row contents', async () => {
    const database = await databaseFixture('imagine-integrity-foreign-key-');
    database.sqlite.pragma('foreign_keys = OFF');
    database.sqlite
      .prepare(
        `INSERT INTO job_inputs (job_id, asset_id, role, sort_order)
         VALUES ('missing-job', 'missing-asset', 'reference', 0)`,
      )
      .run();
    database.sqlite.pragma('foreign_keys = ON');

    const report = checkSqliteIntegrity(database.sqlite, { maxResults: 1 });

    expect(report.ok).toBe(false);
    expect(report.foreignKeysEnabled).toBe(true);
    expect(report.foreignKeyCheck.ok).toBe(false);
    expect(report.foreignKeyCheck.violations).toHaveLength(1);
    expect(report.foreignKeyCheck.violations[0]).toMatchObject({
      parent: expect.any(String),
      table: 'job_inputs',
    });
    expect(report.foreignKeyCheck.truncated).toBe(true);
    expect(JSON.stringify(report)).not.toContain('missing-job');
    expect(JSON.stringify(report)).not.toContain('missing-asset');
  });

  it('reports disabled foreign-key enforcement as unhealthy', async () => {
    const database = await databaseFixture('imagine-integrity-foreign-key-mode-');
    database.sqlite.pragma('foreign_keys = OFF');

    const report = checkSqliteIntegrity(database.sqlite);

    expect(report.foreignKeysEnabled).toBe(false);
    expect(report.foreignKeyCheck.ok).toBe(true);
    expect(report.integrityCheck.ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('bounds integrity-check messages and never returns raw SQLite text', async () => {
    const database = await databaseFixture('imagine-integrity-messages-');
    const prepare = vi.spyOn(database.sqlite, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('PRAGMA integrity_check')) {
        return { all: () => [
          { integrity_check: 'SQL contains secret-value' },
          { integrity_check: 'another failure' },
        ] } as never;
      }
      return { iterate: () => [] } as never;
    });

    const report = checkSqliteIntegrity(database.sqlite, { maxResults: 1 });

    expect(report.integrityCheck).toEqual({ errorCount: 1, ok: false, truncated: true });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('secret-value');
    expect(prepare).toHaveBeenCalledWith('PRAGMA integrity_check(1)');
  });

  it('fails closed for invalid pragma and foreign-key result shapes', async () => {
    const pragmaDatabase = {
      pragma: () => 'enabled',
    } as unknown as Database.Database;
    expect(() => checkSqliteIntegrity(pragmaDatabase)).toThrow(SqliteIntegrityError);

    const malformedIntegrityDatabase = {
      pragma: () => 1,
      prepare: () => ({ all: () => [{ integrity_check: 42 }] }),
    } as unknown as Database.Database;
    expect(() => checkSqliteIntegrity(malformedIntegrityDatabase)).toThrow(SqliteIntegrityError);

    const malformedForeignKeyDatabase = {
      pragma: () => 1,
      prepare: (sql: string) => sql.startsWith('PRAGMA integrity_check')
        ? { all: () => [{ integrity_check: 'ok' }] }
        : { iterate: () => [{ table: 'jobs', rowid: 'not-an-id', parent: 'assets', fkid: 0 }] },
    } as unknown as Database.Database;
    expect(() => checkSqliteIntegrity(malformedForeignKeyDatabase)).toThrow(SqliteIntegrityError);
  });

  it('rejects invalid result limits before running SQLite queries', async () => {
    const database = await databaseFixture('imagine-integrity-limit-');
    const pragma = vi.spyOn(database.sqlite, 'pragma');

    expect(() => checkSqliteIntegrity(database.sqlite, { maxResults: 0 })).toThrow(RangeError);
    expect(() => checkSqliteIntegrity(database.sqlite, { maxResults: 1_001 })).toThrow(RangeError);
    expect(pragma).not.toHaveBeenCalled();
  });
});
