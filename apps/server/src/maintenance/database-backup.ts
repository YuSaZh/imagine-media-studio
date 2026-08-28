import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  link as fsLink,
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
  realpath as fsRealpath,
  unlink as fsUnlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

import { checkSqliteIntegrity } from '../database/integrity.js';
import { UnsafeStoragePathError } from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';

const BACKUP_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const HASH_CHUNK_BYTES = 64 * 1024;
const BACKUP_EXTENSION = '.db';
const STAGING_DIRECTORY = '.staging';
const STAGING_PREFIX = '.ims-backup-';
const STAGING_SUFFIX = '.part';

export interface DatabaseBackupResult {
  /** Identifier used by the database-only backup filename. */
  readonly id: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: Date;
}

export interface DatabaseBackupClock {
  now(): Date;
}

export interface DatabaseBackupFsOps {
  lstat(path: string): Promise<Stats>;
  link(source: string, destination: string): Promise<void>;
  mkdir(path: string, options?: { readonly mode?: number; readonly recursive?: boolean }): Promise<string | undefined>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

export interface DatabaseBackupOptions {
  readonly clock?: DatabaseBackupClock;
  readonly fsops?: Partial<DatabaseBackupFsOps>;
  readonly id?: () => string;
  readonly idFactory?: () => string;
  readonly paths: StoragePaths;
  readonly sqlite: Database.Database;
}

export class DatabaseBackupError extends Error {
  public override readonly name: string = 'DatabaseBackupError';
}

export class BackupInProgressError extends DatabaseBackupError {
  public override readonly name: string = 'BackupInProgressError';
}

export class DatabaseBackupClosedError extends DatabaseBackupError {
  public override readonly name: string = 'DatabaseBackupClosedError';
}

export class DatabaseBackupCollisionError extends DatabaseBackupError {
  public override readonly name: string = 'DatabaseBackupCollisionError';
}

export class DatabaseBackupIntegrityError extends DatabaseBackupError {
  public override readonly name: string = 'DatabaseBackupIntegrityError';
}

export class DatabaseBackupCleanupError extends DatabaseBackupError {
  public override readonly name: string = 'DatabaseBackupCleanupError';
}

const systemClock: DatabaseBackupClock = { now: () => new Date() };

const defaultFsOps: DatabaseBackupFsOps = {
  link: fsLink,
  lstat: fsLstat,
  mkdir: fsMkdir,
  open: fsOpen,
  realpath: fsRealpath,
  unlink: fsUnlink,
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function assertContained(root: string, candidate: string): void {
  const relationship = relative(root, candidate);
  if (
    relationship === '' ||
    relationship === '..' ||
    relationship.startsWith(`..${sep}`) ||
    isAbsolute(relationship)
  ) {
    throw new UnsafeStoragePathError('Database backup path escapes the data directory.');
  }
}

async function assertSafePath(
  fsops: DatabaseBackupFsOps,
  rootPath: string,
  candidatePath: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  assertContained(root, candidate);

  const rootEntry = await fsops.lstat(root);
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    (rootEntry.mode & 0o777) !== DIRECTORY_MODE
  ) {
    throw new UnsafeStoragePathError('The database backup data directory must be a real directory.');
  }
  if (await fsops.realpath(root) !== root) {
    throw new UnsafeStoragePathError('The database backup data directory must use its canonical path.');
  }

  const segments = relative(root, candidate).split(sep);
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    const isLeaf = index === segments.length - 1;
    let entry: Stats;
    try {
      entry = await fsops.lstat(cursor);
    } catch (error) {
      if (isLeaf && allowMissingLeaf && isMissing(error)) return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw new UnsafeStoragePathError('Database backup paths may not traverse symbolic links.');
    }
    if (!isLeaf && !entry.isDirectory()) {
      throw new UnsafeStoragePathError('Database backup paths must use real directories.');
    }
    if (await fsops.realpath(cursor) !== cursor) {
      throw new UnsafeStoragePathError('Database backup paths must use canonical directories.');
    }
  }
}

async function assertSafeDirectory(
  fsops: DatabaseBackupFsOps,
  rootPath: string,
  directoryPath: string,
): Promise<void> {
  const directory = resolve(directoryPath);
  await assertSafePath(fsops, rootPath, directory, false);
  const directoryEntry = await fsops.lstat(directory);
  if (
    directoryEntry.isSymbolicLink() ||
    !directoryEntry.isDirectory() ||
    (directoryEntry.mode & 0o777) !== DIRECTORY_MODE
  ) {
    throw new UnsafeStoragePathError('Database backup directory must be a real directory.');
  }
  if (await fsops.realpath(directory) !== directory) {
    throw new UnsafeStoragePathError('Database backup directory must use its canonical path.');
  }
  const handle = await fsops.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isDirectory() || (stats.mode & 0o777) !== DIRECTORY_MODE) {
      throw new UnsafeStoragePathError('Database backup directory must be a real directory.');
    }
  } finally {
    await handle.close();
  }
}

async function syncDirectory(fsops: DatabaseBackupFsOps, directoryPath: string): Promise<void> {
  const handle = await fsops.open(
    directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validBackupId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new DatabaseBackupError('Database backup identifier is invalid.');
  }
  return value;
}

function backupFilename(id: string): string {
  return `${id}${BACKUP_EXTENSION}`;
}

function stagingFilename(): string {
  return `${STAGING_PREFIX}${randomUUID()}${STAGING_SUFFIX}`;
}

function stagingSidecars(path: string): readonly string[] {
  return [`${path}-wal`, `${path}-shm`];
}

async function removeIfPresent(fsops: DatabaseBackupFsOps, path: string): Promise<void> {
  try {
    await fsops.unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function publicBackupError(error: unknown): Error {
  if (error instanceof DatabaseBackupError || error instanceof UnsafeStoragePathError) return error;
  return new DatabaseBackupError('Database backup failed.');
}

async function hashFile(
  file: FileHandle,
  expectedSize: number,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let size = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
      throw new DatabaseBackupError('Database backup file read returned an invalid size.');
    }
    if (bytesRead === 0) break;
    size += bytesRead;
    if (!Number.isSafeInteger(size) || size > expectedSize) {
      throw new DatabaseBackupError('Database backup file changed while it was being verified.');
    }
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (size !== expectedSize) {
    throw new DatabaseBackupError('Database backup file changed while it was being verified.');
  }
  return { sha256: hash.digest('hex'), size };
}

async function readBackupMetadata(
  fsops: DatabaseBackupFsOps,
  path: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const file = await fsops.open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await file.chmod(BACKUP_MODE);
    await file.sync();
    const stats = await file.stat();
    if (!stats.isFile() || (stats.mode & 0o777) !== BACKUP_MODE) {
      throw new DatabaseBackupError('Database backup file mode or type is unsafe.');
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 1) {
      throw new DatabaseBackupError('Database backup file changed while it was being verified.');
    }
    const metadata = await hashFile(file, stats.size);
    const verifiedStats = await file.stat();
    if (!Number.isSafeInteger(verifiedStats.size) || verifiedStats.size !== metadata.size) {
      throw new DatabaseBackupError('Database backup file changed while it was being verified.');
    }
    return metadata;
  } finally {
    await file.close();
  }
}

export class DatabaseBackup {
  private readonly clock: DatabaseBackupClock;
  private readonly fsops: DatabaseBackupFsOps;
  private readonly idFactory: () => string;
  private readonly paths: StoragePaths;
  private readonly sqlite: Database.Database;
  private active: Promise<DatabaseBackupResult> | null = null;
  private closed = false;

  public constructor(options: DatabaseBackupOptions) {
    this.clock = options.clock ?? systemClock;
    this.fsops = { ...defaultFsOps, ...(options.fsops ?? {}) };
    this.idFactory = options.id ?? options.idFactory ?? randomUUID;
    this.paths = options.paths;
    this.sqlite = options.sqlite;
  }

  public create(): Promise<DatabaseBackupResult> {
    if (this.closed) {
      return Promise.reject(new DatabaseBackupClosedError('Database backup service is closed.'));
    }
    if (this.active !== null) {
      return Promise.reject(new BackupInProgressError('A database backup is already in progress.'));
    }
    const operation = this.createInternal();
    this.active = operation;
    void operation.then(
      () => this.clearActive(operation),
      () => this.clearActive(operation),
    );
    return operation;
  }

  public createBackup(): Promise<DatabaseBackupResult> {
    return this.create();
  }

  public backup(): Promise<DatabaseBackupResult> {
    return this.create();
  }

  public async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (active !== null) await active.catch(() => undefined);
  }

  private clearActive(operation: Promise<DatabaseBackupResult>): void {
    if (this.active === operation) this.active = null;
  }

  private async createInternal(): Promise<DatabaseBackupResult> {
    let staging: string | undefined;
    let final: string | undefined;
    let published = false;
    let stagingCreated = false;
    try {
      const id = validBackupId(this.idFactory());
      const createdAt = this.clock.now();
      if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
        throw new DatabaseBackupError('Database backup clock returned an invalid date.');
      }
      const root = resolve(this.paths.root);
      const backups = resolve(this.paths.backups);
      const stagingDirectory = join(backups, STAGING_DIRECTORY);
      const stagingPath = join(stagingDirectory, stagingFilename());
      const finalPath = join(backups, backupFilename(id));
      staging = stagingPath;
      final = finalPath;
      if (dirname(stagingPath) !== stagingDirectory || dirname(finalPath) !== backups) {
        throw new UnsafeStoragePathError('Database backup staging must stay inside its staging directory.');
      }
      const stagingArtifacts = [stagingPath, ...stagingSidecars(stagingPath)];
      const finalArtifacts = [finalPath, ...stagingSidecars(finalPath)];

      await assertSafeDirectory(this.fsops, root, backups);
      await assertSafePath(this.fsops, root, stagingDirectory, true);
      try {
        await this.fsops.mkdir(stagingDirectory, { mode: DIRECTORY_MODE, recursive: false });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await assertSafeDirectory(this.fsops, root, stagingDirectory);
      for (const path of [...stagingArtifacts, ...finalArtifacts]) {
        await assertSafePath(this.fsops, root, path, true);
        await this.assertAbsent(path);
      }

      let stagingFile: FileHandle;
      try {
        stagingFile = await this.fsops.open(
          stagingPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          BACKUP_MODE,
        );
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new DatabaseBackupCollisionError('Database backup staging already exists.');
        }
        throw error;
      }
      stagingCreated = true;
      try {
        await stagingFile.chmod(BACKUP_MODE);
      } finally {
        await stagingFile.close();
      }
      await this.sqlite.backup(stagingPath);
      await assertSafePath(this.fsops, root, stagingPath, false);
      const snapshot = new Database(stagingPath, { fileMustExist: true, readonly: true });
      try {
        snapshot.pragma('foreign_keys = ON');
        if (!checkSqliteIntegrity(snapshot).ok) {
          throw new DatabaseBackupIntegrityError('Database backup failed its SQLite integrity check.');
        }
      } finally {
        snapshot.close();
      }
      for (const path of stagingSidecars(stagingPath)) {
        await removeIfPresent(this.fsops, path);
      }
      const metadata = await readBackupMetadata(this.fsops, stagingPath);

      await assertSafePath(this.fsops, root, stagingPath, false);
      await assertSafePath(this.fsops, root, finalPath, true);
      await this.assertAbsent(finalPath);
      await syncDirectory(this.fsops, stagingDirectory);
      try {
        await this.fsops.link(stagingPath, finalPath);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new DatabaseBackupCollisionError('Database backup destination already exists.');
        }
        throw error;
      }
      published = true;
      await this.fsops.unlink(stagingPath);
      await syncDirectory(this.fsops, stagingDirectory);
      await syncDirectory(this.fsops, backups);
      return {
        createdAt: new Date(createdAt.getTime()),
        id,
        sha256: metadata.sha256,
        size: metadata.size,
      };
    } catch (error) {
      const cleanupPaths = [
        ...(published ? (final === undefined ? [] : [final]) : []),
        ...(stagingCreated && staging !== undefined ? [staging, ...stagingSidecars(staging)] : []),
      ];
      const cleanupFailures: unknown[] = [];
      for (const path of cleanupPaths) {
        try {
          await removeIfPresent(this.fsops, path);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new DatabaseBackupCleanupError('Database backup cleanup failed.');
      }
      throw publicBackupError(error);
    }
  }

  private async assertAbsent(path: string): Promise<void> {
    try {
      const entry = await this.fsops.lstat(path);
      if (entry.isSymbolicLink()) {
        throw new UnsafeStoragePathError('Database backup paths may not be symbolic links.');
      }
      throw new DatabaseBackupCollisionError('Database backup destination already exists.');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

export { DatabaseBackup as DatabaseBackupService };
