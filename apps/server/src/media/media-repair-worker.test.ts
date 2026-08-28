import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  commitStagedFile,
  stageBuffer,
  type StagedFile,
} from '../storage/atomic-file.js';
import * as pathSafety from '../storage/path-safety.js';
import { ensureStorage, getStoragePaths, type StoragePaths } from '../storage/paths.js';
import type {
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  NewAssetMediaRecord,
} from './types.js';
import { SharpImageProcessor } from './image-processor.js';
import type {
  MediaRepairClaimOptions,
  MediaRepairRecord,
  MediaRepairRetryOptions,
  MediaRepairTransitionOptions,
} from '../database/media-repair.js';
import {
  MEDIA_REPAIR_DEFAULT_BATCH_SIZE,
  MediaRepairInProgressError,
  MediaRepairWorker,
} from './media-repair-worker.js';

const temporaryDirectories: string[] = [];
const NOW = new Date('2026-08-29T00:00:00.000Z');
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

class MemoryAssetRepository implements AssetMediaRepositoryPort {
  public readonly records = new Map<string, AssetMediaRecord>();

  public create(input: NewAssetMediaRecord): AssetMediaRecord {
    const record: AssetMediaRecord = {
      ...input,
      createdAt: NOW,
      deletedAt: null,
      id: `asset-${this.records.size + 1}`,
    };
    this.records.set(record.id, record);
    return record;
  }

  public get(id: string, includeDeleted = false): AssetMediaRecord | null {
    const record = this.records.get(id);
    return record !== undefined && (includeDeleted || record.deletedAt === null) ? record : null;
  }

  public listForMaintenance(): readonly AssetMediaRecord[] {
    return [...this.records.values()];
  }

  public softDelete(id: string): boolean {
    const record = this.records.get(id);
    if (record === undefined || record.deletedAt !== null) return false;
    this.records.set(id, { ...record, deletedAt: NOW });
    return true;
  }
}

class TestQueue {
  public readonly manual: Array<{ issueKey: string; options: MediaRepairTransitionOptions | undefined }> = [];
  public readonly resolved: Array<{ issueKey: string; options: MediaRepairTransitionOptions | undefined }> = [];
  public readonly retried: Array<{ issueKey: string; options: MediaRepairRetryOptions | undefined }> = [];
  public due = false;
  public manualReturnsNull = false;
  public resolveError: Error | undefined;
  public resolveReturnsNull = false;
  public retryReturnsNull = false;
  private readonly claims: MediaRepairRecord[];
  private currentClaim: MediaRepairRecord | null = null;

  public constructor(claims: readonly MediaRepairRecord[]) {
    this.claims = [...claims];
  }

  public claimNext(_options?: MediaRepairClaimOptions): MediaRepairRecord | null {
    this.currentClaim = this.claims.shift() ?? null;
    return this.currentClaim;
  }

  public hasDue(_now?: Date): boolean {
    return this.due || this.claims.length > 0;
  }

  public markManual(issueKey: string, options?: MediaRepairTransitionOptions): MediaRepairRecord | null {
    this.manual.push({ issueKey, options });
    return this.manualReturnsNull ? null : this.currentClaim;
  }

  public resolve(issueKey: string, options?: MediaRepairTransitionOptions): MediaRepairRecord | null {
    this.resolved.push({ issueKey, options });
    if (this.resolveError !== undefined) throw this.resolveError;
    return this.resolveReturnsNull ? null : this.currentClaim;
  }

  public retry(issueKey: string, options?: MediaRepairRetryOptions): MediaRepairRecord | null {
    this.retried.push({ issueKey, options });
    return this.retryReturnsNull ? null : this.currentClaim;
  }
}

function issueKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function claim(
  assetId: string | null,
  storedPath: string,
  overrides: Partial<MediaRepairRecord> = {},
): MediaRepairRecord {
  return {
    assetId,
    attempts: 1,
    firstSeenAt: NOW,
    issueKey: issueKey(`${assetId ?? 'orphan'}:${storedPath}`),
    jobId: null,
    kind: 'missing',
    lastErrorCode: null,
    lastSeenAt: NOW,
    leaseUntil: new Date(NOW.getTime() + 300_000),
    nextAttemptAt: NOW,
    resolvedAt: null,
    state: 'running',
    storedPath,
    ...overrides,
  };
}

function imageAsset(id: string, bytes: Uint8Array, overrides: Partial<AssetMediaRecord> = {}): AssetMediaRecord {
  return {
    createdAt: NOW,
    deletedAt: null,
    durationMs: null,
    filePath: 'media/uploads/primary.png',
    fileSize: bytes.byteLength,
    height: 1,
    id,
    jobId: null,
    metadata: {},
    mimeType: 'image/png',
    originalFilename: 'primary.png',
    parentAssetId: null,
    posterPath: null,
    role: 'upload',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    thumbnailPath: 'media/thumbnails/primary.webp',
    type: 'image',
    width: 1,
    ...overrides,
  };
}

function videoAsset(id: string, bytes: Uint8Array, overrides: Partial<AssetMediaRecord> = {}): AssetMediaRecord {
  return {
    createdAt: NOW,
    deletedAt: null,
    durationMs: 1_000,
    filePath: 'media/originals/primary.mp4',
    fileSize: bytes.byteLength,
    height: 90,
    id,
    jobId: 'job-1',
    metadata: { codec: 'h264', format: 'mp4' },
    mimeType: 'video/mp4',
    originalFilename: 'primary.mp4',
    parentAssetId: null,
    posterPath: 'media/posters/primary.jpg',
    role: 'output',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    thumbnailPath: null,
    type: 'video',
    width: 160,
    ...overrides,
  };
}

async function fixture(): Promise<{
  paths: StoragePaths;
  repository: MemoryAssetRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), 'imagine-media-repair-worker-'));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  return { paths, repository: new MemoryAssetRepository() };
}

function workerOptions(
  paths: StoragePaths,
  repository: MemoryAssetRepository,
  queue: TestQueue,
  overrides: Partial<ConstructorParameters<typeof MediaRepairWorker>[0]> = {},
): ConstructorParameters<typeof MediaRepairWorker>[0] {
  return {
    assets: repository,
    clock: () => NOW,
    imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
    paths,
    queue,
    videoProcessor: {
      createPoster: vi.fn(async (options): Promise<StagedFile> => {
        const staged = await stageBuffer({
          bytes: Buffer.from('poster'),
          dataRoot: options.dataRoot,
          maxBytes: 1024,
          temporaryDirectory: options.temporaryDirectory,
        });
        try {
          await commitStagedFile(options.dataRoot, staged, options.destinationPath, options.signal);
          return staged;
        } catch (error) {
          await rm(staged.temporaryPath, { force: true });
          throw error;
        }
      }),
    },
    ...overrides,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('MediaRepairWorker', () => {
  it('repairs a missing image thumbnail through Sharp and guarded resolve', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('image-1', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 1,
      retried: 0,
      truncated: false,
    });
    expect((await stat(join(paths.root, asset.thumbnailPath!))).isFile()).toBe(true);
    expect((await stat(join(paths.root, asset.thumbnailPath!))).size).toBeGreaterThan(0);
    expect(queue.resolved).toHaveLength(1);
    expect(queue.resolved[0]?.options).toMatchObject({
      expectedAttempts: 1,
      expectedLeaseUntil: new Date(NOW.getTime() + 300_000),
    });
  });

  it('repairs a missing video poster with the existing poster processor contract', async () => {
    const { paths, repository } = await fixture();
    const bytes = Buffer.from('video-primary');
    const asset = videoAsset('video-1', bytes);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), bytes);
    const queue = new TestQueue([claim(asset.id, asset.posterPath!)]);
    const videoProcessor = {
      createPoster: vi.fn(async (options): Promise<StagedFile> => {
        const staged = await stageBuffer({
          bytes: Buffer.from('poster'),
          dataRoot: options.dataRoot,
          maxBytes: 1024,
          temporaryDirectory: options.temporaryDirectory,
        });
        await commitStagedFile(options.dataRoot, staged, options.destinationPath, options.signal);
        return staged;
      }),
    };
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { videoProcessor }));

    await expect(worker.run()).resolves.toMatchObject({ attempted: 1, manual: 0, repaired: 1 });
    expect(await readFile(join(paths.root, asset.posterPath!))).toEqual(Buffer.from('poster'));
    expect(videoProcessor.createPoster).toHaveBeenCalledWith(expect.objectContaining({
      destinationPath: join(paths.root, asset.posterPath!),
      inputPath: join(paths.root, asset.filePath),
      metadata: {
        codec: 'h264',
        durationMs: 1_000,
        format: 'mp4',
        height: 90,
        width: 160,
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it('sends collision, invalid primary, and deleted assets to manual without generation', async () => {
    const { paths, repository } = await fixture();
    const collisionAsset = imageAsset('collision', VALID_PNG);
    repository.records.set(collisionAsset.id, collisionAsset);
    await writeFile(join(paths.root, collisionAsset.filePath), VALID_PNG);
    await writeFile(join(paths.root, collisionAsset.thumbnailPath!), Buffer.from('existing'));
    const invalidAsset = imageAsset('invalid', VALID_PNG, {
      filePath: 'media/uploads/invalid.png',
      sha256: '0'.repeat(64),
      thumbnailPath: 'media/thumbnails/invalid.webp',
    });
    repository.records.set(invalidAsset.id, invalidAsset);
    await writeFile(join(paths.root, invalidAsset.filePath), VALID_PNG);
    const deletedAsset = imageAsset('deleted', VALID_PNG, {
      filePath: 'media/uploads/deleted.png',
      thumbnailPath: 'media/thumbnails/deleted.webp',
      deletedAt: NOW,
    });
    repository.records.set(deletedAsset.id, deletedAsset);
    await writeFile(join(paths.root, deletedAsset.filePath), VALID_PNG);
    const symlinkAsset = imageAsset('symlink', VALID_PNG, {
      filePath: 'media/uploads/symlink.png',
      thumbnailPath: 'media/thumbnails/symlink.webp',
    });
    repository.records.set(symlinkAsset.id, symlinkAsset);
    const outside = join(paths.root, 'outside-primary.png');
    await writeFile(outside, VALID_PNG);
    await symlink(outside, join(paths.root, symlinkAsset.filePath));
    const imageProcessor = { createThumbnail: vi.fn() };
    const queue = new TestQueue([
      claim(collisionAsset.id, collisionAsset.thumbnailPath!),
      claim(invalidAsset.id, invalidAsset.thumbnailPath!, { issueKey: issueKey('invalid') }),
      claim(deletedAsset.id, deletedAsset.thumbnailPath!, { issueKey: issueKey('deleted') }),
      claim(symlinkAsset.id, symlinkAsset.thumbnailPath!, { issueKey: issueKey('symlink') }),
    ]);
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { imageProcessor }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 4,
      manual: 4,
      repaired: 0,
      retried: 0,
      truncated: false,
    });
    expect(imageProcessor.createThumbnail).not.toHaveBeenCalled();
    expect(await readFile(join(paths.root, collisionAsset.thumbnailPath!))).toEqual(Buffer.from('existing'));
    expect(queue.manual.map((entry) => entry.issueKey)).toEqual([
      issueKey(`${collisionAsset.id}:${collisionAsset.thumbnailPath}`),
      issueKey('invalid'),
      issueKey('deleted'),
      issueKey('symlink'),
    ]);
  });

  it('does not count a manual transition that lost its lease', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('manual-transition-race', VALID_PNG, {
      filePath: 'media/uploads/manual-transition-race.png',
      thumbnailPath: 'media/thumbnails/manual-transition-race.webp',
      sha256: '0'.repeat(64),
    });
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    queue.manualReturnsNull = true;
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(queue.manual).toHaveLength(1);
  });

  it('retries tool or database failures with a safe bounded code and no raw error', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('db-failure', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    queue.resolveError = new Error('sqlite secret /data/app.db');
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(queue.retried).toHaveLength(0);
    expect(queue.resolved).toHaveLength(1);
    expect(JSON.stringify(queue.resolved)).not.toContain('sqlite secret');
  });

  it('leaves a successful publication unsettled when resolve loses the claim', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('resolve-race', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    queue.resolveReturnsNull = true;
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(queue.resolved).toHaveLength(1);
    expect((await stat(join(paths.root, asset.thumbnailPath!))).isFile()).toBe(true);
  });

  it('retries tool failures with a safe bounded code and no raw error', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('tool-failure', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    const imageProcessor = {
      createThumbnail: vi.fn().mockRejectedValue(new Error('sharp secret /data/app.db')),
    };
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { imageProcessor }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 1,
      truncated: false,
    });
    expect(queue.retried[0]?.options?.errorCode).toBe('repair_failed');
    expect(JSON.stringify(queue.retried)).not.toContain('sharp secret');
  });

  it('retries transient derived-path inspection errors with a safe code', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('derived-io', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    const error = Object.assign(new Error('private EIO path /data/media'), { code: 'EIO' });
    vi.spyOn(pathSafety, 'assertNoSymlinkTraversal').mockRejectedValueOnce(error);
    const imageProcessor = { createThumbnail: vi.fn() };
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { imageProcessor }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 1,
      truncated: false,
    });
    expect(imageProcessor.createThumbnail).not.toHaveBeenCalled();
    expect(queue.retried[0]?.options?.errorCode).toBe('derived_io_failed');
    expect(JSON.stringify(queue.retried)).not.toContain('/data/media');
  });

  it('does not generate after a stale lease and reports a bounded batch as truncated', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('stale', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const stale = claim(asset.id, asset.thumbnailPath!, {
      leaseUntil: new Date(NOW.getTime() - 1),
    });
    const imageProcessor = { createThumbnail: vi.fn() };
    const queue = new TestQueue([stale, claim(null, 'media/uploads/orphan.png', { issueKey: issueKey('orphan') })]);
    queue.due = true;
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, {
      batchSize: 1,
      imageProcessor,
    }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(imageProcessor.createThumbnail).not.toHaveBeenCalled();
    expect(queue.manual).toHaveLength(0);
  });

  it('does not start a claim when its remaining lease is only the safety margin', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('lease-margin', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!, {
      leaseUntil: new Date(NOW.getTime() + 1_000),
    })]);
    const imageProcessor = { createThumbnail: vi.fn() };
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { imageProcessor }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(imageProcessor.createThumbnail).not.toHaveBeenCalled();
    await expect(stat(join(paths.root, asset.thumbnailPath!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts before publication when generation reaches the lease deadline', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('lease-crossing', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const realProcessor = new SharpImageProcessor({ thumbnailSize: 32 });
    const imageProcessor = {
      createThumbnail: vi.fn(async (options) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        options.signal?.throwIfAborted();
        return realProcessor.createThumbnail(options);
      }),
    };
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!, {
      leaseUntil: new Date(NOW.getTime() + 1_050),
    })]);
    queue.retryReturnsNull = true;
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, {
      imageProcessor,
    }));

    await expect(worker.run()).resolves.toEqual({
      attempted: 1,
      manual: 0,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(queue.resolved).toHaveLength(0);
    expect(queue.retried).toHaveLength(1);
    expect(await stat(join(paths.root, asset.thumbnailPath!)).catch(() => null)).toBeNull();
  });

  it('rejects a concurrent run before it can claim a second batch', async () => {
    const { paths, repository } = await fixture();
    const asset = imageAsset('single-flight', VALID_PNG);
    repository.records.set(asset.id, asset);
    await writeFile(join(paths.root, asset.filePath), VALID_PNG);
    const queue = new TestQueue([claim(asset.id, asset.thumbnailPath!)]);
    const claimNext = vi.spyOn(queue, 'claimNext');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const processorEntered = new Promise<void>((resolve) => { entered = resolve; });
    const realProcessor = new SharpImageProcessor({ thumbnailSize: 32 });
    const imageProcessor = {
      createThumbnail: vi.fn(async (options) => {
        entered();
        await released;
        return realProcessor.createThumbnail(options);
      }),
    };
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue, { imageProcessor }));
    const first = worker.run();
    await processorEntered;
    expect(claimNext).toHaveBeenCalledOnce();

    try {
      await expect(worker.run()).rejects.toBeInstanceOf(MediaRepairInProgressError);
      expect(claimNext).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    await expect(first).resolves.toMatchObject({ attempted: 1, repaired: 1 });
    expect(claimNext).toHaveBeenCalledTimes(2);
  });

  it('uses the fixed default batch size even when more queue rows are due', async () => {
    const { paths, repository } = await fixture();
    const claims = Array.from({ length: MEDIA_REPAIR_DEFAULT_BATCH_SIZE + 1 }, (_, index) =>
      claim(null, `media/uploads/orphan-${index}.png`, { issueKey: issueKey(`orphan-${index}`) }));
    const queue = new TestQueue(claims);
    const worker = new MediaRepairWorker(workerOptions(paths, repository, queue));

    await expect(worker.run()).resolves.toMatchObject({
      attempted: MEDIA_REPAIR_DEFAULT_BATCH_SIZE,
      manual: MEDIA_REPAIR_DEFAULT_BATCH_SIZE,
      repaired: 0,
      retried: 0,
      truncated: true,
    });
    expect(queue.manual).toHaveLength(MEDIA_REPAIR_DEFAULT_BATCH_SIZE);
  });
});
