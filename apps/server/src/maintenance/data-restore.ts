import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
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
import { checkSqliteIntegrity } from '../database/integrity.js';
import {
  ARCHIVE_HASH_CHUNK_BYTES,
  compareArchivePath,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  DataArchiveFormatError,
  archiveEntryMap,
  type DataArchiveEntry,
  type DataArchiveManifest,
} from './archive-format.js';
import {
  DataArchiveError,
  verifyDataArchive,
  type DataArchiveFsOps,
} from './data-archive.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RESTORE_STAGING_PREFIX = '.ims-restore-v1-';
const INPUT_ASSET_ROLES = new Set(['first_frame', 'last_frame', 'reference', 'upload']);
const MEDIA_DIRECTORY_NAMES = ['originals', 'thumbnails', 'posters', 'uploads', 'masks'] as const;
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

export interface DataRestoreOptions {
  readonly bundlePath: string;
  readonly fsops?: Partial<DataArchiveFsOps>;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly stageIdFactory?: () => string;
  readonly targetPath: string;
}

export interface DataRestoreResult {
  readonly bytes: number;
  readonly createdAt: Date;
  readonly entries: number;
  readonly targetPath: string;
}

export class DataRestoreError extends Error {
  public override readonly name: string = 'DataRestoreError';
}

export class DataRestorePathError extends DataRestoreError {
  public override readonly name = 'DataRestorePathError';
}

export class DataRestoreTargetExistsError extends DataRestoreError {
  public override readonly name = 'DataRestoreTargetExistsError';
}

export class DataRestoreCollisionError extends DataRestoreError {
  public override readonly name = 'DataRestoreCollisionError';
}

export class DataRestoreIntegrityError extends DataRestoreError {
  public override readonly name = 'DataRestoreIntegrityError';
}

export class DataRestoreCleanupError extends DataRestoreError {
  public override readonly name = 'DataRestoreCleanupError';
}

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

function missing(error: unknown): boolean {
  return isCode(error, 'ENOENT');
}

function publicError(error: unknown): Error {
  if (error instanceof DataRestoreError) return error;
  if (error instanceof DataArchiveFormatError || error instanceof DataArchiveError) {
    return new DataRestoreIntegrityError('Data restore bundle verification failed.');
  }
  if (error instanceof AdapterManifestError || error instanceof AdapterSourcePolicyError) {
    return new DataRestoreIntegrityError('A trusted adapter failed restore validation.');
  }
  return new DataRestoreError('Data restore operation failed.');
}

function assertContained(rootPath: string, candidatePath: string): void {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const relationship = relative(root, candidate);
  if (
    relationship === '..'
    || relationship.startsWith(`..${sep}`)
    || relationship.startsWith(sep)
  ) throw new DataRestorePathError('Data restore path escapes its parent.');
}

function assertDisjoint(first: string, second: string): void {
  const left = resolve(first);
  const right = resolve(second);
  if (left === right) throw new DataRestorePathError('The restore bundle and target must be separate paths.');
  const isWithin = (root: string, candidate: string): boolean => {
    const relationship = relative(root, candidate);
    return relationship === ''
      || (relationship !== '..'
        && !relationship.startsWith(`..${sep}`)
        && !relationship.startsWith(sep));
  };
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new DataRestorePathError('The restore bundle and target may not contain one another.');
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
  ) throw new DataRestorePathError('Data restore contains an unsafe filename.');
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
    throw new DataRestorePathError('Data restore directory depth exceeds the limit.');
  }
  state.directoryCount += 1;
  if (state.directoryCount > MAX_DIRECTORY_COUNT) {
    throw new DataRestoreError('Data restore directory count exceeds the limit.');
  }
  const handle = await fsops.opendir(directory);
  try {
    const entries: Dirent[] = [];
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      state.entryCount += 1;
      if (state.entryCount > MAX_DIRECTORY_ENTRIES) {
        throw new DataRestoreError('Data restore directory entry count exceeds the limit.');
      }
      entries.push(entry);
    }
    return entries.sort((left, right) => compareArchivePath(left.name, right.name));
  } finally {
    await handle.close();
  }
}

async function assertCanonicalDirectory(
  fsops: DataArchiveFsOps,
  rootPath: string,
  directoryPath: string,
): Promise<void> {
  const root = resolve(rootPath);
  const directory = resolve(directoryPath);
  assertContained(root, directory);
  const stats = await fsops.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new DataRestorePathError('Data restore directories must be canonical 0700 directories.');
  }
  if (await fsops.realpath(directory) !== directory) {
    throw new DataRestorePathError('Data restore directories must use canonical paths.');
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
    entries.push({ dev: stats.dev, ino: stats.ino, mode: stats.mode & 0o777, path: cursor });
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
    ) throw new DataRestorePathError('Data restore parent directory changed during the operation.');
  }
}

async function assertRegularFile(
  fsops: DataArchiveFsOps,
  path: string,
  expectedMode?: number,
): Promise<Stats> {
  const stats = await fsops.lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new DataRestorePathError('Data restore files must be regular files without hardlink aliases.');
  }
  if (expectedMode !== undefined && (stats.mode & 0o777) !== expectedMode) {
    throw new DataRestorePathError('Data restore files have an unsafe mode.');
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new DataRestorePathError('Data restore file size is invalid.');
  }
  return stats;
}

async function ensureDirectory(
  fsops: DataArchiveFsOps,
  rootPath: string,
  directoryPath: string,
): Promise<void> {
  const root = resolve(rootPath);
  const directory = resolve(directoryPath);
  assertContained(root, directory);
  const relationship = relative(root, directory);
  const segments = relationship === '' ? [] : relationship.split(sep);
  let cursor = root;
  for (const segment of segments) {
    safeName(segment);
    cursor = resolve(cursor, segment);
    try {
      await fsops.lstat(cursor);
    } catch (error) {
      if (!missing(error)) throw error;
      await fsops.mkdir(cursor, { mode: DIRECTORY_MODE, recursive: false });
    }
    await fsops.chmod(cursor, DIRECTORY_MODE);
    await assertCanonicalDirectory(fsops, root, cursor);
  }
  if (segments.length === 0) {
    await fsops.chmod(root, DIRECTORY_MODE);
    await assertCanonicalDirectory(fsops, root, root);
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
    ) throw new DataRestorePathError('Data restore directory reservation is unsafe.');
    return stats;
  } finally {
    await handle.close();
  }
}

function assertDirectoryIdentity(current: Stats, expected: Stats, message: string): void {
  if (
    !current.isDirectory()
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || (current.mode & 0o777) !== DIRECTORY_MODE
    || !Number.isSafeInteger(current.nlink)
    || current.nlink < 2
  ) throw new DataRestoreCollisionError(message);
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new DataRestoreError('Data restore file write made no progress.');
    }
    offset += result.bytesWritten;
  }
}

async function copyPayload(
  fsops: DataArchiveFsOps,
  source: string,
  destination: string,
  entry: DataArchiveEntry,
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const sourceParentChain = await captureDirectoryChain(fsops, sourceRoot, dirname(source));
  const destinationParentChain = await captureDirectoryChain(fsops, destinationRoot, dirname(destination));
  await assertDirectoryChainUnchanged(fsops, sourceParentChain);
  await assertDirectoryChainUnchanged(fsops, destinationParentChain);
  const sourceStats = await assertRegularFile(fsops, source);
  if (sourceStats.size !== entry.size) throw new DataRestoreIntegrityError('Restore payload size does not match its manifest.');
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
      || opened.size !== sourceStats.size
    ) throw new DataRestoreIntegrityError('Restore source changed while being copied.');
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
        throw new DataRestoreIntegrityError('Restore source read returned an invalid size.');
      }
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (!Number.isSafeInteger(size) || size > entry.size) {
        throw new DataRestoreIntegrityError('Restore source exceeds its manifest size.');
      }
      hash.update(buffer.subarray(0, result.bytesRead));
      await writeAll(output, buffer.subarray(0, result.bytesRead));
    }
    await output.sync();
    const sourceFinal = await input.stat();
    const destinationStats = await output.stat();
    const destinationPathStats = await assertRegularFile(fsops, destination, FILE_MODE);
    if (
      size !== entry.size
      || hash.digest('hex') !== entry.sha256
      || sourceFinal.dev !== sourceStats.dev
      || sourceFinal.ino !== sourceStats.ino
      || sourceFinal.nlink !== 1
      || sourceFinal.size !== sourceStats.size
      || destinationStats.dev !== destinationPathStats.dev
      || destinationStats.ino !== destinationPathStats.ino
      || destinationStats.size !== entry.size
      || destinationStats.nlink !== 1
    ) throw new DataRestoreIntegrityError('Restore payload changed while being copied.');
    await assertDirectoryChainUnchanged(fsops, sourceParentChain);
    await assertDirectoryChainUnchanged(fsops, destinationParentChain);
  } finally {
    if (output !== undefined) await output.close();
    await input.close();
  }
}

async function hashFile(
  fsops: DataArchiveFsOps,
  path: string,
  expectedSize: number,
  rootPath: string,
): Promise<{ readonly sha256: string; readonly size: number }> {
  const pathStats = await assertRegularFile(fsops, path);
  if (pathStats.size !== expectedSize) throw new DataRestoreIntegrityError('Restore file size changed during verification.');
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
    ) throw new DataRestoreIntegrityError('Restore file changed during verification.');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
    let size = 0;
    while (true) {
      const result = await file.read(buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.byteLength) {
        throw new DataRestoreIntegrityError('Restore file read returned an invalid size.');
      }
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (!Number.isSafeInteger(size) || size > expectedSize) throw new DataRestoreIntegrityError('Restore file exceeds its expected size.');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const finalStats = await file.stat();
    if (
      size !== expectedSize
      || finalStats.dev !== initial.dev
      || finalStats.ino !== initial.ino
      || finalStats.nlink !== 1
      || finalStats.size !== expectedSize
    ) throw new DataRestoreIntegrityError('Restore file changed during verification.');
    await assertDirectoryChainUnchanged(fsops, parentChain);
    return { sha256: hash.digest('hex'), size };
  } finally {
    await file.close();
  }
}

async function readBoundedFile(
  fsops: DataArchiveFsOps,
  path: string,
  maxBytes: number,
  rootPath: string,
): Promise<Buffer> {
  const stats = await assertRegularFile(fsops, path);
  if (stats.size > maxBytes) throw new DataRestoreIntegrityError('A restore adapter file exceeds its size limit.');
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
    ) throw new DataRestoreIntegrityError('A restore adapter file changed while being read.');
    const bytes = Buffer.allocUnsafe(stats.size);
    const chunk = Buffer.allocUnsafe(ARCHIVE_HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < stats.size) {
      const length = Math.min(chunk.byteLength, stats.size - offset);
      const result = await file.read(chunk, 0, length, null);
      if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length) {
        throw new DataRestoreIntegrityError('A restore adapter file read returned an invalid size.');
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
    ) throw new DataRestoreIntegrityError('A restore adapter file changed while being read.');
    await assertDirectoryChainUnchanged(fsops, parentChain);
    return bytes;
  } finally {
    await file.close();
  }
}

function expectedContentPrefix(role: unknown): string {
  if (role === 'output') return 'media/originals/';
  if (role === 'mask') return 'media/masks/';
  if (typeof role === 'string' && INPUT_ASSET_ROLES.has(role)) return 'media/uploads/';
  throw new DataRestoreIntegrityError('Restore database asset role is invalid.');
}

async function validateRestoredDatabase(
  fsops: DataArchiveFsOps,
  targetRoot: string,
  manifest: DataArchiveManifest,
): Promise<void> {
  const map = archiveEntryMap(manifest);
  const databaseEntry = map.get('database/app.db');
  if (databaseEntry === undefined) throw new DataRestoreIntegrityError('Restore database entry is missing.');
  const databasePath = join(targetRoot, 'app.db');
  const metadata = await hashFile(fsops, databasePath, databaseEntry.size, targetRoot);
  if (metadata.sha256 !== databaseEntry.sha256) throw new DataRestoreIntegrityError('Restored database digest does not match its manifest.');
  let sqlite: Database.Database | undefined;
  let failure: unknown;
  const validatedMedia = new Map<string, { readonly sha256: string; readonly size: number }>();
  try {
    sqlite = new Database(databasePath, { fileMustExist: true, readonly: true });
    sqlite.pragma('foreign_keys = ON');
    if (!checkSqliteIntegrity(sqlite).ok) throw new DataRestoreIntegrityError('Restored database integrity validation failed.');
    const rows = sqlite.prepare(
      'SELECT file_path AS filePath, thumbnail_path AS thumbnailPath, poster_path AS posterPath, role, file_size AS fileSize, sha256 FROM assets',
    ).iterate() as Iterable<unknown>;
    let rowCount = 0;
    for (const row of rows) {
      rowCount += 1;
      if (rowCount > MAX_ARCHIVE_ENTRIES) throw new DataRestoreIntegrityError('Restored database contains too many asset rows.');
      if (row === null || typeof row !== 'object') throw new DataRestoreIntegrityError('Restored database asset row is invalid.');
      const record = row as Record<string, unknown>;
      const contentPrefix = expectedContentPrefix(record.role);
      const prefixes = new Map([
        ['filePath', contentPrefix],
        ['thumbnailPath', 'media/thumbnails/'],
        ['posterPath', 'media/posters/'],
      ]);
      for (const key of ['filePath', 'thumbnailPath', 'posterPath']) {
        const value = record[key];
        if (value === null && key !== 'filePath') continue;
        const prefix = prefixes.get(key)!;
        const entry = typeof value === 'string' ? map.get(value) : undefined;
        if (entry === undefined || typeof value !== 'string' || !value.startsWith(prefix)) {
          throw new DataRestoreIntegrityError('Restored database references an invalid media path.');
        }
        let actual = validatedMedia.get(value);
        if (actual === undefined) {
          actual = await hashFile(fsops, join(targetRoot, ...value.split('/')), entry.size, targetRoot);
          validatedMedia.set(value, actual);
        }
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
          throw new DataRestoreIntegrityError('Restored database media path digest does not match its manifest.');
        }
      }
      const content = map.get(record.filePath as string);
      if (content === undefined || content.size !== record.fileSize || content.sha256 !== record.sha256) {
        throw new DataRestoreIntegrityError('Restored database media metadata does not match its file.');
      }
    }
  } catch (error) {
    failure = error;
  }
  if (sqlite !== undefined) {
    try {
      sqlite.close();
    } catch {
      failure = new DataRestoreIntegrityError('Restored database could not be closed after validation.');
    }
  }
  await removeFileIfPresent(fsops, `${databasePath}-wal`);
  await removeFileIfPresent(fsops, `${databasePath}-shm`);
  if (failure !== undefined) {
    if (failure instanceof DataRestoreError) throw failure;
    throw new DataRestoreIntegrityError('Restored database validation failed.');
  }
}

async function validateRestoredAdapters(
  fsops: DataArchiveFsOps,
  targetRoot: string,
  manifest: DataArchiveManifest,
): Promise<void> {
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (!entry.path.startsWith('adapters/')) continue;
    const id = entry.path.split('/')[1];
    if (id !== undefined) ids.add(id);
  }
  for (const id of [...ids].sort(compareArchivePath)) {
    const manifestPath = join(targetRoot, 'adapters', id, 'manifest.json');
    const sourcePath = join(targetRoot, 'adapters', id, 'adapter.mjs');
    const manifestBytes = await readBoundedFile(fsops, manifestPath, MAX_MANIFEST_BYTES, targetRoot);
    const sourceBytes = await readBoundedFile(fsops, sourcePath, MAX_ADAPTER_SOURCE_BYTES, targetRoot);
    const adapterManifest = parseBoundedManifestJson(manifestBytes);
    if (adapterManifest.id !== id) throw new DataRestoreIntegrityError('Restored adapter path does not match its manifest.');
    const source = validateAdapterSource(sourceBytes);
    if (digestAdapterSource(sourceBytes) !== adapterManifest.sha256) throw new DataRestoreIntegrityError('Restored adapter digest does not match its manifest.');
    validateAdapterExports(source, adapterManifest);
  }
}

async function removeFileIfPresent(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    await fsops.unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function removeIfPresent(fsops: DataArchiveFsOps, path: string): Promise<void> {
  try {
    await fsops.rm(path, { force: true, recursive: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function removeTreeIfOwned(
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
  await removeIfPresent(fsops, path);
}

/**
 * Remove only an empty directory created by this restore attempt. When the
 * ownership stat was unavailable, the exclusive mkdir is the only ownership
 * evidence available, so canonical/0700/empty checks are required before the
 * non-recursive removal.
 */
async function removeEmptyDirectoryIfOwned(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats | undefined,
): Promise<void> {
  let current: Stats;
  try {
    current = await fsops.lstat(path);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || (current.mode & 0o777) !== DIRECTORY_MODE
    || !Number.isSafeInteger(current.nlink)
    || current.nlink < 2
  ) return;
  if (
    expected !== undefined
    && (current.dev !== expected.dev || current.ino !== expected.ino)
  ) return;
  try {
    if (await fsops.realpath(path) !== resolve(path)) return;
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  if ((await listEntries(fsops, path, newDirectoryScanState(), 0)).length !== 0) return;
  const final = await fsops.lstat(path);
  if (
    final.isSymbolicLink()
    || !final.isDirectory()
    || (final.mode & 0o777) !== DIRECTORY_MODE
    || !Number.isSafeInteger(final.nlink)
    || final.nlink < 2
    || (expected !== undefined && (final.dev !== expected.dev || final.ino !== expected.ino))
    || final.dev !== current.dev
    || final.ino !== current.ino
  ) return;
  try {
    await fsops.rmdir(path);
  } catch (error) {
    // A concurrent writer that made the directory non-empty is not ours to
    // remove; retain it and report the original restore failure.
    if (isCode(error, 'ENOENT') || isCode(error, 'ENOTEMPTY') || isCode(error, 'EEXIST')) return;
    throw error;
  }
}

async function removeEmptyReservationIfOwned(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
): Promise<void> {
  await removeEmptyDirectoryIfOwned(fsops, path, expected);
}

async function removePublishedTargetIfOwned(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
  manifest: DataArchiveManifest,
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
    await assertTargetLayout(fsops, path, manifest);
    for (const entry of manifest.entries) {
      const metadata = await hashFile(
        fsops,
        join(path, ...targetRelativePath(entry.path).split('/')),
        entry.size,
        path,
      );
      if (metadata.sha256 !== entry.sha256) return;
    }
    await validateRestoredDatabase(fsops, path, manifest);
    await validateRestoredAdapters(fsops, path, manifest);
  } catch {
    return;
  }
  await removeIfPresent(fsops, path);
}

async function assertEmptyTargetReservation(
  fsops: DataArchiveFsOps,
  path: string,
  expected: Stats,
): Promise<void> {
  assertDirectoryIdentity(await fsops.lstat(path), expected, 'Restore target reservation is no longer owned.');
  if ((await listEntries(fsops, path, newDirectoryScanState(), 0)).length !== 0) {
    throw new DataRestoreCollisionError('Restore target reservation is no longer empty.');
  }
  assertDirectoryIdentity(await fsops.lstat(path), expected, 'Restore target reservation is no longer owned.');
}

function targetRelativePath(archivePath: string): string {
  return archivePath === 'database/app.db' ? 'app.db' : archivePath;
}

async function assertTargetLayout(
  fsops: DataArchiveFsOps,
  target: string,
  manifest: DataArchiveManifest,
): Promise<readonly string[]> {
  const expectedFiles = new Set<string>();
  const expectedDirectories = new Set<string>([
    'media',
    'adapters',
    'backups',
    'logs',
    ...MEDIA_DIRECTORY_NAMES.map((name) => `media/${name}`),
    'media/temp',
    'adapters/.staging',
  ]);
  for (const entry of manifest.entries) {
    const destination = targetRelativePath(entry.path);
    expectedFiles.add(destination);
    const segments = destination.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  const foundFiles = new Set<string>();
  const foundDirectories = new Set<string>();
  const scan = newDirectoryScanState();
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    for (const entry of await listEntries(fsops, directory, scan, depth)) {
      safeName(entry.name);
      const path = join(directory, entry.name);
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const stats = await fsops.lstat(path);
      if (stats.isSymbolicLink()) throw new DataRestorePathError('Restored data root may not contain symlinks.');
      if (stats.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) throw new DataRestorePathError('Restored data root contains an unexpected directory.');
        await assertCanonicalDirectory(fsops, target, path);
        foundDirectories.add(relativePath);
        await walk(path, relativePath, depth + 1);
      } else if (stats.isFile()) {
        if (!expectedFiles.has(relativePath)) throw new DataRestorePathError('Restored data root contains an unexpected file.');
        await assertRegularFile(fsops, path, FILE_MODE);
        foundFiles.add(relativePath);
      } else {
        throw new DataRestorePathError('Restored data root contains a non-regular entry.');
      }
    }
  };
  await walk(target, '', 0);
  for (const directory of expectedDirectories) {
    if (!foundDirectories.has(directory)) throw new DataRestoreIntegrityError('Restored data root layout is incomplete.');
  }
  if (foundFiles.size !== expectedFiles.size || [...expectedFiles].some((path) => !foundFiles.has(path))) {
    throw new DataRestoreIntegrityError('Restored data root payload is incomplete.');
  }
  return [target, ...[...foundDirectories].map((path) => join(target, ...path.split('/')))]
    .sort((left, right) => right.length - left.length);
}

export class DataRestore {
  private readonly fsops: DataArchiveFsOps;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly stageIdFactory: () => string;

  public constructor(options: DataRestoreOptions) {
    this.fsops = { ...defaultFsOps, ...(options.fsops ?? {}) };
    this.maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
    this.maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
    this.stageIdFactory = options.stageIdFactory ?? randomUUID;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_ARCHIVE_BYTES) {
      throw new RangeError('maxBytes is outside the restore limit.');
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > MAX_ARCHIVE_ENTRIES) {
      throw new RangeError('maxEntries is outside the restore limit.');
    }
  }

  public async restore(bundlePath: string, targetPath: string): Promise<DataRestoreResult> {
    let stage: string | undefined;
    let stageCreated = false;
    let stageOwnershipStats: Stats | undefined;
    let target: string | undefined;
    let targetReserved = false;
    let targetMutated = false;
    let publicationAttempted = false;
    let stageStats: Stats | undefined;
    let targetReservationStats: Stats | undefined;
    let parentChain: DirectoryChain | undefined;
    let manifest: DataArchiveManifest | undefined;
    try {
      const bundle = resolve(bundlePath);
      target = resolve(targetPath);
      assertDisjoint(bundle, target);
      const parent = dirname(target);
      await assertCanonicalDirectory(this.fsops, parent, parent);
      parentChain = await captureDirectoryChain(this.fsops, parent, parent);
      try {
        await this.fsops.lstat(target);
        throw new DataRestoreTargetExistsError('Restore target must not already exist.');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const verified = await verifyDataArchive(bundle, { fsops: this.fsops });
      manifest = verified.manifest;
      if (verified.bytes > this.maxBytes || verified.entries > this.maxEntries) {
        throw new DataRestoreError('Restore bundle exceeds its configured bounds.');
      }
      const stageId = this.stageIdFactory();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(stageId)) throw new DataRestoreError('Restore staging identifier is invalid.');
      stage = join(parent, `${RESTORE_STAGING_PREFIX}${stageId}`);
      assertContained(parent, stage);
      try {
        await this.fsops.mkdir(stage, { mode: DIRECTORY_MODE, recursive: false });
      } catch (error) {
        if (isCode(error, 'EEXIST')) throw new DataRestoreCollisionError('Restore staging destination already exists.');
        throw error;
      }
      stageCreated = true;
      await this.fsops.chmod(stage, DIRECTORY_MODE);
      stageOwnershipStats = await openDirectoryStats(this.fsops, stage);
      const stageDirs = [
        join(stage, 'media'),
        ...MEDIA_DIRECTORY_NAMES.map((name) => join(stage!, 'media', name)),
        join(stage, 'media', 'temp'),
        join(stage, 'adapters'),
        join(stage, 'adapters', '.staging'),
        join(stage, 'backups'),
        join(stage, 'logs'),
      ];
      for (const directory of stageDirs) await ensureDirectory(this.fsops, stage, directory);
      let totalBytes = 0;
      let copiedEntries = 0;
      for (const entry of manifest.entries) {
        copiedEntries += 1;
        totalBytes += entry.size;
        if (copiedEntries > this.maxEntries || !Number.isSafeInteger(totalBytes) || totalBytes > this.maxBytes) {
          throw new DataRestoreError('Restore bundle exceeds its configured bounds.');
        }
        const source = join(bundle, ...entry.path.split('/'));
        const destinationRelative = targetRelativePath(entry.path);
        const destination = join(stage, ...destinationRelative.split('/'));
        assertContained(bundle, source);
        assertContained(stage, destination);
        const parentDirectory = dirname(destination);
        await ensureDirectory(this.fsops, stage, parentDirectory);
        await copyPayload(this.fsops, source, destination, entry, bundle, stage);
      }
      await validateRestoredDatabase(this.fsops, stage, manifest);
      await validateRestoredAdapters(this.fsops, stage, manifest);
      const stageDirectories = await assertTargetLayout(this.fsops, stage, manifest);
      for (const directory of stageDirectories) await syncDirectory(this.fsops, directory);
      await syncDirectory(this.fsops, parent);
      await assertDirectoryChainUnchanged(this.fsops, parentChain);

      await assertDirectoryChainUnchanged(this.fsops, parentChain);
      try {
        await this.fsops.lstat(target);
        throw new DataRestoreTargetExistsError('Restore target must not already exist.');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      try {
        await this.fsops.mkdir(target, { mode: DIRECTORY_MODE, recursive: false });
      } catch (error) {
        if (isCode(error, 'EEXIST')) throw new DataRestoreCollisionError('Restore target destination already exists.');
        throw error;
      }
      targetReserved = true;
      targetMutated = true;
      targetReservationStats = await openDirectoryStats(this.fsops, target);
      await assertEmptyTargetReservation(this.fsops, target, targetReservationStats);
      await assertDirectoryChainUnchanged(this.fsops, parentChain);
      stageStats = await openDirectoryStats(this.fsops, stage);
      assertDirectoryIdentity(await this.fsops.lstat(stage), stageStats, 'Restore staging directory changed before publication.');
      // Repeat the reservation check immediately before rename. Node does not
      // expose renameat2-style exchange/no-replace semantics for directories.
      await assertEmptyTargetReservation(this.fsops, target, targetReservationStats);
      publicationAttempted = true;
      await this.fsops.rename(stage, target);
      stage = undefined;
      targetReserved = false;
      await assertDirectoryChainUnchanged(this.fsops, parentChain);
      assertDirectoryIdentity(
        await this.fsops.lstat(target),
        stageStats,
        'Published restore target does not match the staging directory.',
      );
      await syncDirectory(this.fsops, parent);
      await assertDirectoryChainUnchanged(this.fsops, parentChain);
      return {
        bytes: totalBytes,
        createdAt: new Date(verified.createdAt.getTime()),
        entries: copiedEntries,
        targetPath: target,
      };
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (stageCreated && stage !== undefined) {
        try {
          if (stageOwnershipStats === undefined) {
            await removeEmptyDirectoryIfOwned(this.fsops, stage, undefined);
          } else {
            await removeTreeIfOwned(this.fsops, stage, stageOwnershipStats);
          }
        } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (target !== undefined && (targetReserved || targetMutated || publicationAttempted)) {
        try {
          if (targetReserved && targetReservationStats !== undefined) {
            await removeEmptyReservationIfOwned(this.fsops, target, targetReservationStats);
          } else if (targetReserved) {
            await removeEmptyDirectoryIfOwned(this.fsops, target, undefined);
          }
          if (publicationAttempted && manifest !== undefined && stageStats !== undefined) {
            // Only the pre-rename staging inode is owned by this invocation;
            // a post-rename replacement must remain untouched.
            await removePublishedTargetIfOwned(this.fsops, target, stageStats, manifest);
          }
        } catch (cleanupError) {
          if (!missing(cleanupError)) cleanupFailures.push(cleanupError);
        }
      }
      if (parentChain !== undefined && (stageCreated || targetMutated || publicationAttempted)) {
        try {
          await assertDirectoryChainUnchanged(this.fsops, parentChain);
          await syncDirectory(this.fsops, parentChain.entries.at(-1)!.path);
          await assertDirectoryChainUnchanged(this.fsops, parentChain);
        } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      }
      if (cleanupFailures.length > 0) throw new DataRestoreCleanupError('Data restore cleanup failed.');
      throw publicError(error);
    }
  }
}

export async function restoreDataArchive(options: DataRestoreOptions): Promise<DataRestoreResult> {
  return new DataRestore(options).restore(options.bundlePath, options.targetPath);
}

export { DataRestore as DataRestoreService };
