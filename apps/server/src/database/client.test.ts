import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from './client.js';

const temporaryDirectories: string[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('SQLite initialization', () => {
  it('applies the committed migration exactly once and configures required pragmas', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-database-test-'));
    temporaryDirectories.push(dataDir);
    const databasePath = resolve(dataDir, 'app.db');

    const first = createDatabase(databasePath, migrationsDirectory);
    expect(
      first.sqlite.prepare('SELECT version FROM schema_migrations').all(),
    ).toEqual([{ version: '0000_pr0.sql' }]);
    expect(first.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    first.sqlite.close();

    const second = createDatabase(databasePath, migrationsDirectory);
    expect(
      second.sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 1 });
    second.sqlite.close();
  });
});
