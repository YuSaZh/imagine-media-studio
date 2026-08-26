import { createMockGenerationRequest } from '@imagine/testkit';
import { describe, expect, it } from 'vitest';

import type { AssetRecord } from '../database/assets.js';
import type { ModelRecord } from '../database/models.js';
import { GenerationInputError, GenerationInputResolver } from './generation-input-resolver.js';

function asset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: overrides.id ?? 'asset-1',
    jobId: overrides.jobId ?? null,
    parentAssetId: overrides.parentAssetId ?? null,
    type: overrides.type ?? 'image',
    role: overrides.role ?? 'upload',
    filePath: overrides.filePath ?? 'media/uploads/input.png',
    thumbnailPath: overrides.thumbnailPath ?? null,
    posterPath: overrides.posterPath ?? null,
    originalFilename: overrides.originalFilename ?? 'input.png',
    mimeType: overrides.mimeType ?? 'image/png',
    width: overrides.width === undefined ? 512 : overrides.width,
    height: overrides.height === undefined ? 512 : overrides.height,
    durationMs: overrides.durationMs ?? null,
    fileSize: overrides.fileSize ?? 1_024,
    sha256: overrides.sha256 ?? 'asset-sha',
    metadata: overrides.metadata ?? {},
    favorite: overrides.favorite ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-08-25T00:00:00.000Z'),
    deletedAt: overrides.deletedAt ?? null,
  };
}

function model(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: overrides.id ?? 'model-row-1',
    providerId: overrides.providerId ?? 'mock',
    modelId: overrides.modelId ?? 'mock-image-v1',
    displayName: overrides.displayName ?? 'Mock Image',
    capabilities: overrides.capabilities ?? {
      operations: ['image.generate', 'image.edit'],
      maxReferenceImages: 4,
      supportsMask: true,
      inputImageConstraints: {
        mimeTypes: ['image/png', 'image/jpeg'],
        maxBytes: 4_096,
        maxPixels: 1_000_000,
        maxWidth: 1_024,
        maxHeight: 1_024,
      },
    },
    capabilitySource: overrides.capabilitySource ?? 'mock',
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? new Date('2026-08-25T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-08-25T00:00:00.000Z'),
  };
}

function harness(
  assetRecords: readonly AssetRecord[],
  modelRecords: readonly ModelRecord[] = [model()],
) {
  const assets = new Map(assetRecords.map((record) => [record.id, record]));
  return new GenerationInputResolver(
    { get: (id) => assets.get(id) ?? null },
    {
      listForProvider: (providerId) =>
        modelRecords.filter((record) => record.providerId === providerId),
    },
  );
}

async function expectCode(operation: () => unknown, code: string): Promise<void> {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationInputError);
    expect((error as GenerationInputError).code).toBe(code);
    return;
  }
  throw new Error(`Expected GenerationInputError ${code}.`);
}

describe('GenerationInputResolver', () => {
  it('resolves enabled Provider models and valid generate references', () => {
    const references = [asset({ id: 'ref-1' }), asset({ id: 'ref-2' })];
    const resolver = harness(references);
    const request = createMockGenerationRequest({
      inputs: references.map((reference) => ({ assetId: reference.id, role: 'reference' })),
    });

    const resolved = resolver.resolve(request);

    expect(resolved.model.modelId).toBe('mock-image-v1');
    expect(resolved.inputs.map((input) => input.asset.id)).toEqual(['ref-1', 'ref-2']);
  });

  it('accepts one edit source and a matching optional PNG mask', () => {
    const source = asset({ id: 'source', width: 640, height: 480 });
    const mask = asset({
      id: 'mask',
      role: 'mask',
      parentAssetId: source.id,
      width: 640,
      height: 480,
    });
    const resolver = harness([source, mask]);
    const request = createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [
        { assetId: source.id, role: 'source' },
        { assetId: mask.id, role: 'mask' },
      ],
    });

    expect(resolver.resolve(request).inputs).toHaveLength(2);
  });

  it('rejects missing, disabled, mismatched, and operation-incompatible models', async () => {
    const request = createMockGenerationRequest();
    await expectCode(() => harness([], []).resolve(request), 'model_not_found');
    await expectCode(
      () => harness([], [model({ enabled: false })]).resolve(request),
      'model_disabled',
    );
    await expectCode(
      () => harness([], [model({ providerId: 'other' })]).resolve(request),
      'model_not_found',
    );
    await expectCode(
      () => harness([], [model({ capabilities: { operations: ['image.edit'] } })]).resolve(request),
      'operation_not_supported',
    );
  });

  it('enforces role cardinality, references, and unique durable inputs', async () => {
    const records = Array.from({ length: 5 }, (_, index) => asset({ id: `ref-${index}` }));
    await expectCode(
      () => harness(records).resolve(createMockGenerationRequest({
        inputs: records.map((record) => ({ assetId: record.id, role: 'reference' })),
      })),
      'reference_limit_exceeded',
    );
    await expectCode(
      () => harness([records[0]!]).resolve(createMockGenerationRequest({
        operation: 'image.edit',
        inputs: [{ assetId: records[0]!.id, role: 'reference' }],
      })),
      'source_input_required',
    );
    await expectCode(
      () => harness([records[0]!]).resolve(createMockGenerationRequest({
        inputs: [
          { assetId: records[0]!.id, role: 'reference' },
          { assetId: records[0]!.id, role: 'reference' },
        ],
      })),
      'asset_input_duplicate',
    );
  });

  it('enforces active image metadata and model byte, MIME, pixel, and dimension limits', async () => {
    const baseRequest = (id: string) => createMockGenerationRequest({
      inputs: [{ assetId: id, role: 'reference' }],
    });
    const cases: Array<[AssetRecord, string]> = [
      [asset({ id: 'missing-dimensions', width: null }), 'image_dimensions_missing'],
      [asset({ id: 'video', type: 'video' }), 'asset_input_not_image'],
      [asset({ id: 'mime', mimeType: 'image/webp' }), 'image_mime_unsupported'],
      [asset({ id: 'bytes', fileSize: 4_097 }), 'image_input_too_large'],
      [asset({ id: 'width', width: 1_025 }), 'image_input_too_large'],
      [asset({ id: 'pixels', width: 1_001, height: 1_000 }), 'image_input_too_large'],
    ];
    for (const [record, code] of cases) {
      await expectCode(() => harness([record]).resolve(baseRequest(record.id)), code);
    }
    await expectCode(
      () => harness([]).resolve(baseRequest('missing')),
      'asset_input_not_found',
    );
    const deleted = asset({ id: 'deleted', deletedAt: new Date() });
    await expectCode(
      () => harness([deleted]).resolve(baseRequest(deleted.id)),
      'asset_input_not_found',
    );
  });

  it('requires masks to be PNG children with source-matching dimensions', async () => {
    const source = asset({ id: 'source', width: 640, height: 480 });
    const requestFor = (mask: AssetRecord) => createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [
        { assetId: source.id, role: 'source' },
        { assetId: mask.id, role: 'mask' },
      ],
    });
    const wrongType = asset({ id: 'mask-jpeg', role: 'mask', mimeType: 'image/jpeg', parentAssetId: source.id });
    await expectCode(
      () => harness([source, wrongType]).resolve(requestFor(wrongType)),
      'mask_type_invalid',
    );
    const wrongParent = asset({ id: 'mask-parent', role: 'mask', parentAssetId: 'other' });
    await expectCode(
      () => harness([source, wrongParent]).resolve(requestFor(wrongParent)),
      'mask_parent_mismatch',
    );
    const wrongSize = asset({ id: 'mask-size', role: 'mask', parentAssetId: source.id, width: 639 });
    await expectCode(
      () => harness([source, wrongSize]).resolve(requestFor(wrongSize)),
      'mask_parent_mismatch',
    );
  });

  it('validates video generate and first-frame image-to-video roles explicitly', async () => {
    const videoModel = model({
      modelId: 'sora-2',
      displayName: 'Sora 2',
      capabilities: {
        operations: ['video.generate', 'video.image_to_video'],
        maxReferenceImages: 1,
        supportsProgress: true,
        supportsCancel: false,
        inputImageConstraints: {
          mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
          maxBytes: 4_096,
          maxPixels: 1_000_000,
        },
      },
    });
    const frame = asset({ id: 'frame' });
    const resolver = harness([frame], [videoModel]);
    expect(resolver.resolve(createMockGenerationRequest({
      providerId: videoModel.providerId,
      modelId: videoModel.modelId,
      operation: 'video.generate',
      inputs: [],
    })).inputs).toHaveLength(0);
    expect(resolver.resolve(createMockGenerationRequest({
      providerId: videoModel.providerId,
      modelId: videoModel.modelId,
      operation: 'video.image_to_video',
      inputs: [{ assetId: frame.id, role: 'first_frame' }],
    })).inputs[0]?.input.role).toBe('first_frame');
    await expectCode(
      () => resolver.resolve(createMockGenerationRequest({
        providerId: videoModel.providerId,
        modelId: videoModel.modelId,
        operation: 'video.generate',
        inputs: [{ assetId: frame.id, role: 'reference' }],
      })),
      'input_role_not_allowed',
    );
    await expectCode(
      () => resolver.resolve(createMockGenerationRequest({
        providerId: videoModel.providerId,
        modelId: videoModel.modelId,
        operation: 'video.image_to_video',
        inputs: [{ assetId: frame.id, role: 'reference' }],
      })),
      'source_input_required',
    );
  });
});
