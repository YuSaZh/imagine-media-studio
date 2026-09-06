import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProviderAssetReference,
  ProviderContext,
} from '@imagine/provider-contract';
import type { CustomAdapterRef, GenerationRequest } from '@imagine/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ProviderRepository } from '../database/providers.js';
import { ProviderAdapterDefinitionRepository } from '../database/adapter-definitions.js';
import { SecretVault } from '../security/secret-vault.js';
import type {
  AdapterErrorView,
  AdapterInvocation,
  AdapterProviderContext,
  AdapterRuntimeReference,
} from '../adapters/index.js';
import {
  canonicalDeclarativeSpec,
  parseDeclarativeJson,
} from './custom-http/index.js';
import type { TrustedJavaScriptWorkerHost } from './custom-js/index.js';
import {
  ProviderRegistry,
  type ProviderHttpClient,
} from './provider-registry.js';

type DeclarativeAdapterRef = CustomAdapterRef & { readonly kind: 'declarative-http' };
type TrustedAdapterRef = CustomAdapterRef & { readonly kind: 'trusted-javascript' };

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const directories: string[] = [];
const databases: DatabaseClient[] = [];
const veoFixtureRoot = new URL(
  '../../../../fixtures/providers/gemini/gemini-veo-operation-v1/',
  import.meta.url,
);
const customHttpFixture = new URL(
  '../../../../fixtures/providers/custom-http/sync-image/adapter.json',
  import.meta.url,
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, veoFixtureRoot), 'utf8')) as unknown;
}

function customHttpDefinition(): {
  definition: Record<string, unknown>;
  ref: DeclarativeAdapterRef;
} {
  const definition = JSON.parse(readFileSync(customHttpFixture, 'utf8')) as Record<string, unknown>;
  const canonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(definition)));
  return {
    definition,
    ref: {
      kind: 'declarative-http',
      adapterId: 'sync-image',
      version: '1.0.0',
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    },
  };
}

function trustedCapabilities(): Record<string, unknown> {
  return {
    providerType: 'fixture-provider',
    models: [{
      id: 'fixture-model',
      displayName: 'Fixture model',
      capabilities: { operations: ['image.generate'] },
    }],
  };
}

function trustedHost(calls: AdapterRuntimeReference[]): TrustedJavaScriptWorkerHost {
  return {
    capabilities: async (reference: AdapterRuntimeReference, _context: AdapterProviderContext) => {
      calls.push(reference);
      return trustedCapabilities();
    },
    submit: async (_reference: AdapterRuntimeReference, _context: AdapterProviderContext, _invocation: AdapterInvocation) => ({
      state: 'completed',
      assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }],
    }),
    poll: async () => ({ state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }] }),
    cancel: async () => undefined,
    normalizeError: async (_reference: AdapterRuntimeReference, _context: AdapterProviderContext, _error: AdapterErrorView) => ({
      code: 'fixture_error',
      kind: 'unknown',
      message: 'Fixture error.',
      retryable: false,
    }),
  };
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
  return { database, providers, vault };
}

describe('ProviderRegistry registrations', () => {
  it('registers every approved profile with durable runtime context', async () => {
    const { providers, vault } = await harness();
    const types = [
      'openai-images-v1',
      'openai-responses-image-v1',
      'openai-chat-image-v1',
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
      expect(registration.adapterRef).toBeNull();
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
    } as unknown as ProviderHttpClient;
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

  it('resolves a current and historical declarative revision without falling back', async () => {
    const { database, providers, vault } = await harness();
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const provider = providers.create({
      id: 'declarative-registry-provider',
      name: 'Declarative registry provider',
      type: 'custom-http-v1',
      baseUrl: 'https://api.example.test',
      apiKeyCiphertext: vault.encryptString('declarative-registry-provider', 'apiKey', 'declarative-secret'),
      headersCiphertext: vault.encryptJson('declarative-registry-provider', 'headers', {
        'X-Unused': 'unused-secret',
      }),
    });
    const first = customHttpDefinition();
    definitions.replace(provider.id, first);
    const http = {
      async request() {
        return {
          status: 200,
          statusCode: 200,
          headers: {},
          json: { data: [{ b64_json: 'aGVsbG8=' }] },
          dispose: async () => undefined,
        };
      },
    } as unknown as ProviderHttpClient;
    const registry = new ProviderRegistry(providers, vault, {
      adapterDefinitions: definitions,
      http,
    });

    const current = registry.resolve(provider.id);
    expect(current.adapter.type).toBe('custom-http-v1');
    expect(current.adapterRef).toEqual(first.ref);
    expect(current.secrets).toEqual({ apiKey: 'declarative-secret' });
    await expect(current.adapter.submit({
      operation: 'image.generate',
      providerId: provider.id,
      modelId: 'image-model',
      prompt: 'fixture',
      inputs: [],
      extra: { style: 'clean' },
    }, {
      providerId: provider.id,
      ...(current.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }),
      config: current.config ?? {},
      ...(current.http === undefined ? {} : { http: current.http }),
      secrets: current.secrets,
    })).resolves.toMatchObject({ state: 'completed' });

    const secondDefinition = { ...first.definition, name: 'Custom Sync Image v2' };
    const secondCanonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(secondDefinition)));
    const second = {
      ...first.ref,
      version: '2.0.0',
      digest: createHash('sha256').update(secondCanonical, 'utf8').digest('hex'),
    } satisfies DeclarativeAdapterRef;
    definitions.replace(provider.id, { definition: secondDefinition, ref: second });

    expect(registry.resolve(provider.id).adapterRef).toEqual(second);
    expect(registry.resolve(provider.id, first.ref).adapterRef).toEqual(first.ref);

    definitions.disable(provider.id, second);
    expect(() => registry.resolve(provider.id)).toThrowError(
      expect.objectContaining({ code: 'provider_adapter_not_found' }),
    );
    expect(registry.resolve(provider.id, second).adapterRef).toEqual(second);
    expect(() => registry.resolve(provider.id, {
      ...first.ref,
      kind: 'trusted-javascript',
    })).toThrowError(expect.objectContaining({ code: 'provider_adapter_kind_mismatch' }));
  });

  it('fails closed for missing custom dependencies and rejects a custom ref on built-ins', async () => {
    const { providers, vault } = await harness();
    const provider = providers.create({
      id: 'missing-custom-registry-provider',
      name: 'Missing custom registry provider',
      type: 'custom-http-v1',
    });
    expect(() => new ProviderRegistry(providers, vault).resolve(provider.id)).toThrowError(
      expect.objectContaining({ code: 'provider_adapter_unavailable' }),
    );

    const builtin = providers.create({ name: 'Builtin registry provider', type: 'mock' });
    expect(() => new ProviderRegistry(providers, vault).resolve(builtin.id, {
      kind: 'declarative-http',
      adapterId: 'wrong',
      version: '1',
      digest: 'a'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'provider_adapter_ref_not_allowed' }));
  });

  it('binds an exact trusted JavaScript ref to the injected runtime host', async () => {
    const { database, providers, vault } = await harness();
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const provider = providers.create({
      id: 'trusted-registry-provider',
      name: 'Trusted registry provider',
      type: 'custom-js-v1',
      apiKeyCiphertext: vault.encryptString('trusted-registry-provider', 'apiKey', 'trusted-secret'),
    });
    const first: TrustedAdapterRef = {
      kind: 'trusted-javascript',
      adapterId: 'trusted-fixture',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    definitions.replace(provider.id, { ref: first });
    const calls: AdapterRuntimeReference[] = [];
    const workerHost = trustedHost(calls);
    const registry = new ProviderRegistry(providers, vault, {
      adapterDefinitions: definitions,
      adapterWorkerHost: workerHost,
    });

    expect(registry.resolve(provider.id).adapterRef).toEqual(first);
    const registration = registry.resolve(provider.id, first);
    expect(registration.adapter.type).toBe('custom-js-v1');
    expect(registration.adapterRef).toEqual(first);
    await expect(registration.adapter.getCapabilities({
      providerId: provider.id,
      config: registration.config ?? {},
      secrets: registration.secrets,
    })).resolves.toMatchObject({ providerType: 'fixture-provider' });
    expect(calls).toEqual([first]);

    const second = { ...first, version: '2.0.0', digest: 'b'.repeat(64) } as const;
    definitions.replace(provider.id, { ref: second });
    expect(registry.resolve(provider.id, first).adapterRef).toEqual(first);
    expect(registry.resolve(provider.id).adapterRef).toEqual(second);
    expect(() => new ProviderRegistry(providers, vault, { adapterDefinitions: definitions }).resolve(provider.id, second))
      .toThrowError(expect.objectContaining({ code: 'provider_adapter_unavailable' }));
  });
});
