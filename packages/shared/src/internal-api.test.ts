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
  ProviderTypeSchema,
  CustomAdapterRefSchema,
  CustomAdapterDeleteBodySchema,
  AdapterFormatQuerySchema,
  EmptyQuerySchema,
  ProviderIdValueSchema,
  AdapterIdParamsSchema,
  ProviderAdapterParamsSchema,
  CustomAdapterRefQuerySchema,
  CustomAdapterRevisionListQuerySchema,
  CustomAdapterExportQuerySchema,
  CustomAdapterImportEnvelopeSchema,
  CustomAdapterImportQuerySchema,
  CustomAdapterImportRequestSchema,
  CustomAdapterPreviewRequestSchema,
  CustomAdapterDryRunRequestSchema,
  CustomAdapterSimulateResponseSchema,
  CustomAdapterSimulateRequestSchema,
  CustomAdapterPathTestRequestSchema,
  CustomAdapterPathTestResponseSchema,
  CustomAdapterCapabilityPreviewSchema,
  CustomAdapterDefinitionDtoSchema,
  TrustedAdapterManifestSchema,
  TrustedAdapterManagementDtoSchema,
  TrustedAdapterBindRequestSchema,
  TrustedAdapterBindBodySchema,
  TrustedAdapterDisableBodySchema,
  TrustedAdapterBindingDtoSchema,
  TrustedAdapterBindingResponseSchema,
  TrustedAdapterBindingPageSchema,
  TrustedAdapterRefQuerySchema,
  TrustedAdapterRevisionQuerySchema,
  TrustedAdapterRevisionListQuerySchema,
  TrustedAdapterUnbindQuerySchema,
  AdapterErrorResponseSchema,
  MAX_ADAPTER_RESPONSE_BYTES,
  CustomAdapterExtractedResponseSchema,
  CustomAdapterSimulationResultSchema,
  MaintenanceIntegrityResponseSchema,
  MaintenanceBackupResponseSchema,
  MaintenanceMediaResponseSchema,
  MaintenanceMediaReconcileResponseSchema,
  MaintenanceMediaRepairsResponseSchema,
} from './internal-api.js';

describe('internal API schemas', () => {
  it('accepts the registered PR5 video provider profiles', () => {
    expect(ProviderTypeSchema.parse('xai-imagine-video-v1')).toBe('xai-imagine-video-v1');
    expect(ProviderTypeSchema.parse('gemini-veo-operation-v1')).toBe('gemini-veo-operation-v1');
    expect(ProviderTypeSchema.parse('gemini-omni-interactions-video-v1')).toBe('gemini-omni-interactions-video-v1');
  });

  it('validates bounded custom adapter references', () => {
    const ref = {
      kind: 'declarative-http',
      adapterId: 'custom-video',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    } as const;
    expect(CustomAdapterRefSchema.parse(ref)).toEqual(ref);
    expect(CustomAdapterRefSchema.safeParse({ ...ref, adapterId: '../escape' }).success).toBe(false);
    expect(CustomAdapterRefSchema.safeParse({ ...ref, adapterId: 'adapter/id' }).success).toBe(false);
    expect(CustomAdapterRefSchema.safeParse({ ...ref, digest: 'not-a-digest' }).success).toBe(false);
    expect(CustomAdapterRefSchema.safeParse({ kind: ref.kind, adapterId: ref.adapterId }).success).toBe(false);
    expect(ProviderTypeSchema.parse('custom-http-v1')).toBe('custom-http-v1');
    expect(ProviderTypeSchema.parse('custom-js-v1')).toBe('custom-js-v1');
  });

  it('keeps authentication status and login payloads strict', () => {
    expect(AuthStatusSchema.parse({ authenticated: false, required: true })).toEqual({
      authenticated: false,
      publicAccessWarning: false,
      required: true,
    });
    expect(AuthStatusSchema.parse({
      authenticated: false,
      publicAccessWarning: true,
      required: false,
    })).toEqual({
      authenticated: false,
      publicAccessWarning: true,
      required: false,
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

  it('keeps maintenance responses bounded to safe flags, counts, and backup metadata', () => {
    const integrity = {
      integrity: {
        foreignKeyCheck: { ok: false, truncated: true, violationCount: 2 },
        foreignKeysEnabled: true,
        integrityCheck: { errorCount: 1, ok: false, truncated: false },
        ok: false,
      },
    };
    expect(MaintenanceIntegrityResponseSchema.parse(integrity)).toEqual(integrity);
    expect(MaintenanceIntegrityResponseSchema.safeParse({
      ...integrity,
      integrity: { ...integrity.integrity, violations: [] },
    }).success).toBe(false);
    expect(MaintenanceIntegrityResponseSchema.safeParse({
      integrity: { ...integrity.integrity, foreignKeyCheck: { ok: true, truncated: false, violationCount: -1 } },
    }).success).toBe(false);

    const backup = {
      backup: {
        createdAt: '2026-08-29T00:00:00.000Z',
        id: 'backup-1',
        sha256: 'a'.repeat(64),
        size: 8192,
      },
    };
    expect(MaintenanceBackupResponseSchema.parse(backup)).toEqual(backup);
    expect(MaintenanceBackupResponseSchema.safeParse({
      ...backup,
      backup: { ...backup.backup, path: '/data/app.db', filename: 'app.db' },
    }).success).toBe(false);
    expect(MaintenanceBackupResponseSchema.safeParse({
      ...backup,
      backup: { ...backup.backup, createdAt: 'not-a-timestamp' },
    }).success).toBe(false);

    const media = {
      media: {
        assetCount: 2,
        fileCount: 4,
        hashedBytes: 128,
        issueCount: 1,
        issues: [{ assetId: 'asset-1', kind: 'missing', storedPath: 'media/uploads/a.png' }],
        ok: false,
        truncated: false,
      },
    };
    expect(MaintenanceMediaResponseSchema.parse(media)).toEqual(media);
    expect(MaintenanceMediaResponseSchema.safeParse({
      ...media,
      media: { ...media.media, issues: [{ ...media.media.issues[0], absolutePath: '/data/app.db' }] },
    }).success).toBe(false);
    expect(MaintenanceMediaResponseSchema.safeParse({
      ...media,
      media: { ...media.media, issueCount: -1 },
    }).success).toBe(false);
    expect(MaintenanceMediaResponseSchema.parse({
      ...media,
      media: {
        ...media.media,
        issues: [
          { assetId: null, kind: 'unsafe', storedPath: '<unsafe-path>' },
          { assetId: null, kind: 'unreadable', storedPath: '<path-too-long>' },
        ],
      },
    })).toMatchObject({ media: { issues: [{ storedPath: '<unsafe-path>' }, { storedPath: '<path-too-long>' }] } });
    for (const storedPath of [
      '/data/app.db',
      'C:/data/app.db',
      'media\\uploads\\asset.png',
      'media/uploads/../asset.png',
      'media//uploads/asset.png',
      `media/uploads/${String.fromCharCode(0)}asset.png`,
    ]) {
      expect(MaintenanceMediaResponseSchema.safeParse({
        ...media,
        media: { ...media.media, issues: [{ assetId: null, kind: 'unsafe', storedPath }] },
      }).success).toBe(false);
    }

    const reconcile = {
      media: {
        queue: { inserted: 1, reopened: 0, resolved: 2, seen: 3, truncated: false, updated: 0 },
        scan: { assetCount: 4, fileCount: 8, hashedBytes: 128, issueCount: 3, ok: false, truncated: false },
      },
    };
    expect(MaintenanceMediaReconcileResponseSchema.parse(reconcile)).toEqual(reconcile);
    expect(MaintenanceMediaReconcileResponseSchema.safeParse({
      ...reconcile,
      media: { ...reconcile.media, queue: { ...reconcile.media.queue, rawError: 'secret' } },
    }).success).toBe(false);

    const repairs = {
      repairs: {
        count: 1,
        items: [{
          assetId: 'asset-1',
          attempts: 2,
          firstSeenAt: '2026-08-29T00:00:00.000Z',
          issueKey: 'a'.repeat(64),
          jobId: null,
          kind: 'missing',
          lastErrorCode: 'repair_failed',
          lastSeenAt: '2026-08-29T00:01:00.000Z',
          leaseUntil: null,
          nextAttemptAt: '2026-08-29T00:02:00.000Z',
          resolvedAt: null,
          state: 'open',
          storedPath: 'media/uploads/missing.png',
        }],
        truncated: false,
      },
    };
    expect(MaintenanceMediaRepairsResponseSchema.parse(repairs)).toEqual(repairs);
    expect(MaintenanceMediaRepairsResponseSchema.safeParse({
      ...repairs,
      repairs: {
        ...repairs.repairs,
        items: [{ ...repairs.repairs.items[0], storedPath: '/data/app.db', rawError: 'secret' }],
      },
    }).success).toBe(false);
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
  it('keeps adapter route params and format queries strict and bounded', () => {
    expect(ProviderAdapterParamsSchema.parse({ providerId: 'provider-1', adapterId: 'custom-video' })).toEqual({
      providerId: 'provider-1',
      adapterId: 'custom-video',
    });
    expect(AdapterIdParamsSchema.safeParse({ adapterId: 'x'.repeat(64) }).success).toBe(false);
    expect(ProviderAdapterParamsSchema.safeParse({ providerId: 'provider-1', adapterId: 'custom-video', source: 'forbidden' }).success).toBe(false);
    expect(AdapterFormatQuerySchema.parse({})).toEqual({ format: 'json' });
    expect(AdapterFormatQuerySchema.parse({ format: 'yaml' }).format).toBe('yaml');
    expect(AdapterFormatQuerySchema.safeParse({ format: 'toml' }).success).toBe(false);
    expect(AdapterFormatQuerySchema.safeParse({ format: 'json', adminEnabled: true }).success).toBe(false);
  });

  it('accepts bounded raw import documents and only the exact export envelope', () => {
    const envelope = {
      schemaVersion: 1 as const,
      version: '1.0.0',
      definition: { schemaVersion: 1, id: 'custom-video' },
    };
    expect(CustomAdapterImportEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(CustomAdapterImportRequestSchema.parse({
      providerId: 'provider-1',
      format: 'yaml',
      document: 'schemaVersion: 1\nid: custom-video\n',
    }).format).toBe('yaml');
    expect(CustomAdapterImportEnvelopeSchema.safeParse({ ...envelope, source: 'adapter.mjs' }).success).toBe(false);
    expect(CustomAdapterImportEnvelopeSchema.safeParse({ ...envelope, adminEnabled: true }).success).toBe(false);
    expect(CustomAdapterImportEnvelopeSchema.safeParse({ ...envelope, definition: { value: 'x'.repeat(4_097) } }).success).toBe(false);
    expect(CustomAdapterImportRequestSchema.safeParse({
      providerId: 'provider-1',
      document: new Uint8Array([1, 2, 3]),
    }).success).toBe(false);
    const inherited = Object.create({ polluted: true }) as Record<string, unknown>;
    inherited.id = 'custom-video';
    expect(CustomAdapterImportRequestSchema.safeParse({ providerId: 'provider-1', document: inherited }).success).toBe(false);
  });

  it('keeps raw import version queries optional, bounded, plain, and strict', () => {
    expect(CustomAdapterImportQuerySchema.parse({})).toEqual({});
    expect(CustomAdapterImportQuerySchema.parse({ version: '1.0.0' })).toEqual({ version: '1.0.0' });
    expect(CustomAdapterImportQuerySchema.safeParse({ version: '' }).success).toBe(false);
    expect(CustomAdapterImportQuerySchema.safeParse({ version: 'x'.repeat(65) }).success).toBe(false);
    expect(CustomAdapterImportQuerySchema.safeParse({ version: '1' }).success).toBe(true);
    expect(CustomAdapterImportQuerySchema.safeParse({ version: null }).success).toBe(false);
    for (const key of ['providerId', 'source', 'secrets', 'adminEnabled']) {
      expect(CustomAdapterImportQuerySchema.safeParse({ version: '1.0.0', [key]: 'forbidden' }).success).toBe(false);
    }
    const inherited = Object.assign(Object.create({ adminEnabled: true }), { version: '1.0.0' });
    expect(CustomAdapterImportQuerySchema.safeParse(inherited).success).toBe(false);
    const nullPrototype = Object.assign(Object.create(null), { version: '1.0.0' });
    expect(CustomAdapterImportQuerySchema.parse(nullPrototype)).toEqual({ version: '1.0.0' });
    expect(CustomAdapterImportEnvelopeSchema.safeParse({ schemaVersion: 1, definition: {} }).success).toBe(false);
  });

  it('keeps preview and dry-run requests free of server-only context and binary inputs', () => {
    const request = {
      operation: 'image.generate' as const,
      providerId: 'provider-1',
      modelId: 'model-1',
      prompt: 'A red kite',
      inputs: [{ assetId: 'asset-1', role: 'source' as const }],
    };
    const parsed = CustomAdapterPreviewRequestSchema.parse({
      providerId: 'provider-1',
      endpoint: 'submit',
      baseUrl: 'https://api.example.test/v1',
      request,
    });
    expect(parsed.request?.inputs).toEqual([{ assetId: 'asset-1', role: 'source' }]);
    expect(CustomAdapterDryRunRequestSchema.parse({ providerId: 'provider-1', request })).toEqual({
      providerId: 'provider-1',
      request: { ...request, inputs: [{ assetId: 'asset-1', role: 'source' }] },
    });
    for (const key of ['adminEnabled', 'secrets', 'secretValues', 'inputs', 'source']) {
      expect(CustomAdapterPreviewRequestSchema.safeParse({ providerId: 'provider-1', request, [key]: key === 'inputs' ? [] : true }).success).toBe(false);
    }
    expect(CustomAdapterPreviewRequestSchema.safeParse({
      providerId: 'provider-1',
      request: { ...request, extra: { payload: { bytes: 'not allowed' } } },
    }).success).toBe(false);
    expect(CustomAdapterPreviewRequestSchema.safeParse({
      providerId: 'provider-1',
      request: { ...request, extra: { payload: 'x'.repeat(MAX_ADAPTER_RESPONSE_BYTES + 1) } },
    }).success).toBe(false);
  });

  it('bounds simulated responses and rejects ambiguous transport aliases', () => {
    const response = {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-trace': ['one', 'two'] },
      json: { request_id: 'remote-1', status: 'done' },
    };
    expect(CustomAdapterSimulateResponseSchema.parse(response)).toEqual(response);
    expect(CustomAdapterSimulateRequestSchema.parse({
      providerId: 'provider-1',
      endpoint: 'poll',
      phase: 'poll',
      response,
    }).phase).toBe('poll');
    expect(CustomAdapterSimulateResponseSchema.safeParse({ ...response, status: 99 }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({ ...response, statusCode: 200 }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({ ...response, body: {} }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({ status: 200 }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({
      ...response,
      headers: { 'x-bad': 'line\nvalue' },
    }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({
      ...response,
      json: Array.from({ length: 513 }, () => true),
    }).success).toBe(false);
    expect(CustomAdapterSimulateResponseSchema.safeParse({
      status: 200,
      text: 'x'.repeat(MAX_ADAPTER_RESPONSE_BYTES + 1),
    }).success).toBe(false);
  });

  it('requires non-empty RFC 6901 paths and round-trips path-test DTOs', () => {
    const input = {
      providerId: 'provider-1',
      path: '/a~1b/0',
      json: { 'a/b': ['value'] },
    };
    expect(CustomAdapterPathTestRequestSchema.parse(input)).toEqual(input);
    expect(CustomAdapterPathTestResponseSchema.parse({ path: '/a~1b/0', found: true, value: 'value' })).toEqual({
      path: '/a~1b/0',
      found: true,
      value: 'value',
    });
    expect(CustomAdapterPathTestRequestSchema.safeParse({ ...input, path: '' }).success).toBe(false);
    expect(CustomAdapterPathTestRequestSchema.safeParse({ ...input, path: '/bad~2path' }).success).toBe(false);
    expect(CustomAdapterPathTestRequestSchema.safeParse({ ...input, path: '/bad\\path' }).success).toBe(false);
    expect(CustomAdapterPathTestRequestSchema.safeParse({ providerId: 'provider-1', path: '/value' }).success).toBe(false);
  });

  it('keeps definition, capability, trusted management, and error DTOs source-free', () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-video',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    const definition = {
      providerId: 'provider-1',
      ref,
      definition: { schemaVersion: 1, id: 'custom-video' },
      isCurrent: true,
      disabled: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    expect(CustomAdapterDefinitionDtoSchema.parse(definition)).toEqual(definition);
    expect(CustomAdapterDefinitionDtoSchema.safeParse({ ...definition, source: 'adapter.mjs' }).success).toBe(false);
    const capabilities = {
      providerType: 'custom-http-v1',
      models: [{
        id: 'model-1',
        displayName: 'Model 1',
        capabilities: { operations: ['image.generate'] },
      }],
    };
    expect(CustomAdapterCapabilityPreviewSchema.parse({ capabilities })).toEqual({ capabilities });
    const manifest = {
      schemaVersion: 1 as const,
      id: 'trusted-js-fixture',
      version: '1.0.0',
      displayName: 'Trusted JavaScript fixture',
      sha256: 'b'.repeat(64),
      operations: ['image.generate' as const],
      capabilities,
      allowedHosts: ['api.example.com'],
      requiredSecrets: [],
      resourceLimits: {
        timeoutMs: 5_000,
        maxMessageBytes: 1_048_576,
        maxOutputBytes: 1_048_576,
        maxLogBytes: 65_536,
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    };
    const trusted = {
      manifest,
      ref: { kind: 'trusted-javascript' as const, adapterId: manifest.id, version: manifest.version, digest: manifest.sha256 },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    expect(TrustedAdapterManifestSchema.parse(manifest)).toEqual(manifest);
    expect(TrustedAdapterManagementDtoSchema.parse(trusted)).toEqual(trusted);
    expect(TrustedAdapterManagementDtoSchema.safeParse({ ...trusted, source: 'adapter.mjs' }).success).toBe(false);
    expect(TrustedAdapterBindRequestSchema.parse({ providerId: 'provider-1', ref: trusted.ref })).toEqual({
      providerId: 'provider-1',
      ref: trusted.ref,
    });
    expect(TrustedAdapterBindRequestSchema.safeParse({ providerId: 'provider-1', ref }).success).toBe(false);
    expect(AdapterErrorResponseSchema.parse({ error: 'adapter_not_found', message: 'missing' })).toEqual({
      error: 'adapter_not_found',
      message: 'missing',
    });
    expect(AdapterErrorResponseSchema.safeParse({ error: 'unknown_adapter_code' }).success).toBe(false);
    expect(AdapterErrorResponseSchema.safeParse({ error: 'storage_error', source: 'secret' }).success).toBe(false);
  });

  it('keeps trusted Provider bindings source-free and uses exact trusted revision refs', () => {
    const manifest = {
      schemaVersion: 1 as const,
      id: 'trusted-js-binding',
      version: '1.0.0',
      displayName: 'Trusted JavaScript binding',
      sha256: 'c'.repeat(64),
      operations: ['image.generate' as const],
      capabilities: {
        providerType: 'custom-js-v1',
        models: [{
          id: 'model-1',
          displayName: 'Model 1',
          capabilities: { operations: ['image.generate'] },
        }],
      },
      allowedHosts: ['api.example.com'],
      requiredSecrets: ['UPSTREAM_TOKEN'],
      resourceLimits: {
        timeoutMs: 5_000,
        maxMessageBytes: 1_048_576,
        maxOutputBytes: 1_048_576,
        maxLogBytes: 65_536,
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    };
    const ref = {
      kind: 'trusted-javascript' as const,
      adapterId: manifest.id,
      version: manifest.version,
      digest: manifest.sha256,
    };
    const adapter = {
      manifest,
      ref,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
    };
    const binding = {
      providerId: 'provider-1',
      adapter,
      isCurrent: true,
      disabled: false,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T01:00:00.000Z',
    };

    expect(TrustedAdapterBindingDtoSchema.parse(binding)).toEqual(binding);
    expect(TrustedAdapterBindingResponseSchema.parse({ binding })).toEqual({ binding });
    expect(TrustedAdapterBindingPageSchema.parse({ items: [binding], nextCursor: 'cursor-1' })).toEqual({
      items: [binding],
      nextCursor: 'cursor-1',
    });
    expect(TrustedAdapterBindingPageSchema.parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });

    expect(TrustedAdapterRefQuerySchema.parse(ref)).toEqual(ref);
    expect(TrustedAdapterUnbindQuerySchema.parse(ref)).toEqual(ref);
    expect(TrustedAdapterRevisionQuerySchema.parse({})).toEqual({});
    expect(TrustedAdapterRevisionListQuerySchema.parse({ limit: '20', ...ref })).toEqual({ limit: 20, ...ref });
    expect(TrustedAdapterRevisionListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(TrustedAdapterRefQuerySchema.safeParse({ ...ref, kind: 'declarative-http' }).success).toBe(false);
    expect(TrustedAdapterRevisionListQuerySchema.safeParse({ ...ref, kind: 'declarative-http' }).success).toBe(false);
    expect(TrustedAdapterRevisionQuerySchema.safeParse({ ...ref, kind: 'declarative-http' }).success).toBe(false);

    for (const key of ['kind', 'adapterId', 'version', 'digest']) {
      const partial = { [key]: ref[key as keyof typeof ref] };
      expect(TrustedAdapterUnbindQuerySchema.safeParse(partial).success).toBe(false);
      expect(TrustedAdapterRevisionListQuerySchema.safeParse(partial).success).toBe(false);
      expect(TrustedAdapterRevisionQuerySchema.safeParse(partial).success).toBe(false);
    }
    expect(TrustedAdapterBindingPageSchema.safeParse({ items: [], nextCursor: 'x'.repeat(2_049) }).success).toBe(false);
    expect(TrustedAdapterBindingPageSchema.safeParse({ items: Array.from({ length: 201 }, () => binding) }).success).toBe(false);

    for (const key of ['source', 'secrets', 'secretValues', 'adminEnabled', 'providerId']) {
      const value = key === 'secrets' || key === 'secretValues' ? { apiKey: 'hidden' } : 'forbidden';
      expect(TrustedAdapterBindBodySchema.safeParse({ ref, [key]: value }).success).toBe(false);
      expect(TrustedAdapterDisableBodySchema.safeParse({ [key]: value }).success).toBe(false);
    }
    expect(TrustedAdapterBindBodySchema.parse({ ref })).toEqual({ ref });
    expect(TrustedAdapterDisableBodySchema.parse({})).toEqual({});
    expect(TrustedAdapterDisableBodySchema.parse({ ref })).toEqual({ ref });
    expect(TrustedAdapterDisableBodySchema.safeParse({ ref, unknown: true }).success).toBe(false);
    expect(TrustedAdapterDisableBodySchema.safeParse(null).success).toBe(false);
    expect(TrustedAdapterDisableBodySchema.safeParse([]).success).toBe(false);

    expect(TrustedAdapterBindingDtoSchema.safeParse({ ...binding, source: 'adapter.mjs' }).success).toBe(false);
    expect(TrustedAdapterBindingDtoSchema.safeParse({ ...binding, secrets: { apiKey: 'hidden' } }).success).toBe(false);
    expect(TrustedAdapterBindingDtoSchema.safeParse({
      ...binding,
      adapter: { ...adapter, source: 'adapter.mjs' },
    }).success).toBe(false);
    expect(TrustedAdapterBindingResponseSchema.safeParse({ binding, unknown: true }).success).toBe(false);
    expect(TrustedAdapterBindingPageSchema.safeParse({ items: [binding], source: 'adapter.mjs' }).success).toBe(false);
    expect(TrustedAdapterBindingDtoSchema.safeParse({ ...binding, createdAt: 'not-a-timestamp' }).success).toBe(false);
    expect(TrustedAdapterBindingDtoSchema.safeParse({ ...binding, updatedAt: '2026-08-27' }).success).toBe(false);
    expect(TrustedAdapterBindingDtoSchema.safeParse({ ...binding, createdAt: undefined }).success).toBe(false);

    const inheritedBinding = Object.assign(Object.create({ source: 'adapter.mjs' }), binding);
    expect(TrustedAdapterBindingDtoSchema.safeParse(inheritedBinding).success).toBe(false);
    const nullPrototypeBinding = Object.assign(Object.create(null), binding);
    expect(TrustedAdapterBindingDtoSchema.parse(nullPrototypeBinding)).toEqual(binding);
    const inheritedRef = Object.assign(Object.create({ source: 'adapter.mjs' }), ref);
    expect(TrustedAdapterRefQuerySchema.safeParse(inheritedRef).success).toBe(false);
    expect(TrustedAdapterDisableBodySchema.safeParse({ ref: inheritedRef }).success).toBe(false);
  });

  it('hardens route query and multipart ProviderId values', () => {
    expect(EmptyQuerySchema.parse({})).toEqual({});
    expect(EmptyQuerySchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(EmptyQuerySchema.safeParse(JSON.parse('{"__proto__":{"polluted":true}}')).success).toBe(false);
    expect(ProviderIdValueSchema.parse('  provider-1  ')).toBe('provider-1');
    expect(ProviderIdValueSchema.safeParse('').success).toBe(false);
    expect(ProviderIdValueSchema.safeParse('provider\nid').success).toBe(false);
    expect(ProviderIdValueSchema.safeParse('x'.repeat(256)).success).toBe(false);
  });

  it('requires complete historical refs and bounds revision lists/export queries', () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-video',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    expect(CustomAdapterRefQuerySchema.parse(ref)).toEqual(ref);
    expect(CustomAdapterRevisionListQuerySchema.parse({ limit: '20', ...ref })).toEqual({ limit: 20, ...ref });
    expect(CustomAdapterRevisionListQuerySchema.parse({}).limit).toBe(50);
    expect(CustomAdapterExportQuerySchema.parse({ format: 'yaml', ...ref })).toEqual({ format: 'yaml', ...ref });
    expect(CustomAdapterExportQuerySchema.parse({ format: 'json' })).toEqual({ format: 'json' });
    for (const key of ['kind', 'adapterId', 'version', 'digest']) {
      const partial = { [key]: ref[key as keyof typeof ref] };
      expect(CustomAdapterRevisionListQuerySchema.safeParse(partial).success).toBe(false);
      expect(CustomAdapterExportQuerySchema.safeParse(partial).success).toBe(false);
    }
    expect(CustomAdapterRevisionListQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(CustomAdapterExportQuerySchema.safeParse({ ...ref, format: 'toml' }).success).toBe(false);
    expect(CustomAdapterExportQuerySchema.safeParse({ ...ref, source: 'adapter.mjs' }).success).toBe(false);
  });

  it('requires a complete immutable ref for current adapter deletion', () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-video',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    expect(CustomAdapterDeleteBodySchema.parse({ ref })).toEqual({ ref });
    for (const key of ['kind', 'adapterId', 'version', 'digest']) {
      const partialRef = { ...ref };
      delete partialRef[key as keyof typeof partialRef];
      expect(CustomAdapterDeleteBodySchema.safeParse({ ref: partialRef }).success).toBe(false);
    }
    expect(CustomAdapterDeleteBodySchema.safeParse(ref).success).toBe(false);
    expect(CustomAdapterDeleteBodySchema.safeParse({ ref, source: 'adapter.mjs' }).success).toBe(false);
  });

  it('validates extracted simulation output as a safe success/pending/failed union', () => {
    const success = {
      state: 'completed' as const,
      assets: [{
        type: 'image' as const,
        mimeType: 'image/png',
        url: 'https://cdn.example.test/result.png',
        resultId: 'result-1',
      }],
    };
    const pending = {
      state: 'pending' as const,
      remoteJobId: 'remote-1',
      progress: 42,
      status: 'running',
      resultExpiresAt: '2026-08-25T00:00:00.000Z',
    };
    const failed = {
      state: 'failed' as const,
      error: {
        code: 'upstream_failed',
        kind: 'transient' as const,
        message: 'The upstream request failed.',
        retryable: true,
        retryAfterMs: 1_000,
        statusCode: 503,
      },
    };
    expect(CustomAdapterExtractedResponseSchema.parse(success)).toEqual(success);
    expect(CustomAdapterExtractedResponseSchema.parse(pending)).toEqual(pending);
    expect(CustomAdapterSimulationResultSchema.parse(failed)).toEqual(failed);
    expect(CustomAdapterExtractedResponseSchema.safeParse({ ...success, source: 'secret' }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({ ...success, secrets: { apiKey: 'secret' } }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({ ...success, body: { raw: true } }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({
      ...success,
      assets: [{ ...success.assets[0], source: 'url' }],
    }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({
      ...success,
      assets: [{ ...success.assets[0], url: 'https://cdn.example.test/result.png?token=secret' }],
    }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({
      state: 'failed',
      error: { ...failed.error, statusCode: 99 },
    }).success).toBe(false);
    expect(CustomAdapterExtractedResponseSchema.safeParse({
      state: 'completed',
      assets: [{ type: 'image', mimeType: 'image/png', base64: 'x'.repeat(MAX_ADAPTER_RESPONSE_BYTES + 1) }],
    }).success).toBe(false);
  });
});
