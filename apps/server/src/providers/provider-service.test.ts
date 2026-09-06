import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderHttpClientPort,
  SubmitResult,
} from '@imagine/provider-contract';
import type { CustomAdapterRef, GenerationRequest } from '@imagine/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ModelRepository } from '../database/models.js';
import { ProviderRepository } from '../database/providers.js';
import { SecretVault } from '../security/secret-vault.js';
import type { ProviderRegistration } from '../jobs/ports.js';
import { MockProviderAdapter } from './mock-provider.js';
import {
  MOCK_PROVIDER_ID,
  ProviderRegistry,
  type ProviderHttpClient,
} from './provider-registry.js';
import type { ProviderRegistryError } from './provider-registry.js';
import { ProviderService } from './provider-service.js';
import type { ModelCatalogServiceError } from './provider-service.js';

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const geminiModelsFixture = new URL(
  '../../../../fixtures/providers/gemini/gemini-generate-content-image-v1/models-response.json',
  import.meta.url,
);
const openAiImagesModelsFixture = new URL(
  '../../../../fixtures/providers/openai/openai-images-v1/models-response.json',
  import.meta.url,
);
const openAiVideosModelsFixture = new URL(
  '../../../../fixtures/providers/openai/openai-videos-v1-compatible/models-response.json',
  import.meta.url,
);
const xaiModelsFixture = new URL(
  '../../../../fixtures/providers/xai/xai-imagine-image-v1/models-response.json',
  import.meta.url,
);
const xaiVideoModelsFixture = new URL(
  '../../../../fixtures/providers/xai/xai-imagine-video-v1/models-response.json',
  import.meta.url,
);
const geminiVeoModelsFixture = new URL(
  '../../../../fixtures/providers/gemini/gemini-veo-operation-v1/models-response.json',
  import.meta.url,
);
const geminiOmniVideoModelsFixture = new URL(
  '../../../../fixtures/providers/gemini/gemini-omni-interactions-video-v1/models-response.json',
  import.meta.url,
);

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createHarness(
  adapter: MockProviderAdapter = new MockProviderAdapter(),
  options: { readonly http?: ProviderHttpClientPort } = {},
) {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-provider-service-test-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const models = new ModelRepository(database.orm);
  const vault = new SecretVault('provider-service-test-secret-with-enough-entropy');
  const registry = options.http === undefined
    ? new ProviderRegistry(providers, vault, adapter)
    : new ProviderRegistry(providers, vault, { http: options.http });
  const times = [1_000, 1_037];
  const service = new ProviderService(providers, models, vault, registry, {
    now: () => times.shift() ?? 1_037,
  });
  return { database, providers, models, vault, registry, service };
}

describe('provider family migration', () => {
  it('matches native protocols and capabilities when an OpenAI catalog contains other families', async () => {
    const { service } = await createHarness(undefined, { http: { request: async () => ({ status: 200, statusCode: 200, headers: { 'content-type': 'application/json' }, json: { data: [{ id: 'gpt-image-2' }, { id: 'gemini-3.1-flash-image' }, { id: 'grok-imagine-image' }] }, dispose: async () => {} }) } });
    const provider = service.create({ name: 'Mixed catalog', type: 'openai', apiKey: 'fixture-only', baseUrl: 'https://example.com/v1' });
    const models = await service.refreshModels(provider.id);
    expect(models.find(model => model.modelId === 'gpt-image-2')?.capabilities.profile).toBe('openai-images-v1');
    expect(models.find(model => model.modelId === 'gemini-3.1-flash-image')?.capabilities).toMatchObject({ profile: 'gemini-generate-content-image-v1', resolutions: ['512', '1K', '2K', '4K'] });
    expect(models.find(model => model.modelId === 'grok-imagine-image')?.capabilities.profile).toBe('xai-imagine-image-v1');
  });
  it('upgrades a legacy connection when automatic model matching selects a different family', async () => {
    const { service } = await createHarness();
    const provider = service.create({ name: 'Legacy mixed', type: 'openai-images-v1' });
    service.saveManualModel({ providerId: provider.id, modelId: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2', capabilities: { operations: ['image.generate'] }, enabled: true });
    expect(service.get(provider.id)?.type).toBe('openai');
  });
  it('lists the complete paginated remote catalog without importing or filtering unknown models', async () => {
    const urls: string[] = [];
    const dispose = vi.fn();
    const { service, models } = await createHarness(undefined, { http: { request: async request => {
      urls.push(request.url);
      expect(request.headers.authorization).toBe('Bearer catalog-key');
      return { status: 200, statusCode: 200, headers: { 'content-type': 'application/json' }, json: urls.length === 1
        ? { data: [{ id: 'gpt-image-2' }, { id: 'unknown-text-model' }], has_more: true, last_id: 'unknown-text-model' }
        : { data: [{ id: 'gemini-3.1-flash-image' }, { id: 'gpt-image-2' }], has_more: false }, dispose };
    } } });
    const provider = service.create({ name: 'Catalog', type: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'catalog-key' });
    expect(await service.discoverModels(provider.id)).toEqual({ models: [
      { id: 'gpt-image-2', displayName: 'GPT Image 2' }, { id: 'unknown-text-model', displayName: 'unknown-text-model' }, { id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2' },
    ] });
    expect(urls[1]).toBe('https://example.com/v1/models?after=unknown-text-model');
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(models.listForProvider(provider.id)).toEqual([]);
  });
  it('allows cross-family model protocols and keeps manual display names on refresh', async () => {
    const { service, models } = await createHarness();
    const provider = service.create({ name: 'Mixed', type: 'openai' });
    service.saveManualModel({ providerId: provider.id, modelId: 'gpt-image-1', displayName: 'My image', capabilities: { operations: ['image.generate'], profile: 'xai-imagine-image-v1' }, enabled: true });
    await service.refreshModels(provider.id);
    expect(models.listForProvider(provider.id).find(model => model.modelId === 'gpt-image-1')).toMatchObject({ displayName: 'My image', capabilities: { profile: 'xai-imagine-image-v1' } });
    expect(models.listForProvider(provider.id).filter(model => model.capabilitySource !== 'manual').every(model => !model.displayName.startsWith('OpenAI Images'))).toBe(true);
  });
  it('persists protocol and parameter policy through catalog normalization', async () => {
    const { service, registry, models } = await createHarness();
    const provider = service.create({ name: 'Shared xAI', type: 'xai' });
    const registration = registry.resolve(provider.id);
    Object.assign(registration.adapter, { getLiveCapabilities: async () => ({ providerType: 'xai', models: [{ id: 'grok-imagine-image', displayName: 'Image', capabilities: { operations: ['image.generate'], profile: 'xai-imagine-image-v1', parameters: [] } }] }) });
    vi.spyOn(registry, 'resolve').mockReturnValue({ ...registration, http: { request: vi.fn() } });
    await service.refreshModels(provider.id);
    expect(models.listForProvider(provider.id)[0]?.capabilities).toMatchObject({ profile: 'xai-imagine-image-v1', parameters: [] });
  });
  it('activates model-specific routing when a legacy connection gains an explicit binding', async () => {
    const { service } = await createHarness();
    const provider = service.create({ name: 'Legacy images', type: 'openai-images-v1' });
    service.saveManualModel({ providerId: provider.id, modelId: 'video-model', displayName: 'Video', capabilities: { operations: ['video.generate'], profile: 'openai-videos-v1-compatible' }, enabled: true });
    expect(service.page().items.find(item => item.id === provider.id)?.type).toBe('openai');
  });
  it('preserves model protocol, manual policy and credentials when upgrading a legacy connection', async () => {
    const { service, models, registry } = await createHarness();
    const provider = service.create({ name: 'Responses endpoint', type: 'openai-responses-image-v1', baseUrl: 'https://example.com/v1', apiKey: 'retained-key' });
    const model = service.saveManualModel({ providerId: provider.id, modelId: 'image-model', displayName: 'Image model', capabilities: { operations: ['image.generate'], parameters: [] }, enabled: true });
    expect(service.update(provider.id, { type: 'openai' })).toMatchObject({ type: 'openai', hasApiKey: true });
    expect(models.get(model.id)).toMatchObject({ capabilitySource: 'manual', capabilities: { profile: 'openai-responses-image-v1', parameters: [] } });
    expect((await registry.resolve(provider.id)).secrets.apiKey).toBe('retained-key');
    expect(() => service.saveManualModel({ providerId: provider.id, modelId: 'wrong', displayName: 'Wrong', capabilities: { operations: ['image.generate'], profile: 'xai-imagine-video-v1' }, enabled: true })).toThrow('模型调用协议');
  });
});

function capabilities(providerType: string, modelId: string): ProviderCapabilities {
  return {
    providerType,
    models: [{
      id: modelId,
      displayName: modelId,
      capabilities: { operations: ['image.generate'] },
    }],
  };
}

class CustomServiceAdapter implements ProviderAdapter {
  public readonly type: 'custom-http-v1' | 'custom-js-v1';
  public readonly spec: { readonly catalog?: object };
  public staticCapabilities: ProviderCapabilities;
  public liveCapabilities: ProviderCapabilities;
  public staticCalls = 0;
  public liveCalls = 0;
  public liveFailure = false;

  public constructor(options: {
    readonly type: 'custom-http-v1' | 'custom-js-v1';
    readonly catalog?: boolean;
    readonly staticCapabilities: ProviderCapabilities;
    readonly liveCapabilities?: ProviderCapabilities;
  }) {
    this.type = options.type;
    this.spec = options.catalog === true ? { catalog: {} } : {};
    this.staticCapabilities = options.staticCapabilities;
    this.liveCapabilities = options.liveCapabilities ?? options.staticCapabilities;
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    this.staticCalls += 1;
    return this.staticCapabilities;
  }

  public async getLiveCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    this.liveCalls += 1;
    if (this.liveFailure) throw new Error('live catalog unavailable: secret material');
    return this.liveCapabilities;
  }

  public async validate(_request: GenerationRequest, _context: ProviderContext): Promise<void> {}

  public async submit(_request: GenerationRequest, _context: ProviderContext): Promise<SubmitResult> {
    return { state: 'completed', assets: [] };
  }

  public normalizeError(_error: unknown): ProviderError {
    return { code: 'fixture_error', kind: 'unknown', message: 'Fixture error.', retryable: false };
  }
}

class CustomServiceConnectionAdapter extends CustomServiceAdapter {
  public constructor(
    options: ConstructorParameters<typeof CustomServiceAdapter>[0],
    private readonly probe: () => Promise<void>,
  ) {
    super(options);
  }

  public async testConnection(_context: ProviderContext): Promise<void> {
    await this.probe();
  }
}

function customRef(
  kind: CustomAdapterRef['kind'],
  version: string,
  digest: string,
): CustomAdapterRef {
  return { kind, adapterId: 'service-fixture', version, digest };
}

async function createCustomServiceHarness(
  type: 'custom-http-v1' | 'custom-js-v1',
  adapter: CustomServiceAdapter,
  ref: CustomAdapterRef,
  options: { readonly http?: boolean } = {},
) {
  const base = await createHarness();
  const provider = base.service.create({ name: `Service ${type}`, type });
  let registration: ProviderRegistration = {
    adapter,
    adapterRef: ref,
    config: {},
    secrets: {},
    submitReplaySafe: false,
    ...(options.http ? { http: {} as NonNullable<ProviderRegistration['http']> } : {}),
  };
  const registry = { resolve: () => registration } as unknown as ProviderRegistry;
  const service = new ProviderService(base.providers, base.models, base.vault, registry);
  return {
    ...base,
    provider,
    service,
    setRegistration(next: ProviderRegistration): void {
      registration = next;
    },
  };
}

describe('ProviderService', () => {
  it('encrypts create and update secrets while returning only safe DTO fields', async () => {
    const { providers, service, vault } = await createHarness();
    const created = service.create({
      name: 'Encrypted Mock',
      type: 'mock',
      apiKey: 'plaintext-api-key',
      headers: { Authorization: 'Bearer plaintext-header' },
      config: { profile: 'fixture' },
    });

    expect(created).toMatchObject({ hasApiKey: true, hasCustomHeaders: true });
    expect(JSON.stringify(created)).not.toContain('plaintext');
    expect(JSON.stringify(created)).not.toContain('ciphertext');
    const stored = providers.get(created.id);
    expect(stored?.apiKeyCiphertext).not.toContain('plaintext-api-key');
    expect(vault.decryptString(created.id, 'apiKey', stored?.apiKeyCiphertext ?? '')).toBe(
      'plaintext-api-key',
    );
    expect(vault.decryptJson(created.id, 'headers', stored?.headersCiphertext ?? '')).toEqual({
      Authorization: 'Bearer plaintext-header',
    });

    expect(service.update(created.id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
      hasApiKey: true,
      hasCustomHeaders: true,
      config: { profile: 'fixture' },
    });
    expect(service.update(created.id, { enabled: false })).toMatchObject({
      name: 'Renamed',
      enabled: false,
      config: { profile: 'fixture' },
    });
    expect(service.update(created.id, { apiKey: null, headers: null })).toMatchObject({
      hasApiKey: false,
      hasCustomHeaders: false,
    });
    expect(service.update(created.id, { headers: {} })).toMatchObject({
      hasCustomHeaders: false,
    });
  });

  it('rejects unsafe Provider writes and does not echo unsafe legacy configuration', async () => {
    const { providers, service } = await createHarness();
    expect(() => service.create({
      name: 'Unsafe config',
      type: 'mock',
      config: { nested: { token: 'secret' } },
    })).toThrow();
    expect(() => service.create({
      name: 'Unsafe URL',
      type: 'mock',
      baseUrl: 'https://user:pass@example.test/v1?token=secret',
    })).toThrow();

    const legacy = providers.create({
      name: 'Legacy config',
      type: 'mock',
      baseUrl: 'https://user:pass@example.test/v1?token=legacy',
      config: { region: 'fixture', nested: { api_key: 'legacy-secret' } },
    });
    const dto = service.get(legacy.id);
    expect(dto).toMatchObject({ baseUrl: null, config: { region: 'fixture', nested: {} } });
    expect(JSON.stringify(dto)).not.toContain('legacy-secret');
  });

  it('creates one stable mock Provider without replacing an existing default', async () => {
    const { providers, service } = await createHarness();
    const existing = providers.create({
      name: 'Existing default',
      type: 'future-provider',
      isDefault: true,
    });

    const first = service.ensureMockProvider();
    const second = service.ensureMockProvider();

    expect(first.id).toBe(MOCK_PROVIDER_ID);
    expect(second.id).toBe(MOCK_PROVIDER_ID);
    expect(first.isDefault).toBe(false);
    expect(providers.get(existing.id)?.isDefault).toBe(true);
    expect(providers.page().items.filter((provider) => provider.id === MOCK_PROVIDER_ID)).toHaveLength(1);
  });

  it('refreshes and lists the model catalog and safely tests the adapter', async () => {
    const { service } = await createHarness();
    service.ensureMockProvider();

    const refreshed = await service.refreshModels(MOCK_PROVIDER_ID);
    const listed = service.listModels({ providerId: MOCK_PROVIDER_ID });
    const connection = await service.testConnection(MOCK_PROVIDER_ID);

    expect(refreshed).toHaveLength(2);
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
      modelId: 'mock-image-v1',
      capabilitySource: 'mock',
      }),
    ]));
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'mock-video-v1',
        capabilitySource: 'mock',
        capabilities: expect.objectContaining({
          operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
          supportsProgress: true,
          supportsCancel: true,
        }),
      }),
    ]));
    expect(listed.items.map((model) => model.id)).toEqual(refreshed.map((model) => model.id));
    expect(connection).toEqual({
      ok: true,
      latencyMs: 37,
      message: 'Provider connection succeeded.',
    });
  });

  it('uses the injected Gemini models endpoint for live refresh and preserves manual overrides', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(geminiModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service, models } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'Live Gemini',
      type: 'gemini-generate-content-image-v1',
      baseUrl: 'https://proxy.example.test/gemini/v1beta',
      apiKey: 'live-gemini-api-key',
    });

    const refreshed = await service.refreshModels(provider.id);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/v1beta/models',
    });
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-image',
        capabilitySource: 'provider',
      }),
      expect.objectContaining({
        modelId: 'gemini-custom-image-preview',
        capabilitySource: 'provider',
        capabilities: expect.objectContaining({ maxReferenceImages: 3 }),
      }),
    ]));
    expect(refreshed.some((model) => model.modelId === 'gemini-3.1-flash-text')).toBe(false);

    const discovered = refreshed.find((model) => model.modelId === 'gemini-custom-image-preview');
    if (!discovered) throw new Error('Expected discovered Gemini image model.');
    const manual = service.saveManualModel({
      providerId: provider.id,
      modelId: discovered.modelId,
      displayName: 'Pinned manual name',
      capabilities: discovered.capabilities,
      enabled: false,
    });
    const refreshedAgain = await service.refreshModels(provider.id);
    expect(models.get(manual.id)).toMatchObject({
      id: manual.id,
      displayName: 'Pinned manual name',
      capabilitySource: 'manual',
      enabled: false,
    });
    expect(refreshedAgain).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, capabilitySource: 'manual', displayName: 'Pinned manual name' }),
    ]));
  });

  it('uses the custom OpenAI-compatible Base URL for live image catalog refresh', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(openAiImagesModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'OpenAI-compatible Images',
      type: 'openai-images-v1',
      baseUrl: 'https://proxy.example.test/compatible/v1',
      apiKey: 'openai-compatible-catalog-key',
    });

    const refreshed = await service.refreshModels(provider.id);

    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/compatible/v1/models',
      headers: { Authorization: 'Bearer openai-compatible-catalog-key' },
    });
    expect(refreshed.map((model) => model.modelId)).toEqual(expect.arrayContaining([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-compatible-preview',
    ]));
    expect(refreshed).toHaveLength(3);
    expect(refreshed.every((model) => model.capabilitySource === 'provider')).toBe(true);
    expect(refreshed.find((model) => model.modelId === 'gpt-image-2')?.capabilities)
      .toMatchObject({ resolutions: expect.arrayContaining(['3840x2160']), supportsMask: true });
    expect(refreshed.find((model) => model.modelId === 'gpt-image-compatible-preview')?.capabilities)
      .toMatchObject({ maxReferenceImages: 1, supportsMask: false, supportsBatchCount: false });
  });

  it('falls back to the built-in Gemini profile catalog without live HTTP', async () => {
    const { service } = await createHarness();
    const provider = service.create({
      name: 'Profile Gemini',
      type: 'gemini-generate-content-image-v1',
    });

    const refreshed = await service.refreshModels(provider.id);

    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'gemini-3.1-flash-lite-image',
        capabilitySource: 'profile',
      }),
    ]));
  });

  it('refreshes the OpenAI-compatible Videos catalog through the custom Base URL', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(openAiVideosModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'OpenAI-compatible Videos',
      type: 'openai-videos-v1-compatible',
      baseUrl: 'https://proxy.example.test/videos/v1',
      apiKey: 'openai-video-catalog-key',
    });

    const refreshed = await service.refreshModels(provider.id);

    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/videos/v1/models',
      headers: { Authorization: 'Bearer openai-video-catalog-key' },
    });
    expect(refreshed.map((model) => model.modelId)).toEqual(expect.arrayContaining(['sora-2', 'sora-2-pro']));
    expect(refreshed.find((model) => model.modelId === 'sora-2')?.capabilities).toMatchObject({
      operations: ['video.generate', 'video.image_to_video'],
      supportsProgress: true,
      supportsCancel: false,
    });
    expect(refreshed.every((model) => model.capabilitySource === 'provider')).toBe(true);
  });

  it('refreshes xAI Imagine Video through its video catalog and preserves manual overrides', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(xaiVideoModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service, models } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'Live xAI Video',
      type: 'xai-imagine-video-v1',
      baseUrl: 'https://proxy.example.test/xai/video/v1',
      apiKey: 'xai-video-catalog-key',
      headers: { 'X-Trace': 'xai-video-trace' },
    });

    const refreshed = await service.refreshModels(provider.id);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/xai/video/v1/video-generation-models',
      headers: { Authorization: 'Bearer xai-video-catalog-key', 'X-Trace': 'xai-video-trace' },
    });
    expect(refreshed.map((model) => model.modelId)).toEqual(expect.arrayContaining([
      'grok-imagine-video',
      'grok-imagine-video-1.5',
      'grok-video-unknown-preview',
    ]));
    expect(refreshed).toHaveLength(3);
    expect(refreshed.find((model) => model.modelId === 'grok-imagine-video-1.5')?.capabilities)
      .toMatchObject({ operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'], maxReferenceImages: 7 });
    expect(refreshed.find((model) => model.modelId === 'grok-video-unknown-preview')?.capabilities)
      .toMatchObject({ operations: ['video.generate'], maxReferenceImages: 0, resolutions: ['480p'] });

    const unknownModel = refreshed.find((model) => model.modelId === 'grok-video-unknown-preview');
    if (!unknownModel) throw new Error('Expected the conservative xAI video model.');
    const manual = service.saveManualModel({
      providerId: provider.id,
      modelId: 'grok-video-unknown-preview',
      displayName: 'Pinned xAI video model',
      capabilities: unknownModel.capabilities,
      enabled: false,
    });
    await expect(service.testConnection(provider.id)).resolves.toMatchObject({ ok: true });
    expect(requests[1]).toMatchObject({ url: 'https://proxy.example.test/xai/video/v1/video-generation-models' });
    const refreshedAgain = await service.refreshModels(provider.id);
    expect(models.get(manual.id)).toMatchObject({
      displayName: 'Pinned xAI video model',
      capabilitySource: 'manual',
      enabled: false,
    });
    expect(refreshedAgain).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, capabilitySource: 'manual', displayName: 'Pinned xAI video model' }),
    ]));
    expect(JSON.stringify(service.get(provider.id))).not.toContain('xai-video-catalog-key');
    expect(JSON.stringify(service.get(provider.id))).not.toContain('xai-video-trace');
  });

  it('refreshes Gemini Veo through its custom catalog endpoint and keeps unknown models conservative', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(geminiVeoModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'Live Gemini Veo',
      type: 'gemini-veo-operation-v1',
      baseUrl: 'https://proxy.example.test/gemini/veo/v1beta',
      apiKey: 'gemini-veo-catalog-key',
      headers: { 'X-Trace': 'gemini-veo-trace' },
    });

    const refreshed = await service.refreshModels(provider.id);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/veo/v1beta/models',
      headers: { 'x-goog-api-key': 'gemini-veo-catalog-key', 'X-Trace': 'gemini-veo-trace' },
    });
    expect(refreshed.map((model) => model.modelId)).toEqual(expect.arrayContaining([
      'veo-3.1-generate-preview',
      'veo-future-preview',
    ]));
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((model) => model.modelId === 'veo-3.1-generate-preview')?.capabilities)
      .toMatchObject({ operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'], resolutions: ['720p', '1080p', '4k'] });
    expect(refreshed.find((model) => model.modelId === 'veo-future-preview')?.capabilities)
      .toMatchObject({ operations: ['video.generate'], resolutions: ['720p'], maxReferenceImages: 0 });
    await expect(service.testConnection(provider.id)).resolves.toMatchObject({ ok: true });
    expect(requests[1]).toMatchObject({ url: 'https://proxy.example.test/gemini/veo/v1beta/models' });
    expect(JSON.stringify(service.get(provider.id))).not.toContain('gemini-veo-catalog-key');
    expect(JSON.stringify(service.get(provider.id))).not.toContain('gemini-veo-trace');
  });

  it('refreshes Gemini Omni Video through its custom catalog endpoint and filters non-video models', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(geminiOmniVideoModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'Live Gemini Omni Video',
      type: 'gemini-omni-interactions-video-v1',
      baseUrl: 'https://proxy.example.test/gemini/omni/v1beta',
      apiKey: 'gemini-omni-catalog-key',
      headers: { 'X-Trace': 'gemini-omni-trace' },
    });

    const refreshed = await service.refreshModels(provider.id);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/omni/v1beta/models',
      headers: { 'x-goog-api-key': 'gemini-omni-catalog-key', 'X-Trace': 'gemini-omni-trace' },
    });
    expect(refreshed.map((model) => model.modelId)).toEqual(expect.arrayContaining([
      'gemini-omni-flash-preview',
      'gemini-omni-future-preview',
    ]));
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((model) => model.modelId === 'gemini-omni-flash-preview')?.capabilities)
      .toMatchObject({ operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'], supportsCancel: false });
    expect(refreshed.find((model) => model.modelId === 'gemini-omni-future-preview')?.capabilities)
      .toMatchObject({ operations: ['video.generate'], maxReferenceImages: 0, supportsAudio: false });
    await expect(service.testConnection(provider.id)).resolves.toMatchObject({ ok: true });
    expect(requests[1]).toMatchObject({ url: 'https://proxy.example.test/gemini/omni/v1beta/models' });
    expect(JSON.stringify(service.get(provider.id))).not.toContain('gemini-omni-catalog-key');
    expect(JSON.stringify(service.get(provider.id))).not.toContain('gemini-omni-trace');
  });

  it('uses static catalogs for registered video profiles when no live client is configured', async () => {
    const { service } = await createHarness();
    const profiles = [
      ['xai-imagine-video-v1', 'grok-imagine-video'],
      ['gemini-veo-operation-v1', 'veo-3.1-generate-preview'],
      ['gemini-omni-interactions-video-v1', 'gemini-omni-flash-preview'],
    ] as const;

    for (const [type, modelId] of profiles) {
      const provider = service.create({ name: type, type });
      const refreshed = await service.refreshModels(provider.id);
      expect(refreshed).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId, capabilitySource: 'profile' }),
      ]));
    }
  });

  it('uses the injected xAI models endpoint for live refresh and preserves manual overrides', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const http = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: JSON.parse(readFileSync(xaiModelsFixture, 'utf8')) as unknown,
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    const { service, models } = await createHarness(new MockProviderAdapter(), { http });
    const provider = service.create({
      name: 'Live xAI',
      type: 'xai-imagine-image-v1',
      baseUrl: 'https://proxy.example.test/xai/v1',
      apiKey: 'live-xai-api-key',
    });

    const refreshed = await service.refreshModels(provider.id);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/xai/v1/models',
    });
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'grok-imagine-image-2.0',
        capabilitySource: 'provider',
      }),
      expect.objectContaining({
        modelId: 'grok-imagine-image-custom-preview',
        capabilitySource: 'provider',
        capabilities: expect.objectContaining({ maxReferenceImages: 1, maxBatchCount: 1 }),
      }),
    ]));
    expect(refreshed.some((model) => model.modelId === 'grok-text-model')).toBe(false);

    const discovered = refreshed.find((model) => model.modelId === 'grok-imagine-image-custom-preview');
    if (!discovered) throw new Error('Expected discovered xAI image model.');
    const manual = service.saveManualModel({
      providerId: provider.id,
      modelId: discovered.modelId,
      displayName: 'Pinned xAI model',
      capabilities: discovered.capabilities,
      enabled: false,
    });
    await service.refreshModels(provider.id);
    expect(models.get(manual.id)).toMatchObject({
      displayName: 'Pinned xAI model',
      capabilitySource: 'manual',
      enabled: false,
    });
  });

  it('uses the explicit connection probe instead of static capabilities', async () => {
    let probes = 0;
    class ProbeAdapter extends MockProviderAdapter {
      public override async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
        throw new Error('static capabilities must not be used as a connection probe');
      }

      public override async testConnection(_context: ProviderContext): Promise<void> {
        probes += 1;
      }
    }
    const { service } = await createHarness(new ProbeAdapter());
    service.ensureMockProvider();

    await expect(service.testConnection(MOCK_PROVIDER_ID)).resolves.toMatchObject({
      ok: true,
      message: 'Provider connection succeeded.',
    });
    expect(probes).toBe(1);
  });

  it('preserves manual model overrides and only mutates manual rows through manual APIs', async () => {
    const { models, service } = await createHarness();
    service.ensureMockProvider();
    const initial = await service.refreshModels(MOCK_PROVIDER_ID);
    const providerModel = initial[0];
    if (!providerModel) throw new Error('Expected a provider model.');
    const providerOnly = models.replaceForProvider(MOCK_PROVIDER_ID, [{
      modelId: 'provider-only',
      displayName: 'Provider only',
      capabilities: providerModel.capabilities,
      capabilitySource: 'provider',
    }]).find((model) => model.modelId === 'provider-only');
    if (!providerOnly) throw new Error('Expected a provider-only model.');

    const manual = service.saveManualModel({
      providerId: MOCK_PROVIDER_ID,
      modelId: providerModel.modelId,
      displayName: 'Manual override',
      capabilities: providerModel.capabilities,
      enabled: false,
    });
    expect(manual).toMatchObject({ capabilitySource: 'manual', enabled: false });

    expect(() => service.updateManualModel(providerOnly.id, { displayName: 'Nope' }))
      .toThrowError(expect.objectContaining({ code: 'model_not_manual' }));
    expect(() => service.deleteManualModel(providerOnly.id)).toThrowError(
      expect.objectContaining({ code: 'model_not_manual' }),
    );

    const refreshed = await service.refreshModels(MOCK_PROVIDER_ID);
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: manual.id,
        modelId: providerModel.modelId,
        displayName: 'Manual override',
        capabilitySource: 'manual',
        enabled: false,
      }),
      expect.objectContaining({ id: providerOnly.id, enabled: false }),
    ]));
  });

  it('maps refresh adapter failures to a safe catalog error', async () => {
    class FailingMockAdapter extends MockProviderAdapter {
      public override async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
        throw new Error('upstream secret material');
      }
    }
    const { service } = await createHarness(new FailingMockAdapter());
    service.ensureMockProvider();

    const result = service.refreshModels(MOCK_PROVIDER_ID);
    await expect(result).rejects.toEqual(
      expect.objectContaining<Partial<ModelCatalogServiceError>>({
        code: 'model_catalog_unavailable',
        message: 'Provider model catalog could not be refreshed.',
      }),
    );
    try {
      await result;
    } catch (error) {
      expect(String(error)).not.toContain('upstream secret material');
    }
  });

  it('forwards persisted endpoint, config, and decrypted header context to catalog calls', async () => {
    let received: ProviderContext | undefined;
    class ContextMockAdapter extends MockProviderAdapter {
      public override async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
        received = context;
        return super.getCapabilities(context);
      }
    }
    const { service } = await createHarness(new ContextMockAdapter());
    const provider = service.create({
      name: 'Context Provider',
      type: 'mock',
      baseUrl: 'https://provider.example.test/v1',
      config: { profile: 'fixture' },
      apiKey: 'catalog-api-key',
      headers: { 'X-Trace': 'catalog-trace' },
    });

    await service.refreshModels(provider.id);
    expect(received).toMatchObject({
      providerId: provider.id,
      baseUrl: 'https://provider.example.test/v1',
      config: { profile: 'fixture' },
      secrets: { apiKey: 'catalog-api-key', 'header:X-Trace': 'catalog-trace' },
    });
  });

  it('does not leak adapter errors from a failed connection test', async () => {
    class FailingMockAdapter extends MockProviderAdapter {
      public override async testConnection(_context: ProviderContext): Promise<void> {
        throw new Error('secret material from upstream');
      }
    }
    const { service } = await createHarness(new FailingMockAdapter());
    service.ensureMockProvider();

    const result = await service.testConnection(MOCK_PROVIDER_ID);

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Provider connection test failed.');
    expect(JSON.stringify(result)).not.toContain('secret material');
  });

  it('reports a safe upstream status without exposing its response or credentials', async () => {
    class UnauthorizedAdapter extends MockProviderAdapter {
      public override async testConnection(): Promise<void> { throw new Error('upstream secret key'); }
      public override normalizeError() { return { code: 'upstream_auth', kind: 'rejected' as const, message: 'upstream secret key', retryable: false, statusCode: 401 }; }
    }
    const { service } = await createHarness(new UnauthorizedAdapter());
    service.ensureMockProvider();
    const result = await service.testConnection(MOCK_PROVIDER_ID);
    expect(result.message).toContain('HTTP 401');
    expect(JSON.stringify(result)).not.toContain('secret key');
  });

  it('uses custom HTTP catalog responses only when configured and marks static fallback stale', async () => {
    const adapter = new CustomServiceAdapter({
      type: 'custom-http-v1',
      catalog: true,
      staticCapabilities: capabilities('custom-http-v1', 'definition-model'),
      liveCapabilities: capabilities('custom-http-v1', 'catalog-model'),
    });
    const ref = customRef('declarative-http', '1.0.0', 'a'.repeat(64));
    const { provider, service } = await createCustomServiceHarness('custom-http-v1', adapter, ref, { http: true });

    const live = await service.refreshModels(provider.id);
    expect(live).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'catalog-model', capabilitySource: 'provider' }),
    ]));
    expect(service.getCatalogStatus(provider.id)).toEqual({
      providerId: provider.id,
      source: 'provider',
      stale: false,
      adapterRef: ref,
    });

    adapter.liveFailure = true;
    const fallback = await service.refreshModels(provider.id);
    expect(fallback).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'definition-model', capabilitySource: 'profile', enabled: true }),
    ]));
    expect(fallback.find((model) => model.modelId === 'catalog-model')).toMatchObject({ enabled: false });
    expect(service.getCatalogStatus(provider.id)).toMatchObject({
      source: 'profile',
      stale: true,
      adapterRef: ref,
    });
    expect(adapter.staticCalls).toBe(1);
    expect(adapter.liveCalls).toBe(2);
  });

  it('does not treat a custom HTTP adapter without a catalog endpoint as live', async () => {
    const adapter = new CustomServiceAdapter({
      type: 'custom-http-v1',
      staticCapabilities: capabilities('custom-http-v1', 'profile-model'),
      liveCapabilities: capabilities('custom-http-v1', 'must-not-be-used'),
    });
    const ref = customRef('declarative-http', '1.0.0', 'b'.repeat(64));
    const { provider, service } = await createCustomServiceHarness('custom-http-v1', adapter, ref, { http: true });

    const refreshed = await service.refreshModels(provider.id);
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'profile-model', capabilitySource: 'profile' }),
    ]));
    expect(adapter.liveCalls).toBe(0);
    expect(service.getCatalogStatus(provider.id)).toMatchObject({ source: 'profile', stale: false });
  });

  it('accepts provider-specific custom JavaScript providerType and isolates static cache by exact ref', async () => {
    const firstAdapter = new CustomServiceAdapter({
      type: 'custom-js-v1',
      staticCapabilities: capabilities('fixture-provider', 'first-model'),
    });
    const firstRef = customRef('trusted-javascript', '1.0.0', 'c'.repeat(64));
    const { provider, service, setRegistration } = await createCustomServiceHarness('custom-js-v1', firstAdapter, firstRef);

    await service.refreshModels(provider.id);
    await service.refreshModels(provider.id);
    expect(firstAdapter.staticCalls).toBe(1);

    const secondAdapter = new CustomServiceAdapter({
      type: 'custom-js-v1',
      staticCapabilities: capabilities('another-fixture-provider', 'second-model'),
    });
    const secondRef = customRef('trusted-javascript', '2.0.0', 'd'.repeat(64));
    setRegistration({
      adapter: secondAdapter,
      adapterRef: secondRef,
      config: { models: ['spoofed-model'] },
      secrets: {},
      submitReplaySafe: false,
    });
    const replaced = await service.refreshModels(provider.id);
    expect(replaced).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'second-model', capabilitySource: 'profile', enabled: true }),
    ]));
    expect(replaced.find((model) => model.modelId === 'first-model')).toMatchObject({ enabled: false });
    expect(secondAdapter.staticCalls).toBe(1);
    expect(service.getCatalogStatus(provider.id)).toMatchObject({
      source: 'profile',
      stale: false,
      adapterRef: secondRef,
    });

    firstAdapter.staticCapabilities = capabilities('fixture-provider', 'first-model-reloaded');
    setRegistration({
      adapter: firstAdapter,
      adapterRef: firstRef,
      config: {},
      secrets: {},
      submitReplaySafe: false,
    });
    const reverted = await service.refreshModels(provider.id);
    expect(reverted).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'first-model-reloaded', capabilitySource: 'profile' }),
    ]));
    expect(firstAdapter.staticCalls).toBe(2);
  });

  it('does not reuse static or live catalog results across custom HTTP revisions', async () => {
    const firstAdapter = new CustomServiceAdapter({
      type: 'custom-http-v1',
      catalog: true,
      staticCapabilities: capabilities('custom-http-v1', 'http-definition-one'),
      liveCapabilities: capabilities('custom-http-v1', 'http-live-one'),
    });
    const firstRef = customRef('declarative-http', '1.0.0', '3'.repeat(64));
    const { provider, service, setRegistration } = await createCustomServiceHarness(
      'custom-http-v1',
      firstAdapter,
      firstRef,
      { http: true },
    );

    const first = await service.refreshModels(provider.id);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'http-live-one', capabilitySource: 'provider' }),
    ]));

    const secondAdapter = new CustomServiceAdapter({
      type: 'custom-http-v1',
      catalog: true,
      staticCapabilities: capabilities('custom-http-v1', 'http-definition-two'),
      liveCapabilities: capabilities('custom-http-v1', 'http-live-two'),
    });
    const secondRef = customRef('declarative-http', '2.0.0', '4'.repeat(64));
    setRegistration({
      adapter: secondAdapter,
      adapterRef: secondRef,
      config: {},
      http: {} as NonNullable<ProviderRegistration['http']>,
      secrets: {},
      submitReplaySafe: false,
    });

    const second = await service.refreshModels(provider.id);
    expect(second).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'http-live-two', capabilitySource: 'provider' }),
    ]));
    expect(second.find((model) => model.modelId === 'http-live-one')).toMatchObject({ enabled: false });
    expect(firstAdapter.staticCalls).toBe(1);
    expect(firstAdapter.liveCalls).toBe(1);
    expect(secondAdapter.staticCalls).toBe(1);
    expect(secondAdapter.liveCalls).toBe(1);
    expect(service.getCatalogStatus(provider.id)).toMatchObject({ adapterRef: secondRef });
  });

  it('invalidates only the affected Provider catalog state on update, default, and delete', async () => {
    const base = await createHarness();
    const adapterA = new CustomServiceAdapter({
      type: 'custom-js-v1',
      staticCapabilities: capabilities('provider-a', 'model-a'),
    });
    const adapterB = new CustomServiceAdapter({
      type: 'custom-js-v1',
      staticCapabilities: capabilities('provider-b', 'model-b'),
    });
    const providerA = base.service.create({ name: 'Cache Provider A', type: 'custom-js-v1' });
    const providerB = base.service.create({ name: 'Cache Provider B', type: 'custom-js-v1' });
    const registrations = new Map<string, ProviderRegistration>([
      [providerA.id, {
        adapter: adapterA,
        adapterRef: customRef('trusted-javascript', '1.0.0', '5'.repeat(64)),
        config: {},
        secrets: {},
        submitReplaySafe: false,
      }],
      [providerB.id, {
        adapter: adapterB,
        adapterRef: customRef('trusted-javascript', '1.0.0', '6'.repeat(64)),
        config: {},
        secrets: {},
        submitReplaySafe: false,
      }],
    ]);
    const registry = {
      resolve(providerId: string): ProviderRegistration {
        const registration = registrations.get(providerId);
        if (registration === undefined) throw new Error('fixture registration missing');
        return registration;
      },
    } as unknown as ProviderRegistry;
    const service = new ProviderService(base.providers, base.models, base.vault, registry);

    await service.refreshModels(providerA.id);
    await service.refreshModels(providerB.id);
    await service.refreshModels(providerA.id);
    await service.refreshModels(providerB.id);
    expect(adapterA.staticCalls).toBe(1);
    expect(adapterB.staticCalls).toBe(1);

    service.update(providerA.id, { name: 'Cache Provider A updated' });
    expect(service.getCatalogStatus(providerA.id)).toBeNull();
    expect(service.getCatalogStatus(providerB.id)).not.toBeNull();
    await service.refreshModels(providerB.id);
    expect(adapterB.staticCalls).toBe(1);
    await service.refreshModels(providerA.id);
    expect(adapterA.staticCalls).toBe(2);

    service.setDefault(providerA.id);
    expect(service.getCatalogStatus(providerA.id)).toBeNull();
    expect(service.getCatalogStatus(providerB.id)).not.toBeNull();
    await service.refreshModels(providerB.id);
    expect(adapterB.staticCalls).toBe(1);
    await service.refreshModels(providerA.id);
    expect(adapterA.staticCalls).toBe(3);

    expect(service.delete(providerA.id)).toBe(true);
    expect(service.getCatalogStatus(providerA.id)).toBeNull();
    expect(service.getCatalogStatus(providerB.id)).not.toBeNull();
    await service.refreshModels(providerB.id);
    expect(adapterB.staticCalls).toBe(1);

    base.providers.create({ id: providerA.id, name: 'Cache Provider A recreated', type: 'custom-js-v1' });
    await service.refreshModels(providerA.id);
    expect(adapterA.staticCalls).toBe(4);
  });

  it('evicts the oldest static catalog entry at the cache limit and reloads the current ref', async () => {
    const base = await createHarness();
    const registrations = new Map<string, ProviderRegistration>();
    const adapters: CustomServiceAdapter[] = [];
    const providers: string[] = [];
    const registry = {
      resolve(providerId: string): ProviderRegistration {
        const registration = registrations.get(providerId);
        if (registration === undefined) throw new Error('fixture registration missing');
        return registration;
      },
    } as unknown as ProviderRegistry;
    const service = new ProviderService(base.providers, base.models, base.vault, registry);

    for (let index = 0; index <= 128; index += 1) {
      const adapter = new CustomServiceAdapter({
        type: 'custom-js-v1',
        staticCapabilities: capabilities('cache-provider', `cache-model-${index}`),
      });
      const provider = base.service.create({
        name: `Cache fill ${index}`,
        type: 'custom-js-v1',
      });
      const ref = customRef(
        'trusted-javascript',
        '1.0.0',
        index.toString(16).padStart(64, '0'),
      );
      registrations.set(provider.id, {
        adapter,
        adapterRef: ref,
        config: {},
        secrets: {},
        submitReplaySafe: false,
      });
      adapters.push(adapter);
      providers.push(provider.id);
      await service.refreshModels(provider.id);
    }

    const firstAdapter = adapters[0];
    const firstProviderId = providers[0];
    if (firstAdapter === undefined || firstProviderId === undefined) {
      throw new Error('Expected cache fixture providers.');
    }
    firstAdapter.staticCapabilities = capabilities('cache-provider', 'cache-model-current');
    const reloaded = await service.refreshModels(firstProviderId);

    expect(firstAdapter.staticCalls).toBe(2);
    expect(reloaded).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'cache-model-current', capabilitySource: 'profile' }),
    ]));
  });

  it('keeps strict adapter type checks and rejects unknown capability fields', async () => {
    const badHttp = new CustomServiceAdapter({
      type: 'custom-http-v1',
      staticCapabilities: {
        ...capabilities('wrong-provider', 'bad-model'),
        unknown: true,
      } as ProviderCapabilities,
    });
    const { provider, service } = await createCustomServiceHarness(
      'custom-http-v1',
      badHttp,
      customRef('declarative-http', '1.0.0', 'e'.repeat(64)),
    );

    await expect(service.refreshModels(provider.id)).rejects.toEqual(
      expect.objectContaining<Partial<ModelCatalogServiceError>>({
        code: 'model_capabilities_invalid',
        message: 'Provider returned an invalid model catalog.',
      }),
    );
    expect(service.getCatalogStatus(provider.id)).toBeNull();
  });

  it('uses an explicit custom HTTP connection endpoint and does not probe static custom JavaScript capabilities', async () => {
    let probes = 0;
    const httpAdapter = new CustomServiceConnectionAdapter({
      type: 'custom-http-v1',
      staticCapabilities: capabilities('custom-http-v1', 'connection-model'),
    }, async () => { probes += 1; });
    const httpHarness = await createCustomServiceHarness(
      'custom-http-v1',
      httpAdapter,
      customRef('declarative-http', '1.0.0', 'f'.repeat(64)),
    );
    await expect(httpHarness.service.testConnection(httpHarness.provider.id)).resolves.toMatchObject({ ok: true });
    expect(probes).toBe(1);

    const jsAdapter = new CustomServiceAdapter({
      type: 'custom-js-v1',
      staticCapabilities: capabilities('fixture-provider', 'runtime-model'),
    });
    const jsHarness = await createCustomServiceHarness(
      'custom-js-v1',
      jsAdapter,
      customRef('trusted-javascript', '1.0.0', '1'.repeat(64)),
    );
    const unsupported = await jsHarness.service.testConnection(jsHarness.provider.id);
    expect(unsupported).toMatchObject({
      ok: false,
      message: 'Provider connection test is not supported for this adapter.',
    });
    expect(unsupported.latencyMs).toBeGreaterThanOrEqual(0);
    expect(unsupported.latencyMs).toBeLessThan(1_000);
    expect(jsAdapter.staticCalls).toBe(0);
  });

  it('does not allow manual model writes to override custom adapter definitions', async () => {
    const adapter = new CustomServiceAdapter({
      type: 'custom-http-v1',
      staticCapabilities: capabilities('custom-http-v1', 'definition-model'),
    });
    const { provider, service } = await createCustomServiceHarness(
      'custom-http-v1',
      adapter,
      customRef('declarative-http', '1.0.0', '2'.repeat(64)),
    );

    expect(() => service.saveManualModel({
      providerId: provider.id,
      modelId: 'definition-model',
      displayName: 'Spoofed model',
      capabilities: { operations: ['video.generate'] },
    })).toThrowError(expect.objectContaining({ code: 'invalid_model' }));
  });
});

describe('ProviderRegistry', () => {
  it('resolves only enabled mock Providers and keeps decrypted secrets internal', async () => {
    const { providers, registry, service } = await createHarness();
    const provider = service.create({
      name: 'Mock',
      type: 'mock',
      apiKey: 'registry-api-key',
      headers: { 'X-Private': 'registry-header' },
    });

    expect(registry.resolve(provider.id)).toMatchObject({
      adapter: { type: 'mock' },
      secrets: {
        apiKey: 'registry-api-key',
        'header:X-Private': 'registry-header',
      },
      submitReplaySafe: true,
    });
    providers.update(provider.id, { enabled: false });
    expect(() => registry.resolve(provider.id)).toThrowError(
      expect.objectContaining<Partial<ProviderRegistryError>>({ code: 'provider_disabled' }),
    );
  });

  it('reports missing, unsupported, and invalid-secret Providers without plaintext', async () => {
    const { providers, registry } = await createHarness();
    expect(() => registry.resolve('missing')).toThrowError(
      expect.objectContaining<Partial<ProviderRegistryError>>({ code: 'provider_not_found' }),
    );

    const unsupported = providers.create({ name: 'Future', type: 'future-provider' });
    expect(() => registry.resolve(unsupported.id)).toThrowError(
      expect.objectContaining<Partial<ProviderRegistryError>>({
        code: 'provider_type_unsupported',
      }),
    );

    const corrupt = providers.create({
      name: 'Corrupt',
      type: 'mock',
      apiKeyCiphertext: 'plaintext-that-is-not-an-envelope',
    });
    let thrown: unknown;
    try {
      registry.resolve(corrupt.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(
      expect.objectContaining<Partial<ProviderRegistryError>>({ code: 'provider_secret_invalid' }),
    );
    expect(String(thrown)).not.toContain('plaintext-that-is-not-an-envelope');
  });
});
