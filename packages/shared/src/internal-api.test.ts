import { describe, expect, it } from 'vitest';

import {
  AssetDtoSchema,
  AuthLoginSchema,
  AuthStatusSchema,
  InternalEventSchema,
  ProviderCreateSchema,
  ProviderDtoSchema,
  SettingsPatchSchema,
} from './internal-api.js';

describe('internal API schemas', () => {
  it('keeps authentication status and login payloads strict', () => {
    expect(AuthStatusSchema.parse({ authenticated: false, required: true })).toEqual({
      authenticated: false,
      required: true,
    });
    expect(
      AuthStatusSchema.safeParse({ authenticated: true, required: true, token: 'forbidden' }).success,
    ).toBe(false);
    expect(AuthLoginSchema.parse({ password: 'local-password' })).toEqual({
      password: 'local-password',
    });
    expect(AuthLoginSchema.safeParse({ password: '' }).success).toBe(false);
    expect(AuthLoginSchema.safeParse({ password: 'x', remember: true }).success).toBe(false);
  });

  it('keeps Provider DTOs strict and secret-free', () => {
    const safeProvider = {
      id: 'provider-1',
      name: 'Provider',
      type: 'mock',
      baseUrl: null,
      config: {},
      enabled: true,
      isDefault: true,
      hasApiKey: true,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    expect(ProviderDtoSchema.parse(safeProvider)).toEqual(safeProvider);
    expect(
      ProviderDtoSchema.safeParse({ ...safeProvider, encryptedApiKey: 'ciphertext' }).success,
    ).toBe(false);
  });

  it('rejects nested secret-like keys outside encrypted Provider fields', () => {
    expect(
      ProviderCreateSchema.safeParse({
        name: 'Unsafe',
        type: 'custom',
        config: { nested: { api_key: 'must-not-live-here' } },
      }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ values: { 'provider.api-key': 'unsafe' } }).success,
    ).toBe(false);
  });

  it('parses stable Asset and SSE wire representations', () => {
    expect(
      AssetDtoSchema.parse({
        id: 'asset-1',
        jobId: null,
        parentAssetId: null,
        type: 'image',
        role: 'upload',
        contentUrl: '/internal/assets/asset-1/content',
        thumbnailUrl: '/internal/assets/asset-1/thumbnail',
        posterUrl: null,
        originalFilename: 'input.png',
        mimeType: 'image/png',
        width: 1024,
        height: 1024,
        durationMs: null,
        fileSize: 42,
        sha256: 'a'.repeat(64),
        metadata: { version: 1 },
        favorite: false,
        collectionIds: [],
        createdAt: '2026-08-25T00:00:00.000Z',
      }).type,
    ).toBe('image');
    expect(
      InternalEventSchema.parse({
        version: 1,
        id: 1,
        type: 'asset.created',
        entityId: 'asset-1',
        revision: 0,
        occurredAt: '2026-08-25T00:00:00.000Z',
      }).id,
    ).toBe(1);
  });
});
