import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerationRequest } from '@imagine/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { AssetRecord } from '../database/assets.js';
import { ProviderInputLoader } from './provider-input-loader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function request(
  assetIds: readonly string[],
  roles?: readonly ('source' | 'reference' | 'mask' | 'first_frame')[],
): GenerationRequest {
  return {
    operation: 'image.edit',
    providerId: 'provider',
    modelId: 'model',
    prompt: 'Edit the image',
    inputs: assetIds.map((assetId, index) => ({
      assetId,
      role: roles?.[index] ?? (index === 0 ? 'source' : 'reference'),
    })),
  };
}

function videoRequest(assetId?: string): GenerationRequest {
  return {
    operation: assetId === undefined ? 'video.generate' : 'video.image_to_video',
    providerId: 'provider',
    modelId: 'video-model',
    prompt: 'Animate the input',
    inputs: assetId === undefined ? [] : [{ assetId, role: 'first_frame' }],
  };
}

function asset(id: string, bytes: Buffer, overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id,
    jobId: null,
    parentAssetId: null,
    type: 'image',
    role: 'upload',
    filePath: `media/uploads/${id}.png`,
    thumbnailPath: null,
    posterPath: null,
    originalFilename: `${id}\r\n.png`,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    durationMs: null,
    fileSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata: {},
    favorite: false,
    createdAt: new Date(0),
    deletedAt: null,
    ...overrides,
  };
}

async function harness(records: readonly AssetRecord[], files: Readonly<Record<string, Buffer>>) {
  const root = await mkdtemp(join(tmpdir(), 'imagine-provider-input-'));
  roots.push(root);
  await mkdir(join(root, 'media', 'uploads'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(root, 'media', 'uploads', name), bytes);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  return new ProviderInputLoader({
    assets: { get: (id) => byId.get(id) ?? null },
    dataRoot: root,
    maxBytesPerFile: 8,
    maxTotalBytes: 12,
  });
}

describe('ProviderInputLoader', () => {
  it('loads ordered immutable inputs and sanitizes filenames', async () => {
    const first = Buffer.from('first');
    const second = Buffer.from('second');
    const records = [asset('a', first), asset('b', second)];
    const loader = await harness(records, { 'a.png': first, 'b.png': second });

    const loaded = await loader.load(request(['a', 'b']));

    expect(loaded.map((input) => ({
      assetId: input.assetId,
      role: input.role,
      filename: input.filename,
      bytes: Buffer.from(input.bytes).toString(),
      parentAssetId: input.parentAssetId,
      width: input.width,
      height: input.height,
      fileSize: input.fileSize,
      sha256: input.sha256,
    }))).toEqual([
      {
        assetId: 'a',
        role: 'source',
        filename: 'a__.png',
        bytes: 'first',
        parentAssetId: null,
        width: 1,
        height: 1,
        fileSize: first.byteLength,
        sha256: createHash('sha256').update(first).digest('hex'),
      },
      {
        assetId: 'b',
        role: 'reference',
        filename: 'b__.png',
        bytes: 'second',
        parentAssetId: null,
        width: 1,
        height: 1,
        fileSize: second.byteLength,
        sha256: createHash('sha256').update(second).digest('hex'),
      },
    ]);
  });

  it('preserves verified source and mask relationship metadata', async () => {
    const sourceBytes = Buffer.from('source');
    const maskBytes = Buffer.from('mask');
    const loader = await harness(
      [
        asset('source', sourceBytes),
        asset('mask', maskBytes, {
          role: 'mask',
          parentAssetId: 'source',
          width: 1,
          height: 1,
        }),
      ],
      { 'source.png': sourceBytes, 'mask.png': maskBytes },
    );

    const loaded = await loader.load(request(['source', 'mask'], ['source', 'mask']));

    expect(loaded[0]).toMatchObject({
      assetId: 'source',
      width: 1,
      height: 1,
      fileSize: sourceBytes.byteLength,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    });
    expect(loaded[1]).toMatchObject({
      assetId: 'mask',
      role: 'mask',
      parentAssetId: 'source',
      width: 1,
      height: 1,
      fileSize: maskBytes.byteLength,
      sha256: createHash('sha256').update(maskBytes).digest('hex'),
    });
  });

  it('rejects missing, oversized, and changed inputs without returning partial results', async () => {
    const bytes = Buffer.from('source');
    const missing = await harness([], {});
    await expect(missing.load(request(['missing']))).rejects.toMatchObject({
      code: 'provider_input_missing',
    });

    const oversizedRecord = asset('large', Buffer.alloc(9));
    const oversized = await harness([oversizedRecord], { 'large.png': Buffer.alloc(9) });
    await expect(oversized.load(request(['large']))).rejects.toMatchObject({
      code: 'provider_input_too_large',
    });

    const changedRecord = asset('changed', bytes);
    const changed = await harness([changedRecord], { 'changed.png': Buffer.from('tamper') });
    await expect(changed.load(request(['changed']))).rejects.toMatchObject({
      code: 'provider_input_changed',
    });
  });

  it('rejects aggregate overflow and honors AbortSignal', async () => {
    const first = Buffer.alloc(7, 1);
    const second = Buffer.alloc(7, 2);
    const loader = await harness(
      [asset('a', first), asset('b', second)],
      { 'a.png': first, 'b.png': second },
    );
    await expect(loader.load(request(['a', 'b']))).rejects.toMatchObject({
      code: 'provider_input_too_large',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(loader.load(request(['a']), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('loads a first-frame image for video and rejects image inputs for video operations', async () => {
    const bytes = Buffer.from('frame');
    const frame = asset('frame', bytes, {
      role: 'first_frame',
      originalFilename: 'frame.png',
    });
    const loader = await harness([frame], { 'frame.png': bytes });
    await expect(loader.load(videoRequest('frame'))).resolves.toMatchObject([{
      assetId: 'frame',
      role: 'first_frame',
      fileSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }]);
    await expect(loader.load({ ...videoRequest(), inputs: [{ assetId: 'frame', role: 'reference' }] })).rejects.toMatchObject({
      code: 'provider_input_invalid',
    });
  });

  it('rejects unverified video edit/extend source inputs in the current runtime', async () => {
    const bytes = Buffer.from('video');
    const source = asset('video', bytes, {
      type: 'video',
      role: 'upload',
      filePath: 'media/uploads/video.mp4',
      originalFilename: 'video.mp4',
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationMs: 4_000,
    });
    const loader = await harness([source], { 'video.mp4': bytes });
    await expect(loader.load({
      ...videoRequest('video'),
      operation: 'video.edit',
      inputs: [{ assetId: 'video', role: 'source' }],
    })).rejects.toMatchObject({ code: 'provider_input_invalid' });
  });
});
