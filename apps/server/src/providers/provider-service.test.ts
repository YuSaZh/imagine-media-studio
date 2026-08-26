import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderCapabilities, ProviderContext } from '@imagine/provider-contract';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ModelRepository } from '../database/models.js';
import { ProviderRepository } from '../database/providers.js';
import { SecretVault } from '../security/secret-vault.js';
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
  options: { readonly http?: ProviderHttpClient } = {},
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
