import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import {
  AssetMediaService,
  InvalidBase64MediaError,
  InvalidProviderDownloadTargetError,
} from './asset-media-service.js';
import { SharpImageProcessor } from './image-processor.js';
import { auditMediaConsistency } from './maintenance.js';
import type {
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  NewAssetMediaRecord,
} from './types.js';
import { VideoProcessor } from './video-processor.js';
import type { CommandRunner } from './video-processor.js';
import { stageBuffer } from '../storage/atomic-file.js';
import {
  MOCK_VIDEO_MP4_BASE64,
  MOCK_VIDEO_MP4_SHA256,
} from '../providers/mock-provider.js';

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

  public get(id: string, includeDeleted = false): AssetMediaRecord | null {
    return this.records.find(
      (record) => record.id === id && (includeDeleted || record.deletedAt === null),
    ) ?? null;
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

async function rgbaPng(width: number, height: number, alpha: readonly number[]): Promise<Buffer> {
  if (alpha.length !== width * height) throw new Error('Alpha fixture size is invalid.');
  const bytes = Buffer.alloc(width * height * 4);
  for (const [index, value] of alpha.entries()) {
    const offset = index * 4;
    bytes[offset] = 32;
    bytes[offset + 1] = 64;
    bytes[offset + 2] = 96;
    bytes[offset + 3] = value;
  }
  return sharp(bytes, { raw: { channels: 4, height, width } }).png().toBuffer();
}

describe('AssetMediaService', () => {
  it('uses the provider-scoped downloader for provider-owned results', async () => {
    const { paths, png, repository } = await fixture();
    const publicDownloader = { download: vi.fn() };
    const providerDownloader = {
      download: vi.fn(async (input: {
        dataRoot: string;
        headers?: Readonly<Record<string, string>>;
        temporaryDirectory: string;
      }) => ({
        finalUrl: new URL('https://provider.example/video.mp4'),
        mediaType: { extension: 'png', kind: 'image' as const, mimeType: 'image/png' },
        staged: await stageBuffer({
          bytes: png,
          dataRoot: input.dataRoot,
          maxBytes: 1024 * 1024,
          temporaryDirectory: input.temporaryDirectory,
        }),
      })),
    };
    const service = new AssetMediaService({
      imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
      maxBytes: 1024 * 1024,
      paths,
      providerRemoteDownloader: providerDownloader as never,
      remoteDownloader: publicDownloader as never,
      repository,
      videoProcessor: new VideoProcessor(),
    });

    await service.materializeProviderUrl({
      claimedMimeType: 'image/png',
      expectedKind: 'image',
      jobId: 'provider-owned-job',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://provider.example/video.mp4',
    });

    expect(providerDownloader.download).toHaveBeenCalledTimes(1);
    expect(publicDownloader.download).not.toHaveBeenCalled();
  });

  it('rejects provider result URL credentials and header injection before download', async () => {
    const { paths, png, repository } = await fixture();
    const providerDownloader = {
      download: vi.fn(async (input: {
        dataRoot: string;
        headers?: Readonly<Record<string, string>>;
        temporaryDirectory: string;
      }) => ({
        finalUrl: new URL('https://provider.example/video.mp4'),
        mediaType: { extension: 'png', kind: 'image' as const, mimeType: 'image/png' },
        staged: await stageBuffer({
          bytes: png,
          dataRoot: input.dataRoot,
          maxBytes: 1024 * 1024,
          temporaryDirectory: input.temporaryDirectory,
        }),
      })),
    };
    const service = new AssetMediaService({
      imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
      maxBytes: 1024 * 1024,
      paths,
      providerRemoteDownloader: providerDownloader as never,
      repository,
      videoProcessor: new VideoProcessor(),
    });
    await expect(service.materializeProviderUrl({
      expectedKind: 'video',
      headers: { Authorization: 'Bearer secret\r\nX-Leak: yes' },
      jobId: 'provider-owned-invalid',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://user:pass@provider.example/video.mp4',
    })).rejects.toBeInstanceOf(InvalidProviderDownloadTargetError);
    await expect(service.materializeProviderUrl({
      expectedKind: 'video',
      headers: { Authorization: 'Bearer secret\r\nX-Leak: yes' },
      jobId: 'provider-owned-invalid-header',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://provider.example/video.mp4',
    })).rejects.toBeInstanceOf(InvalidProviderDownloadTargetError);
    await expect(service.materializeProviderUrl({
      expectedKind: 'video',
      jobId: 'provider-owned-invalid-fragment',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://provider.example/video.mp4#fragment',
    })).rejects.toBeInstanceOf(InvalidProviderDownloadTargetError);
    await expect(service.materializeProviderUrl({
      expectedKind: 'video',
      jobId: 'provider-owned-invalid-query',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://provider.example/video.mp4?token=secret',
    })).rejects.toBeInstanceOf(InvalidProviderDownloadTargetError);
    for (const name of ['api-key', 'api_key', 'api.key', 'oauth.token', 'x-amz-signature', 'x_amz_signature', 'x.amz.signature']) {
      await expect(service.materializeProviderUrl({
        expectedKind: 'video',
        jobId: `provider-owned-invalid-${name}`,
        outputSlot: 0,
        providerOwned: true,
        url: `https://provider.example/video.mp4?${name}=secret`,
      })).rejects.toBeInstanceOf(InvalidProviderDownloadTargetError);
    }
    await service.materializeProviderUrl({
      claimedMimeType: 'image/png',
      expectedKind: 'image',
      headers: { Authorization: 'Bearer first', authorization: 'Bearer last', Accept: 'image/*' },
      jobId: 'provider-owned-normalized-headers',
      outputSlot: 0,
      providerOwned: true,
      url: 'https://provider.example/video.mp4?variant=video&format=fixture',
    });
    await service.materializeProviderUrl({
      claimedMimeType: 'image/png',
      expectedKind: 'image',
      jobId: 'provider-owned-public-query',
      outputSlot: 1,
      providerOwned: true,
      url: 'https://provider.example/video.mp4?tokenizer=fixture',
    });
    expect(providerDownloader.download).toHaveBeenCalledTimes(2);
    expect(providerDownloader.download.mock.calls[0]?.[0].headers).toEqual({
      authorization: 'Bearer last',
      Accept: 'image/*',
    });
  });

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

  it('accepts partial and full-edit PNG masks while preserving their parent relationship', async () => {
    const { paths, repository, service } = await fixture();
    const parentBytes = await rgbaPng(2, 1, [255, 255]);
    const parent = await service.materializeUpload({
      claimedMimeType: 'image/png',
      role: 'upload',
      source: Readable.from([parentBytes]),
    });

    const partial = await service.materializeUpload({
      claimedMimeType: 'image/png',
      parentAssetId: parent.id,
      role: 'mask',
      source: Readable.from([await rgbaPng(2, 1, [0, 255])]),
    });
    const full = await service.materializeUpload({
      claimedMimeType: 'image/png',
      parentAssetId: parent.id,
      role: 'mask',
      source: Readable.from([await rgbaPng(2, 1, [0, 0])]),
    });

    expect(partial).toMatchObject({
      height: 1,
      mimeType: 'image/png',
      parentAssetId: parent.id,
      role: 'mask',
      thumbnailPath: null,
      width: 2,
    });
    expect(full).toMatchObject({ parentAssetId: parent.id, role: 'mask', thumbnailPath: null });
    expect(repository.records).toHaveLength(3);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.masks)).toHaveLength(2);
    expect(await readdir(paths.thumbnails)).toHaveLength(1);
  });

  it('rejects an empty mask and removes every provisional mask file', async () => {
    const { paths, repository, service } = await fixture();
    const parent = await service.materializeUpload({
      role: 'upload',
      source: Readable.from([await rgbaPng(2, 1, [255, 255])]),
    });

    await expect(
      service.materializeUpload({
        parentAssetId: parent.id,
        role: 'mask',
        source: Readable.from([await rgbaPng(2, 1, [255, 255])]),
      }),
    ).rejects.toMatchObject({ code: 'mask_has_no_edit_area' });

    expect(repository.records).toHaveLength(1);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.masks)).toEqual([]);
    expect(await readdir(paths.temporary)).toEqual([]);
  });

  it('rejects masks without an active image parent and cleans committed content', async () => {
    const { paths, repository, service } = await fixture();
    const maskBytes = await rgbaPng(1, 1, [0]);

    await expect(
      service.materializeUpload({ role: 'mask', source: Readable.from([maskBytes]) }),
    ).rejects.toMatchObject({ code: 'mask_parent_required' });
    await expect(
      service.materializeUpload({
        parentAssetId: 'missing-parent',
        role: 'mask',
        source: Readable.from([maskBytes]),
      }),
    ).rejects.toMatchObject({ code: 'mask_parent_missing' });

    const inactiveParent = repository.create({
      durationMs: null,
      filePath: 'media/uploads/parent.png',
      fileSize: 1,
      height: 1,
      jobId: null,
      metadata: {},
      mimeType: 'image/png',
      originalFilename: null,
      parentAssetId: null,
      posterPath: null,
      role: 'upload',
      sha256: '0'.repeat(64),
      thumbnailPath: null,
      type: 'image',
      width: 1,
    });
    expect(repository.softDelete(inactiveParent.id)).toBe(true);
    await expect(
      service.materializeUpload({
        parentAssetId: inactiveParent.id,
        role: 'mask',
        source: Readable.from([maskBytes]),
      }),
    ).rejects.toMatchObject({ code: 'mask_parent_inactive' });

    const videoParent = repository.create({
      durationMs: 1000,
      filePath: 'media/uploads/parent.mp4',
      fileSize: 1,
      height: 1,
      jobId: null,
      metadata: {},
      mimeType: 'video/mp4',
      originalFilename: null,
      parentAssetId: null,
      posterPath: null,
      role: 'upload',
      sha256: '1'.repeat(64),
      thumbnailPath: null,
      type: 'video',
      width: 1,
    });
    await expect(
      service.materializeUpload({
        parentAssetId: videoParent.id,
        role: 'mask',
        source: Readable.from([maskBytes]),
      }),
    ).rejects.toMatchObject({ code: 'mask_parent_must_be_image' });

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.masks)).toEqual([]);
  });

  it('rejects non-PNG and dimension-mismatched masks without persistence', async () => {
    const { paths, repository, service } = await fixture();
    const parent = await service.materializeUpload({
      role: 'upload',
      source: Readable.from([await rgbaPng(2, 1, [255, 255])]),
    });
    const jpegMask = await sharp({
      create: { background: '#000000', channels: 3, height: 1, width: 2 },
    }).jpeg().toBuffer();

    await expect(
      service.materializeUpload({
        parentAssetId: parent.id,
        role: 'mask',
        source: Readable.from([jpegMask]),
      }),
    ).rejects.toMatchObject({ code: 'mask_must_be_png' });
    await expect(
      service.materializeUpload({
        parentAssetId: parent.id,
        role: 'mask',
        source: Readable.from([await rgbaPng(1, 1, [0])]),
      }),
    ).rejects.toMatchObject({ code: 'mask_dimension_mismatch' });

    expect(repository.records).toHaveLength(1);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(paths.masks)).toEqual([]);
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

  it('materializes the fixed Mock MP4 with metadata, poster, and a reusable manifest', async () => {
    const { paths, repository } = await fixture();
    const posterBytes = await sharp({
      create: { background: '#000000', channels: 3, height: 1, width: 1 },
    }).jpeg().toBuffer();
    const runner: CommandRunner = {
      run: async (command, args) => {
        if (command === 'fixture-ffprobe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '1', format_name: 'mov,mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 90, width: 160 }],
            }),
          };
        }
        const outputPath = args.at(-1);
        if (outputPath === undefined) throw new Error('Missing poster output path.');
        await writeFile(outputPath, posterBytes);
        return { stderr: '', stdout: '' };
      },
    };
    const service = new AssetMediaService({
      imageProcessor: new SharpImageProcessor({ thumbnailSize: 32 }),
      maxBytes: 1024 * 1024,
      paths,
      repository,
      videoProcessor: new VideoProcessor({
        ffmpegCommand: 'fixture-ffmpeg',
        ffprobeCommand: 'fixture-ffprobe',
        runner,
      }),
    });

    const record = await service.materializeProviderBase64({
      base64: MOCK_VIDEO_MP4_BASE64,
      claimedMimeType: 'video/mp4',
      expectedKind: 'video',
      jobId: 'mock-video-materialize',
      outputSlot: 0,
      resultId: 'mock-video-success-test',
    });

    expect(record).toMatchObject({
      durationMs: 1_000,
      fileSize: 1_525,
      height: 90,
      mimeType: 'video/mp4',
      posterPath: expect.stringMatching(/^media\/posters\/job-[a-f0-9]{64}-slot-0000\.jpg$/),
      sha256: MOCK_VIDEO_MP4_SHA256,
      type: 'video',
      width: 160,
    });
    expect(await readFile(join(paths.root, record.filePath))).toEqual(
      Buffer.from(MOCK_VIDEO_MP4_BASE64, 'base64'),
    );
    expect((await stat(join(paths.root, record.posterPath!))).size).toBeGreaterThan(0);
    expect(repository.records).toEqual([]);
    await expect(service.validateProviderOutputs('mock-video-materialize', [record])).resolves.toBe(true);
    const manifestDirectory = join(
      paths.temporary,
      'provider-results',
      createHash('sha256').update('imagine-provider-output-v1\0mock-video-materialize').digest('hex'),
    );
    const manifest = await readFile(join(manifestDirectory, 'slot-0000.json'), 'utf8');
    expect(manifest).toContain('video/mp4');
    expect(manifest).not.toContain('provider.invalid');
    expect(manifest).not.toContain('Bearer');
    expect(manifest).not.toContain('secret');
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
