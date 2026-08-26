import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProviderAssetReference,
  ProviderContext,
} from '@imagine/provider-contract';
import type { GenerationRequest } from '@imagine/shared';
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
const veoFixtureRoot = new URL(
  '../../../../fixtures/providers/gemini/gemini-veo-operation-v1/',
  import.meta.url,
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, veoFixtureRoot), 'utf8')) as unknown;
}

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

describe('ProviderRegistry registrations', () => {
  it('registers every approved profile with durable runtime context', async () => {
    const { providers, vault } = await harness();
    const types = [
      'openai-images-v1',
      'openai-responses-image-v1',
      'openai-videos-v1-compatible',
      'gemini-generate-content-image-v1',
      'gemini-interactions-image-v1',
      'gemini-veo-operation-v1',
      'gemini-omni-interactions-video-v1',
      'xai-imagine-image-v1',
      'xai-imagine-video-v1',
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

  it('rebuilds an injected video provider context across submit, poll, and result resolution', async () => {
    const { providers, vault } = await harness();
    const id = 'veo-runtime-provider';
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>> }> = [];
    const bodies = [fixture('submit-response-pending.json'), fixture('poll-completed-uri.json')];
    let responseIndex = 0;
    const client = {
      async request(input: { method: 'GET' | 'POST'; url: string; headers: Readonly<Record<string, string>> }) {
        requests.push(input);
        return {
          status: 200,
          statusCode: 200,
          body: bodies[Math.min(responseIndex++, bodies.length - 1)],
          headers: {},
          dispose: async () => undefined,
        };
      },
    } as ProviderHttpClient;
    providers.create({
      id,
      name: 'Veo runtime provider',
      type: 'gemini-veo-operation-v1',
      baseUrl: 'https://proxy.example.test/gemini/v1beta',
      apiKeyCiphertext: vault.encryptString(id, 'apiKey', 'veo-runtime-key'),
      headersCiphertext: vault.encryptJson(id, 'headers', { 'X-Trace': 'runtime-trace' }),
      config: { region: 'fixture' },
    });

    const registration = new ProviderRegistry(providers, vault, { http: client }).resolve(id);
    const context = {
      providerId: id,
      modelId: 'veo-3.1-generate-preview',
      baseUrl: registration.baseUrl,
      config: registration.config,
      http: registration.http,
      secrets: registration.secrets,
    } as ProviderContext & { readonly http?: ProviderHttpClient };
    const request: GenerationRequest = {
      operation: 'video.generate',
      providerId: id,
      modelId: 'veo-3.1-generate-preview',
      prompt: 'A paper boat crossing a quiet lake.',
      inputs: [],
    };

    const submitted = await registration.adapter.submit(request, context);
    if (submitted.state !== 'pending') throw new Error('Expected an asynchronous video submission.');
    expect(submitted).toEqual({
      state: 'pending',
      remoteJobId: 'operation:operations/veo-fixture-001',
      pollAfterMs: 10_000,
    });
    if (!registration.adapter.poll) throw new Error('Expected the video adapter to support polling.');
    const completed = await registration.adapter.poll(submitted.remoteJobId, context);
    expect(completed.state).toBe('completed');
    if (completed.state !== 'completed') throw new Error('Expected a completed video result.');
    const asset = completed.assets[0];
    if (!asset || asset.source !== 'provider') throw new Error('Expected a provider-owned video result.');
    if (!registration.adapter.resolveResult) throw new Error('Expected the video adapter to resolve provider results.');
    const target = await registration.adapter.resolveResult(asset as ProviderAssetReference, context);

    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://proxy.example.test/gemini/v1beta/models/veo-3.1-generate-preview:predictLongRunning',
      headers: { 'x-goog-api-key': 'veo-runtime-key', 'X-Trace': 'runtime-trace' },
    });
    expect(requests[1]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/v1beta/operations/veo-fixture-001',
    });
    expect(target).toMatchObject({
      url: 'https://proxy.example.test/gemini/v1beta/files/veo-file-001:download?alt=media',
      headers: { 'x-goog-api-key': 'veo-runtime-key', 'X-Trace': 'runtime-trace' },
    });
    expect(target.url).not.toContain('veo-runtime-key');
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
