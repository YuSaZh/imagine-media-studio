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
} from './provider-registry.js';
import type { ProviderRegistryError } from './provider-registry.js';
import { ProviderService } from './provider-service.js';

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createHarness(adapter: MockProviderAdapter = new MockProviderAdapter()) {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-provider-service-test-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const models = new ModelRepository(database.orm);
  const vault = new SecretVault('provider-service-test-secret-with-enough-entropy');
  const registry = new ProviderRegistry(providers, vault, adapter);
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
    });
    expect(service.update(created.id, { apiKey: null, headers: null })).toMatchObject({
      hasApiKey: false,
      hasCustomHeaders: false,
    });
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

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({
      modelId: 'mock-image-v1',
      capabilitySource: 'mock',
    });
    expect(listed.items.map((model) => model.id)).toEqual(refreshed.map((model) => model.id));
    expect(connection).toEqual({
      ok: true,
      latencyMs: 37,
      message: 'Provider connection succeeded with 1 model(s).',
    });
  });

  it('does not leak adapter errors from a failed connection test', async () => {
    class FailingMockAdapter extends MockProviderAdapter {
      public override async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
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
