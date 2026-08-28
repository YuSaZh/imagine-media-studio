import { createHash } from 'node:crypto';
import {
  chmod,
  link as fsLink,
  lstat,
  mkdir as fsMkdir,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink as fsUnlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../database/client.js';
import { ensureStorage, getStoragePaths, type StoragePaths } from '../storage/paths.js';
import { UnsafeStoragePathError } from '../storage/path-safety.js';
import {
  BackupInProgressError,
  DatabaseBackup,
  DatabaseBackupError,
  DatabaseBackupCleanupError,
  DatabaseBackupCollisionError,
  DatabaseBackupClosedError,
  type DatabaseBackupFsOps,
} from './database-backup.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: Database.Database[] = [];
const CREATED_AT = new Date('2026-08-29T00:00:00.000Z');

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function fixture(prefix: string): Promise<{
  readonly paths: StoragePaths;
  readonly sqlite: Database.Database;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const sqlite = createDatabase(paths.database, migrationsDirectory).sqlite;
  databases.push(sqlite);
  return { paths, sqlite };
}

function backup(options: {
  readonly paths: StoragePaths;
  readonly sqlite: Database.Database;
  readonly id?: string;
  readonly fsops?: Partial<DatabaseBackupFsOps>;
}): DatabaseBackup {
  return new DatabaseBackup({
    clock: { now: () => CREATED_AT },
    id: () => options.id ?? 'backup-test',
    paths: options.paths,
    sqlite: options.sqlite,
    ...(options.fsops === undefined ? {} : { fsops: options.fsops }),
  });
}

function realFsops(): DatabaseBackupFsOps {
  return {
    link: fsLink,
    lstat,
    mkdir: fsMkdir,
    open: fsOpen,
    realpath,
    unlink: fsUnlink,
  };
}

async function closeDatabases(): Promise<void> {
  for (const sqlite of databases.splice(0)) {
    try {
      sqlite.close();
    } catch {
      // A test may intentionally close the live connection.
    }
  }
}

afterEach(async () => {
  await closeDatabases();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
});

describe('DatabaseBackup', () => {
  it('captures the latest committed WAL writes before backup starts and validates the snapshot', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-wal-');
    sqlite.pragma('wal_autocheckpoint = 1000000');
    sqlite.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('before', '{\"value\":\"before\"}', 1)",
    ).run();

    const started = deferred<void>();
    const release = deferred<void>();
    const realBackup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, 'backup').mockImplementation(async (destination, options) => {
      started.resolve();
      await release.promise;
      return realBackup(destination, options);
    });

    const pending = backup({ id: 'wal-snapshot', paths, sqlite }).create();
    await started.promise;
    sqlite.prepare(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('during', '{\"value\":\"during\"}', 2)",
    ).run();
    release.resolve();
    const result = await pending;

    expect(Object.keys(result).sort()).toEqual(['createdAt', 'id', 'sha256', 'size']);
    expect(result).toEqual({
      createdAt: CREATED_AT,
      id: 'wal-snapshot',
      sha256: expect.any(String),
      size: expect.any(Number),
    });
    const backupPath = join(paths.backups, 'wal-snapshot.db');
    const backupStats = await lstat(backupPath);
    expect(backupStats.isFile()).toBe(true);
    expect(backupStats.mode & 0o777).toBe(0o600);
    const bytes = await readFile(backupPath);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readdir(paths.backups)).toEqual(['.staging', 'wal-snapshot.db']);
    expect(await readdir(join(paths.backups, '.staging'))).toEqual([]);

    const snapshot = new Database(backupPath, { fileMustExist: true, readonly: true });
    try {
      snapshot.pragma('foreign_keys = ON');
      expect(snapshot.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(snapshot.prepare('SELECT key, value_json FROM settings ORDER BY key').all()).toEqual([
        { key: 'before', value_json: '{"value":"before"}' },
        { key: 'during', value_json: '{"value":"during"}' },
      ]);
      expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      snapshot.close();
    }
  });

  it('does not overwrite a final backup or a pre-existing staging collision', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-collision-');
    const opened: string[] = [];
    const fsops = realFsops();
    const originalOpen = fsops.open;
    fsops.open = async (path, flags, mode) => {
      opened.push(path);
      return originalOpen(path, flags, mode);
    };
    const service = backup({ id: 'collision', paths, sqlite, fsops });
    const first = await service.create();
    const finalPath = join(paths.backups, 'collision.db');
    const original = await readFile(finalPath);
    expect(opened).not.toContain(finalPath);

    await expect(service.create()).rejects.toBeInstanceOf(DatabaseBackupCollisionError);
    expect(await readFile(finalPath)).toEqual(original);
    expect(first.id).toBe('collision');

  });

  it('maps an atomic link collision without overwriting a concurrently created final file', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-link-collision-');
    const finalPath = join(paths.backups, 'link-collision.db');
    const fsops = realFsops();
    fsops.link = async (_source, destination) => {
      await writeFile(destination, 'concurrent final', { flag: 'wx' });
      const error = new Error('destination exists') as Error & { code?: string };
      error.code = 'EEXIST';
      throw error;
    };

    await expect(backup({ id: 'link-collision', paths, sqlite, fsops }).create())
      .rejects.toBeInstanceOf(DatabaseBackupCollisionError);
    expect(await readFile(finalPath, 'utf8')).toBe('concurrent final');
    expect(await readdir(join(paths.backups, '.staging'))).toEqual([]);
  });

  it('fsyncs the staging directory before and after publication and then fsyncs backups', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-directory-syncs-');
    const fsops = realFsops();
    const originalOpen = fsops.open;
    const syncCounts = new Map<string, number>();
    fsops.open = async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      const originalSync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        const key = resolve(path);
        syncCounts.set(key, (syncCounts.get(key) ?? 0) + 1);
        await originalSync();
      });
      return handle;
    };

    await backup({ id: 'directory-syncs', paths, sqlite, fsops }).create();

    expect(syncCounts.get(resolve(join(paths.backups, '.staging')))).toBe(2);
    expect(syncCounts.get(resolve(paths.backups))).toBe(1);
  });

  it.each([
    ['backup', async (staging: string) => {
      await writeFile(staging, 'partial backup');
      throw new Error('backup failed');
    }],
    ['integrity', async (staging: string) => {
      await writeFile(staging, 'not a sqlite database');
    }],
  ])('cleans staging after %s failure', async (_label, backupOperation) => {
    const { paths, sqlite: liveSqlite } = await fixture('imagine-database-backup-operation-failure-');
    const sqlite = { backup: backupOperation } as unknown as Database.Database;
    const service = backup({ id: 'operation-failure', paths, sqlite });
    await expect(service.create()).rejects.toThrow();
    expect(await readdir(paths.backups)).toEqual(['.staging']);
    expect(await readdir(join(paths.backups, '.staging'))).toEqual([]);
    liveSqlite.close();
  });

  it('cleans staging when chmod fails', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-file-failure-');
    const fsops = realFsops();
    fsops.open = async (path, flags, mode) => {
      const handle = await fsOpen(path, flags, mode);
      if (path.endsWith('.part')) {
        vi.spyOn(handle, 'chmod').mockRejectedValue(new Error('chmod failed'));
      }
      return handle;
    };
    await expect(backup({ id: 'chmod-failure', paths, sqlite, fsops }).create()).rejects.toThrow(DatabaseBackupError);
    expect(await readdir(paths.backups)).toEqual(['.staging']);
    expect(await readdir(join(paths.backups, '.staging'))).toEqual([]);
  });

  it('cleans staging when file sync, publication, or parent sync fails', async () => {
    const cases: readonly {
      readonly id: string;
      readonly configure: (paths: StoragePaths, fsops: DatabaseBackupFsOps) => void;
    }[] = [
      {
        id: 'sync-failure',
        configure: (paths: StoragePaths, fsops: DatabaseBackupFsOps) => {
          const originalOpen = fsops.open;
          fsops.open = async (path, flags, mode) => {
            const handle = await originalOpen(path, flags, mode);
            if (path.endsWith('.part')) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('file sync failed'));
            return handle;
          };
          void paths;
        },
      },
      {
        id: 'staging-directory-sync-failure',
        configure: (paths: StoragePaths, fsops: DatabaseBackupFsOps) => {
          const originalOpen = fsops.open;
          fsops.open = async (path, flags, mode) => {
            const handle = await originalOpen(path, flags, mode);
            if (resolve(path) === resolve(join(paths.backups, '.staging'))) {
              vi.spyOn(handle, 'sync').mockRejectedValue(new Error('staging directory sync failed'));
            }
            return handle;
          };
        },
      },
      {
        id: 'link-failure',
        configure: (_paths: StoragePaths, fsops: DatabaseBackupFsOps) => {
          fsops.link = async () => { throw new Error('publication failed'); };
        },
      },
      {
        id: 'directory-sync-failure',
        configure: (paths: StoragePaths, fsops: DatabaseBackupFsOps) => {
          const originalOpen = fsops.open;
          fsops.open = async (path, flags, mode) => {
            const handle = await originalOpen(path, flags, mode);
            if (resolve(path) === resolve(paths.backups)) {
              vi.spyOn(handle, 'sync').mockRejectedValue(new Error('directory sync failed'));
            }
            return handle;
          };
        },
      },
      {
        id: 'staging-post-sync-failure',
        configure: (paths: StoragePaths, fsops: DatabaseBackupFsOps) => {
          const originalOpen = fsops.open;
          let syncCount = 0;
          fsops.open = async (path, flags, mode) => {
            const handle = await originalOpen(path, flags, mode);
            if (resolve(path) === resolve(join(paths.backups, '.staging'))) {
              const originalSync = handle.sync.bind(handle);
              vi.spyOn(handle, 'sync').mockImplementation(async () => {
                syncCount += 1;
                if (syncCount === 2) throw new Error('staging post-publication sync failed');
                await originalSync();
              });
            }
            return handle;
          };
        },
      },
    ];

    for (const testCase of cases) {
      const { paths, sqlite } = await fixture(`imagine-database-backup-${testCase.id}-`);
      const fsops = realFsops();
      testCase.configure(paths, fsops);
      await expect(backup({ id: testCase.id, paths, sqlite, fsops }).create()).rejects.toThrow();
      expect(await readdir(paths.backups)).toEqual(['.staging']);
      expect(await readdir(join(paths.backups, '.staging'))).toEqual([]);
      sqlite.close();
    }
  });

  it('surfaces cleanup failure instead of claiming a clean rollback', async () => {
    const { paths, sqlite: liveSqlite } = await fixture('imagine-database-backup-cleanup-failure-');
    const sqlite = {
      backup: async (staging: string) => {
        await writeFile(staging, 'partial backup');
        throw new Error('backup failed');
      },
    } as unknown as Database.Database;
    const fsops = realFsops();
    fsops.unlink = async () => { throw new Error('unlink failed'); };

    await expect(backup({ id: 'cleanup-failure', paths, sqlite, fsops }).create())
      .rejects.toBeInstanceOf(DatabaseBackupCleanupError);
    liveSqlite.close();
  });

  it('rejects symlink roots, backup directories, staging files, and unsafe directory modes', async () => {
    const rootFixture = await fixture('imagine-database-backup-root-link-');
    const rootLink = `${rootFixture.paths.root}-link`;
    await symlink(rootFixture.paths.root, rootLink);
    temporaryDirectories.push(rootLink);
    const rootLinkPaths = getStoragePaths(rootLink);
    await expect(backup({ id: 'root-link', paths: rootLinkPaths, sqlite: rootFixture.sqlite }).create())
      .rejects.toBeInstanceOf(UnsafeStoragePathError);

    const backupsFixture = await fixture('imagine-database-backup-backups-link-');
    const outside = join(backupsFixture.paths.root, 'outside');
    await mkdir(outside);
    await rm(backupsFixture.paths.backups, { recursive: true, force: true });
    await symlink(outside, backupsFixture.paths.backups);
    await expect(backup({ id: 'backups-link', paths: backupsFixture.paths, sqlite: backupsFixture.sqlite }).create())
      .rejects.toBeInstanceOf(UnsafeStoragePathError);

    const stagingFixture = await fixture('imagine-database-backup-staging-link-');
    const stagingPath = join(stagingFixture.paths.backups, '.staging');
    await rm(stagingPath, { recursive: true, force: true });
    await symlink(stagingFixture.paths.database, stagingPath);
    await expect(backup({ id: 'staging-link', paths: stagingFixture.paths, sqlite: stagingFixture.sqlite }).create())
      .rejects.toBeInstanceOf(UnsafeStoragePathError);
    expect((await lstat(stagingPath)).isSymbolicLink()).toBe(true);

    const modeFixture = await fixture('imagine-database-backup-mode-');
    await chmod(modeFixture.paths.backups, 0o750);
    await expect(backup({ id: 'mode', paths: modeFixture.paths, sqlite: modeFixture.sqlite }).create())
      .rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it('rejects concurrent backups, rejects new work after close, and waits for the active backup', async () => {
    const { paths, sqlite } = await fixture('imagine-database-backup-concurrency-');
    const started = deferred<void>();
    const release = deferred<void>();
    const realBackup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, 'backup').mockImplementation(async (destination, options) => {
      started.resolve();
      await release.promise;
      return realBackup(destination, options);
    });
    const service = backup({ id: 'concurrency', paths, sqlite });
    const active = service.create();
    await started.promise;
    await expect(service.create()).rejects.toBeInstanceOf(BackupInProgressError);

    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    expect(closed).toBe(false);
    await expect(service.create()).rejects.toBeInstanceOf(DatabaseBackupClosedError);
    release.resolve();
    await active;
    await closing;
    expect(closed).toBe(true);
    await expect(service.create()).rejects.toBeInstanceOf(DatabaseBackupClosedError);
  });
});
