import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    ]);
    expect(first.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.sqlite.pragma('synchronous', { simple: true })).toBe(1);
    expect(first.sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
    first.sqlite.close();

    const second = createDatabase(databasePath, migrationsDirectory);
    expect(
      second.sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get(),
    ).toEqual({ count: 5 });
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
  });
});
