import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { digestAdapterSource } from '../adapters/store.js';
import { parseBoundedManifestJson } from '../adapters/manifest.js';
import { createDatabase } from '../database/client.js';
import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import type { StoragePaths } from '../storage/paths.js';
import {
  DataArchive,
  DataArchiveCleanupError,
  DataArchiveCollisionError,
  DataArchiveError,
  DataArchiveInProgressError,
  DataArchiveIntegrityError,
  DataArchivePathError,
  verifyDataArchive,
} from './data-archive.js';
import type { DataArchiveOptions } from './data-archive.js';
import { acquireOfflineMaintenanceLease, type OfflineMaintenanceLease } from './runtime-lock.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const adapterFixtureDirectory = fileURLToPath(new URL('../../../../fixtures/adapters/trusted-fixture-v1', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const activeLeases = new Map<string, OfflineMaintenanceLease>();
const leases: OfflineMaintenanceLease[] = [];
const CREATED_AT = new Date('2026-08-29T00:00:00.000Z');

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function fixture(prefix: string): Promise<{ readonly paths: StoragePaths; readonly sqlite: Database.Database }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const offlineLease = await acquireOfflineMaintenanceLease({
    assertServerStopped: () => true,
    dataRoot: root,
  });
  activeLeases.set(root, offlineLease);
  leases.push(offlineLease);
  const sqlite = createDatabase(paths.database, migrationsDirectory).sqlite;
  databases.push(sqlite);
  return { paths, sqlite };
}

function service(paths: StoragePaths, sqlite: Database.Database, overrides: Partial<DataArchiveOptions> = {}): DataArchive {
  const currentLease = activeLeases.get(paths.root);
  return new DataArchive({
    clock: { now: () => CREATED_AT },
    id: () => 'archive-test',
    paths,
    sqlite,
    ...(currentLease === undefined ? {} : { lease: currentLease }),
    ...overrides,
  });
}

afterEach(async () => {
  for (const sqlite of databases.splice(0)) {
    try { sqlite.close(); } catch { /* A failure test may close it. */ }
  }
  for (const offlineLease of leases.splice(0)) {
    try { await offlineLease.release(); } catch { /* Keep fixture cleanup progressing. */ }
    activeLeases.delete(offlineLease.dataRoot);
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe('DataArchive', () => {
  it('fails closed without an offline maintenance lease', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-lease-');
    const archive = new DataArchive({ paths, sqlite });
    await expect(archive.create()).rejects.toThrow('verifiable offline maintenance lease');
    await expect(readdir(join(paths.backups, '.staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates and verifies a deterministic directory bundle with allowlisted media', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-basic-');
    const payload = Buffer.from('archive-media-payload');
    await writeFile(join(paths.uploads, 'upload-1.bin'), payload, { mode: 0o600 });
    await writeFile(join(paths.temporary, 'provider-result.json'), 'transient', { mode: 0o600 });
    await writeFile(join(paths.logs, 'server.log'), 'operational', { mode: 0o600 });
    const archive = service(paths, sqlite);

    const result = await archive.create();
    expect(result).toMatchObject({
      bytes: expect.any(Number),
      bundlePath: join(paths.backups, 'archive-test.bundle'),
      createdAt: CREATED_AT,
      entries: 2,
      id: 'archive-test',
    });
    const verified = await verifyDataArchive(result.bundlePath);
    expect(verified).toMatchObject({ bytes: result.bytes, createdAt: CREATED_AT, entries: 2 });
    const manifest = JSON.parse(await readFile(join(result.bundlePath, 'manifest.json'), 'utf8')) as {
      entries: readonly { path: string; sha256: string; size: number }[];
      excluded: readonly string[];
    };
    expect(manifest.entries.map((entry) => entry.path)).toEqual(['database/app.db', 'media/uploads/upload-1.bin']);
    expect(manifest.excluded).toContain('.offline-maintenance.lock');
    expect(await readFile(join(result.bundlePath, 'media/uploads/upload-1.bin'))).toEqual(payload);
    expect(await lstat(join(result.bundlePath, 'database/app.db'))).toMatchObject({ mode: expect.any(Number) });
    expect((await lstat(join(result.bundlePath, 'database/app.db'))).mode & 0o777).toBe(0o600);
    expect((await lstat(result.bundlePath)).mode & 0o777).toBe(0o700);
    await expect(lstat(join(result.bundlePath, 'media/temp/provider-result.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(result.bundlePath, 'logs/server.log'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves the database-to-media consistency contract', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-media-consistency-');
    const payload = Buffer.from('database referenced media');
    const storedPath = 'media/uploads/referenced.bin';
    await writeFile(join(paths.root, storedPath), payload, { mode: 0o600 });
    sqlite.prepare(
      `INSERT INTO assets (id, job_id, type, role, file_path, mime_type, file_size, sha256, created_at)
       VALUES (?, NULL, 'image', 'upload', ?, 'application/octet-stream', ?, ?, ?)`,
    ).run(
      'asset-archive-consistency',
      storedPath,
      payload.byteLength,
      createHash('sha256').update(payload).digest('hex'),
      CREATED_AT.getTime(),
    );
    const result = await service(paths, sqlite, { id: () => 'consistency' }).create();
    expect((await verifyDataArchive(result.bundlePath)).entries).toBe(2);
  });

  it('maps output, mask, and input roles to their required media roots', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-role-roots-');
    const files = [
      {
        id: 'output',
        path: 'media/originals/output.bin',
        role: 'output',
        bytes: Buffer.from('output'),
        poster: 'media/posters/output-poster.bin',
        thumbnail: 'media/thumbnails/output-thumb.bin',
      },
      { id: 'mask', path: 'media/masks/mask.bin', role: 'mask', bytes: Buffer.from('mask'), poster: null, thumbnail: null },
      { id: 'input', path: 'media/uploads/input.bin', role: 'reference', bytes: Buffer.from('input'), poster: null, thumbnail: null },
    ] as const;
    for (const file of files) {
      await writeFile(join(paths.root, file.path), file.bytes, { mode: 0o600 });
      if (file.poster !== null) await writeFile(join(paths.root, file.poster), 'poster', { mode: 0o600 });
      if (file.thumbnail !== null) await writeFile(join(paths.root, file.thumbnail), 'thumbnail', { mode: 0o600 });
      sqlite.prepare(
        `INSERT INTO assets (id, job_id, type, role, file_path, thumbnail_path, poster_path, mime_type, file_size, sha256, created_at)
         VALUES (?, NULL, 'image', ?, ?, ?, ?, 'application/octet-stream', ?, ?, ?)`,
      ).run(
        `asset-${file.id}`,
        file.role,
        file.path,
        file.thumbnail,
        file.poster,
        file.bytes.byteLength,
        createHash('sha256').update(file.bytes).digest('hex'),
        CREATED_AT.getTime(),
      );
    }
    const result = await service(paths, sqlite, { id: () => 'role-roots' }).create();
    expect((await verifyDataArchive(result.bundlePath)).entries).toBe(6);
  });

  it('rejects database and adapter paths in asset content fields', async () => {
    const databasePathFixture = await fixture('ims-data-archive-database-path-');
    databasePathFixture.sqlite.prepare(
      `INSERT INTO assets (id, job_id, type, role, file_path, mime_type, file_size, sha256, created_at)
       VALUES ('database-path', NULL, 'image', 'upload', 'database/app.db', 'application/octet-stream', 1, ?, ?)`,
    ).run('0'.repeat(64), CREATED_AT.getTime());
    await expect(service(databasePathFixture.paths, databasePathFixture.sqlite).create()).rejects.toThrow(DataArchiveIntegrityError);

    const adapterPathFixture = await fixture('ims-data-archive-adapter-path-');
    adapterPathFixture.sqlite.prepare(
      `INSERT INTO assets (id, job_id, type, role, file_path, mime_type, file_size, sha256, created_at)
       VALUES ('adapter-path', NULL, 'image', 'upload', 'adapters/fake/adapter.mjs', 'application/octet-stream', 1, ?, ?)`,
    ).run('0'.repeat(64), CREATED_AT.getTime());
    await expect(service(adapterPathFixture.paths, adapterPathFixture.sqlite).create()).rejects.toThrow(DataArchiveIntegrityError);
  });

  it('rejects thumbnail and poster paths outside their derived media roots', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-derived-path-');
    const content = Buffer.from('content');
    await writeFile(join(paths.originals, 'output.bin'), content, { mode: 0o600 });
    await writeFile(join(paths.uploads, 'wrong-thumb.bin'), content, { mode: 0o600 });
    sqlite.prepare(
      `INSERT INTO assets (id, job_id, type, role, file_path, thumbnail_path, poster_path, mime_type, file_size, sha256, created_at)
       VALUES ('derived-path', NULL, 'image', 'output', 'media/originals/output.bin', 'media/uploads/wrong-thumb.bin', NULL, 'application/octet-stream', ?, ?, ?)`,
    ).run(content.byteLength, createHash('sha256').update(content).digest('hex'), CREATED_AT.getTime());
    await expect(service(paths, sqlite).create()).rejects.toThrow(DataArchiveIntegrityError);
  });

  it('enforces the entry budget cumulatively across all media trees', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-global-budget-');
    await writeFile(join(paths.originals, 'original.bin'), 'original', { mode: 0o600 });
    await writeFile(join(paths.thumbnails, 'thumbnail.bin'), 'thumbnail', { mode: 0o600 });
    const archive = service(paths, sqlite, { maxEntries: 2 });
    await expect(archive.create()).rejects.toThrow(DataArchiveError);
    expect((await readdir(paths.backups)).filter((name) => name !== '.staging')).toEqual([]);
  });

  it('archives trusted adapters only after reusing manifest, source, export, and digest checks', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-adapter-');
    const adapterId = 'trusted-fixture-v1';
    const directory = join(paths.adapters, adapterId);
    await mkdir(directory, { mode: 0o700 });
    const source = await readFile(join(adapterFixtureDirectory, 'adapter.mjs'));
    const manifest = await readFile(join(adapterFixtureDirectory, 'manifest.json'));
    expect(digestAdapterSource(source)).toBe(parseBoundedManifestJson(manifest).sha256);
    await writeFile(join(directory, 'manifest.json'), manifest, { mode: 0o600 });
    await writeFile(join(directory, 'adapter.mjs'), source, { mode: 0o600 });

    const result = await service(paths, sqlite, { id: () => 'adapter-archive' }).create();
    const verified = await verifyDataArchive(result.bundlePath);
    expect(verified.entries).toBe(3);
    expect(await readFile(join(result.bundlePath, 'adapters', adapterId, 'adapter.mjs'))).toEqual(source);
  });

  it('rejects symlinks and hardlink aliases before publishing', async () => {
    const symlinkFixture = await fixture('ims-data-archive-symlink-');
    const outside = await mkdtemp(join(tmpdir(), 'ims-data-archive-outside-'));
    temporaryDirectories.push(outside);
    await symlink(outside, join(symlinkFixture.paths.uploads, 'escape'));
    await expect(service(symlinkFixture.paths, symlinkFixture.sqlite).create()).rejects.toThrow(DataArchivePathError);
    await expect(lstat(join(symlinkFixture.paths.backups, 'archive-test.bundle'))).rejects.toMatchObject({ code: 'ENOENT' });

    const hardlinkFixture = await fixture('ims-data-archive-hardlink-');
    const source = join(hardlinkFixture.paths.uploads, 'source.bin');
    await writeFile(source, 'hardlink', { mode: 0o600 });
    await import('node:fs/promises').then(({ link }) => link(source, join(hardlinkFixture.paths.uploads, 'alias.bin')));
    await expect(service(hardlinkFixture.paths, hardlinkFixture.sqlite).create()).rejects.toThrow(DataArchivePathError);
  });

  it('preserves an existing collision and cleans a failed staged backup', async () => {
    const collision = await fixture('ims-data-archive-collision-');
    const existing = join(collision.paths.backups, 'archive-test.bundle');
    await mkdir(existing, { mode: 0o700 });
    await writeFile(join(existing, 'sentinel'), 'keep', { mode: 0o600 });
    await expect(service(collision.paths, collision.sqlite).create()).rejects.toThrow(DataArchiveCollisionError);
    expect(await readFile(join(existing, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readdir(join(collision.paths.backups, '.staging'))).toEqual([]);

    const failed = await fixture('ims-data-archive-failure-');
    vi.spyOn(failed.sqlite, 'backup').mockRejectedValue(new Error('sqlite secret detail'));
    await expect(service(failed.paths, failed.sqlite).create()).rejects.toThrow(DataArchiveError);
    expect((await readdir(failed.paths.backups)).filter((name) => name !== '.staging')).toEqual([]);
    expect(await readdir(join(failed.paths.backups, '.staging'))).toEqual([]);
  });

  it('rejects tampered payloads and supports collision-safe close/concurrency', async () => {
    const basic = await fixture('ims-data-archive-tamper-');
    await writeFile(join(basic.paths.uploads, 'file.bin'), 'before', { mode: 0o600 });
    const result = await service(basic.paths, basic.sqlite, { id: () => 'tamper' }).create();
    await writeFile(join(result.bundlePath, 'media/uploads/file.bin'), 'after', { mode: 0o600 });
    await expect(verifyDataArchive(result.bundlePath)).rejects.toThrow(DataArchiveIntegrityError);

    const concurrent = await fixture('ims-data-archive-concurrent-');
    const started = deferred<void>();
    const release = deferred<void>();
    const realBackup = concurrent.sqlite.backup.bind(concurrent.sqlite);
    vi.spyOn(concurrent.sqlite, 'backup').mockImplementation(async (destination, options) => {
      started.resolve();
      await release.promise;
      return realBackup(destination, options);
    });
    const archive = service(concurrent.paths, concurrent.sqlite, { id: () => 'concurrent' });
    const pending = archive.create();
    await started.promise;
    await expect(archive.create()).rejects.toThrow(DataArchiveInProgressError);
    const closing = archive.close();
    release.resolve();
    await closing;
    await pending;
    await expect(archive.create()).rejects.toThrow('closed');
  });

  it('reports a cleanup error if staged artifacts cannot be removed', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-cleanup-');
    const remove = vi.fn(async () => { throw new Error('cleanup failure'); });
    vi.spyOn(sqlite, 'backup').mockRejectedValue(new Error('backup failure'));
    const archive = service(paths, sqlite, {
      fsops: { rm: remove },
    });
    await expect(archive.create()).rejects.toThrow(DataArchiveCleanupError);
  });

  it('cleans the staged directory when rename or final directory fsync fails', async () => {
    const renameFixture = await fixture('ims-data-archive-rename-');
    const renameArchive = service(renameFixture.paths, renameFixture.sqlite, {
      fsops: { rename: async () => { throw new Error('rename failure'); } },
    });
    await expect(renameArchive.create()).rejects.toThrow(DataArchiveError);
    expect(await readdir(join(renameFixture.paths.backups, '.staging'))).toEqual([]);
    expect((await readdir(renameFixture.paths.backups)).filter((name) => name !== '.staging')).toEqual([]);

    const fsyncFixture = await fixture('ims-data-archive-fsync-');
    let failBackupDirectorySync = true;
    const fsyncArchive = service(fsyncFixture.paths, fsyncFixture.sqlite, {
      fsops: {
        open: async (path, flags, mode) => {
          const handle = await import('node:fs/promises').then(({ open }) => open(path, flags, mode));
          if (path === fsyncFixture.paths.backups && (flags & constants.O_DIRECTORY) !== 0 && failBackupDirectorySync) {
            const originalSync = handle.sync.bind(handle);
            handle.sync = async () => {
              failBackupDirectorySync = false;
              await originalSync();
              throw new Error('directory fsync failure');
            };
          }
          return handle;
        },
      },
    });
    await expect(fsyncArchive.create()).rejects.toThrow(DataArchiveError);
    expect((await readdir(fsyncFixture.paths.backups)).filter((name) => name !== '.staging')).toEqual([]);
  });

  it('rejects a final reservation that is changed or populated before rename', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-reservation-');
    let reservationPath: string | undefined;
    let reservationChecked = false;
    const realLstat = lstat;
    const realMkdir = mkdir;
    const reservationArchive = service(paths, sqlite, {
      fsops: {
        mkdir: async (path, options) => {
          const result = await realMkdir(path, options);
          if (path.endsWith('reservation.bundle')) reservationPath = path;
          return result;
        },
        lstat: async (path) => {
          const stats = await realLstat(path);
          if (path === reservationPath && !reservationChecked) {
            reservationChecked = true;
            await writeFile(join(path, 'unexpected'), 'race', { mode: 0o600 });
          }
          return stats;
        },
      },
      id: () => 'reservation',
    });
    await expect(reservationArchive.create()).rejects.toThrow(DataArchiveCollisionError);
    expect(await readFile(join(paths.backups, 'reservation.bundle', 'unexpected'), 'utf8')).toBe('race');
  });

  it('keeps a replaced reservation and removes only an empty reservation after lstat failure', async () => {
    const replaced = await fixture('ims-data-archive-reservation-replaced-');
    let reservationPath: string | undefined;
    let replacedOnce = false;
    const replacementPath = join(replaced.paths.backups, 'reservation-replacement');
    const replacedArchive = service(replaced.paths, replaced.sqlite, {
      fsops: {
        mkdir: async (path, options) => {
          const result = await mkdir(path, options);
          if (path.endsWith('replaced.bundle')) reservationPath = path;
          return result;
        },
        lstat: async (path) => {
          if (path === reservationPath && !replacedOnce) {
            replacedOnce = true;
            await rename(path, replacementPath);
            await mkdir(path, { mode: 0o700 });
          }
          return lstat(path);
        },
      },
      id: () => 'replaced',
    });
    await expect(replacedArchive.create()).rejects.toThrow(DataArchiveCollisionError);
    expect((await readdir(replaced.paths.backups)).filter((name) => name !== '.staging').sort()).toEqual([
      'replaced.bundle',
      'reservation-replacement',
    ]);

    const lstatFailure = await fixture('ims-data-archive-reservation-lstat-');
    let reservation: string | undefined;
    let failOnce = true;
    const lstatFailureArchive = service(lstatFailure.paths, lstatFailure.sqlite, {
      fsops: {
        mkdir: async (path, options) => {
          const result = await mkdir(path, options);
          if (path.endsWith('lstat.bundle')) reservation = path;
          return result;
        },
        lstat: async (path) => {
          if (path === reservation && failOnce) {
            failOnce = false;
            const error = new Error('reservation lstat failure');
            Object.assign(error, { code: 'EIO' });
            throw error;
          }
          return lstat(path);
        },
      },
      id: () => 'lstat',
    });
    await expect(lstatFailureArchive.create()).rejects.toThrow(DataArchiveError);
    expect((await readdir(lstatFailure.paths.backups)).filter((name) => name !== '.staging')).toEqual([]);
  });

  it('uses the staging inode to clean a published bundle when post-rename lstat fails', async () => {
    const { paths, sqlite } = await fixture('ims-data-archive-post-rename-lstat-');
    let finalLstatCount = 0;
    const finalPath = join(paths.backups, 'post-rename.bundle');
    const archive = service(paths, sqlite, {
      fsops: {
        lstat: async (path) => {
          if (path === finalPath) {
            const result = await lstat(path);
            finalLstatCount += 1;
            if (finalLstatCount === 3) {
              const error = new Error('post-rename lstat failure');
              Object.assign(error, { code: 'EIO' });
              throw error;
            }
            return result;
          }
          return lstat(path);
        },
      },
      id: () => 'post-rename',
    });
    await expect(archive.create()).rejects.toThrow(DataArchiveError);
    expect((await readdir(paths.backups)).filter((name) => name !== '.staging')).toEqual([]);
    expect(finalLstatCount).toBeGreaterThanOrEqual(4);
  });

  it('detects source and destination parent replacement around file opens', async () => {
    const sourceFixture = await fixture('ims-data-archive-source-parent-');
    const sourcePath = join(sourceFixture.paths.uploads, 'source-parent.bin');
    await writeFile(sourcePath, 'source', { mode: 0o600 });
    let sourceReplaced = false;
    const sourceArchive = service(sourceFixture.paths, sourceFixture.sqlite, {
      fsops: {
        open: async (path, flags, mode) => {
          if (path === sourcePath && !sourceReplaced) {
            sourceReplaced = true;
            const moved = join(sourceFixture.paths.root, 'uploads-replaced');
            await rename(sourceFixture.paths.uploads, moved);
            await mkdir(sourceFixture.paths.uploads, { mode: 0o700 });
            await writeFile(join(sourceFixture.paths.uploads, 'source-parent.bin'), 'attacker', { mode: 0o600 });
          }
          return fsOpen(path, flags, mode);
        },
      },
      id: () => 'source-parent',
    });
    await expect(sourceArchive.create()).rejects.toThrow(DataArchivePathError);

    const destinationFixture = await fixture('ims-data-archive-destination-parent-');
    const destinationSource = join(destinationFixture.paths.uploads, 'destination-parent.bin');
    await writeFile(destinationSource, 'destination', { mode: 0o600 });
    let destinationReplaced = false;
    const destinationArchive = service(destinationFixture.paths, destinationFixture.sqlite, {
      fsops: {
        open: async (path, flags, mode) => {
          if (path.includes('/.staging/') && path.endsWith('/media/uploads/destination-parent.bin') && !destinationReplaced) {
            destinationReplaced = true;
            const parent = dirname(path);
            await rename(parent, `${parent}-replaced`);
            await mkdir(parent, { mode: 0o700 });
          }
          return fsOpen(path, flags, mode);
        },
      },
      id: () => 'destination-parent',
    });
    await expect(destinationArchive.create()).rejects.toThrow(DataArchivePathError);
  });
});
