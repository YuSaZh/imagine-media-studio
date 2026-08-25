import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ProviderRepository } from '../database/providers.js';
import { SecretVault } from '../security/secret-vault.js';
import {
  ProviderRegistry,
  type ProviderHttpClient,
} from './provider-registry.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const directories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function harness() {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-provider-registry-'));
  directories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const vault = new SecretVault('provider-registry-test-secret-with-enough-entropy');
  return { providers, vault };
}

describe('ProviderRegistry PR4 registrations', () => {
  it('registers every approved image profile with durable runtime context', async () => {
    const { providers, vault } = await harness();
    const types = [
      'openai-images-v1',
      'openai-responses-image-v1',
      'gemini-generate-content-image-v1',
      'gemini-interactions-image-v1',
      'xai-imagine-image-v1',
    ] as const;
    const client = {} as ProviderHttpClient;
    const registry = new ProviderRegistry(providers, vault, { http: client });

    for (const [index, type] of types.entries()) {
      const id = `provider-${index}`;
      providers.create({
        id,
        name: type,
        type,
        baseUrl: `https://proxy.example.test/${type}`,
        apiKeyCiphertext: vault.encryptString(id, 'apiKey', `secret-${index}`),
        headersCiphertext: vault.encryptJson(id, 'headers', { 'X-Trace': `trace-${index}` }),
        config: { profileOption: type },
      });

      const registration = registry.resolve(id);
      expect(registration.adapter.type).toBe(type);
      expect(registration.baseUrl).toBe(`https://proxy.example.test/${type}`);
      expect(registration.config).toEqual({ profileOption: type });
      expect(registration.secrets).toEqual({
        apiKey: `secret-${index}`,
        'header:X-Trace': `trace-${index}`,
      });
      expect(registration.http).toBe(client);
      expect(registration.submitReplaySafe).toBe(false);
    }
  });

  it('uses the injected factory per provider without exposing credentials in errors', async () => {
    const { providers, vault } = await harness();
    const id = 'factory-provider';
    providers.create({
      id,
      name: 'Factory provider',
      type: 'gemini-interactions-image-v1',
      apiKeyCiphertext: vault.encryptString(id, 'apiKey', 'factory-secret'),
    });
    let seenSecrets: Readonly<Record<string, string>> | undefined;
    const client = {} as ProviderHttpClient;
    const registry = new ProviderRegistry(providers, vault, {
      httpFactory: (_provider, secrets) => {
        seenSecrets = secrets;
        return client;
      },
    });

    expect(registry.resolve(id).http).toBe(client);
    expect(seenSecrets).toEqual({ apiKey: 'factory-secret' });

    const invalid = providers.create({
      id: 'invalid-provider',
      name: 'Invalid provider',
      type: 'gemini-interactions-image-v1',
      apiKeyCiphertext: 'not-an-envelope',
    });
    let thrown: unknown;
    try {
      registry.resolve(invalid.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'provider_secret_invalid' });
    expect(String(thrown)).toContain('invalid encrypted credentials');
    expect(String(thrown)).not.toContain('not-an-envelope');
  });

  it('filters legacy secret-like config before the runtime boundary', async () => {
    const { providers, vault } = await harness();
    const id = 'legacy-config-provider';
    providers.create({
      id,
      name: 'Legacy config provider',
      type: 'xai-imagine-image-v1',
      apiKeyCiphertext: vault.encryptString(id, 'apiKey', 'runtime-key'),
      config: {
        region: 'fixture',
        headers: { Authorization: 'legacy-header-secret' },
        nested: { token: 'legacy-token', keep: true },
      },
    });

    const registration = new ProviderRegistry(providers, vault).resolve(id);

    expect(registration.config).toEqual({ region: 'fixture', nested: { keep: true } });
    expect(JSON.stringify(registration.config)).not.toContain('legacy');
  });
});
