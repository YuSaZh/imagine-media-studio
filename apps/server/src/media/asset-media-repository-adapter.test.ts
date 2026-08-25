import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AssetRecord,
  CreateAssetInput,
} from '../database/assets.js';
import {
  AssetMediaMappingError,
  AssetMediaRepositoryAdapter,
  toAssetMediaRecord,
} from './asset-media-repository-adapter.js';
import type {
  AssetMediaRepositoryPort,
  AssetRole,
  NewAssetMediaRecord,
} from './types.js';

const ROLES: readonly AssetRole[] = [
  'output',
  'upload',
  'reference',
  'mask',
  'first_frame',
  'last_frame',
];

function databaseRecord(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: overrides.id ?? 'asset-1',
    jobId: overrides.jobId ?? null,
    parentAssetId: overrides.parentAssetId ?? null,
    type: overrides.type ?? 'image',
    role: overrides.role ?? 'upload',
    filePath: overrides.filePath ?? 'media/uploads/asset-1.png',
    thumbnailPath: overrides.thumbnailPath ?? 'media/thumbnails/asset-1.webp',
    posterPath: overrides.posterPath ?? null,
    originalFilename: overrides.originalFilename ?? 'asset-1.png',
    mimeType: overrides.mimeType ?? 'image/png',
    width: overrides.width ?? 10,
    height: overrides.height ?? 20,
    durationMs: overrides.durationMs ?? null,
    fileSize: overrides.fileSize ?? 100,
    sha256: overrides.sha256 ?? 'a'.repeat(64),
    metadata: overrides.metadata ?? { format: 'png', nested: { pages: 1 } },
    favorite: overrides.favorite ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-08-25T00:00:00.000Z'),
    deletedAt: overrides.deletedAt ?? null,
  };
}

function mediaInput(overrides: Partial<NewAssetMediaRecord> = {}): NewAssetMediaRecord {
  return {
    jobId: overrides.jobId ?? null,
    parentAssetId: overrides.parentAssetId ?? null,
    type: overrides.type ?? 'image',
    role: overrides.role ?? 'upload',
    filePath: overrides.filePath ?? 'media/uploads/new.png',
    thumbnailPath: overrides.thumbnailPath ?? 'media/thumbnails/new.webp',
    posterPath: overrides.posterPath ?? null,
    originalFilename: overrides.originalFilename ?? 'new.png',
    mimeType: overrides.mimeType ?? 'image/png',
    width: overrides.width ?? 10,
    height: overrides.height ?? 20,
    durationMs: overrides.durationMs ?? null,
    fileSize: overrides.fileSize ?? 100,
    sha256: overrides.sha256 ?? 'b'.repeat(64),
    metadata: overrides.metadata ?? { format: 'png' },
  };
}

class FakeAssetRepository {
  public createdInput: CreateAssetInput | null = null;
  public getIncludeDeleted: boolean | undefined;
  public records: AssetRecord[] = [databaseRecord()];
  public softDeletedId: string | null = null;

  public create(input: CreateAssetInput): AssetRecord {
    this.createdInput = input;
    const record = databaseRecord({
      ...input,
      id: 'created-asset',
      metadata: input.metadata ?? {},
    });
    this.records.push(record);
    return record;
  }

  public get(id: string, includeDeleted = false): AssetRecord | null {
    this.getIncludeDeleted = includeDeleted;
    return this.records.find(
      (record) => record.id === id && (includeDeleted || record.deletedAt === null),
    ) ?? null;
  }

  public listForMaintenance(): readonly AssetRecord[] {
    return this.records;
  }

  public softDelete(id: string): boolean {
    this.softDeletedId = id;
    return this.records.some((record) => record.id === id);
  }
}

describe('AssetMediaRepositoryAdapter', () => {
  it('implements the media port and explicitly maps create fields', () => {
    const repository = new FakeAssetRepository();
    const adapter = new AssetMediaRepositoryAdapter(repository);
    expectTypeOf(adapter).toMatchTypeOf<AssetMediaRepositoryPort>();
    const input = {
      ...mediaInput(),
      apiKey: 'must-not-cross-the-adapter',
      favorite: true,
    } as NewAssetMediaRecord & { apiKey: string; favorite: boolean };

    const created = adapter.create(input);

    expect(created).toMatchObject({ id: 'created-asset', role: 'upload', type: 'image' });
    expect(repository.createdInput).toEqual(mediaInput());
    expect(JSON.stringify(repository.createdInput)).not.toContain('must-not-cross-the-adapter');
    expect(created).not.toHaveProperty('favorite');
  });

  it('maps every canonical role and both media types', () => {
    for (const role of ROLES) {
      expect(toAssetMediaRecord(databaseRecord({ role })).role).toBe(role);
    }
    expect(toAssetMediaRecord(databaseRecord({ type: 'image' })).type).toBe('image');
    expect(toAssetMediaRecord(databaseRecord({ type: 'video' })).type).toBe('video');
  });

  it('rejects legacy or corrupt role, type, and metadata values', () => {
    expect(() => toAssetMediaRecord(databaseRecord({ role: 'source' }))).toThrow(
      AssetMediaMappingError,
    );
    expect(() => toAssetMediaRecord(databaseRecord({ type: 'audio' }))).toThrow(
      AssetMediaMappingError,
    );
    expect(() =>
      toAssetMediaRecord(databaseRecord({ metadata: [] as unknown as Record<string, unknown> })),
    ).toThrow('JSON object');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const adapter = new AssetMediaRepositoryAdapter(new FakeAssetRepository());
    expect(() => adapter.create(mediaInput({ metadata: circular }))).toThrow('cannot be circular');
    expect(() => adapter.create(mediaInput({ metadata: { invalid: undefined } }))).toThrow(
      'only JSON values',
    );
  });

  it('delegates active lookup and soft delete while retaining deleted rows for maintenance', () => {
    const repository = new FakeAssetRepository();
    repository.records.push(
      databaseRecord({ id: 'deleted', deletedAt: new Date('2026-08-25T01:00:00.000Z') }),
    );
    const adapter = new AssetMediaRepositoryAdapter(repository);

    expect(adapter.get('asset-1')).toMatchObject({ id: 'asset-1' });
    expect(repository.getIncludeDeleted).toBe(false);
    expect(adapter.get('deleted')).toBeNull();
    expect(adapter.get('deleted', true)).toMatchObject({ id: 'deleted' });
    expect(repository.getIncludeDeleted).toBe(true);
    expect(adapter.listForMaintenance().map((record) => record.id)).toEqual([
      'asset-1',
      'deleted',
    ]);
    expect(adapter.softDelete('asset-1')).toBe(true);
    expect(repository.softDeletedId).toBe('asset-1');
  });

  it('clones metadata so repository-owned objects cannot mutate media records', () => {
    const metadata = { nested: { pages: 1 } };
    const mapped = toAssetMediaRecord(databaseRecord({ metadata }));
    metadata.nested.pages = 2;
    expect(mapped.metadata).toEqual({ nested: { pages: 1 } });
  });
});
