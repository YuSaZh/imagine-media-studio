import { createHash } from 'node:crypto';
import { type FileHandle } from 'node:fs/promises';

import { MAINTENANCE_MEDIA_REPAIR_RUN_MAX_COUNT } from '@imagine/shared';

import type {
  MediaRepairRecord,
  MediaRepairRetryOptions,
  MediaRepairTransitionOptions,
  MediaRepairClaimOptions,
} from '../database/media-repair.js';
import type { AssetMediaRecord, AssetMediaRepositoryPort, VideoMediaMetadata } from './types.js';
import {
  assertNoSymlinkTraversal,
  openStoredFile,
  resolveStoredPath,
  toStoredPath,
  UnsafeStoragePathError,
} from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';
import type { SharpImageProcessor } from './image-processor.js';
import type { VideoProcessor } from './video-processor.js';

export const MEDIA_REPAIR_DEFAULT_BATCH_SIZE = MAINTENANCE_MEDIA_REPAIR_RUN_MAX_COUNT;
export const MEDIA_REPAIR_MAX_BATCH_SIZE = 100;
export const MEDIA_REPAIR_MAX_PRIMARY_HASH_BYTES = 1 * 1024 * 1024 * 1024;
export const MEDIA_REPAIR_DEADLINE_MARGIN_MS = 1_000;

export interface MediaRepairRunResult {
  readonly attempted: number;
  readonly repaired: number;
  readonly manual: number;
  readonly retried: number;
  readonly truncated: boolean;
}

export class MediaRepairInProgressError extends Error {
  public override readonly name = 'MediaRepairInProgressError';
}

interface MediaRepairExecutionQueuePort {
  claimNext(options?: MediaRepairClaimOptions): MediaRepairRecord | null | Promise<MediaRepairRecord | null>;
  hasDue(now?: Date): boolean | Promise<boolean>;
  markManual(issueKey: string, options?: MediaRepairTransitionOptions): MediaRepairRecord | null | Promise<MediaRepairRecord | null>;
  resolve(issueKey: string, options?: MediaRepairTransitionOptions): MediaRepairRecord | null | Promise<MediaRepairRecord | null>;
  retry(issueKey: string, options?: MediaRepairRetryOptions): MediaRepairRecord | null | Promise<MediaRepairRecord | null>;
}

export interface MediaRepairWorkerOptions {
  readonly assets: AssetMediaRepositoryPort;
  readonly clock?: () => Date;
  readonly imageProcessor: Pick<SharpImageProcessor, 'createThumbnail'>;
  readonly leaseMs?: number;
  readonly paths: StoragePaths;
  readonly queue: MediaRepairExecutionQueuePort;
  readonly videoProcessor: Pick<VideoProcessor, 'createPoster'>;
  readonly batchSize?: number;
}

class ManualRepairError extends Error {
  public override readonly name = 'ManualRepairError';

  public constructor(public readonly code: string) {
    super(code);
  }
}

class RetryRepairError extends Error {
  public override readonly name = 'RetryRepairError';

  public constructor(public readonly code: string) {
    super(code);
  }
}

class UnsettledRepairError extends Error {
  public override readonly name = 'UnsettledRepairError';
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface PrimarySnapshot {
  readonly absolutePath: string;
  readonly identity: FileIdentity;
  readonly sha256: string;
  readonly size: number;
}

interface RepairDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

type MediaRepairProcessOutcome = 'manual' | 'repaired' | 'retried' | 'unsettled';

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSafeSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function directoryForAsset(paths: StoragePaths, asset: AssetMediaRecord): string {
  if (asset.role === 'output') return paths.originals;
  if (asset.role === 'mask') return paths.masks;
  return paths.uploads;
}

function isStoredPathUnder(paths: StoragePaths, storedPath: string, directory: string): boolean {
  try {
    resolveStoredPath(paths.root, storedPath);
    const storedDirectory = toStoredPath(paths.root, directory);
    return storedPath.startsWith(`${storedDirectory}/`);
  } catch {
    return false;
  }
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof RetryRepairError) return error.code;
  if (error instanceof ManualRepairError) return error.code;
  if (error instanceof UnsafeStoragePathError) return 'unsafe_path';
  if (isNodeError(error, 'EEXIST')) return 'derived_collision';
  if (isNodeError(error, 'ENOENT')) return 'derived_missing';
  return fallback;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hashFile(file: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  while (bytes < expectedSize) {
    const length = Math.min(buffer.byteLength, expectedSize - bytes);
    const result = await file.read(buffer, 0, length, null);
    if (!isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > length) {
      throw new ManualRepairError('primary_changed');
    }
    bytes += result.bytesRead;
    hash.update(buffer.subarray(0, result.bytesRead));
  }
  return hash.digest('hex');
}

async function verifyPrimary(paths: StoragePaths, asset: AssetMediaRecord): Promise<PrimarySnapshot> {
  if (
    !isStoredPathUnder(paths, asset.filePath, directoryForAsset(paths, asset)) ||
    !isSafeInteger(asset.fileSize) ||
    asset.fileSize <= 0 ||
    asset.fileSize > MEDIA_REPAIR_MAX_PRIMARY_HASH_BYTES ||
    !isSafeSha256(asset.sha256)
  ) {
    throw new ManualRepairError('primary_invalid');
  }
  let file: FileHandle | undefined;
  try {
    file = await openStoredFile(paths.root, asset.filePath);
    const stats = await file.stat();
    if (!stats.isFile()) throw new ManualRepairError('primary_not_regular');
    if (stats.size !== asset.fileSize) throw new ManualRepairError('primary_size_mismatch');
    const identity = { dev: stats.dev, ino: stats.ino } satisfies FileIdentity;
    const sha256 = await hashFile(file, stats.size);
    const finalStats = await file.stat();
    if (finalStats.size !== asset.fileSize || !sameFileIdentity(identity, {
      dev: finalStats.dev,
      ino: finalStats.ino,
    })) {
      throw new ManualRepairError('primary_changed');
    }
    if (sha256 !== asset.sha256) {
      throw new ManualRepairError('primary_hash_mismatch');
    }
    return {
      absolutePath: resolveStoredPath(paths.root, asset.filePath),
      identity,
      sha256,
      size: stats.size,
    };
  } catch (error) {
    if (error instanceof ManualRepairError || error instanceof RetryRepairError) throw error;
    if (error instanceof UnsafeStoragePathError) throw new ManualRepairError('primary_unsafe');
    if (isNodeError(error, 'ENOENT')) throw new ManualRepairError('primary_missing');
    if (isNodeError(error, 'ELOOP')) throw new ManualRepairError('primary_symlink');
    throw new RetryRepairError('primary_io_failed');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function assertDerivedMissing(paths: StoragePaths, storedPath: string): Promise<string> {
  let absolutePath: string;
  try {
    absolutePath = resolveStoredPath(paths.root, storedPath);
  } catch {
    throw new ManualRepairError('derived_unsafe');
  }
  try {
    await assertNoSymlinkTraversal(paths.root, absolutePath, false);
    throw new ManualRepairError('derived_collision');
  } catch (error) {
    if (error instanceof ManualRepairError) throw error;
    if (error instanceof UnsafeStoragePathError) throw new ManualRepairError('derived_unsafe');
    if (isNodeError(error, 'ENOENT')) return absolutePath;
    throw new RetryRepairError('derived_io_failed');
  }
}

async function verifyDerived(paths: StoragePaths, storedPath: string): Promise<void> {
  let file: FileHandle | undefined;
  try {
    file = await openStoredFile(paths.root, storedPath);
    const stats = await file.stat();
    if (!stats.isFile() || stats.size <= 0) throw new ManualRepairError('derived_not_regular');
  } catch (error) {
    if (error instanceof ManualRepairError) throw error;
    if (error instanceof UnsafeStoragePathError || isNodeError(error, 'ELOOP')) {
      throw new ManualRepairError('derived_unsafe');
    }
    if (isNodeError(error, 'ENOENT')) {
      throw new Error('Derived media was not published.', { cause: error });
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function videoMetadata(asset: AssetMediaRecord): VideoMediaMetadata {
  const metadata = asset.metadata;
  if (
    !isSafeInteger(asset.width) || asset.width <= 0 ||
    !isSafeInteger(asset.height) || asset.height <= 0 ||
    !isSafeInteger(asset.durationMs) || asset.durationMs <= 0 ||
    typeof metadata.codec !== 'string' || metadata.codec.length === 0 || metadata.codec.length > 255 ||
    typeof metadata.format !== 'string' || metadata.format.length === 0 || metadata.format.length > 255
  ) {
    throw new ManualRepairError('video_metadata_invalid');
  }
  return {
    codec: metadata.codec,
    durationMs: asset.durationMs,
    format: metadata.format,
    height: asset.height,
    width: asset.width,
  };
}

interface RepairPlan {
  readonly asset: AssetMediaRecord;
  readonly derivedPath: string;
  readonly derivedStoredPath: string;
  readonly primary: PrimarySnapshot;
}

function createRepairDeadline(claim: MediaRepairRecord, now: Date): RepairDeadline {
  const leaseUntil = claim.leaseUntil;
  const remaining = leaseUntil === null ? Number.NaN : leaseUntil.getTime() - now.getTime();
  if (!Number.isSafeInteger(remaining) || remaining <= MEDIA_REPAIR_DEADLINE_MARGIN_MS) {
    throw new UnsettledRepairError();
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    remaining - MEDIA_REPAIR_DEADLINE_MARGIN_MS,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

async function planRepair(
  paths: StoragePaths,
  assets: AssetMediaRepositoryPort,
  claim: MediaRepairRecord,
): Promise<RepairPlan> {
  if (claim.kind !== 'missing' || claim.assetId === null) {
    throw new ManualRepairError('issue_not_auto_repairable');
  }
  const asset = await assets.get(claim.assetId, true);
  if (asset === null) throw new ManualRepairError('asset_missing');
  if (asset.deletedAt !== null) throw new ManualRepairError('asset_deleted');
  const derivedStoredPath = asset.type === 'image' ? asset.thumbnailPath : asset.posterPath;
  const derivedDirectory = asset.type === 'image' ? paths.thumbnails : paths.posters;
  if (
    derivedStoredPath === null ||
    claim.storedPath !== derivedStoredPath ||
    !isStoredPathUnder(paths, derivedStoredPath, derivedDirectory)
  ) {
    throw new ManualRepairError('derived_reference_mismatch');
  }
  if (asset.type === 'video') videoMetadata(asset);
  const primaryPath = await verifyPrimary(paths, asset);
  const derivedPath = await assertDerivedMissing(paths, derivedStoredPath);
  return {
    asset,
    derivedPath,
    derivedStoredPath,
    primary: primaryPath,
  };
}

export class MediaRepairWorker {
  private readonly assets: AssetMediaRepositoryPort;
  private readonly clock: () => Date;
  private readonly imageProcessor: Pick<SharpImageProcessor, 'createThumbnail'>;
  private readonly leaseMs: number | undefined;
  private readonly paths: StoragePaths;
  private readonly queue: MediaRepairExecutionQueuePort;
  private readonly videoProcessor: Pick<VideoProcessor, 'createPoster'>;
  private readonly batchSize: number;
  private active = false;

  public constructor(options: MediaRepairWorkerOptions) {
    const batchSize = options.batchSize ?? MEDIA_REPAIR_DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MEDIA_REPAIR_MAX_BATCH_SIZE) {
      throw new RangeError(`Media repair batch size must be between 1 and ${MEDIA_REPAIR_MAX_BATCH_SIZE}.`);
    }
    this.assets = options.assets;
    this.clock = options.clock ?? (() => new Date());
    this.imageProcessor = options.imageProcessor;
    this.leaseMs = options.leaseMs;
    this.paths = options.paths;
    this.queue = options.queue;
    this.videoProcessor = options.videoProcessor;
    this.batchSize = batchSize;
  }

  public async run(): Promise<MediaRepairRunResult> {
    if (this.active) throw new MediaRepairInProgressError('A media repair run is already in progress.');
    this.active = true;
    try {
      return await this.runBatch();
    } finally {
      this.active = false;
    }
  }

  private async runBatch(): Promise<MediaRepairRunResult> {
    let attempted = 0;
    let repaired = 0;
    let manual = 0;
    let retried = 0;
    let truncated = false;
    for (; attempted < this.batchSize; attempted += 1) {
      let claim: MediaRepairRecord | null;
      try {
        const options: MediaRepairClaimOptions = {
          now: this.clock(),
          ...(this.leaseMs === undefined ? {} : { leaseMs: this.leaseMs }),
        };
        claim = await this.queue.claimNext(options);
      } catch {
        truncated = true;
        break;
      }
      if (claim === null) break;
      const outcome = await this.processClaim(claim);
      if (outcome === 'repaired') repaired += 1;
      else if (outcome === 'manual') manual += 1;
      else if (outcome === 'retried') retried += 1;
      else truncated = true;
    }
    if (attempted >= this.batchSize) {
      try {
        truncated = truncated || await this.queue.hasDue(this.clock());
      } catch {
        truncated = true;
      }
    }
    return { attempted, manual, repaired, retried, truncated };
  }

  private guard(claim: MediaRepairRecord): MediaRepairTransitionOptions {
    if (claim.leaseUntil === null) throw new UnsettledRepairError();
    const now = this.clock();
    if (!Number.isSafeInteger(now.getTime())) throw new UnsettledRepairError();
    if (claim.leaseUntil.getTime() <= now.getTime()) {
      throw new UnsettledRepairError();
    }
    return {
      expectedAttempts: claim.attempts,
      expectedLeaseUntil: claim.leaseUntil,
      now,
    };
  }

  private async processClaim(claim: MediaRepairRecord): Promise<MediaRepairProcessOutcome> {
    let guard: MediaRepairTransitionOptions | undefined;
    let deadline: RepairDeadline | undefined;
    try {
      guard = this.guard(claim);
      const plan = await planRepair(this.paths, this.assets, claim);
      guard = this.guard(claim);
      deadline = createRepairDeadline(claim, guard.now ?? this.clock());
      const refreshedPrimary = await verifyPrimary(this.paths, plan.asset);
      if (
        refreshedPrimary.absolutePath !== plan.primary.absolutePath ||
        !sameFileIdentity(refreshedPrimary.identity, plan.primary.identity) ||
        refreshedPrimary.sha256 !== plan.primary.sha256 ||
        refreshedPrimary.size !== plan.primary.size
      ) {
        throw new ManualRepairError('primary_replaced');
      }
      deadline.signal.throwIfAborted();
      if (plan.asset.type === 'image') {
        await this.imageProcessor.createThumbnail({
          dataRoot: this.paths.root,
          destinationPath: plan.derivedPath,
          inputPath: plan.primary.absolutePath,
          signal: deadline.signal,
          temporaryDirectory: this.paths.temporary,
        });
      } else {
        await this.videoProcessor.createPoster({
          dataRoot: this.paths.root,
          destinationPath: plan.derivedPath,
          inputPath: plan.primary.absolutePath,
          metadata: videoMetadata(plan.asset),
          signal: deadline.signal,
          temporaryDirectory: this.paths.temporary,
        });
      }
      deadline.signal.throwIfAborted();
      await verifyDerived(this.paths, plan.derivedStoredPath);
      guard = this.guard(claim);
      let resolved: MediaRepairRecord | null;
      try {
        resolved = await this.queue.resolve(claim.issueKey, guard);
      } catch {
        return 'unsettled';
      }
      return resolved === null ? 'unsettled' : 'repaired';
    } catch (error) {
      if (error instanceof UnsettledRepairError) return 'unsettled';
      if (error instanceof ManualRepairError) {
        return this.markManual(claim, guard ?? { now: this.clock() });
      }
      if (isNodeError(error, 'EEXIST')) {
        return this.markManual(claim, guard ?? { now: this.clock() });
      }
      return this.retry(claim, guard ?? { now: this.clock() }, errorCode(error, 'repair_failed'));
    } finally {
      deadline?.dispose();
    }
  }

  private async markManual(
    claim: MediaRepairRecord,
    options: MediaRepairTransitionOptions,
  ): Promise<'manual' | 'unsettled'> {
    try {
      const result = await this.queue.markManual(claim.issueKey, { ...options, now: this.clock() });
      return result === null ? 'unsettled' : 'manual';
    } catch {
      return 'unsettled';
    }
  }

  private async retry(
    claim: MediaRepairRecord,
    options: MediaRepairTransitionOptions,
    code: string,
  ): Promise<'unsettled' | 'retried'> {
    try {
      const retry = await this.queue.retry(claim.issueKey, {
        ...options,
        errorCode: code,
        now: this.clock(),
      });
      return retry === null ? 'unsettled' : 'retried';
    } catch {
      return 'unsettled';
    }
  }
}
