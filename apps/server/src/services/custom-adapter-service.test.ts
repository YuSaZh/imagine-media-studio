import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ProviderInput } from '@imagine/provider-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ProviderAdapterDefinitionRepository } from '../database/adapter-definitions.js';
import { ProviderRepository } from '../database/providers.js';
import { parseDeclarativeYaml } from '../providers/custom-http/index.js';
import {
  CustomAdapterService,
  CustomAdapterServiceError,
  type CustomAdapterMockResponse,
} from './custom-adapter-service.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const fixtures = new URL('../../../../fixtures/providers/custom-http/', import.meta.url);
const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function harness(type = 'custom-http-v1') {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-custom-adapter-service-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const provider = providers.create({ name: `Provider ${providers.page().items.length + 1}`, type, baseUrl: 'https://api.example.test/root' });
  const adapterDefinitions = new ProviderAdapterDefinitionRepository(database.orm);
  const flushState = { count: 0, fail: false };
  return {
    adapterDefinitions,
    flushState,
    provider,
    providers,
    service: new CustomAdapterService({
      adapterDefinitions,
      authorization: { adminEnabled: true },
      outbox: { flush: () => { flushState.count += 1; if (flushState.fail) throw new Error('flush failed'); } },
      providers,
    }),
  };
}

function fixture(path: string): string {
  return readFileSync(new URL(path, fixtures), 'utf8');
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'image.generate',
    providerId: 'provider-id',
    modelId: 'image-model',
    prompt: 'A red kite',
    inputs: [],
    ...overrides,
  } as never;
}

function input(assetId: string, role: ProviderInput['role'], bytes = new Uint8Array([1, 2, 3])): ProviderInput {
  return {
    assetId,
    bytes,
    fileSize: bytes.byteLength,
    filename: `${assetId}.png`,
    height: 1,
    mimeType: 'image/png',
    parentAssetId: role === 'mask' ? 'source-1' : null,
    role,
    sha256: '0'.repeat(64),
    width: 1,
  };
}

class BoundOutboxPublisher {
  public count = 0;

  public flush(): void {
    this.count += 1;
  }
}

describe('CustomAdapterService', () => {
  it('imports strict JSON/YAML, derives canonical refs, and maintains exact revisions', async () => {
    const { provider, service } = await harness();
    const json = await service.create({ providerId: provider.id, format: 'json', version: '1.0.0', document: fixture('sync-image/adapter.json') });
    const yaml = await service.replace({ providerId: provider.id, format: 'yaml', version: '2.0.0', document: fixture('async-video/adapter.yaml') });

    expect(json.ref.kind).toBe('declarative-http');
    expect(json.ref.adapterId).toBe('sync-image');
    expect(service.current(provider.id)?.ref).toEqual(yaml.ref);
    expect(service.getExact(provider.id, json.ref)?.ref).toEqual(json.ref);
    expect(service.list(provider.id).map((item) => item.ref.version)).toEqual(['1.0.0', '2.0.0']);
    await expect(service.create({ providerId: provider.id, version: 'bad', document: fixture('sync-image/adapter.json') })).resolves.toBeTruthy();
  });

  it('exports deterministic secret-free JSON and YAML', async () => {
    const { provider, service, providers } = await harness();
    const saved = await service.create({ providerId: provider.id, version: '1.0.0', document: fixture('sync-image/adapter.json') });
    const json = service.export({ providerId: provider.id, ref: saved.ref });
    const yaml = service.export({ providerId: provider.id, ref: saved.ref, format: 'yaml' });

    expect(json.content).toBe(service.export({ providerId: provider.id, ref: saved.ref }).content);
    expect(json.content).toContain('secretRef');
    expect(json.content).not.toContain('ciphertext');
    expect(json.content).not.toContain('secret-value');
    expect(yaml.content).toBe(service.export({ providerId: provider.id, ref: saved.ref, format: 'yaml' }).content);
    expect(yaml.content).toContain('schemaVersion: 1');
    expect(yaml.content).not.toContain('ciphertext');
    expect(yaml.content).not.toContain('secret-value');
    const envelope = JSON.parse(json.content) as { schemaVersion: number; version: string; definition: Record<string, unknown> };
    expect(envelope).toMatchObject({ schemaVersion: 1, version: '1.0.0' });
    const definitionCanonical = service.validate({ document: envelope.definition }).canonical;
    expect(service.validate({ document: json.content, format: 'json' }).canonical).toBe(definitionCanonical);
    expect(service.validate({ document: yaml.content, format: 'yaml' }).canonical).toBe(definitionCanonical);
    const secondProvider = providers.create({ name: 'Roundtrip provider', type: 'custom-http-v1', baseUrl: 'https://api.example.test' });
    await expect(service.create({ providerId: secondProvider.id, document: json.content, format: 'json' })).resolves.toMatchObject({ ref: saved.ref });
    await expect(service.create({ providerId: secondProvider.id, document: json.content, format: 'json', version: '9.0.0' })).rejects.toMatchObject({ code: 'invalid_reference' });
    const withUnknown = { ...envelope, unknown: true };
    await expect(Promise.resolve().then(() => service.validate({ document: JSON.stringify(withUnknown), format: 'json' }))).rejects.toMatchObject({ code: 'invalid_definition' });
  });

  it('previews JSON, form, and multipart requests without bytes or network', async () => {
    const { provider, service } = await harness();
    const sync = await service.create({ providerId: provider.id, version: '1.0.0', document: fixture('sync-image/adapter.json') });
    const syncPreview = await service.preview({
      providerId: provider.id,
      ref: sync.ref,
      request: request({ providerId: provider.id, extra: { style: 'editorial' } }),
      secrets: { apiKey: 'super-secret' },
    });
    expect(syncPreview.url).toBe('https://api.example.test/root/v1/images');
    expect(syncPreview.headers.Authorization).toBe('[REDACTED]');
    expect(syncPreview.body).toMatchObject({ type: 'json', value: { model: 'image-model', prompt: 'A red kite' } });
    expect(JSON.stringify(syncPreview)).not.toContain('super-secret');
    expect(JSON.stringify(syncPreview)).not.toContain('bytes');

    const asyncVideo = await service.replace({ providerId: provider.id, version: '2.0.0', document: fixture('async-video/adapter.yaml') });
    const formPreview = await service.preview({ providerId: provider.id, ref: asyncVideo.ref, request: request({ providerId: provider.id, modelId: 'video-model', operation: 'video.generate' }) });
    expect(formPreview.body).toMatchObject({ type: 'form', fields: { model: 'video-model' } });

    const edit = await service.replace({ providerId: provider.id, version: '3.0.0', document: fixture('multipart-image-edit/adapter.json') });
    const source = input('source-1', 'source');
    const mask = input('mask-1', 'mask', new Uint8Array([4, 5]));
    const multipart = await service.preview({
      providerId: provider.id,
      ref: edit.ref,
      request: request({ providerId: provider.id, modelId: 'edit-model', operation: 'image.edit', inputs: [{ assetId: 'source-1', role: 'source' }, { assetId: 'mask-1', role: 'mask' }] }),
      inputs: [source, mask],
      secrets: { apiKey: 'super-secret' },
    });
    expect(multipart.body).toMatchObject({ type: 'multipart' });
    expect((multipart.body as { files: readonly { assetId: string; byteLength: number }[] }).files).toEqual([
      { assetId: 'source-1', byteLength: 3, contentType: 'image/png', field: 'image', filename: 'source-1.png' },
      { assetId: 'mask-1', byteLength: 2, contentType: 'image/png', field: 'mask', filename: 'mask-1.png' },
    ]);
    expect(JSON.stringify(multipart)).not.toContain('1,2,3');

    const dryRun = await service.dryRun({ providerId: provider.id, ref: sync.ref, request: request({ providerId: provider.id, extra: { style: 'editorial' } }), secrets: { apiKey: 'super-secret' } });
    expect(dryRun).toMatchObject({ network: false, performed: false, request: { url: 'https://api.example.test/root/v1/images' } });
  });

  it('simulates status/result extraction and tests RFC6901 paths with bounds', async () => {
    const { provider, service } = await harness();
    const saved = await service.create({ providerId: provider.id, version: '1.0.0', document: fixture('async-video/adapter.yaml') });
    const running = service.simulateResponse({
      providerId: provider.id,
      ref: saved.ref,
      endpoint: 'poll',
      response: { status: 200, json: { id: 'job-1', status: 'running', progress: 50 } },
      expectedRemoteJobId: 'job-1',
    });
    expect(running).toEqual({ state: 'pending', remoteJobId: 'job-1', progress: 50, status: 'running' });
    const path = service.testPath({ providerId: provider.id, path: '/a~1b/0', json: { 'a/b': ['value'] } });
    expect(path).toEqual({ found: true, path: '/a~1b/0', value: 'value' });
    expect(() => service.testPath({ providerId: provider.id, path: '/bad~2path', json: {} })).toThrow(CustomAdapterServiceError);
    expect(() => service.simulateResponse({ providerId: provider.id, ref: saved.ref, endpoint: 'poll', response: { status: 99, json: {} } })).toThrow(CustomAdapterServiceError);

    const invalidBase64: CustomAdapterMockResponse = { status: 200, json: { data: { b64_json: 'not-base64' } } };
    const sync = await service.replace({ providerId: provider.id, version: '2.0.0', document: fixture('sync-image/adapter.json') });
    expect(() => service.simulateResponse({ providerId: provider.id, ref: sync.ref, response: invalidBase64 })).toThrow(CustomAdapterServiceError);

    const failedSpec = parseDeclarativeYaml(fixture('async-video/adapter.yaml')) as unknown as Record<string, unknown>;
    const poll = failedSpec.poll as Record<string, unknown>;
    poll.extract = { statusPath: '/status', failureValues: ['failed'], errorPath: '/error', errorCodePath: '/errorCode' };
    const failed = service.simulateResponse({
      providerId: provider.id,
      document: JSON.stringify(failedSpec),
      endpoint: 'poll',
      response: { status: 200, json: { status: 'failed', error: 'raw-secret-value', errorCode: 'raw-secret-value' } },
    });
    expect(failed).toMatchObject({ state: 'failed', error: { message: 'Mock provider response failed.', code: 'mock_response_error' } });
    expect(JSON.stringify(failed)).not.toContain('raw-secret-value');
  });

  it('maps provider/kind mismatches and preserves lifecycle state', async () => {
    const { provider, service } = await harness();
    const saved = await service.create({ providerId: provider.id, version: '1.0.0', document: fixture('sync-image/adapter.json') });
    const second = await service.replace({ providerId: provider.id, version: '2.0.0', document: fixture('sync-image/adapter.json') });
    expect((await service.disable({ providerId: provider.id, ref: saved.ref }))?.disabled).toBe(true);
    expect(service.current(provider.id)?.ref).toEqual(second.ref);
    expect(await service.delete({ providerId: provider.id, ref: saved.ref })).toBe(true);
    expect(service.getExact(provider.id, saved.ref)).toBeNull();
    expect((await service.disable(provider.id))?.ref).toEqual(second.ref);
    expect(service.current(provider.id)).toBeNull();

    const builtIn = await harness('mock');
    await expect(builtIn.service.create({ providerId: builtIn.provider.id, version: '1.0.0', document: fixture('sync-image/adapter.json') })).rejects.toMatchObject({ code: 'provider_type_mismatch' });
  });

  it('rejects static credentials and secret templates for every draft entry point', async () => {
    const { provider, service } = await harness();
    const parse = (path: string): Record<string, unknown> => path.endsWith('.yaml')
      ? parseDeclarativeYaml(fixture(path)) as unknown as Record<string, unknown>
      : JSON.parse(fixture(path)) as Record<string, unknown>;
    const cases: readonly [string, Record<string, unknown>][] = [
      ['header literal', (() => {
        const spec = parse('sync-image/adapter.json');
        (spec.submit as Record<string, unknown>).headers = { 'X-API-Key': 'literal-secret' };
        return spec;
      })()],
      ['header secret template', (() => {
        const spec = parse('sync-image/adapter.json');
        (spec.submit as Record<string, unknown>).headers = { 'X-Trace': '{{ secret.apiKey }}' };
        return spec;
      })()],
      ['JSON body secret template', (() => {
        const spec = parse('sync-image/adapter.json');
        (spec.submit as Record<string, unknown>).body = { type: 'json', value: { prompt: '{{ secret.apiKey }}' } };
        return spec;
      })()],
      ['form credential field', (() => {
        const spec = parse('async-video/adapter.yaml');
        (spec.submit as Record<string, unknown>).body = { type: 'form', fields: { api_key: 'literal-secret' } };
        return spec;
      })()],
      ['multipart credential field', (() => {
        const spec = parse('multipart-image-edit/adapter.json');
        (spec.submit as Record<string, unknown>).body = {
          type: 'multipart',
          fields: { safe: 'value' },
          files: [{ field: 'access-token', input: { role: 'source', index: 0 } }],
        };
        return spec;
      })()],
      ['query credential field', (() => {
        const spec = parse('sync-image/adapter.json');
        (spec.submit as Record<string, unknown>).query = { api_key: 'literal-secret' };
        return spec;
      })()],
      ['custom field metadata', (() => {
        const spec = parse('sync-image/adapter.json');
        const model = (spec.models as Array<Record<string, unknown>>)[0]!;
        const capabilities = model.capabilities as Record<string, unknown>;
        capabilities.customFields = { apiKey: 'literal-secret' };
        return spec;
      })()],
    ];

    for (const [label, spec] of cases) {
      const document = JSON.stringify(spec);
      const actions = [
        () => service.validate({ document }),
        () => service.preview({ providerId: provider.id, document }),
        () => service.dryRun({ providerId: provider.id, document }),
        () => service.simulateResponse({ providerId: provider.id, document, response: { status: 200, json: {} } }),
        () => service.capabilityPreview({ providerId: provider.id, document }),
      ];
      for (const action of actions) {
        try {
          await action();
          throw new Error(`${label} unexpectedly passed`);
        } catch (error) {
          expect(error).toBeInstanceOf(CustomAdapterServiceError);
          expect(JSON.stringify(error)).not.toContain('literal-secret');
          expect((error as { cause?: unknown }).cause).toBeUndefined();
          expect((error as { source?: unknown }).source).toBeUndefined();
        }
      }
    }

    const normal = parse('sync-image/adapter.json');
    (normal.submit as Record<string, unknown>).headers = { 'X-Trace': '{{ request.prompt }}' };
    const normalDocument = JSON.stringify(normal);
    expect(service.validate({ document: normalDocument }).valid).toBe(true);
    const preview = await service.preview({
      providerId: provider.id,
      document: normalDocument,
      request: request({ providerId: provider.id, extra: { style: 'editorial' } }),
    });
    expect(preview.headers['X-Trace']).toBe('A red kite');
  });

  it('requires static administrator authorization for every management entry point', async () => {
    const { provider, adapterDefinitions, flushState, providers } = await harness();
    const denied = new CustomAdapterService({
      adapterDefinitions,
      authorization: { adminEnabled: false },
      outbox: { flush: () => { flushState.count += 1; } },
      providers,
    });
    const document = fixture('sync-image/adapter.json');
    const target = { providerId: provider.id };
    const ref = { kind: 'declarative-http' as const, adapterId: 'sync-image', version: '1.0.0', digest: '0'.repeat(64) };
    const actions: Array<() => unknown> = [
      () => denied.validate({ document }),
      () => denied.create({ ...target, document, version: '1.0.0' }),
      () => denied.replace({ ...target, document, version: '1.0.0' }),
      () => denied.import({ ...target, document, version: '1.0.0' }),
      () => denied.getCurrent(target),
      () => denied.current(target),
      () => denied.get(target),
      () => denied.getExact(provider.id, ref),
      () => denied.list(target),
      () => denied.disable(target),
      () => denied.delete(target),
      () => denied.export(target),
      () => denied.exportDefinition(target),
      () => denied.capabilities(target),
      () => denied.capabilityPreview(target),
      () => denied.preview({ ...target, document }),
      () => denied.dryRun({ ...target, document }),
      () => denied.simulateResponse({ ...target, document, response: { status: 200, json: {} } }),
      () => denied.testResponse({ ...target, document, response: { status: 200, json: {} } }),
      () => denied.testPath({ ...target, path: '/value', json: {} }),
      () => denied.testResponsePath({ ...target, path: '/value', json: {} }),
    ];
    for (const action of actions) {
      await expect(Promise.resolve().then(action)).rejects.toMatchObject({ code: 'administrator_required', statusCode: 403 });
    }
    expect(flushState.count).toBe(0);
  });

  it('flushes outbox once after each committed mutation and never after a failed mutation', async () => {
    const { provider, adapterDefinitions, flushState, providers, service } = await harness();
    const first = await service.create({ providerId: provider.id, version: '1.0.0', document: fixture('sync-image/adapter.json') });
    expect(flushState.count).toBe(1);
    await service.replace({ providerId: provider.id, version: '2.0.0', document: fixture('sync-image/adapter.json') });
    expect(flushState.count).toBe(2);
    await service.disable({ providerId: provider.id, ref: first.ref });
    expect(flushState.count).toBe(3);
    expect(await service.delete({ providerId: provider.id, ref: first.ref })).toBe(true);
    expect(flushState.count).toBe(4);

    await expect(service.create({ providerId: provider.id, version: 'bad/invalid', document: fixture('sync-image/adapter.json') })).rejects.toMatchObject({ code: 'invalid_reference' });
    expect(flushState.count).toBe(4);
    const create = vi.spyOn(adapterDefinitions, 'create').mockImplementation(() => {
      throw new Error('database failed');
    });
    await expect(service.create({ providerId: provider.id, version: '3.0.0', document: fixture('sync-image/adapter.json') })).rejects.toMatchObject({ code: 'storage_error' });
    expect(flushState.count).toBe(4);
    create.mockRestore();

    flushState.fail = true;
    await expect(service.replace({ providerId: provider.id, version: '4.0.0', document: fixture('sync-image/adapter.json') })).rejects.toMatchObject({ code: 'outbox_failure', statusCode: 500 });
    expect(flushState.count).toBe(5);

    const boundOutbox = new BoundOutboxPublisher();
    const boundService = new CustomAdapterService({
      adapterDefinitions,
      authorization: { adminEnabled: true },
      outbox: boundOutbox,
      providers,
    });
    await boundService.replace({ providerId: provider.id, version: '5.0.0', document: fixture('sync-image/adapter.json') });
    expect(boundOutbox.count).toBe(1);
  });

  it('uses bounded strict JSON path tests and redacts credential-like values', async () => {
    const { provider, service } = await harness();
    for (const [path, value] of [['/apiKey', 'key-secret'], ['/nested/token', 'token-secret'], ['/password', 'password-secret']] as const) {
      await expect(Promise.resolve().then(() => service.testPath({ providerId: provider.id, path, text: JSON.stringify(path === '/nested/token' ? { nested: { token: value } } : { [path.slice(1)]: value }) }))).resolves.toMatchObject({ found: true, value: '[REDACTED]' });
    }
    await expect(Promise.resolve().then(() => service.testPath({ providerId: provider.id, path: '/nested', json: { nested: { token: 'token-secret', safe: 'ok' } } }))).resolves.toEqual({ found: true, path: '/nested', value: { token: '[REDACTED]', safe: 'ok' } });
    await expect(Promise.resolve().then(() => service.testPath({ providerId: provider.id, path: '' , json: { safe: true } }))).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(Promise.resolve().then(() => service.testPath({ providerId: provider.id, path: '/x', text: '{"x":1,"x":2}' }))).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(Promise.resolve().then(() => service.testPath({ providerId: provider.id, path: '/x', text: `${' '.repeat(2 * 1024 * 1024 + 1)}` }))).rejects.toMatchObject({ code: 'response_too_large', statusCode: 413 });
  });
});
