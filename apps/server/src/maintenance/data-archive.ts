import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dir, type Dirent, type Stats } from 'node:fs';
import {
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  opendir as fsOpendir,
  open as fsOpen,
  realpath as fsRealpath,
  rename as fsRename,
  rmdir as fsRmdir,
  rm as fsRm,
  unlink as fsUnlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';

import { checkSqliteIntegrity } from '../database/integrity.js';
import {
  AdapterManifestError,
  AdapterSourcePolicyError,
  MAX_ADAPTER_SOURCE_BYTES,
  MAX_MANIFEST_BYTES,
  parseBoundedManifestJson,
  validateAdapterExports,
  validateAdapterSource,
} from '../adapters/manifest.js';
import { digestAdapterSource } from '../adapters/store.js';
import {
  ARCHIVE_HASH_CHUNK_BYTES,
  compareArchivePath,
  DATA_ARCHIVE_MANIFEST_FILENAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  DataArchiveFormatError,
  archiveEntryMap,
  createDataArchiveManifest,
  parseDataArchiveManifest,
  serializeDataArchiveManifest,
  type DataArchiveEntry,
  type DataArchiveManifest,
} from './archive-format.js';
import {
  OfflineMaintenanceLeaseError,
  assertOfflineMaintenanceLease,
  type OfflineMaintenanceLease,
} from './runtime-lock.js';
import { UnsafeStoragePathError } from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const STAGING_DIRECTORY = '.staging';
const STAGING_PREFIX = '.ims-data-v1-';
const BUNDLE_SUFFIX = '.bundle';
const ARCHIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MEDIA_DIRECTORY_NAMES = ['originals', 'thumbnails', 'posters', 'uploads', 'masks'] as const;
const MEDIA_PATHS = new Map<string, keyof StoragePaths>([
  ['originals', 'originals'],
  ['thumbnails', 'thumbnails'],
  ['posters', 'posters'],
  ['uploads', 'uploads'],
  ['masks', 'masks'],
]);
const ROOT_NAMES = new Set([
  'app.db',
  'app.db-shm',
  'app.db-wal',
  'media',
  'adapters',
  'backups',
  'logs',
  '.offline-maintenance.lock',
]);
const MEDIA_NAMES = new Set([...MEDIA_DIRECTORY_NAMES, 'temp']);
const ADAPTER_NAMES = new Set(['.staging', 'manifest.json', 'adapter.mjs']);
const INPUT_ASSET_ROLES = new Set(['first_frame', 'last_frame', 'reference', 'upload']);
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_DIRECTORY_COUNT = 10_000;
const MAX_DIRECTORY_DEPTH = 64;

interface DirectoryScanState {
  entryCount: number;
  directoryCount: number;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly path: string;
}

interface DirectoryChain {
  readonly entries: readonly DirectoryIdentity[];
  readonly root: string;
}

export interface DataArchiveClock {
  now(): Date;
}

export interface DataArchiveFsOps {
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<Stats>;
  mkdir(path: string, options?: { readonly mode?: number; readonly recursive?: boolean }): Promise<string | undefined>;
  opendir(path: string): Promise<Dir>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rm(path: string, options?: { readonly force?: boolean; readonly recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DataArchiveOptions {
  readonly clock?: DataArchiveClock;
  readonly fsops?: Partial<DataArchiveFsOps>;
  readonly id?: () => string;
  readonly idFactory?: () => string;
  readonly lease?: OfflineMaintenanceLease;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly paths: StoragePaths;
  readonly sqlite: Database.Database;
}

export interface DataArchiveResult {
  readonly id: string;
  readonly bundlePath: string;
  readonly bytes: number;
  readonly entries: number;
  readonly createdAt: Date;
}

export interface DataArchiveVerifyResult {
  readonly bytes: number;
  readonly createdAt: Date;
  readonly entries: number;
  readonly manifest: DataArchiveManifest;
}

export class DataArchiveError extends Error {
  public override readonly name: string = 'DataArchiveError';
}

export class DataArchivePathError extends DataArchiveError {
  public override readonly name = 'DataArchivePathError';
}

export class DataArchiveInProgressError extends DataArchiveError {
  public override readonly name = 'DataArchiveInProgressError';
}

export class DataArchiveClosedError extends DataArchiveError {
  public override readonly name = 'DataArchiveClosedError';
}

export class DataArchiveCollisionError extends DataArchiveError {
  public override readonly name = 'DataArchiveCollisionError';
}

export class DataArchiveIntegrityError extends DataArchiveError {
  public override readonly name = 'DataArchiveIntegrityError';
}

export class DataArchiveCleanupError extends DataArchiveError {
  public override readonly name = 'DataArchiveCleanupError';
}

const systemClock: DataArchiveClock = { now: () => new Date() };

const defaultFsOps: DataArchiveFsOps = {
  chmod: fsChmod,
  lstat: fsLstat,
  mkdir: fsMkdir,
  opendir: fsOpendir,
  open: fsOpen,
  realpath: fsRealpath,
  rename: fsRename,
  rmdir: fsRmdir,
  rm: fsRm,
  unlink: fsUnlink,
};

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function assertContained(rootPath: string, candidatePath: string): void {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const relationship = relative(root, candidate);
  if (
    relationship === '..'
    || relationship.startsWith(`..${sep}`)
    || relationship.startsWith(sep)
  ) {
    throw new DataArchivePathError('Data archive path escapes the data root.');
  }
}

function publicError(error: unknown): Error {
  if (
    error instanceof DataArchiveError
    || error instanceof DataArchiveFormatError
    || error instanceof OfflineMaintenanceLeaseError
    || error instanceof UnsafeStoragePathError
  ) return error;
  if (error instanceof AdapterManifestError || error instanceof AdapterSourcePolicyError) {
    return new DataArchiveIntegrityError('A trusted adapter failed archive validation.');
  }
  return new DataArchiveError('Data archive operation failed.');
}

function validArchiveId(value: string): string {
  if (!ARCHIVE_ID.test(value) || value === '.' || value === '..') {
    throw new DataArchiveError('Data archive identifier is invalid.');
  }
  return value;
}

function bundlePath(backups: string, id: string): string {
  const finalPath = join(backups, `${id}${BUNDLE_SUFFIX}`);
  assertContained(backups, finalPath);
  if (dirname(finalPath) !== resolve(backups)) throw new DataArchivePathError('Data archive destination is invalid.');
  return finalPath;
}

function missing(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

async function assertCanonicalDirectory(
  fsops: DataArchiveFsOps,
  rootPath: string,
  directoryPath: string,
): Promise<void> {
  const root = resolve(rootPath);
  const directory = resolve(directoryPath);
  assertContained(root, directory);
  const entry = await fsops.lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o777) !== DIRECTORY_MODE) {
    throw new DataArchivePathError('Data archive roots must be canonical 0700 directories.');
  }
  if (await fsops.realpath(directory) !== directory) {
    throw new DataArchivePathError('Data archive roots must use canonical paths.');
  }
}

async function assertCanonicalRoot(fsops: DataArchiveFsOps, rootPath: string): Promise<string> {
  const root = resolve(rootPath);
  await assertCanonicalDirectory(fsops, root, root);
  return root;
}

function newDirectoryScanState(): DirectoryScanState {
  return { directoryCount: 0, entryCount: 0 };
}

async function listEntries(
  fsops: DataArchiveFsOps,
  directory: string,
  state: DirectoryScanState,
  depth: number,
): Promise<Dirent[]> {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > MAX_DIRECTORY_DEPTH) {
    throw new DataArchivePathError('Data archive directory depth exceeds the limit.');
  }
  state.directoryCount += 1;
  if (state.directoryCount > MAX_DIRECTORY_COUNT) {
    throw new DataArchiveError('Data archive directory count exceeds the limit.');
  }
  const handle = await fsops.opendir(directory);
  try {
    const entries: Dirent[] = [];
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      state.entryCount += 1;
      if (state.entryCount > MAX_DIRECTORY_ENTRIES) {
        throw new DataArchiveError('Data archive directory entry count exceeds the limit.');
      }
      entries.push(entry);
    }
    return entries.sort((left, right) => compareArchivePath(left.name, right.name));
  } finally {
    await handle.close();
  }
}

async function captureDirectoryChain(
  fsops: DataArchiveFsOps,
  rootPath: string,
  directoryPath: string,
): Promise<DirectoryChain> {
  const root = resolve(rootPath);
  const directory = resolve(directoryPath);
  assertContained(root, directory);
  const relationship = relative(root, directory);
  const segments = relationship === '' ? [] : relationship.split(sep);
  const entries: DirectoryIdentity[] = [];
  let cursor = root;
  for (const segment of ['', ...segments]) {
    if (segment !== '') cursor = resolve(cursor, segment);
    await assertCanonicalDirectory(fsops, root, cursor);
    const stats = await fsops.lstat(cursor);
    entries.push({
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode & 0o777,
      path: cursor,
    });
  }
  return { entries, root };
}

async function assertDirectoryChainUnchanged(
  fsops: DataArchiveFsOps,
  chain: DirectoryChain,
): Promise<void> {
  for (const expected of chain.entries) {
    await assertCanonicalDirectory(fsops, chain.root, expected.path);
    const current = await fsops.lstat(expected.path);
    if (
      !current.isDirectory()
      || current.dev !== expected.dev
      || current.ino !== expected.ino
      || (current.mode & 0o777) !== expected.mode
    ) {
      throw new DataArchivePathError('Data archive parent directory changed during the operation.');
    }
  }
}

async function assertRegularFile(
  fsops: DataArchiveFsOps,
  path: string,
  expectedMode?: number,
): Promise<Stats> {
  const entry = await fsops.lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new DataArchivePathError('Data archive files must be regular files without hardlink aliases.');
  }
  if (expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode) {
    throw new DataArchivePathError('Data archive files have an unsafe mode.');
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new DataArchivePathError('Data archive file size is invalid.');
  }
  return entry;
}

async function ensureStageDirectory(
  fsops: DataArchiveFsOps,
  stageRoot: string,
  directory: string,
): Promise<void> {
  assertContained(stageRoot, directory);
  const relativeDirectory = relative(stageRoot, directory);
  if (relativeDirectory === '' || relativeDirectory === '.') return;
  let cursor = stageRoot;
  for (const segment of relativeDirectory.split(sep)) {
    safeName(segment);
    cursor = join(cursor, segment);
    try {
      await fsops.lstat(cursor);
    } catch (error) {
      if (!missing(error)) throw error;
      await fsops.mkdir(cursor, { mode: DIRECTORY_MODE, recursive: false });
    }
    await assertCanonicalDirectory(fsops, stageRoot, cursor);
  }
}

async function syncDirectory(fsops: DataArchiveFsOps, directory: string): Promise<void> {
  const handle = await fsops.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openDirectoryStats(fsops: DataArchiveFsOps, directory: string): Promise<Stats> {
  const handle = await fsops.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (
      !stats.isDirectory()
      || (stats.mode & 0o777) !== DIRECTORY_MODE
      || !Number.isSafeInteger(stats.nlink)
      || stats.nlink < 2
    ) throw new DataArchivePathError('Data archive directory reservation is unsafe.');
    return stats;
  } finally {
    await handle.close();
  }
}

function assertReservationStats(current: Stats, expected: Stats): void {
  if (
    current.dev !== expected.dev
    || current.ino !== expected.ino
    || !current.isDirectory()
    || (current.mode & 0o777) !== DIRECTORY_MODE
    || !Number.isSafeInteger(current.nlink)
    || current.nlink < 2
  ) throw new DataArchiveCollisionError('Data archive reservation is no longer owned.');
}

async function assertFinalReservation(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
): Promise<void> {
  const current = await fsops.lstat(path);
  assertReservationStats(current, expected);
  if ((await listEntries(fsops, path, newDirectoryScanState(), 0)).length !== 0) {
    throw new DataArchiveCollisionError('Data archive reservation is no longer empty.');
  }
  assertReservationStats(await fsops.lstat(path), expected);
}

async function removeIfPresent(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    await fsops.rm(path, { force: true, recursive: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function removeFileIfPresent(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    await fsops.unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function removeEmptyReservationIfOwned(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
): Promise<void> {
  let current: Stats;
  try {
    current = await fsops.lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  try {
    assertReservationStats(current, expected);
    if ((await listEntries(fsops, path, newDirectoryScanState(), 0)).length !== 0) return;
    assertReservationStats(await fsops.lstat(path), expected);
  } catch (error) {
    if (error instanceof DataArchiveCollisionError) return;
    throw error;
  }
  await removeIfPresent(fsops, path);
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new DataArchiveError('Data archive file write made no progress.');
    }
    offset += result.bytesWritten;
  }
}

async function writeSecureFile(
  fsops: DataArchiveFsOps,
  path: string,
  bytes: Uint8Array,
  rootPath: string,
): Promise<void> {
  const parentChain = await captureDirectoryChain(fsops, rootPath, dirname(path));
  await assertDirectoryChainUnchanged(fsops, parentChain);
  const file = await fsops.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    FILE_MODE,
  );
  try {
    await file.chmod(FILE_MODE);
    await writeAll(file, bytes);
    await file.sync();
    await assertDirectoryChainUnchanged(fsops, parentChain);
  } finally {
    await file.close();
  }
}

async function hashFile(
  fsops: DataArchiveFsOps,
  path: string,
  expectedSize: number,
  rootPath: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const pathStats = await assertRegularFile(fsops, path);
  if (pathStats.size !== expectedSize) {
    throw new DataArchiveIntegrityError('Data archive file changed while it was being hashed.');
  }
  const parentChain = await captureDirectoryChain(fsops, rootPath, dirname(path));
  await assertDirectoryChainUnchanged(fsops, parentChain);
  const file = await fsops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await file.stat();
    if (
      !initial.isFile()
      || initial.nlink !== 1
      || initial.dev !== pathStats.dev
      || initial.ino !== pathStats.ino
      || initial.size !== expectedSize
    ) {
      throw new DataArchiveIntegrityError('Data archive file changed while it was being hashed.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
    let size = 0;
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.byteLength) {
        throw new DataArchiveIntegrityError('Data archive file read returned an invalid size.');
      }
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (!Number.isSafeInteger(size) || size > expectedSize) {
        throw new DataArchiveIntegrityError('Data archive file changed while it was being hashed.');
      }
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const finalStats = await file.stat();
    if (
      size !== expectedSize
      || finalStats.size !== expectedSize
      || finalStats.dev !== initial.dev
      || finalStats.ino !== initial.ino
      || finalStats.nlink !== 1
    ) {
      throw new DataArchiveIntegrityError('Data archive file changed while it was being hashed.');
    }
    await assertDirectoryChainUnchanged(fsops, parentChain);
    return { sha256: hash.digest('hex'), size };
  } finally {
    await file.close();
  }
}

async function copyRegularFile(
  fsops: DataArchiveFsOps,
  source: string,
  destination: string,
  maxBytes: number,
  sourceRoot: string,
  destinationRoot: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  const sourceParentChain = await captureDirectoryChain(fsops, sourceRoot, dirname(source));
  const destinationParentChain = await captureDirectoryChain(fsops, destinationRoot, dirname(destination));
  await assertDirectoryChainUnchanged(fsops, sourceParentChain);
  await assertDirectoryChainUnchanged(fsops, destinationParentChain);
  const sourceStats = await assertRegularFile(fsops, source);
  if (sourceStats.size > maxBytes) throw new DataArchiveError('Data archive payload exceeds the size limit.');
  const input = await fsops.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: FileHandle | undefined;
  try {
    const opened = await input.stat();
    await assertDirectoryChainUnchanged(fsops, sourceParentChain);
    await assertDirectoryChainUnchanged(fsops, destinationParentChain);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== sourceStats.dev
      || opened.ino !== sourceStats.ino
    ) {
      throw new DataArchiveIntegrityError('Data archive source changed while it was being copied.');
    }
    output = await fsops.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    await assertDirectoryChainUnchanged(fsops, sourceParentChain);
    await assertDirectoryChainUnchanged(fsops, destinationParentChain);
    await output.chmod(FILE_MODE);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
    let size = 0;
    while (true) {
      const result = await input.read(buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.byteLength) {
        throw new DataArchiveIntegrityError('Data archive source read returned an invalid size.');
      }
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        throw new DataArchiveError('Data archive payload exceeds the size limit.');
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      await writeAll(output, buffer.subarray(0, result.bytesRead));
    }
    await output.sync();
    const sourceFinal = await input.stat();
    const destinationStats = await output.stat();
    const destinationPathStats = await assertRegularFile(fsops, destination, FILE_MODE);
    if (
      size !== sourceStats.size
      || sourceFinal.dev !== sourceStats.dev
      || sourceFinal.size !== sourceStats.size
      || sourceFinal.ino !== sourceStats.ino
      || sourceFinal.nlink !== 1
      || destinationStats.size !== size
      || destinationPathStats.dev !== destinationStats.dev
      || destinationPathStats.ino !== destinationStats.ino
      || (destinationStats.mode & 0o777) !== FILE_MODE
    ) {
      throw new DataArchiveIntegrityError('Data archive source changed while it was being copied.');
    }
    await assertDirectoryChainUnchanged(fsops, sourceParentChain);
    await assertDirectoryChainUnchanged(fsops, destinationParentChain);
    return { sha256: hash.digest('hex'), size };
  } finally {
    if (output !== undefined) await output.close();
    await input.close();
  }
}

async function readBoundedFile(
  fsops: DataArchiveFsOps,
  path: string,
  maxBytes: number,
  rootPath: string,
): Promise<Buffer> {
  const stats = await assertRegularFile(fsops, path);
  if (stats.size > maxBytes) throw new DataArchiveIntegrityError('A trusted adapter file exceeds its size limit.');
  const parentChain = await captureDirectoryChain(fsops, rootPath, dirname(path));
  await assertDirectoryChainUnchanged(fsops, parentChain);
  const file = await fsops.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== stats.dev
      || opened.ino !== stats.ino
      || opened.size !== stats.size
    ) throw new DataArchiveIntegrityError('A trusted adapter file changed while being read.');
    const bytes = Buffer.allocUnsafe(stats.size);
    const chunk = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < stats.size) {
      const length = Math.min(chunk.byteLength, stats.size - offset);
      const result = await file.read(chunk, 0, length, null);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length) {
        throw new DataArchiveIntegrityError('A trusted adapter file read returned an invalid size.');
      }
      chunk.copy(bytes, offset, 0, result.bytesRead);
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      after.dev !== stats.dev
      || after.ino !== stats.ino
      || after.nlink !== 1
      || after.size !== stats.size
    ) throw new DataArchiveIntegrityError('A trusted adapter file changed while being read.');
    await assertDirectoryChainUnchanged(fsops, parentChain);
    return bytes;
  } finally {
    await file.close();
  }
}

function safeName(name: string): void {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) throw new DataArchivePathError('Data archive contains an unsafe filename.');
}

async function assertExcludedSidecar(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    const stats = await fsops.lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new DataArchivePathError('Excluded SQLite sidecars must be regular files.');
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function validateRootLayout(
  fsops: DataArchiveFsOps,
  paths: StoragePaths,
  scan: DirectoryScanState,
): Promise<string> {
  const root = await assertCanonicalRoot(fsops, paths.root);
  const expected: StoragePaths = {
    adapters: join(root, 'adapters'),
    backups: join(root, 'backups'),
    database: join(root, 'app.db'),
    logs: join(root, 'logs'),
    masks: join(root, 'media', 'masks'),
    originals: join(root, 'media', 'originals'),
    posters: join(root, 'media', 'posters'),
    temporary: join(root, 'media', 'temp'),
    thumbnails: join(root, 'media', 'thumbnails'),
    uploads: join(root, 'media', 'uploads'),
    root,
  };
  for (const key of Object.keys(expected) as (keyof StoragePaths)[]) {
    if (resolve(paths[key]) !== expected[key]) throw new DataArchivePathError('Storage paths are not canonical.');
  }
  for (const name of await listEntries(fsops, root, scan, 0)) {
    safeName(name.name);
    if (!ROOT_NAMES.has(name.name)) throw new DataArchivePathError('Data root contains an unexpected entry.');
  }
  for (const directory of [
    join(root, 'media'),
    paths.adapters,
    paths.backups,
    paths.logs,
    ...MEDIA_DIRECTORY_NAMES.map((name) => join(root, 'media', name)),
    paths.temporary,
  ]) await assertCanonicalDirectory(fsops, root, directory);
  await assertRegularFile(fsops, paths.database);
  await assertExcludedSidecar(fsops, join(root, 'app.db-wal'));
  await assertExcludedSidecar(fsops, join(root, 'app.db-shm'));
  const lock = join(root, '.offline-maintenance.lock');
  try {
    await assertRegularFile(fsops, lock, FILE_MODE);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const staging = join(paths.backups, STAGING_DIRECTORY);
  try {
    await fsops.lstat(staging);
  } catch (error) {
    if (!missing(error)) throw error;
    await fsops.mkdir(staging, { mode: DIRECTORY_MODE, recursive: false });
  }
  await assertCanonicalDirectory(fsops, root, staging);
  return root;
}

async function validateMediaLayout(
  fsops: DataArchiveFsOps,
  paths: StoragePaths,
  scan: DirectoryScanState,
): Promise<void> {
  const media = join(paths.root, 'media');
  for (const entry of await listEntries(fsops, media, scan, 1)) {
    safeName(entry.name);
    if (!MEDIA_NAMES.has(entry.name)) throw new DataArchivePathError('Media root contains an unexpected entry.');
    const path = join(media, entry.name);
    await assertCanonicalDirectory(fsops, paths.root, path);
  }
}

async function walkMediaFiles(
  fsops: DataArchiveFsOps,
  root: string,
  directory: string,
  prefix: string,
  seen: Set<string>,
  maxEntries: number,
  scan: DirectoryScanState,
  depth: number,
): Promise<readonly { readonly archivePath: string; readonly sourcePath: string }[]> {
  const results: { archivePath: string; sourcePath: string }[] = [];
  for (const entry of await listEntries(fsops, directory, scan, depth)) {
    safeName(entry.name);
    const sourcePath = join(directory, entry.name);
    const archivePath = `${prefix}/${entry.name}`;
    const stats = await fsops.lstat(sourcePath);
    if (stats.isSymbolicLink()) throw new DataArchivePathError('Media archive sources may not be symlinks.');
    if (stats.isDirectory()) {
      await assertCanonicalDirectory(fsops, root, sourcePath);
      const nested = await walkMediaFiles(
        fsops,
        root,
        sourcePath,
        archivePath,
        seen,
        maxEntries - results.length,
        scan,
        depth + 1,
      );
      results.push(...nested);
    } else if (stats.isFile()) {
      if (stats.nlink !== 1) throw new DataArchivePathError('Media archive sources may not use hardlink aliases.');
      const inode = `${String(stats.dev)}:${String(stats.ino)}`;
      if (seen.has(inode)) throw new DataArchivePathError('Media archive sources may not alias the same inode.');
      seen.add(inode);
      results.push({ archivePath, sourcePath });
    } else {
      throw new DataArchivePathError('Media archive sources must be regular files or directories.');
    }
    if (results.length > maxEntries) throw new DataArchiveError('Data archive entry count exceeds the limit.');
  }
  return results;
}

async function validateAdapterDirectory(
  fsops: DataArchiveFsOps,
  paths: StoragePaths,
  adapterId: string,
  scan: DirectoryScanState,
  depth: number,
): Promise<{ readonly manifestPath: string; readonly sourcePath: string }> {
  const directory = join(paths.adapters, adapterId);
  await assertCanonicalDirectory(fsops, paths.root, directory);
  const entries = await listEntries(fsops, directory, scan, depth);
  for (const entry of entries) {
    safeName(entry.name);
    if (!ADAPTER_NAMES.has(entry.name) || entry.name === '.staging') {
      throw new DataArchivePathError('Trusted adapter directory contains an unexpected entry.');
    }
  }
  if (entries.length !== 2 || !entries.some((entry) => entry.name === 'manifest.json') || !entries.some((entry) => entry.name === 'adapter.mjs')) {
    throw new DataArchiveIntegrityError('Trusted adapter directory is incomplete.');
  }
  const manifestPath = join(directory, 'manifest.json');
  const sourcePath = join(directory, 'adapter.mjs');
  const manifestBytes = await readBoundedFile(fsops, manifestPath, MAX_MANIFEST_BYTES, paths.root);
  const sourceBytes = await readBoundedFile(fsops, sourcePath, MAX_ADAPTER_SOURCE_BYTES, paths.root);
  const manifest = parseBoundedManifestJson(manifestBytes);
  if (manifest.id !== adapterId) throw new DataArchiveIntegrityError('Trusted adapter path does not match its manifest.');
  const source = validateAdapterSource(sourceBytes);
  if (digestAdapterSource(sourceBytes) !== manifest.sha256) throw new DataArchiveIntegrityError('Trusted adapter digest does not match its manifest.');
  validateAdapterExports(source, manifest);
  return { manifestPath, sourcePath };
}

async function listAdapterFiles(
  fsops: DataArchiveFsOps,
  paths: StoragePaths,
  scan: DirectoryScanState,
): Promise<readonly { readonly archivePath: string; readonly sourcePath: string }[]> {
  const files: { archivePath: string; sourcePath: string }[] = [];
  for (const entry of await listEntries(fsops, paths.adapters, scan, 1)) {
    safeName(entry.name);
    if (entry.name === STAGING_DIRECTORY) {
      await assertCanonicalDirectory(fsops, paths.root, join(paths.adapters, entry.name));
      continue;
    }
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(entry.name)) {
      throw new DataArchivePathError('Trusted adapter id is unsafe.');
    }
    const adapter = await validateAdapterDirectory(fsops, paths, entry.name, scan, 2);
    files.push(
      { archivePath: `adapters/${entry.name}/adapter.mjs`, sourcePath: adapter.sourcePath },
      { archivePath: `adapters/${entry.name}/manifest.json`, sourcePath: adapter.manifestPath },
    );
  }
  return files.sort((left, right) => compareArchivePath(left.archivePath, right.archivePath));
}

async function stageDirectoryTree(fsops: DataArchiveFsOps, root: string): Promise<void> {
  const directories = [
    join(root, 'database'),
    join(root, 'media'),
    ...MEDIA_DIRECTORY_NAMES.map((name) => join(root, 'media', name)),
    join(root, 'adapters'),
  ];
  await fsops.chmod(root, DIRECTORY_MODE);
  for (const directory of directories) {
    await fsops.mkdir(directory, { mode: DIRECTORY_MODE, recursive: false });
    await fsops.chmod(directory, DIRECTORY_MODE);
  }
}

async function assertAbsent(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    await fsops.lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new DataArchiveCollisionError('Data archive destination already exists.');
}

async function verifyBundleLayout(
  fsops: DataArchiveFsOps,
  bundle: string,
  manifest: DataArchiveManifest,
): Promise<void> {
  await assertCanonicalDirectory(fsops, resolve(bundle), resolve(bundle));
  const map = archiveEntryMap(manifest);
  const scan = newDirectoryScanState();
  const found = new Set<string>();
  const visitedDirectories = new Set<string>();
  const expectedDirectories = new Set<string>([
    'database',
    'media',
    'adapters',
    ...MEDIA_DIRECTORY_NAMES.map((name) => `media/${name}`),
  ]);
  for (const entry of manifest.entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await listEntries(fsops, directory, scan, prefix.length === 0 ? 0 : prefix.split('/').length)) {
      safeName(entry.name);
      const path = join(directory, entry.name);
      const archivePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const stats = await fsops.lstat(path);
      if (stats.isSymbolicLink()) throw new DataArchivePathError('Archive bundle may not contain symlinks.');
      if (stats.isDirectory()) {
        if (!expectedDirectories.has(archivePath)) throw new DataArchiveIntegrityError('Archive contains an undeclared directory.');
        await assertCanonicalDirectory(fsops, bundle, path);
        visitedDirectories.add(archivePath);
        await walk(path, archivePath);
      } else if (stats.isFile()) {
        if (archivePath === DATA_ARCHIVE_MANIFEST_FILENAME) {
          if (stats.nlink !== 1 || (stats.mode & 0o777) !== FILE_MODE) throw new DataArchivePathError('Archive manifest file is unsafe.');
        } else {
          const declared = map.get(archivePath);
          if (declared === undefined) throw new DataArchiveIntegrityError('Archive contains an undeclared file.');
          if (stats.nlink !== 1 || (stats.mode & 0o777) !== FILE_MODE) throw new DataArchivePathError('Archive payload file is unsafe.');
          found.add(archivePath);
        }
      } else {
        throw new DataArchivePathError('Archive bundle contains a non-regular entry.');
      }
    }
  };
  await walk(bundle, '');
  for (const directory of expectedDirectories) {
    if (!visitedDirectories.has(directory)) throw new DataArchiveIntegrityError('Archive bundle layout is incomplete.');
  }
  if (found.size !== manifest.entries.length || manifest.entries.some((entry) => !found.has(entry.path))) {
    throw new DataArchiveIntegrityError('Archive payload does not match its manifest.');
  }
}

async function validateArchivedDatabase(
  fsops: DataArchiveFsOps,
  bundle: string,
  manifest: DataArchiveManifest,
): Promise<void> {
  const databaseEntry = archiveEntryMap(manifest).get('database/app.db');
  if (databaseEntry === undefined) throw new DataArchiveIntegrityError('Archive database entry is missing.');
  const databasePath = join(bundle, 'database', 'app.db');
  const metadata = await hashFile(fsops, databasePath, databaseEntry.size, bundle);
  if (metadata.sha256 !== databaseEntry.sha256) throw new DataArchiveIntegrityError('Archive database digest does not match its manifest.');
  let snapshot: Database.Database | undefined;
  let validationFailure: unknown;
  try {
    snapshot = new Database(databasePath, { fileMustExist: true, readonly: true });
    snapshot.pragma('foreign_keys = ON');
    const report = checkSqliteIntegrity(snapshot);
    if (!report.ok) throw new DataArchiveIntegrityError('Archive database integrity validation failed.');
    const rows = snapshot.prepare(
      'SELECT file_path AS filePath, thumbnail_path AS thumbnailPath, poster_path AS posterPath, role, file_size AS fileSize, sha256 FROM assets',
    ).iterate() as Iterable<unknown>;
    const map = archiveEntryMap(manifest);
    let rowCount = 0;
    for (const row of rows) {
      rowCount += 1;
      if (rowCount > MAX_ARCHIVE_ENTRIES) throw new DataArchiveIntegrityError('Archive database contains too many asset rows.');
      if (row === null || typeof row !== 'object') throw new DataArchiveIntegrityError('Archive database asset row is invalid.');
      const record = row as Record<string, unknown>;
      if (typeof record.role !== 'string' || (record.role !== 'output' && record.role !== 'mask' && !INPUT_ASSET_ROLES.has(record.role))) {
        throw new DataArchiveIntegrityError('Archive database asset role is invalid.');
      }
      const contentPrefix = record.role === 'output'
        ? 'media/originals/'
        : record.role === 'mask'
          ? 'media/masks/'
          : 'media/uploads/';
      const prefixes = new Map([
        ['filePath', contentPrefix],
        ['thumbnailPath', 'media/thumbnails/'],
        ['posterPath', 'media/posters/'],
      ]);
      for (const key of ['filePath', 'thumbnailPath', 'posterPath']) {
        const value = record[key];
        if (value === null && key !== 'filePath') continue;
        const prefix = prefixes.get(key)!;
        if (typeof value !== 'string' || !value.startsWith(prefix) || map.get(value) === undefined) {
          throw new DataArchiveIntegrityError('Archive database references an unarchived media file.');
        }
      }
      const file = map.get(record.filePath as string);
      if (
        file === undefined
        || file.size !== record.fileSize
        || file.sha256 !== record.sha256
      ) throw new DataArchiveIntegrityError('Archive database media metadata does not match its file.');
    }
  } catch (error) {
    validationFailure = error;
  }
  if (snapshot !== undefined) {
    try {
      snapshot.close();
    } catch {
      validationFailure = new DataArchiveIntegrityError('Archive database could not be closed after validation.');
    }
  }
  // Opening a SQLite snapshot can create coordination sidecars even in
  // readonly mode. They are explicitly outside the bundle format.
  await removeFileIfPresent(fsops, `${databasePath}-wal`);
  await removeFileIfPresent(fsops, `${databasePath}-shm`);
  if (validationFailure !== undefined) {
    if (validationFailure instanceof DataArchiveError) throw validationFailure;
    throw new DataArchiveIntegrityError('Archive database validation failed.');
  }
}

async function validateArchivedAdapters(
  fsops: DataArchiveFsOps,
  bundle: string,
  manifest: DataArchiveManifest,
): Promise<void> {
  const adapterIds = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry.path.startsWith('adapters/')) continue;
    const adapterId = entry.path.split('/')[1];
    if (adapterId !== undefined) adapterIds.add(adapterId);
  }
  for (const adapterId of [...adapterIds].sort(compareArchivePath)) {
    const manifestPath = join(bundle, 'adapters', adapterId, 'manifest.json');
    const sourcePath = join(bundle, 'adapters', adapterId, 'adapter.mjs');
    const manifestBytes = await readBoundedFile(fsops, manifestPath, MAX_MANIFEST_BYTES, bundle);
    const sourceBytes = await readBoundedFile(fsops, sourcePath, MAX_ADAPTER_SOURCE_BYTES, bundle);
    const adapterManifest = parseBoundedManifestJson(manifestBytes);
    if (adapterManifest.id !== adapterId) throw new DataArchiveIntegrityError('Trusted adapter path does not match its manifest.');
    const source = validateAdapterSource(sourceBytes);
    if (digestAdapterSource(sourceBytes) !== adapterManifest.sha256) throw new DataArchiveIntegrityError('Trusted adapter digest does not match its manifest.');
    validateAdapterExports(source, adapterManifest);
  }
}

export async function verifyDataArchive(
  bundlePath: string,
  options: { readonly fsops?: Partial<DataArchiveFsOps> } = {},
): Promise<DataArchiveVerifyResult> {
  const fsops = { ...defaultFsOps, ...(options.fsops ?? {}) };
  try {
    const bundle = resolve(bundlePath);
    await assertCanonicalDirectory(fsops, bundle, bundle);
    const manifestPath = join(bundle, DATA_ARCHIVE_MANIFEST_FILENAME);
    const manifestBytes = await readBoundedFile(fsops, manifestPath, 2 * 1024 * 1024, bundle);
    const manifest = parseDataArchiveManifest(manifestBytes);
    await verifyBundleLayout(fsops, bundle, manifest);
    await validateArchivedDatabase(fsops, bundle, manifest);
    await validateArchivedAdapters(fsops, bundle, manifest);
    for (const entry of manifest.entries) {
      const metadata = await hashFile(fsops, join(bundle, ...entry.path.split('/')), entry.size, bundle);
      if (metadata.sha256 !== entry.sha256) throw new DataArchiveIntegrityError('Archive payload digest does not match its manifest.');
    }
    const bytes = manifest.entries.reduce((total, entry) => total + entry.size, 0);
    return {
      bytes,
      createdAt: new Date(manifest.createdAt),
      entries: manifest.entries.length,
      manifest,
    };
  } catch (error) {
    throw publicError(error);
  }
}

async function removePublishedBundleIfOwned(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
): Promise<void> {
  let current: Stats;
  try {
    current = await fsops.lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) return;
  try {
    await verifyDataArchive(path, { fsops });
  } catch {
    // Do not recursively remove a bundle that no longer matches the exact
    // bytes and layout produced by this invocation.
    return;
  }
  await removeIfPresent(fsops, path);
}

export class DataArchive {
  private readonly clock: DataArchiveClock;
  private readonly fsops: DataArchiveFsOps;
  private readonly idFactory: () => string;
  private readonly lease: OfflineMaintenanceLease | undefined;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly paths: StoragePaths;
  private readonly sqlite: Database.Database;
  private active: Promise<DataArchiveResult> | null = null;
  private closed = false;

  public constructor(options: DataArchiveOptions) {
    this.clock = options.clock ?? systemClock;
    this.fsops = { ...defaultFsOps, ...(options.fsops ?? {}) };
    this.idFactory = options.id ?? options.idFactory ?? (() => `data-v1-${randomUUID()}`);
    this.lease = options.lease;
    this.maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
    this.maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
    this.paths = options.paths;
    this.sqlite = options.sqlite;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_ARCHIVE_BYTES) {
      throw new RangeError('maxBytes is outside the archive limit.');
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ARCHIVE_ENTRIES) {
      throw new RangeError('maxEntries is outside the archive limit.');
    }
  }

  public create(): Promise<DataArchiveResult> {
    if (this.closed) return Promise.reject(new DataArchiveClosedError('Data archive service is closed.'));
    if (this.active !== null) return Promise.reject(new DataArchiveInProgressError('A data archive is already in progress.'));
    const operation = this.createInternal();
    this.active = operation;
    void operation.then(
      () => this.clearActive(operation),
      () => this.clearActive(operation),
    );
    return operation;
  }

  public createArchive(): Promise<DataArchiveResult> {
    return this.create();
  }

  public async close(): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (active !== null) await active.catch(() => undefined);
  }

  private clearActive(operation: Promise<DataArchiveResult>): void {
    if (this.active === operation) this.active = null;
  }

  private async createInternal(): Promise<DataArchiveResult> {
    let stagingBundle: string | undefined;
    let stagingCreated = false;
    let stagingParent: string | undefined;
    let stagingParentChain: DirectoryChain | undefined;
    let backupsParentChain: DirectoryChain | undefined;
    let stagingStats: Stats | undefined;
    let finalBundle: string | undefined;
    let finalReserved = false;
    let finalMutated = false;
    let publicationAttempted = false;
    let finalReservationStats: Stats | undefined;
    let publishedStats: Stats | undefined;
    try {
      await assertOfflineMaintenanceLease(this.lease, this.paths.root);
      const sourceScan = newDirectoryScanState();
      const root = await validateRootLayout(this.fsops, this.paths, sourceScan);
      await validateMediaLayout(this.fsops, this.paths, sourceScan);
      stagingParent = join(this.paths.backups, STAGING_DIRECTORY);
      stagingParentChain = await captureDirectoryChain(this.fsops, root, stagingParent);
      backupsParentChain = await captureDirectoryChain(this.fsops, root, this.paths.backups);
      const id = validArchiveId(this.idFactory());
      const createdAt = this.clock.now();
      if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new DataArchiveError('Data archive clock returned an invalid date.');
      finalBundle = bundlePath(this.paths.backups, id);
      await assertAbsent(this.fsops, finalBundle);
      const stagingRoot = stagingParent!;
      stagingBundle = join(stagingRoot, `${STAGING_PREFIX}${randomUUID()}${BUNDLE_SUFFIX}`);
      assertContained(this.paths.root, stagingBundle);
      try {
        await this.fsops.mkdir(stagingBundle, { mode: DIRECTORY_MODE, recursive: false });
      } catch (error) {
        if (isCode(error, 'EEXIST')) throw new DataArchiveCollisionError('Data archive staging destination already exists.');
        throw error;
      }
      stagingCreated = true;
      await stageDirectoryTree(this.fsops, stagingBundle);
      const entries: DataArchiveEntry[] = [];
      let totalBytes = 0;
      const addEntry = (archivePath: string, metadata: { readonly size: number; readonly sha256: string }): void => {
        entries.push({ path: archivePath, sha256: metadata.sha256, size: metadata.size });
        totalBytes += metadata.size;
        if (entries.length > this.maxEntries || !Number.isSafeInteger(totalBytes) || totalBytes > this.maxBytes) {
          throw new DataArchiveError('Data archive exceeds its configured bounds.');
        }
      };

      const stagedDatabase = join(stagingBundle, 'database', 'app.db');
      const stagedDatabaseParentChain = await captureDirectoryChain(
        this.fsops,
        stagingBundle,
        dirname(stagedDatabase),
      );
      await assertDirectoryChainUnchanged(this.fsops, stagedDatabaseParentChain);
      const dbHandle = await this.fsops.open(
        stagedDatabase,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      try {
        await dbHandle.chmod(FILE_MODE);
        await dbHandle.sync();
      } finally {
        await dbHandle.close();
      }
      await assertDirectoryChainUnchanged(this.fsops, stagedDatabaseParentChain);
      await this.sqlite.backup(stagedDatabase);
      await assertDirectoryChainUnchanged(this.fsops, stagedDatabaseParentChain);
      await assertRegularFile(this.fsops, stagedDatabase, FILE_MODE);
      const syncedDatabase = await this.fsops.open(stagedDatabase, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await syncedDatabase.sync();
      } finally {
        await syncedDatabase.close();
      }
      await removeFileIfPresent(this.fsops, `${stagedDatabase}-wal`);
      await removeFileIfPresent(this.fsops, `${stagedDatabase}-shm`);
      const dbMetadata = await hashFile(
        this.fsops,
        stagedDatabase,
        (await assertRegularFile(this.fsops, stagedDatabase, FILE_MODE)).size,
        stagingBundle,
      );
      const snapshot = new Database(stagedDatabase, { fileMustExist: true, readonly: true });
      try {
        snapshot.pragma('foreign_keys = ON');
        if (!checkSqliteIntegrity(snapshot).ok) throw new DataArchiveIntegrityError('Data archive database integrity validation failed.');
      } finally {
        snapshot.close();
      }
      // A read-only SQLite connection may create WAL coordination sidecars;
      // they are transient and must not enter the directory bundle.
      await removeFileIfPresent(this.fsops, `${stagedDatabase}-wal`);
      await removeFileIfPresent(this.fsops, `${stagedDatabase}-shm`);
      addEntry('database/app.db', dbMetadata);

      await assertOfflineMaintenanceLease(this.lease, root);
      const mediaFiles: { archivePath: string; sourcePath: string }[] = [];
      const inodeSet = new Set<string>();
      for (const name of MEDIA_DIRECTORY_NAMES) {
        const remainingEntries = this.maxEntries - entries.length - mediaFiles.length;
        if (remainingEntries <= 0) throw new DataArchiveError('Data archive entry count exceeds the limit.');
        const sourceDirectory = this.paths[MEDIA_PATHS.get(name)!];
        mediaFiles.push(...await walkMediaFiles(
          this.fsops,
          root,
          sourceDirectory,
          `media/${name}`,
          inodeSet,
          remainingEntries,
          sourceScan,
          2,
        ));
      }
      const adapterFiles = await listAdapterFiles(this.fsops, this.paths, sourceScan);
      for (const file of [...mediaFiles, ...adapterFiles].sort((left, right) => compareArchivePath(left.archivePath, right.archivePath))) {
        if (entries.length >= this.maxEntries) throw new DataArchiveError('Data archive entry count exceeds the limit.');
        const destination = join(stagingBundle, ...file.archivePath.split('/'));
        await ensureStageDirectory(this.fsops, stagingBundle, dirname(destination));
        const sourceStats = await assertRegularFile(this.fsops, file.sourcePath);
        const remaining = this.maxBytes - totalBytes;
        if (sourceStats.size > remaining) throw new DataArchiveError('Data archive payload exceeds its configured bounds.');
        const metadata = await copyRegularFile(
          this.fsops,
          file.sourcePath,
          destination,
          remaining,
          root,
          stagingBundle,
        );
        addEntry(file.archivePath, metadata);
      }

      const manifest = createDataArchiveManifest({ createdAt, entries });
      await writeSecureFile(
        this.fsops,
        join(stagingBundle, DATA_ARCHIVE_MANIFEST_FILENAME),
        serializeDataArchiveManifest(manifest),
        stagingBundle,
      );
      await syncDirectory(this.fsops, join(stagingBundle, 'database'));
      for (const name of MEDIA_DIRECTORY_NAMES) await syncDirectory(this.fsops, join(stagingBundle, 'media', name));
      await syncDirectory(this.fsops, join(stagingBundle, 'adapters'));
      await syncDirectory(this.fsops, stagingBundle);
      await syncDirectory(this.fsops, stagingRoot);
      await verifyDataArchive(stagingBundle, { fsops: this.fsops });

      await assertOfflineMaintenanceLease(this.lease, root);
      await assertAbsent(this.fsops, finalBundle);
      try {
        await this.fsops.mkdir(finalBundle, { mode: DIRECTORY_MODE, recursive: false });
        finalReserved = true;
        finalMutated = true;
        finalReservationStats = await openDirectoryStats(this.fsops, finalBundle);
      } catch (error) {
        if (isCode(error, 'EEXIST')) throw new DataArchiveCollisionError('Data archive destination already exists.');
        throw error;
      }
      if (finalReservationStats === undefined) {
        throw new DataArchiveCollisionError('Data archive reservation could not be verified.');
      }
      await assertFinalReservation(this.fsops, finalBundle, finalReservationStats);
      if (stagingParentChain === undefined || backupsParentChain === undefined) {
        throw new DataArchivePathError('Data archive publication parents could not be verified.');
      }
      await assertDirectoryChainUnchanged(this.fsops, stagingParentChain);
      await assertDirectoryChainUnchanged(this.fsops, backupsParentChain);
      stagingStats = await openDirectoryStats(this.fsops, stagingBundle);
      assertReservationStats(await this.fsops.lstat(stagingBundle), stagingStats);
      publicationAttempted = true;
      await this.fsops.rename(stagingBundle, finalBundle);
      stagingBundle = undefined;
      finalReserved = false;
      await assertDirectoryChainUnchanged(this.fsops, stagingParentChain);
      await assertDirectoryChainUnchanged(this.fsops, backupsParentChain);
      publishedStats = await this.fsops.lstat(finalBundle);
      await syncDirectory(this.fsops, stagingRoot);
      await assertDirectoryChainUnchanged(this.fsops, stagingParentChain);
      await syncDirectory(this.fsops, this.paths.backups);
      await assertDirectoryChainUnchanged(this.fsops, backupsParentChain);
      if (publishedStats === undefined) {
        throw new DataArchiveCollisionError('Data archive publication could not be verified.');
      }
      return {
        bundlePath: finalBundle,
        bytes: totalBytes,
        createdAt: new Date(createdAt.getTime()),
        entries: entries.length,
        id,
      };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (stagingCreated && stagingBundle !== undefined) {
        try { await removeIfPresent(this.fsops, stagingBundle); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (finalBundle !== undefined && (finalReserved || finalMutated || publishedStats !== undefined || publicationAttempted)) {
        try {
          if (finalReserved && finalReservationStats !== undefined) {
            await removeEmptyReservationIfOwned(this.fsops, finalBundle, finalReservationStats);
          }
          if (publicationAttempted && (publishedStats !== undefined || stagingStats !== undefined)) {
            await removePublishedBundleIfOwned(this.fsops, finalBundle, publishedStats ?? stagingStats!);
          }
        } catch (cleanupError) {
          if (!missing(cleanupError)) cleanupFailures.push(cleanupError);
        }
      }
      if (stagingParent !== undefined && stagingCreated) {
        try {
          if (stagingParentChain !== undefined) await assertDirectoryChainUnchanged(this.fsops, stagingParentChain);
          await syncDirectory(this.fsops, stagingParent);
          if (stagingParentChain !== undefined) await assertDirectoryChainUnchanged(this.fsops, stagingParentChain);
        } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (finalMutated || finalReservationStats !== undefined) {
        try {
          if (backupsParentChain !== undefined) await assertDirectoryChainUnchanged(this.fsops, backupsParentChain);
          await syncDirectory(this.fsops, this.paths.backups);
          if (backupsParentChain !== undefined) await assertDirectoryChainUnchanged(this.fsops, backupsParentChain);
        } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (cleanupFailures.length > 0) throw new DataArchiveCleanupError('Data archive cleanup failed.');
      throw publicError(error);
    }
  }
}

export { DataArchive as DataArchiveService };
