import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';

import {
  CUSTOM_JS_ADAPTER_TYPE,
  MAX_RESULT_EXPIRY_MS,
  TrustedJavaScriptAdapter,
  type TrustedJavaScriptWorkerHost,
} from './index.js';
import {
  AdapterWorkerHost,
  createAdapterWorkerFactory,
  digestAdapterSource,
  parseBoundedManifestJson,
} from '../../adapters/index.js';
import type {
  AdapterErrorView,
  AdapterInvocation,
  AdapterProviderContext,
  AdapterRuntimeReference,
} from '../../adapters/index.js';
import type { AdapterManifest } from '../../adapters/index.js';
import type { AdapterCapabilities } from '../../adapters/index.js';
import type { ProviderContext } from '@imagine/provider-contract';
import type { ProviderInput } from '@imagine/provider-contract';

const reference: AdapterRuntimeReference = {
  kind: 'trusted-javascript',
  adapterId: 'trusted-js-fixture',
  version: '1.0.0',
  digest: 'a'.repeat(64),
};

const context: ProviderContext = {
  providerId: 'provider-1',
  config: {},
  secrets: {},
};

const request = (overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  operation: 'image.generate',
  providerId: 'provider-1',
  modelId: 'fixture-model',
  prompt: 'a fixture',
  inputs: [],
  ...overrides,
});

const capabilities: AdapterCapabilities = {
  providerType: 'fixture-provider',
  models: [{
    id: 'fixture-model',
    displayName: 'Fixture model',
    capabilities: {
      operations: ['image.generate', 'video.generate'],
      maxReferenceImages: 1,
      supportsProgress: true,
      supportsCancel: true,
      supportsNegativePrompt: true,
      supportsBatchCount: true,
      maxBatchCount: 2,
    },
  }],
};

const completed = {
  state: 'completed',
  assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }],
} as const;

class FakeHost implements TrustedJavaScriptWorkerHost {
  public readonly calls: string[] = [];
  public readonly references: AdapterRuntimeReference[] = [];
  public readonly submitInvocations: AdapterInvocation[] = [];
  public capabilitiesResult: unknown = capabilities;
  public submitResult: unknown = completed;
  public pollResult: unknown = completed;
  public cancelResult: unknown = undefined;
  public normalizeResult: unknown = { code: 'fixture', kind: 'unknown', message: 'Fixture failed.', retryable: false };
  public normalizeFailure = false;

  public capabilities(ref: AdapterRuntimeReference, _context: AdapterProviderContext): Promise<unknown> {
    this.calls.push('capabilities');
    this.references.push(ref);
    return Promise.resolve(this.capabilitiesResult);
  }

  public submit(ref: AdapterRuntimeReference, _context: AdapterProviderContext, invocation: AdapterInvocation): Promise<unknown> {
    this.calls.push('submit');
    this.references.push(ref);
    this.submitInvocations.push(invocation);
    return Promise.resolve(this.submitResult);
  }

  public poll(ref: AdapterRuntimeReference, _context: AdapterProviderContext, _remoteJobId: string): Promise<unknown> {
    this.calls.push('poll');
    this.references.push(ref);
    return Promise.resolve(this.pollResult);
  }

  public cancel(ref: AdapterRuntimeReference, _context: AdapterProviderContext, _remoteJobId: string): Promise<unknown> {
    this.calls.push('cancel');
    this.references.push(ref);
    return Promise.resolve(this.cancelResult);
  }

  public normalizeError(ref: AdapterRuntimeReference, _context: AdapterProviderContext, _error: AdapterErrorView): Promise<unknown> {
    this.calls.push('normalizeError');
    this.references.push(ref);
    if (this.normalizeFailure) return Promise.reject(new Error('raw cause includes secret=do-not-return'));
    return Promise.resolve(this.normalizeResult);
  }
}

function fixtureManifest(source: Uint8Array): AdapterManifest {
  return parseBoundedManifestJson(source) as AdapterManifest;
}

describe('TrustedJavaScriptAdapter', () => {
  it('maps fake-host lifecycle results and uses the exact runtime reference', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);

    await expect(adapter.getCapabilities(context)).resolves.toMatchObject({ providerType: 'fixture-provider' });
    await expect(adapter.validate(request(), context)).resolves.toBeUndefined();
    await expect(adapter.submit(request(), context)).resolves.toEqual(completed);

    host.submitResult = { state: 'pending', remoteJobId: 'remote-1', pollAfterMs: 50 };
    await expect(adapter.submit(request({ prompt: 'pending' }), context)).resolves.toMatchObject({ state: 'pending', remoteJobId: 'remote-1', pollAfterMs: 50 });
    host.pollResult = { state: 'remote_running', progress: 42, pollAfterMs: 25 };
    await expect(adapter.poll('remote-1', context)).resolves.toEqual({ state: 'remote_running', progress: 42, pollAfterMs: 25 });
    host.pollResult = { state: 'failed', error: { code: 'failed', kind: 'rejected', message: 'Fixture failed.', retryable: false } };
    await expect(adapter.poll('remote-1', context)).resolves.toMatchObject({ state: 'failed', error: { code: 'failed', kind: 'rejected' } });
    await expect(adapter.cancel('remote-1', context)).resolves.toBeUndefined();
    expect(host.references.every((candidate) => candidate === reference)).toBe(true);
    expect(host.calls).toContain('cancel');
  });

  it('rejects unknown keys and malformed worker result fields', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);

    host.submitResult = { ...completed, unknown: true };
    await expect(adapter.submit(request(), context)).rejects.toMatchObject({ code: 'invalid_submit_result' });

    host.submitResult = { state: 'pending', remoteJobId: 'remote-1', resultExpiresAt: '9999-01-01T00:00:00.000Z' };
    await expect(adapter.submit(request(), context)).rejects.toMatchObject({ code: 'invalid_submit_result' });

    host.submitResult = { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'url', url: 'http://unsafe.example/result' }] };
    await expect(adapter.submit(request(), context)).rejects.toMatchObject({ code: 'invalid_submit_result' });

    host.pollResult = { state: 'remote_running', progress: 101 };
    await expect(adapter.poll('remote-1', context)).rejects.toMatchObject({ code: 'invalid_poll_result' });
    expect(MAX_RESULT_EXPIRY_MS).toBeGreaterThan(Date.now());
  });

  it('checks shared request, model, operation, capability, and input constraints', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);

    await expect(adapter.validate(request({ modelId: 'missing' }), context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.validate(request({ operation: 'video.image_to_video' }), context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.validate(request({ negativePrompt: 'avoid text' }), context)).resolves.toBeUndefined();
    await expect(adapter.validate(request({ count: 3 }), context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.validate(request({ extra: { custom: true } }), context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(adapter.validate(request({ providerId: 'other-provider' }), context)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('maps only bounded, request-matched ProviderInput fields into AdapterFileView', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);
    const input: ProviderInput = {
      assetId: 'reference-1',
      role: 'reference',
      filename: 'reference-1.png',
      mimeType: 'image/png; charset=binary',
      bytes: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
      fileSize: 3,
      parentAssetId: null,
      sha256: '0'.repeat(64),
    };
    const inputContext = { ...context, inputs: [input] };
    await adapter.submit(request({ inputs: [{ assetId: 'reference-1', role: 'reference' }] }), inputContext);
    const file = host.submitInvocations.at(-1)?.files?.[0];
    expect(file).toMatchObject({ assetId: 'reference-1', role: 'reference', filename: 'reference-1.png', mimeType: 'image/png; charset=binary' });
    expect(file?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(file && 'width' in file).toBe(false);
  });

  it('fails closed for aborts and never exposes a raw normalizeError cause', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.validate(request(), { ...context, signal: controller.signal })).rejects.toThrow();

    await expect(adapter.normalizeError(new Error('safe input'))).resolves.toEqual({
      code: 'fixture',
      kind: 'unknown',
      message: 'Fixture failed.',
      retryable: false,
    });
    host.normalizeFailure = true;
    const normalized = await adapter.normalizeError(new Error('raw cause includes secret=do-not-return'));
    expect(normalized).toEqual({ code: 'provider_unknown', kind: 'unknown', message: 'Trusted JavaScript provider operation failed.', retryable: false });
    expect(JSON.stringify(normalized)).not.toContain('do-not-return');
  });

  it('awaits and safely parses asynchronous transient normalize results', async () => {
    const host = new FakeHost();
    const adapter = new TrustedJavaScriptAdapter(reference, host);
    host.normalizeResult = {
      code: 'fixture_rate_limited',
      kind: 'transient',
      message: 'Try again later.',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    };

    await expect(adapter.normalizeError({ statusCode: 429 })).resolves.toEqual({
      code: 'fixture_rate_limited',
      kind: 'transient',
      message: 'Try again later.',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    });

    host.normalizeResult = {
      code: 'invalid',
      kind: 'unknown',
      message: 'invalid',
      retryable: false,
      unexpected: true,
    };
    await expect(adapter.normalizeError(new Error('invalid result'))).resolves.toEqual({
      code: 'provider_unknown',
      kind: 'unknown',
      message: 'Trusted JavaScript provider operation failed.',
      retryable: false,
    });
  });

  it('uses host/runtime manifest validation without forcing providerType to custom-js-v1', async () => {
    const host = new FakeHost();
    const manifest = {
      capabilities,
      operations: ['image.generate', 'video.generate'],
    } satisfies Pick<AdapterManifest, 'capabilities' | 'operations'>;
    const adapter = new TrustedJavaScriptAdapter(reference, host, manifest);
    await expect(adapter.getCapabilities(context)).resolves.toMatchObject({ providerType: 'fixture-provider' });
    host.capabilitiesResult = { ...capabilities, providerType: CUSTOM_JS_ADAPTER_TYPE };
    await expect(adapter.getCapabilities(context)).rejects.toMatchObject({ code: 'invalid_capabilities' });
  });

  it('runs the installed source through the real worker boundary', async () => {
    const directory = new URL('./fixtures/', import.meta.url);
    const source = await readFile(new URL('trusted-fixture.mjs', directory));
    const manifest = fixtureManifest(await readFile(new URL('trusted-fixture-manifest.json', directory)));
    expect(digestAdapterSource(source)).toBe(manifest.sha256);
    const realReference: AdapterRuntimeReference = {
      kind: 'trusted-javascript',
      adapterId: manifest.id,
      version: manifest.version,
      digest: manifest.sha256,
    };
    const runtimeReader = {
      readByRef: async (candidate: AdapterRuntimeReference) => {
        expect(candidate).toEqual(realReference);
        return { manifest, source };
      },
    };
    const http = { async request() { return { status: 200, headers: {}, body: new Uint8Array() }; } };
    const workerFactory = createAdapterWorkerFactory({
      workerEntryUrl: new URL('./fixtures/trusted-worker-entry.mjs', import.meta.url),
    });
    const host = new AdapterWorkerHost(runtimeReader, http, workerFactory);
    const adapter = new TrustedJavaScriptAdapter(realReference, host, manifest);
    const realContext: ProviderContext = { providerId: 'provider-1', config: {}, secrets: {} };

    await expect(adapter.getCapabilities(realContext)).resolves.toMatchObject({ providerType: 'fixture-provider' });
    await expect(adapter.validate(request(), realContext)).resolves.toBeUndefined();
    await expect(adapter.submit(request(), realContext)).resolves.toMatchObject({ state: 'completed', assets: [{ source: 'base64' }] });
    await expect(adapter.submit(request({ prompt: 'pending' }), realContext)).resolves.toMatchObject({ state: 'pending', remoteJobId: 'fixture-job' });
    await expect(adapter.poll('fixture-running', realContext)).resolves.toEqual({ state: 'remote_running', progress: 42, pollAfterMs: 100 });
    await expect(adapter.poll('fixture-fail', realContext)).resolves.toMatchObject({ state: 'failed', error: { code: 'fixture_failed' } });
    await expect(adapter.cancel('fixture-job', realContext)).resolves.toBeUndefined();
    await expect(adapter.normalizeError({ statusCode: 429 })).resolves.toMatchObject({
      code: 'fixture_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    });
    await expect(adapter.normalizeError({ code: 'fixture-invalid' })).resolves.toEqual({
      code: 'provider_unknown',
      kind: 'unknown',
      message: 'Trusted JavaScript provider operation failed.',
      retryable: false,
    });
    await expect(adapter.normalizeError({ code: 'fixture-fail' })).resolves.toEqual({
      code: 'provider_unknown',
      kind: 'unknown',
      message: 'Trusted JavaScript provider operation failed.',
      retryable: false,
    });
    await host.close();
  });
});
