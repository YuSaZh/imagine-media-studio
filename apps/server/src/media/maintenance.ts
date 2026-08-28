import { createHash } from 'node:crypto';
import {
  lstat,
  opendir,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MAX_GENERATION_COUNT } from '@imagine/shared';

import type { JobMaintenanceRecord } from '../database/jobs.js';
import {
  assertNoSymlinkTraversal,
  openStoredFile,
  resolveStoredPath,
  toStoredPath,
  UnsafeStoragePathError,
} from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';
import type { AssetMediaRepositoryPort, AssetMediaRecord } from './types.js';

const TEMPORARY_NAME = /^ims-[0-9a-f-]{36}\.(?:part|poster\.jpg)$/i;
const PROVIDER_RESULTS_DIRECTORY = 'provider-results';
const PROVIDER_JOB_KEY = /^[a-f0-9]{64}$/u;
const PROVIDER_MANIFEST_NAME = /^slot-(\d{4})\.json$/u;
const PROVIDER_OUTPUT_EXTENSIONS = ['avif', 'gif', 'jpg', 'mov', 'mp4', 'png', 'webm', 'webp'] as const;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_STORED_PATH_LENGTH = 4_096;
const MAX_ASSET_ID_LENGTH = 255;
const UNSAFE_PATH_SENTINEL = '<unsafe-path>';
const PATH_TOO_LONG_SENTINEL = '<path-too-long>';
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'rejected', 'expired']);
const ACTIVE_JOB_STATUSES = new Set([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
]);

export const DEFAULT_MEDIA_CONSISTENCY_LIMITS = {
  maxAssets: 10_000,
  maxFiles: 20_000,
  maxHashedBytes: 512 * 1024 * 1024,
  maxIssues: 100,
} as const;

const MAX_MEDIA_CONSISTENCY_LIMITS = {
  maxAssets: 100_000,
  maxFiles: 200_000,
  maxHashedBytes: 4 * 1024 * 1024 * 1024,
  maxIssues: 1_000,
} as const;

export interface MediaConsistencyLimits {
  readonly maxAssets: number;
  readonly maxFiles: number;
  readonly maxHashedBytes: number;
  readonly maxIssues: number;
}

export interface MediaConsistencyIssue {
  readonly assetId: string | null;
  readonly kind: 'hash_mismatch' | 'missing' | 'orphan' | 'size_mismatch' | 'unsafe' | 'unreadable';
  readonly storedPath: string;
}

export interface MediaConsistencyReport {
  readonly assetCount: number;
  readonly fileCount: number;
  readonly hashedBytes: number;
  readonly issueCount: number;
  readonly issues: readonly MediaConsistencyIssue[];
  readonly ok: boolean;
  readonly truncated: boolean;
}

export interface TemporaryCleanupResult {
  readonly removed: readonly string[];
  readonly skipped: readonly string[];
}

export interface MaintenanceJobPort {
  listForMaintenance(options?: { readonly limit?: number }):
    | readonly JobMaintenanceRecord[]
    | Promise<readonly JobMaintenanceRecord[]>;
}

export interface ProviderOutputCleanupResult {
  readonly inspected: number;
  readonly preserved: number;
  readonly removed: number;
  readonly truncated: boolean;
}

interface ScanState {
  readonly issues: MediaConsistencyIssue[];
  assetCount: number;
  fileCount: number;
  hashedBytes: number;
  issueCount: number;
  truncated: boolean;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function resolveLimits(input: Partial<MediaConsistencyLimits> | undefined): MediaConsistencyLimits {
  const values = {
    ...DEFAULT_MEDIA_CONSISTENCY_LIMITS,
    ...(input ?? {}),
  };
  for (const [name, value] of Object.entries(values)) {
    const maximum = MAX_MEDIA_CONSISTENCY_LIMITS[name as keyof typeof MAX_MEDIA_CONSISTENCY_LIMITS];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(`Media consistency ${name} is outside its safety limit.`);
    }
  }
  return values;
}

function boundedStoredPath(value: string): string {
  if (value.length > MAX_STORED_PATH_LENGTH) return PATH_TOO_LONG_SENTINEL;
  if (value === UNSAFE_PATH_SENTINEL || value === PATH_TOO_LONG_SENTINEL) return value;
  const segments = value.split('/');
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    WINDOWS_DRIVE_PATH.test(value) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return UNSAFE_PATH_SENTINEL;
  }
  return value;
}

function boundedAssetId(value: string): string {
  return value.length <= MAX_ASSET_ID_LENGTH ? value : '<asset-id-too-long>';
}

function addIssue(
  state: ScanState,
  limits: MediaConsistencyLimits,
  assetId: string | null,
  kind: MediaConsistencyIssue['kind'],
  storedPath: string,
): void {
  state.issueCount += 1;
  if (state.issues.length >= limits.maxIssues) {
    state.truncated = true;
    return;
  }
  state.issues.push({
    assetId: assetId === null ? null : boundedAssetId(assetId),
    kind,
    storedPath: boundedStoredPath(storedPath),
  });
}

function reserveAsset(state: ScanState, limits: MediaConsistencyLimits): boolean {
  if (state.assetCount >= limits.maxAssets) {
    state.truncated = true;
    return false;
  }
  state.assetCount += 1;
  return true;
}

function reserveFile(state: ScanState, limits: MediaConsistencyLimits): boolean {
  if (state.fileCount >= limits.maxFiles) {
    state.truncated = true;
    return false;
  }
  state.fileCount += 1;
  return true;
}

function reserveHash(state: ScanState, limits: MediaConsistencyLimits, bytes: number): boolean {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > limits.maxHashedBytes - state.hashedBytes
  ) {
    state.truncated = true;
    return false;
  }
  state.hashedBytes += bytes;
  return true;
}

function reportFor(state: ScanState): MediaConsistencyReport {
  return {
    assetCount: state.assetCount,
    fileCount: state.fileCount,
    hashedBytes: state.hashedBytes,
    issueCount: state.issueCount,
    issues: state.issues,
    ok: state.issueCount === 0 && !state.truncated,
    truncated: state.truncated,
  };
}

function storedDirectory(dataRoot: string, directory: string): string {
  return toStoredPath(dataRoot, resolve(directory));
}

function pathUnderDirectory(storedPath: string, directory: string): boolean {
  return storedPath.startsWith(`${directory}/`);
}

function contentDirectory(paths: StoragePaths, asset: AssetMediaRecord): string {
  if (asset.role === 'output') return paths.originals;
  if (asset.role === 'mask') return paths.masks;
  return paths.uploads;
}

function expectedDirectory(
  paths: StoragePaths,
  asset: AssetMediaRecord,
  variant: 'content' | 'poster' | 'thumbnail',
): string {
  if (variant === 'content') return storedDirectory(paths.root, contentDirectory(paths, asset));
  return storedDirectory(paths.root, variant === 'poster' ? paths.posters : paths.thumbnails);
}

function safeAssetPath(
  paths: StoragePaths,
  asset: AssetMediaRecord,
  variant: 'content' | 'poster' | 'thumbnail',
  storedPath: string,
): boolean {
  try {
    resolveStoredPath(paths.root, storedPath);
  } catch {
    return false;
  }
  return pathUnderDirectory(storedPath, expectedDirectory(paths, asset, variant));
}

async function hashFile(
  file: FileHandle,
  expectedSize: number,
  state: ScanState,
  limits: MediaConsistencyLimits,
): Promise<string | null> {
  if (!reserveHash(state, limits, expectedSize)) return null;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let bytes = 0;
  while (bytes < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - bytes);
    const result = await file.read(buffer, 0, length, null);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length) {
      throw new Error('Media consistency read returned an invalid size.');
    }
    bytes += result.bytesRead;
    hash.update(buffer.subarray(0, result.bytesRead));
  }
  if ((await file.stat()).size !== expectedSize) {
    throw new Error('Media consistency file changed while it was being checked.');
  }
  return hash.digest('hex');
}

async function inspectAssetPath(
  paths: StoragePaths,
  asset: AssetMediaRecord,
  variant: 'content' | 'poster' | 'thumbnail',
  storedPath: string,
  state: ScanState,
  limits: MediaConsistencyLimits,
): Promise<void> {
  if (!safeAssetPath(paths, asset, variant, storedPath)) {
    addIssue(state, limits, asset.id, 'unsafe', storedPath);
    return;
  }

  let file: FileHandle | undefined;
  try {
    file = await openStoredFile(paths.root, storedPath);
    const stats = await file.stat();
    if (!stats.isFile()) {
      addIssue(state, limits, asset.id, 'missing', storedPath);
      return;
    }
    if (variant !== 'content') return;
    if (!Number.isSafeInteger(stats.size) || stats.size !== asset.fileSize) {
      addIssue(state, limits, asset.id, 'size_mismatch', storedPath);
    }
    if (!Number.isSafeInteger(stats.size)) return;
    const actualHash = await hashFile(file, stats.size, state, limits);
    if (actualHash !== null && actualHash !== asset.sha256) {
      addIssue(state, limits, asset.id, 'hash_mismatch', storedPath);
    }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      addIssue(state, limits, asset.id, 'missing', storedPath);
    } else if (error instanceof UnsafeStoragePathError) {
      addIssue(state, limits, asset.id, 'unsafe', storedPath);
    } else {
      addIssue(state, limits, asset.id, 'unreadable', storedPath);
    }
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function listManagedFiles(
  paths: StoragePaths,
  directoryPath: string,
  expected: ReadonlySet<string>,
  state: ScanState,
  limits: MediaConsistencyLimits,
): Promise<void> {
  const pending = [resolve(directoryPath)];
  while (pending.length > 0 && !state.truncated) {
    const current = pending.pop()!;
    try {
      await assertNoSymlinkTraversal(paths.root, current, false);
      const directory = await opendir(current);
      for await (const entry of directory) {
        if (!reserveFile(state, limits)) return;
        const absolutePath = join(current, entry.name);
        let storedPath: string;
        try {
          storedPath = toStoredPath(paths.root, absolutePath);
        } catch {
          addIssue(state, limits, null, 'unsafe', UNSAFE_PATH_SENTINEL);
          continue;
        }
        if (entry.isSymbolicLink()) {
          addIssue(state, limits, null, 'unsafe', storedPath);
        } else if (entry.isDirectory()) {
          pending.push(absolutePath);
        } else if (entry.isFile()) {
          if (!expected.has(storedPath)) addIssue(state, limits, null, 'orphan', storedPath);
        } else {
          addIssue(state, limits, null, 'unsafe', storedPath);
        }
      }
    } catch (error) {
      const storedPath = (() => {
        try {
          return toStoredPath(paths.root, current);
        } catch {
          return UNSAFE_PATH_SENTINEL;
        }
      })();
      addIssue(
        state,
        limits,
        null,
        isNodeError(error, 'ENOENT') ? 'missing' : 'unreadable',
        storedPath,
      );
    }
  }
}

export async function inspectMediaConsistency(options: {
  readonly jobs?: MaintenanceJobPort;
  readonly limits?: Partial<MediaConsistencyLimits>;
  readonly paths: StoragePaths;
  readonly repository: AssetMediaRepositoryPort;
}): Promise<MediaConsistencyReport> {
  const limits = resolveLimits(options.limits);
  const state: ScanState = {
    assetCount: 0,
    fileCount: 0,
    hashedBytes: 0,
    issueCount: 0,
    issues: [],
    truncated: false,
  };
  const assets = await options.repository.listForMaintenance({ limit: limits.maxAssets + 1 });
  const completeAssetSet = assets.length <= limits.maxAssets;
  const expected = new Set<string>();

  if (options.jobs !== undefined) {
    const jobs = await options.jobs.listForMaintenance({ limit: limits.maxAssets + 1 });
    if (jobs.length > limits.maxAssets) {
      state.truncated = true;
    } else {
      for (const job of jobs) {
        if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
        for (let slot = 0; slot < MAX_GENERATION_COUNT; slot += 1) {
          for (const path of providerOutputStoredPaths(options.paths, job.id, slot)) {
            expected.add(path);
          }
        }
      }
    }
  }

  for (const asset of assets.slice(0, limits.maxAssets)) {
    if (!reserveAsset(state, limits)) break;
    const assetPaths = [
      { path: asset.filePath, variant: 'content' as const },
      ...(asset.thumbnailPath === null ? [] : [{ path: asset.thumbnailPath, variant: 'thumbnail' as const }]),
      ...(asset.posterPath === null ? [] : [{ path: asset.posterPath, variant: 'poster' as const }]),
    ];
    for (const item of assetPaths) {
      if (safeAssetPath(options.paths, asset, item.variant, item.path)) expected.add(item.path);
      await inspectAssetPath(options.paths, asset, item.variant, item.path, state, limits);
      if (state.truncated) break;
    }
    if (state.truncated) break;
  }
  if (!completeAssetSet) state.truncated = true;
  if (!state.truncated && completeAssetSet) {
    for (const directory of [
      options.paths.originals,
      options.paths.thumbnails,
      options.paths.posters,
      options.paths.uploads,
      options.paths.masks,
    ]) {
      await listManagedFiles(options.paths, directory, expected, state, limits);
      if (state.truncated) break;
    }
  }
  return reportFor(state);
}

/** Backwards-compatible issue-only view used by existing media callers. */
export async function auditMediaConsistency(options: {
  readonly jobs?: MaintenanceJobPort;
  readonly limits?: Partial<MediaConsistencyLimits>;
  readonly paths: StoragePaths;
  readonly repository: AssetMediaRepositoryPort;
}): Promise<readonly MediaConsistencyIssue[]> {
  return (await inspectMediaConsistency(options)).issues;
}

export async function cleanupTemporaryMedia(options: {
  readonly dataRoot: string;
  readonly maxAgeMs: number;
  readonly now?: Date;
  readonly temporaryDirectory: string;
}): Promise<TemporaryCleanupResult> {
  if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new RangeError('maxAgeMs must be a non-negative safe integer.');
  }
  await assertNoSymlinkTraversal(options.dataRoot, options.temporaryDirectory, false);
  const directory = await opendir(options.temporaryDirectory);
  const removed: string[] = [];
  const skipped: string[] = [];
  const threshold = (options.now ?? new Date()).getTime() - options.maxAgeMs;
  for await (const entry of directory) {
    if (!TEMPORARY_NAME.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const path = join(options.temporaryDirectory, entry.name);
    const entryStat = await lstat(path);
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.mtimeMs > threshold) {
      skipped.push(entry.name);
      continue;
    }
    await rm(path, { force: true });
    removed.push(entry.name);
  }
  return { removed, skipped };
}

function providerJobKey(jobId: string): string {
  return createHash('sha256').update(`imagine-provider-output-v1\0${jobId}`).digest('hex');
}

function providerBasename(jobId: string, slot: number): string {
  return `job-${providerJobKey(jobId)}-slot-${String(slot).padStart(4, '0')}`;
}

function providerOutputStoredPaths(paths: StoragePaths, jobId: string, slot: number): readonly string[] {
  const basename = providerBasename(jobId, slot);
  return [
    ...PROVIDER_OUTPUT_EXTENSIONS.map((extension) => toStoredPath(paths.root, join(paths.originals, `${basename}.${extension}`))),
    toStoredPath(paths.root, join(paths.thumbnails, `${basename}.webp`)),
    toStoredPath(paths.root, join(paths.posters, `${basename}.jpg`)),
  ];
}

async function removeOwnedFile(
  dataRoot: string,
  storedPath: string,
): Promise<'removed' | 'missing' | 'preserved'> {
  let absolutePath: string;
  try {
    absolutePath = resolveStoredPath(dataRoot, storedPath);
    await assertNoSymlinkTraversal(dataRoot, absolutePath, false);
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? 'missing' : 'preserved';
  }
  try {
    const entry = await lstat(absolutePath);
    if (!entry.isFile() || entry.isSymbolicLink()) return 'preserved';
    await unlink(absolutePath);
    return 'removed';
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? 'missing' : 'preserved';
  }
}

/**
 * Remove only deterministic provider provisional outputs belonging to terminal
 * Jobs. Unknown or active Job directories are deliberately left untouched.
 */
export async function cleanupTerminalProviderOutputs(options: {
  readonly jobs: MaintenanceJobPort;
  readonly limits?: Partial<MediaConsistencyLimits>;
  readonly paths: StoragePaths;
  readonly repository: AssetMediaRepositoryPort;
}): Promise<ProviderOutputCleanupResult> {
  const limits = resolveLimits(options.limits);
  const jobs = await options.jobs.listForMaintenance({ limit: limits.maxAssets + 1 });
  const assets = await options.repository.listForMaintenance({ limit: limits.maxAssets + 1 });
  if (jobs.length > limits.maxAssets || assets.length > limits.maxAssets) {
    return { inspected: 0, preserved: 0, removed: 0, truncated: true };
  }
  const references = new Set<string>();
  for (const asset of assets) {
    references.add(asset.filePath);
    if (asset.thumbnailPath !== null) references.add(asset.thumbnailPath);
    if (asset.posterPath !== null) references.add(asset.posterPath);
  }
  const jobsByKey = new Map(jobs.map((job) => [providerJobKey(job.id), job]));
  const providerRoot = join(options.paths.temporary, PROVIDER_RESULTS_DIRECTORY);
  try {
    await assertNoSymlinkTraversal(options.paths.root, providerRoot, false);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { inspected: 0, preserved: 0, removed: 0, truncated: false };
    return { inspected: 0, preserved: 1, removed: 0, truncated: true };
  }

  let inspected = 0;
  let preserved = 0;
  let removed = 0;
  let truncated = false;
  let rootDirectory;
  try {
    rootDirectory = await opendir(providerRoot);
  } catch {
    return { inspected: 0, preserved: 1, removed: 0, truncated: true };
  }
  for await (const directoryEntry of rootDirectory) {
    if (inspected >= limits.maxFiles) {
      truncated = true;
      break;
    }
    inspected += 1;
    if (!directoryEntry.isDirectory() || !PROVIDER_JOB_KEY.test(directoryEntry.name)) {
      preserved += 1;
      continue;
    }
    const job = jobsByKey.get(directoryEntry.name);
    const directoryPath = join(providerRoot, directoryEntry.name);
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) {
      preserved += 1;
      continue;
    }
    try {
      await assertNoSymlinkTraversal(options.paths.root, directoryPath, false);
    } catch {
      preserved += 1;
      continue;
    }
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      preserved += 1;
      continue;
    }
    for await (const entry of directory) {
      if (inspected >= limits.maxFiles) {
        truncated = true;
        break;
      }
      inspected += 1;
      const match = PROVIDER_MANIFEST_NAME.exec(entry.name);
      if (!entry.isFile() || match === null) {
        preserved += 1;
        continue;
      }
      const slot = Number(match[1]);
      if (slot < 0 || slot >= MAX_GENERATION_COUNT) {
        preserved += 1;
        continue;
      }
      const manifestStoredPath = toStoredPath(options.paths.root, join(directoryPath, entry.name));
      const outputPaths = providerOutputStoredPaths(options.paths, job.id, slot);
      const referenced = outputPaths.some((path) => references.has(path));
      if (referenced && job.status !== 'completed') {
        preserved += 1;
        continue;
      }
      if (referenced && job.status === 'completed') {
        const result = await removeOwnedFile(options.paths.root, manifestStoredPath);
        if (result === 'removed') removed += 1;
        else if (result === 'preserved') preserved += 1;
        continue;
      }
      let outputBlocked = false;
      for (const path of outputPaths) {
        const result = await removeOwnedFile(options.paths.root, path);
        if (result === 'removed') removed += 1;
        else if (result === 'preserved') {
          preserved += 1;
          outputBlocked = true;
        }
      }
      if (outputBlocked) {
        preserved += 1;
        continue;
      }
      const manifestResult = await removeOwnedFile(options.paths.root, manifestStoredPath);
      if (manifestResult === 'removed') removed += 1;
      else if (manifestResult === 'preserved') {
        preserved += 1;
      }
    }
    if (truncated) break;
  }
  return { inspected, preserved, removed, truncated };
}

export const reconcileTerminalProviderOutputs = cleanupTerminalProviderOutputs;
