import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { AssetMediaService, InvalidBase64MediaError } from './asset-media-service.js';
import { SharpImageProcessor } from './image-processor.js';
import { auditMediaConsistency } from './maintenance.js';
import type {
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  NewAssetMediaRecord,
} from './types.js';
import { VideoProcessor } from './video-processor.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

class MemoryAssetRepository implements AssetMediaRepositoryPort {
  public readonly records: AssetMediaRecord[] = [];

  public create(input: NewAssetMediaRecord): AssetMediaRecord {
    const record: AssetMediaRecord = {
      ...input,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      deletedAt: null,
      id: `asset-${this.records.length + 1}`,
    };
    this.records.push(record);
    return record;
  }

  public get(id: string): AssetMediaRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  public listForMaintenance(): readonly AssetMediaRecord[] {
    return this.records;
  }

  public softDelete(id: string): boolean {
    const index = this.records.findIndex((record) => record.id === id && record.deletedAt === null);
    const current = this.records[index];
    if (index < 0 || current === undefined) return false;
    this.records[index] = { ...current, deletedAt: new Date() };
    return true;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ims-asset-service-'));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const repository = new MemoryAssetRepository();
  const service = new AssetMediaService({
    imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
    maxBytes: 1024 * 1024,
    paths,
    repository,
    videoProcessor: new VideoProcessor(),
  });
  const png = await sharp({
    create: { background: '#00ff00', channels: 4, height: 40, width: 80 },
  })
    .png()
    .toBuffer();
  return { paths, png, repository, service };
}

describe('AssetMediaService', () => {
  it('materializes an upload, derives a thumbnail, persists relative paths, and serves variants', async () => {
    const { paths, png, repository, service } = await fixture();
    const asset = await service.materializeUpload({
      claimedMimeType: 'image/png',
      originalFilename: 'fixture.png',
      role: 'upload',
      source: Readable.from([png]),
    });
    expect(asset).toMatchObject({
      fileSize: png.byteLength,
      height: 40,
      mimeType: 'image/png',
      originalFilename: 'fixture.png',
      role: 'upload',
      type: 'image',
      width: 80,
    });
    expect(asset.filePath).toMatch(/^media\/uploads\/.+\.png$/);
    expect(asset.thumbnailPath).toMatch(/^media\/thumbnails\/.+\.webp$/);
    expect(await readFile(join(paths.root, asset.filePath))).toEqual(png);
    expect((await stat(join(paths.root, asset.thumbnailPath!))).size).toBeGreaterThan(0);

    await expect(service.getDelivery(asset.id, 'content')).resolves.toMatchObject({
      etag: `"${asset.sha256}-content"`,
      mimeType: 'image/png',
    });
    await expect(service.getDelivery(asset.id, 'poster')).resolves.toBeNull();
    await rm(join(paths.root, asset.filePath));
    await expect(service.getDelivery(asset.id, 'content')).resolves.toBeNull();
    expect(await service.softDelete(asset.id)).toBe(true);
    await expect(service.getDelivery(asset.id, 'content')).resolves.toBeNull();
    expect(repository.records).toHaveLength(1);
  });

  it('accepts a strict data URL and rejects malformed Base64 without persistence', async () => {
    const { png, repository, service } = await fixture();
    await expect(
      service.materializeBase64({
        base64: `data:image/png;base64,${png.toString('base64')}`,
        role: 'reference',
      }),
    ).resolves.toMatchObject({ type: 'image' });
    await expect(
      service.materializeBase64({ base64: 'not base64!', role: 'reference' }),
    ).rejects.toThrow(InvalidBase64MediaError);
    expect(repository.records).toHaveLength(1);
  });

  it('reuses complete stable Provider outputs after a crash without creating visible assets', async () => {
    const { paths, png, repository, service } = await fixture();
    const input = {
      base64: `data:image/png;base64,${png.toString('base64')}`,
      claimedMimeType: 'image/png',
      expectedKind: 'image' as const,
      jobId: 'recoverable-job',
      outputSlot: 0,
      resultId: 'provider-result-1',
    };
    const first = await service.materializeProviderBase64(input);
    const inspect = vi.spyOn(SharpImageProcessor.prototype, 'inspect');
    const resumed = new AssetMediaService({
      imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
      maxBytes: 1024 * 1024,
      paths,
      repository,
      videoProcessor: new VideoProcessor(),
    });

    const second = await resumed.materializeProviderBase64(input);

    expect(second).toEqual(first);
    expect(inspect).not.toHaveBeenCalled();
    expect(first.filePath).toMatch(/^media\/originals\/job-[a-f0-9]{64}-slot-0000\.png$/);
    expect(repository.records).toEqual([]);
    expect(await resumed.validateProviderOutputs('recoverable-job', [first])).toBe(true);
  });

  it('repairs a hash-mismatched Provider output and removes provisional files on discard', async () => {
    const { paths, png, repository, service } = await fixture();
    const input = {
      base64: `data:image/png;base64,${png.toString('base64')}`,
      expectedKind: 'image' as const,
      jobId: 'repair-job',
      outputSlot: 0,
    };
    const first = await service.materializeProviderBase64(input);
    await writeFile(join(paths.root, first.filePath), 'corrupt');

    const repaired = await service.materializeProviderBase64(input);

    expect(repaired.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(await readFile(join(paths.root, repaired.filePath))).toEqual(png);
    expect(repository.records).toEqual([]);
    await service.cleanupProviderOutputs(input.jobId, 1);
    await expect(stat(join(paths.root, repaired.filePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.validateProviderOutputs(input.jobId, [repaired])).toBe(false);
  });

  it('enforces the detected media kind limit before committing files', async () => {
    const { paths, png, repository } = await fixture();
    const service = new AssetMediaService({
      imageProcessor: new SharpImageProcessor(),
      maxImageBytes: png.byteLength - 1,
      maxVideoBytes: png.byteLength * 10,
      paths,
      repository,
      videoProcessor: new VideoProcessor(),
    });

    await expect(
      service.materializeUpload({ role: 'upload', source: Readable.from([png]) }),
    ).rejects.toThrow(`image media exceeds the ${png.byteLength - 1} byte limit`);
    expect(repository.records).toEqual([]);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.uploads)).toEqual([]);
    expect(await readdir(paths.temporary)).toEqual([]);
  });

  it('removes committed files when repository persistence fails', async () => {
    const { paths, png } = await fixture();
    const repository: AssetMediaRepositoryPort = {
      create: () => {
        throw new Error('database unavailable');
      },
      get: () => null,
      listForMaintenance: () => [],
      softDelete: () => false,
    };
    const service = new AssetMediaService({
      imageProcessor: new SharpImageProcessor(),
      paths,
      repository,
      videoProcessor: new VideoProcessor(),
    });
    await expect(
      service.materializeUpload({ role: 'upload', source: Readable.from([png]) }),
    ).rejects.toThrow('database unavailable');
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.uploads)).toEqual([]);
    expect(await readdir(paths.thumbnails)).toEqual([]);
  });

  it('reports missing, modified, and orphaned media without deleting it', async () => {
    const { paths, png, service, repository } = await fixture();
    const asset = await service.materializeUpload({ role: 'upload', source: Readable.from([png]) });
    expect(await auditMediaConsistency({ paths, repository })).toEqual([]);

    await writeFile(join(paths.root, asset.filePath), 'changed');
    const orphan = join(paths.uploads, 'orphan.bin');
    await writeFile(orphan, 'orphan');
    const issues = await auditMediaConsistency({ paths, repository });
    expect(issues).toEqual(
      expect.arrayContaining([
        { assetId: asset.id, kind: 'size_mismatch', storedPath: asset.filePath },
        { assetId: asset.id, kind: 'hash_mismatch', storedPath: asset.filePath },
        { assetId: null, kind: 'orphan', storedPath: 'media/uploads/orphan.bin' },
      ]),
    );
    expect(createHash('sha256').update(await readFile(orphan)).digest('hex')).toHaveLength(64);
  });
});
