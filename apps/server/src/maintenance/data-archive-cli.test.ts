import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../database/client.js';
import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  OfflineMaintenanceLeaseError,
  acquireServerRuntimeLease,
} from './runtime-lock.js';
import {
  DataArchiveCliUsageError,
  parseDataArchiveCliArgs,
  runDataArchiveCli,
} from './data-archive-cli.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try { database.sqlite.close(); } catch { /* Keep fixture cleanup progressing. */ }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const database = createDatabase(paths.database, migrationsDirectory);
  await writeFile(join(paths.uploads, 'cli-fixture.bin'), 'archive fixture', { mode: 0o600 });
  database.sqlite.close();
  return root;
}

describe('data archive CLI', () => {
  it('parses only the strict create and verify forms', () => {
    expect(parseDataArchiveCliArgs(['create', '--data-dir', '/var/lib/imagine'])).toEqual({
      command: 'create',
      dataDir: '/var/lib/imagine',
    });
    expect(parseDataArchiveCliArgs(['verify', '--bundle', '/var/lib/imagine/backups/data.bundle'])).toEqual({
      bundlePath: '/var/lib/imagine/backups/data.bundle',
      command: 'verify',
    });
    expect(parseDataArchiveCliArgs(['restore', '--bundle', '/var/lib/imagine/backups/data.bundle', '--target', '/var/lib/imagine-restored'])).toEqual({
      bundlePath: '/var/lib/imagine/backups/data.bundle',
      command: 'restore',
      targetPath: '/var/lib/imagine-restored',
    });
    expect(() => parseDataArchiveCliArgs([])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['create', '--bundle', 'archive.bundle'])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['verify', '--bundle', 'archive.bundle', '--extra'])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['restore', '--bundle', 'archive.bundle'])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['create', '--data-dir', '--bad'])).toThrow(DataArchiveCliUsageError);
  });

  it('creates through the production offline lease wiring and cleans the gate', async () => {
    const root = await fixture('ims-archive-cli-create-');
    const output: string[] = [];
    const code = await runDataArchiveCli(['create', '--data-dir', root], {
      write: (chunk) => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatch(/^created id=[A-Za-z0-9][A-Za-z0-9._-]{0,127} entries=2 bytes=\d+ createdAt=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n$/u);
    expect(output.join('')).not.toContain(root);
    expect(await readdir(join(root, 'backups'))).toHaveLength(2);
    expect(await readFile(join(root, '.offline-maintenance.lock')).catch(() => null)).toBeNull();
  });

  it('fails closed when the server owns the shared runtime gate', async () => {
    const root = await fixture('ims-archive-cli-running-');
    const serverLease = await acquireServerRuntimeLease(root);
    try {
      await expect(runDataArchiveCli(['create', '--data-dir', root])).rejects.toThrow(OfflineMaintenanceLeaseError);
      expect(await readdir(join(root, 'backups'))).toEqual([]);
    } finally {
      await serverLease.release();
    }
  });

  it('runs verify through an injected verifier without printing paths or contents', async () => {
    const output: string[] = [];
    const code = await runDataArchiveCli(['verify', '--bundle', '/tmp/archive.bundle'], {
      verify: async () => ({ bytes: 12, createdAt: new Date('2026-08-29T00:00:00.000Z'), entries: 2 }),
      write: (chunk) => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(output).toEqual(['verified entries=2 bytes=12 createdAt=2026-08-29T00:00:00.000Z\n']);
    expect(output.join('')).not.toContain('/tmp/archive.bundle');
  });

  it('runs restore through an injected restorer without printing paths or secrets', async () => {
    const output: string[] = [];
    const code = await runDataArchiveCli(['restore', '--bundle', '/tmp/archive.bundle', '--target', '/tmp/restored'], {
      restore: async () => ({
        bytes: 12,
        createdAt: new Date('2026-08-29T00:00:00.000Z'),
        entries: 2,
        targetPath: '/tmp/restored',
      }),
      write: (chunk) => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(output).toEqual(['restored entries=2 bytes=12 createdAt=2026-08-29T00:00:00.000Z\n']);
    expect(output.join('')).not.toContain('/tmp/');
    expect(output.join('')).not.toContain('APP_SECRET');
  });
});
