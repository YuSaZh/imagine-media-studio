import { describe, expect, it } from 'vitest';

import { toAssetDto, toProviderDto } from './dto.js';

describe('internal route DTO mappers', () => {
  it('never exposes Provider ciphertext', () => {
    const dto = toProviderDto({
      id: 'provider-1',
      name: 'Provider',
      type: 'mock',
      baseUrl: null,
      apiKeyCiphertext: 'ciphertext-api-key',
      headersCiphertext: 'ciphertext-headers',
      config: {},
      enabled: true,
      isDefault: true,
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      updatedAt: new Date('2026-08-25T00:00:00.000Z'),
    });

    expect(dto).toMatchObject({ hasApiKey: true, hasCustomHeaders: true });
    expect(JSON.stringify(dto)).not.toContain('ciphertext');
  });

  it('exposes media routes instead of managed filesystem paths', () => {
    const dto = toAssetDto({
      id: 'asset/with space',
      jobId: null,
      parentAssetId: null,
      type: 'image',
      role: 'upload',
      filePath: 'media/uploads/private.png',
      thumbnailPath: 'media/thumbnails/private.webp',
      posterPath: null,
      originalFilename: 'input.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      durationMs: null,
      fileSize: 4,
      sha256: 'a'.repeat(64),
      metadata: {},
      favorite: false,
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      deletedAt: null,
    }, ['collection-1']);

    expect(dto.contentUrl).toBe('/internal/assets/asset%2Fwith%20space/content');
    expect(dto.thumbnailUrl).toBe('/internal/assets/asset%2Fwith%20space/thumbnail');
    expect(JSON.stringify(dto)).not.toContain('media/uploads');
  });
});
