import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppConfig } from '../config.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../database/client.js';
import { createServer, type ImagineServer } from '../server.js';
import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import type { StoragePaths } from '../storage/paths.js';
import { DataArchive } from './data-archive.js';
import {
  DataRestore,
  DataRestoreCleanupError,
  DataRestoreCollisionError,
  DataRestoreError,
  DataRestoreIntegrityError,
  DataRestorePathError,
  DataRestoreTargetExistsError,
} from './data-restore.js';
import type { DataArchiveFsOps } from './data-archive.js';
import { acquireOfflineMaintenanceLease, type OfflineMaintenanceLease } from './runtime-lock.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const adapterFixtureDirectory = fileURLToPath(new URL('../../../../fixtures/adapters/trusted-fixture-v1', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const leases: OfflineMaintenanceLease[] = [];
const servers: ImagineServer[] = [];
const CREATED_AT = new Date('2026-08-29T00:00:00.000Z');

async function sourceFixture(
  prefix: string,
  withMedia = true,
  withAdapter = false,
  withSharedDerivedPath = false,
  sourceMigrationsDirectory = migrationsDirectory,
): Promise<{
  readonly archive: Awaited<ReturnType<DataArchive['create']>>;
  readonly paths: StoragePaths;
  readonly sqlite: Database.Database;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const sqlite = createDatabase(paths.database, sourceMigrationsDirectory).sqlite;
  databases.push(sqlite);
  if (withMedia) {
    const bytes = Buffer.from('restore media payload');
    await writeFile(join(paths.originals, 'output.bin'), bytes, { mode: 0o600 });
    await writeFile(join(paths.thumbnails, 'output.webp'), 'thumbnail', { mode: 0o600 });
    sqlite.prepare(
      `INSERT INTO assets (id, job_id, type, role, file_path, thumbnail_path, poster_path, mime_type, file_size, sha256, created_at)
       VALUES ('restore-asset', NULL, 'image', 'output', 'media/originals/output.bin', 'media/thumbnails/output.webp', NULL, 'application/octet-stream', ?, ?, ?)`,
    ).run(bytes.byteLength, createHash('sha256').update(bytes).digest('hex'), CREATED_AT.getTime());
    if (withSharedDerivedPath) {
      const secondBytes = Buffer.from('restore second media payload');
      await writeFile(join(paths.originals, 'second.bin'), secondBytes, { mode: 0o600 });
      sqlite.prepare(
        `INSERT INTO assets (id, job_id, type, role, file_path, thumbnail_path, poster_path, mime_type, file_size, sha256, created_at)
         VALUES ('restore-asset-shared', NULL, 'image', 'output', 'media/originals/second.bin', 'media/thumbnails/output.webp', NULL, 'application/octet-stream', ?, ?, ?)`,
      ).run(secondBytes.byteLength, createHash('sha256').update(secondBytes).digest('hex'), CREATED_AT.getTime());
    }
  }
  if (withAdapter) {
    const adapterId = 'trusted-fixture-v1';
    const adapterDirectory = join(paths.adapters, adapterId);
    await mkdir(adapterDirectory, { mode: 0o700 });
    await writeFile(join(adapterDirectory, 'manifest.json'), await readFile(join(adapterFixtureDirectory, 'manifest.json')), { mode: 0o600 });
    await writeFile(join(adapterDirectory, 'adapter.mjs'), await readFile(join(adapterFixtureDirectory, 'adapter.mjs')), { mode: 0o600 });
  }
  const lease = await acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: root });
  leases.push(lease);
  const archive = await new DataArchive({
    clock: { now: () => CREATED_AT },
    id: () => 'restore-source',
    lease,
    paths,
    sqlite,
  }).create();
  return { archive, paths, sqlite };
}

async function preQueueMigrations(): Promise<string> {
  const destination = await mkdtemp(join(tmpdir(), 'ims-data-restore-migrations-'));
  temporaryDirectories.push(destination);
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^000[0-6]_[a-z0-9][a-z0-9_-]*\.sql$/u.test(name));
  await Promise.all(names.map((name) => copyFile(join(migrationsDirectory, name), join(destination, name))));
  const currentManifest = JSON.parse(await readFile(join(migrationsDirectory, 'manifest.json'), 'utf8')) as {
    readonly migrations: Readonly<Record<string, string>>;
    readonly version: number;
  };
  const migrations = Object.fromEntries(
    Object.entries(currentManifest.migrations).filter(([name]) => name < '0007'),
  );
  await writeFile(
    join(destination, 'manifest.json'),
    `${JSON.stringify({ migrations, version: currentManifest.version })}\n`,
    { mode: 0o600 },
  );
  return destination;
}

function restore(options: {
  readonly bundlePath: string;
  readonly targetPath: string;
  readonly fsops?: Partial<DataArchiveFsOps>;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly stageIdFactory?: () => string;
}): DataRestore {
  const { fsops, ...rest } = options;
  return new DataRestore({ ...rest, ...(fsops === undefined ? {} : { fsops }) });
}

async function expectDirectoryMode(path: string, mode: number): Promise<void> {
  expect((await lstat(path)).mode & 0o777).toBe(mode);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
  for (const lease of leases.splice(0)) {
    try { await lease.release(); } catch { /* Fixture cleanup should continue. */ }
  }
  for (const sqlite of databases.splice(0)) {
    try { sqlite.close(); } catch { /* A failure test may have closed it. */ }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe('DataRestore', () => {
  it('restores a verified bundle into the standard data layout', async () => {
    const source = await sourceFixture('ims-data-restore-basic-');
    const target = join(source.paths.root, 'restored-data');
    const result = await restore({ bundlePath: source.archive.bundlePath, targetPath: target }).restore(
      source.archive.bundlePath,
      target,
    );

    expect(result).toMatchObject({
      bytes: source.archive.bytes,
      createdAt: CREATED_AT,
      entries: 3,
      targetPath: target,
    });
    await expectDirectoryMode(target, 0o700);
    await expectDirectoryMode(join(target, 'media'), 0o700);
    await expectDirectoryMode(join(target, 'media', 'originals'), 0o700);
    await expectDirectoryMode(join(target, 'media', 'thumbnails'), 0o700);
    await expectDirectoryMode(join(target, 'media', 'temp'), 0o700);
    await expectDirectoryMode(join(target, 'adapters', '.staging'), 0o700);
    expect(await readdir(join(target, 'backups'))).toEqual([]);
    expect(await readdir(join(target, 'logs'))).toEqual([]);
    expect(await readFile(join(target, 'media', 'originals', 'output.bin'), 'utf8')).toBe('restore media payload');
    expect((await lstat(join(target, 'app.db'))).mode & 0o777).toBe(0o600);
    const restored = createDatabase(join(target, 'app.db'), migrationsDirectory).sqlite;
    databases.push(restored);
    expect(restored.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(restored.prepare('SELECT COUNT(*) AS count FROM assets').get()).toEqual({ count: 1 });
  });

  it('validates a shared derived path once when multiple Assets reference it', async () => {
    const source = await sourceFixture('ims-data-restore-shared-path-', true, false, true);
    const target = join(source.paths.root, 'restored-shared-path');
    let thumbnailOpens = 0;
    await restore({
      bundlePath: source.archive.bundlePath,
      fsops: {
        open: async (path, flags, mode) => {
          if (path.endsWith('/media/thumbnails/output.webp')) thumbnailOpens += 1;
          return fsOpen(path, flags, mode);
        },
      },
      targetPath: target,
    }).restore(source.archive.bundlePath, target);

    // One source verification, one source copy, one staged destination copy,
    // and one cached database-reference validation.
    expect(thumbnailOpens).toBe(4);
  });

  it('starts the application against a restored pre-0007 database and applies current migrations', async () => {
    const legacyMigrations = await preQueueMigrations();
    const source = await sourceFixture('ims-data-restore-server-', true, false, false, legacyMigrations);
    const target = join(source.paths.root, 'restored-server');
    await restore({ bundlePath: source.archive.bundlePath, targetPath: target }).restore(source.archive.bundlePath, target);
    const webDistDir = join(source.paths.root, 'missing-web-dist');
    const config: AppConfig = {
      allowHttpMediaDownloads: false,
      allowInsecureProviderHttp: false,
      allowPrivateNetworkAccess: false,
      appPort: 3030,
      appPassword: null,
      appSecret: 'test-app-secret-with-at-least-32-characters',
      dataDir: target,
      logLevel: 'silent',
      maxImageUploadBytes: 32 * 1024 * 1024,
      maxRemoteImageBytes: 64 * 1024 * 1024,
      maxRemoteVideoBytes: 1024 * 1024 * 1024,
      maxVideoUploadBytes: 512 * 1024 * 1024,
      providerInputMaxBytesPerFile: 64 * 1024 * 1024,
      providerInputMaxTotalBytes: 256 * 1024 * 1024,
      mediaProcessTimeoutMs: 30_000,
      mockProviderEnabled: true,
      nodeEnvironment: 'test',
      webDistDir,
    };
    const server = await createServer({ config, logger: false, migrationsDirectory, startRunner: false });
    servers.push(server);
    await server.app.ready();
    const health = await server.app.inject({ method: 'GET', url: '/internal/health' });
    const asset = await server.app.inject({ method: 'GET', url: '/internal/assets/restore-asset' });
    expect(health.statusCode).toBe(200);
    expect(asset.statusCode).toBe(200);
    expect(asset.json()).toMatchObject({ asset: { id: 'restore-asset' } });

    const restoredDatabase = new Database(join(target, 'app.db'), { fileMustExist: true, readonly: true });
    try {
      expect(restoredDatabase.prepare(
        'SELECT version FROM schema_migrations WHERE version = ?',
      ).get('0007_pr8_media_repair_queue.sql')).toEqual({ version: '0007_pr8_media_repair_queue.sql' });
      expect(restoredDatabase.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_repair_queue'",
      ).get()).toEqual({ name: 'media_repair_queue' });
    } finally {
      restoredDatabase.close();
    }
  });

  it('restores and revalidates trusted adapter files', async () => {
    const source = await sourceFixture('ims-data-restore-adapter-', false, true);
    const target = join(source.paths.root, 'restored-adapter');
    await restore({ bundlePath: source.archive.bundlePath, targetPath: target }).restore(source.archive.bundlePath, target);
    expect(await readFile(join(target, 'adapters', 'trusted-fixture-v1', 'adapter.mjs'), 'utf8')).toContain('export const capabilities');
    expect(await readdir(join(target, 'adapters', '.staging'))).toEqual([]);
  });

  it('rejects existing, symlinked, and contained targets without changing them', async () => {
    const source = await sourceFixture('ims-data-restore-targets-', false);
    const existing = join(source.paths.root, 'existing-target');
    await mkdir(existing, { mode: 0o700 });
    await writeFile(join(existing, 'sentinel'), 'keep', { mode: 0o600 });
    await expect(restore({ bundlePath: source.archive.bundlePath, targetPath: existing }).restore(source.archive.bundlePath, existing)).rejects.toThrow(DataRestoreTargetExistsError);
    expect(await readFile(join(existing, 'sentinel'), 'utf8')).toBe('keep');

    const outside = await mkdtemp(join(tmpdir(), 'ims-data-restore-target-outside-'));
    temporaryDirectories.push(outside);
    const linked = join(source.paths.root, 'linked-target');
    await symlink(outside, linked);
    await expect(restore({ bundlePath: source.archive.bundlePath, targetPath: linked }).restore(source.archive.bundlePath, linked)).rejects.toThrow(DataRestoreTargetExistsError);
    await expect(restore({ bundlePath: source.archive.bundlePath, targetPath: join(source.archive.bundlePath, 'nested') }).restore(source.archive.bundlePath, join(source.archive.bundlePath, 'nested'))).rejects.toThrow(DataRestorePathError);
  });

  it('cleans an empty stage or target when ownership verification fails after mkdir', async () => {
    const stageFailure = await sourceFixture('ims-data-restore-stage-stat-failure-', false);
    const stageTarget = join(stageFailure.paths.root, 'stage-stat-target');
    const stagePath = join(stageFailure.paths.root, '.ims-restore-v1-stage-stat');
    let stageStatFailed = false;
    await expect(restore({
      bundlePath: stageFailure.archive.bundlePath,
      fsops: {
        open: async (path, flags, mode) => {
          const handle = await fsOpen(path, flags, mode);
          if (path === stagePath && (flags & constants.O_DIRECTORY) !== 0 && !stageStatFailed) {
            stageStatFailed = true;
            handle.stat = async () => { throw new Error('stage ownership stat failure'); };
          }
          return handle;
        },
      },
      stageIdFactory: () => 'stage-stat',
      targetPath: stageTarget,
    }).restore(stageFailure.archive.bundlePath, stageTarget)).rejects.toThrow(DataRestoreError);
    await expect(lstat(stagePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const targetFailure = await sourceFixture('ims-data-restore-target-stat-failure-', false);
    const target = join(targetFailure.paths.root, 'target-stat-target');
    let targetStatFailed = false;
    await expect(restore({
      bundlePath: targetFailure.archive.bundlePath,
      fsops: {
        lstat: async (path) => {
          const stats = await lstat(path);
          if (path === target && stats.isDirectory() && !targetStatFailed) {
            targetStatFailed = true;
            throw Object.assign(new Error('target ownership lstat failure'), { code: 'EIO' });
          }
          return stats;
        },
      },
      targetPath: target,
    }).restore(targetFailure.archive.bundlePath, target)).rejects.toThrow(DataRestoreError);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails before publishing for tampered, symlinked, hardlinked, or oversized bundles', async () => {
    const tampered = await sourceFixture('ims-data-restore-tamper-');
    await writeFile(join(tampered.archive.bundlePath, 'media', 'originals', 'output.bin'), 'tampered', { mode: 0o600 });
    const tamperedTarget = join(tampered.paths.root, 'tampered-target');
    await expect(restore({ bundlePath: tampered.archive.bundlePath, targetPath: tamperedTarget }).restore(tampered.archive.bundlePath, tamperedTarget)).rejects.toThrow(DataRestoreIntegrityError);
    await expect(lstat(tamperedTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const linked = await sourceFixture('ims-data-restore-hardlink-');
    await import('node:fs/promises').then(({ link }) => link(
      join(linked.archive.bundlePath, 'database', 'app.db'),
      join(linked.archive.bundlePath, 'database', 'alias.db'),
    ));
    const linkedTarget = join(linked.paths.root, 'linked-target');
    await expect(restore({ bundlePath: linked.archive.bundlePath, targetPath: linkedTarget }).restore(linked.archive.bundlePath, linkedTarget)).rejects.toThrow(DataRestoreError);
    await expect(lstat(linkedTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const symlinked = await sourceFixture('ims-data-restore-symlink-');
    const outside = await mkdtemp(join(tmpdir(), 'ims-data-restore-symlink-outside-'));
    temporaryDirectories.push(outside);
    await symlink(outside, join(symlinked.archive.bundlePath, 'media', 'originals', 'escape'));
    const symlinkedTarget = join(symlinked.paths.root, 'symlinked-target');
    await expect(restore({ bundlePath: symlinked.archive.bundlePath, targetPath: symlinkedTarget }).restore(symlinked.archive.bundlePath, symlinkedTarget)).rejects.toThrow(DataRestoreError);
    await expect(lstat(symlinkedTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    const bounded = await sourceFixture('ims-data-restore-bounds-');
    const boundedTarget = join(bounded.paths.root, 'bounded-target');
    await expect(restore({ bundlePath: bounded.archive.bundlePath, targetPath: boundedTarget, maxEntries: 1 }).restore(bounded.archive.bundlePath, boundedTarget)).rejects.toThrow(DataRestoreError);
    await expect(lstat(boundedTarget)).rejects.toMatchObject({ code: 'ENOENT' });
    const bytesTarget = join(bounded.paths.root, 'bytes-target');
    await expect(restore({ bundlePath: bounded.archive.bundlePath, targetPath: bytesTarget, maxBytes: bounded.archive.bytes - 1 }).restore(bounded.archive.bundlePath, bytesTarget)).rejects.toThrow(DataRestoreError);
    await expect(lstat(bytesTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves collisions and cleans stage/target on rename or fsync failure', async () => {
    const collision = await sourceFixture('ims-data-restore-collision-', false);
    const collisionStage = join(collision.paths.root, '.ims-restore-v1-fixed');
    await mkdir(collisionStage, { mode: 0o700 });
    await writeFile(join(collisionStage, 'sentinel'), 'keep', { mode: 0o600 });
    const collisionTarget = join(collision.paths.root, 'collision-target');
    await expect(restore({
      bundlePath: collision.archive.bundlePath,
      stageIdFactory: () => 'fixed',
      targetPath: collisionTarget,
    }).restore(collision.archive.bundlePath, collisionTarget)).rejects.toThrow(DataRestoreCollisionError);
    expect(await readFile(join(collisionStage, 'sentinel'), 'utf8')).toBe('keep');

    const renameFailure = await sourceFixture('ims-data-restore-rename-failure-', false);
    const renameRestore = restore({
      bundlePath: renameFailure.archive.bundlePath,
      fsops: { rename: async () => { throw new Error('rename failure'); } },
      targetPath: join(renameFailure.paths.root, 'rename-target'),
    });
    await expect(renameRestore.restore(renameFailure.archive.bundlePath, join(renameFailure.paths.root, 'rename-target'))).rejects.toThrow(DataRestoreError);
    expect((await readdir(renameFailure.paths.root)).filter((name) => name.startsWith('.ims-restore-v1-'))).toEqual([]);

    const fsyncFailure = await sourceFixture('ims-data-restore-fsync-failure-', false);
    const parent = fsyncFailure.paths.root;
    const target = join(parent, 'fsync-target');
    let parentSyncCount = 0;
    const fsyncRestore = restore({
      bundlePath: fsyncFailure.archive.bundlePath,
      fsops: {
        open: async (path, flags, mode) => {
          const handle = await fsOpen(path, flags, mode);
          if (path === parent && (flags & constants.O_DIRECTORY) !== 0) {
            parentSyncCount += 1;
            if (parentSyncCount >= 2) {
              const originalSync = handle.sync.bind(handle);
              handle.sync = async () => {
                await originalSync();
                throw new Error('parent fsync failure');
              };
            }
          }
          return handle;
        },
      },
      targetPath: target,
    });
    await expect(fsyncRestore.restore(fsyncFailure.archive.bundlePath, target)).rejects.toThrow(DataRestoreCleanupError);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(parentSyncCount).toBeGreaterThanOrEqual(3);
  });

  it('fails closed on a detected reservation replacement and preserves the replacement', async () => {
    const source = await sourceFixture('ims-data-restore-reservation-replacement-', false);
    const target = join(source.paths.root, 'reservation-target');
    let targetChecks = 0;
    let replaced = false;
    const response = restore({
      bundlePath: source.archive.bundlePath,
      fsops: {
        lstat: async (path) => {
          const stats = await lstat(path);
          if (path === target && stats.isDirectory()) {
            targetChecks += 1;
            if (targetChecks === 3) {
              await rm(path, { force: true, recursive: true });
              await mkdir(path, { mode: 0o700 });
              await writeFile(join(path, 'sentinel'), 'replacement', { mode: 0o600 });
              replaced = true;
            }
          }
          return stats;
        },
      },
      targetPath: target,
    }).restore(source.archive.bundlePath, target);
    await expect(response).rejects.toThrow(DataRestoreCollisionError);
    expect(replaced).toBe(true);
    expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('replacement');
  });

  it('cleans a published bundle after the post-rename target stat fails', async () => {
    const source = await sourceFixture('ims-data-restore-post-rename-stat-failure-', false);
    const target = join(source.paths.root, 'post-rename-target');
    let targetChecks = 0;
    let failed = false;
    await expect(restore({
      bundlePath: source.archive.bundlePath,
      fsops: {
        lstat: async (path) => {
          const stats = await lstat(path);
          if (path === target && stats.isDirectory()) {
            targetChecks += 1;
            if (targetChecks === 5 && !failed) {
              failed = true;
              throw Object.assign(new Error('post-rename lstat failure'), { code: 'EIO' });
            }
          }
          return stats;
        },
      },
      targetPath: target,
    }).restore(source.archive.bundlePath, target)).rejects.toThrow(DataRestoreError);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
