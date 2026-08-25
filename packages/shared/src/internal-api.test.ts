import { describe, expect, it } from 'vitest';

import {
  AssetDtoSchema,
  AuthLoginSchema,
  AuthStatusSchema,
  InternalEventSchema,
  ManualModelCreateSchema,
  ManualModelPatchSchema,
  ModelCapabilitiesSchema,
  ProviderHeadersSchema,
  ProviderCreateSchema,
  ProviderPatchSchema,
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
        type: 'openai-images-v1',
        config: { nested: { api_key: 'must-not-live-here' } },
      }).success,
    ).toBe(false);
    expect(
      ProviderCreateSchema.safeParse({
        name: 'Unsafe headers',
        type: 'openai-images-v1',
        config: { headers: { 'X-Trace': 'must-live-in-encrypted-headers' } },
      }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ values: { 'provider.api-key': 'unsafe' } }).success,
    ).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({
        values: {
          'ui.preferences': {
            profiles: [{ name: 'safe', headers: { Authorization: 'unsafe' } }],
          },
        },
      }).success,
    ).toBe(false);
    expect(ProviderHeadersSchema.safeParse({ 'X-Test': 'line\nvalue' }).success).toBe(false);
  });

  it('keeps Provider PATCH fields optional and constrains Base URL safety', () => {
    expect(ProviderPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(ProviderPatchSchema.safeParse({ baseUrl: 'https://user:pass@example.test/v1' }).success).toBe(false);
    expect(ProviderPatchSchema.safeParse({ baseUrl: 'https://example.test/v1?api_key=secret' }).success).toBe(false);
    expect(ProviderPatchSchema.safeParse({ baseUrl: 'https://example.test/v1#fragment' }).success).toBe(false);
    expect(ProviderPatchSchema.safeParse({ baseUrl: 'http://localhost:8080/v1' }).success).toBe(true);
    expect(ProviderPatchSchema.safeParse({ type: 'custom-http' }).success).toBe(false);
  });

  it('strips legacy secret-like config keys from Provider DTOs', () => {
    const safeProvider = {
      id: 'provider-legacy',
      name: 'Legacy Provider',
      type: 'openai-images-v1',
      baseUrl: 'https://user:pass@example.test/v1?token=legacy',
      config: {
        region: 'test',
        nested: { api_key: 'legacy-secret', keep: true },
        values: [{ token: 'legacy-token', keep: 'ok' }],
      },
      enabled: true,
      isDefault: false,
      hasApiKey: false,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    const parsed = ProviderDtoSchema.parse(safeProvider);
    expect(parsed.baseUrl).toBeNull();
    expect(parsed.config).toEqual({
      region: 'test',
      nested: { keep: true },
      values: [{ keep: 'ok' }],
    });
  });

  it('downgrades legacy unsafe and oversized Provider Base URLs instead of throwing', () => {
    const provider = {
      id: 'provider-url-legacy',
      name: 'Legacy URL Provider',
      type: 'openai-images-v1',
      config: {},
      enabled: true,
      isDefault: false,
      hasApiKey: false,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };

    expect(ProviderDtoSchema.parse({
      ...provider,
      baseUrl: `https://example.test/${'x'.repeat(2048)}`,
    }).baseUrl).toBeNull();
    expect(ProviderDtoSchema.parse({
      ...provider,
      baseUrl: 'https://user:pass@example.test/v1?token=legacy',
    }).baseUrl).toBeNull();
  });

  it('keeps manual model capabilities strict and bounded', () => {
    const valid = {
      providerId: 'provider-1',
      modelId: 'image-v1',
      displayName: 'Image v1',
      capabilities: {
        operations: ['image.generate'],
        durations: { min: 1, max: 10 },
        inputImageConstraints: { mimeTypes: ['image/png'], maxBytes: 1024 },
      },
    };
    expect(ManualModelCreateSchema.parse(valid).enabled).toBe(true);
    expect(ModelCapabilitiesSchema.safeParse({ operations: ['image.generate'], durations: [] }).success)
      .toBe(true);
    expect(ModelCapabilitiesSchema.safeParse({ operations: ['image.generate'], extra: true }).success)
      .toBe(false);
    expect(ModelCapabilitiesSchema.safeParse({ operations: ['image.generate', 'image.generate'] }).success)
      .toBe(false);
    expect(ModelCapabilitiesSchema.safeParse({ operations: ['image.generate'], durations: { min: 5, max: 1 } }).success)
      .toBe(false);
    expect(ModelCapabilitiesSchema.safeParse({
      operations: ['image.generate'],
      inputImageConstraints: { mimeTypes: [] },
    }).success).toBe(false);
    expect(ManualModelPatchSchema.safeParse({}).success).toBe(false);
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
