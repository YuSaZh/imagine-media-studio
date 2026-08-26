import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  AdapterHttpRequestError,
  AdapterProtocolError,
  AdapterWorkerAbortError,
  AdapterWorkerFailure,
  AdapterWorkerHost,
  AdapterWorkerTimeoutError,
  AdapterStore,
  createAdapterWorkerFactory,
  parseBoundedManifestJson,
  validateAdapterResult,
  messageBytes,
  validateHttpResponse,
  digestAdapterSource,
  validateHttpRequest,
  sanitizeError,
  resolveAdapterWorkerEntry,
  DEFAULT_ADAPTER_WORKER_ENTRY,
  type AdapterWorkerFactory,
  type AdapterWorkerLike,
} from './index.js';
import type {
  AdapterHttpRequest,
  AdapterHttpResponse,
  AdapterInvocation,
  AdapterWorkerData,
  SafeHttpPort,
} from './worker-protocol.js';
import type { AdapterProviderContext } from './worker-host.js';

const source = "export const capabilities = { providerType: 'fixture', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }] }; export async function submit() { return { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }] }; } export function normalizeError() { return { code: 'error', kind: 'unknown', message: 'error', retryable: false }; }\n";
const limits = {
  timeoutMs: 1000,
  maxMessageBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
  maxLogBytes: 65_536,
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
};
const baseManifest = {
  schemaVersion: 1,
  id: 'fixture-adapter',
  version: '1.0.0',
  displayName: 'Fixture adapter',
  sha256: digestAdapterSource(source),
  operations: ['image.generate'],
  capabilities: {
    providerType: 'fixture',
    models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }],
  },
  allowedHosts: ['api.example.com'],
  requiredSecrets: ['apiKey'],
  resourceLimits: limits,
};
const context: AdapterProviderContext = {
  providerId: 'provider-1',
  baseUrl: 'https://api.example.com/v1',
  config: { mode: 'safe', nested: { value: 'bounded' } },
  secrets: { apiKey: 'real-secret', other: 'must-not-cross' },
};

const roots: string[] = [];

class FakeStream {
  private readonly listeners: ((chunk: unknown) => void)[] = [];
  public on(_event: 'data', listener: (chunk: unknown) => void): unknown {
    this.listeners.push(listener);
    return this;
  }
  public off(_event: 'data', listener: (chunk: unknown) => void): unknown {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
    return this;
  }
  public listenerCount(): number {
    return this.listeners.length;
  }
  public emit(chunk: unknown): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

type FakeMode = 'capabilities' | 'capabilities-wrong-provider' | 'capabilities-unknown-model' | 'capabilities-extra-operation' | 'capabilities-extra-support' | 'submit' | 'http' | 'evil-http' | 'redirect' | 'post-fail-http' | 'flood' | 'large-output' | 'stdout' | 'timeout' | 'oom' | 'mismatch' | 'terminate-reject';

class FakeWorker implements AdapterWorkerLike {
  public readonly stdout = new FakeStream();
  public readonly stderr = new FakeStream();
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  private readonly exitListeners: ((code: number) => void)[] = [];
  public terminated = false;
  public terminateCalls = 0;

  public constructor(private readonly data: AdapterWorkerData, private readonly mode: FakeMode, private readonly terminateDelayMs = 0) {
    queueMicrotask(() => this.begin());
  }

  public on(event: 'message' | 'error' | 'exit', listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): this {
    if (event === 'message') this.messageListeners.push(listener as (message: unknown) => void);
    else if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.exitListeners.push(listener as (code: number) => void);
    return this;
  }

  public off(event: 'message' | 'error' | 'exit', listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): this {
    const listeners = event === 'message' ? this.messageListeners : event === 'error' ? this.errorListeners : this.exitListeners;
    const index = listeners.indexOf(listener as never);
    if (index >= 0) listeners.splice(index, 1);
    return this;
  }

  public postMessage(value: unknown): void {
    if (this.mode === 'post-fail-http') throw new Error('worker post failed');
    if (this.terminated || value === null || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    if (message.kind === 'http-result') {
      if (message.ok) this.emitMessage({ kind: 'result', requestId: this.data.requestId, value: completedAsset() });
      else this.emitMessage({ kind: 'error', requestId: this.data.requestId, error: message.error });
    }
  }

  public async terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (this.mode === 'terminate-reject') throw new Error('terminate rejected');
    await new Promise<void>((resolve) => setTimeout(resolve, this.terminateDelayMs));
    this.terminated = true;
    return 0;
  }

  private begin(): void {
    if (this.mode === 'timeout') return;
    if (this.mode === 'oom') {
      for (const listener of this.errorListeners) listener(new Error('worker out of memory'));
      return;
    }
    if (this.mode === 'stdout') {
      this.stdout.emit('log'.repeat(70_000));
      return;
    }
    if (this.mode === 'flood') {
      for (let index = 0; index < 300; index += 1) this.emitMessage({ kind: 'noise', requestId: this.data.requestId, index });
      return;
    }
    if (this.mode === 'mismatch') {
      this.emitMessage({ kind: 'result', requestId: 'wrong-id', value: {} });
      return;
    }
    if (this.data.call === 'cancel') {
      this.emitMessage({ kind: 'result', requestId: this.data.requestId, value: undefined });
      return;
    }
    if (this.data.call === 'normalizeError') {
      this.emitMessage({ kind: 'result', requestId: this.data.requestId, value: { code: 'normalized', kind: 'unknown', message: 'normalized', retryable: false } });
      return;
    }
    if (this.data.call === 'poll') {
      this.emitMessage({ kind: 'result', requestId: this.data.requestId, value: completedAsset() });
      return;
    }
    if (this.mode === 'evil-http' || this.mode === 'http' || this.mode === 'redirect' || this.mode === 'post-fail-http') {
      this.emitMessage({ kind: 'http-request', requestId: `${this.data.requestId}:http:0`, input: {
        method: 'POST',
        url: this.mode === 'evil-http' ? 'https://evil.example/v1' : 'https://api.example.com/v1/generate',
        headers: { authorization: 'Bearer real-secret' },
        body: new Uint8Array([1]),
      } satisfies AdapterHttpRequest });
      return;
    }
    const value = this.mode === 'large-output' ? { state: 'completed', assets: [], large: 'x'.repeat(2_000_000) } : this.mode === 'capabilities'
      ? { providerType: 'fixture', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }] }
      : this.mode === 'capabilities-wrong-provider'
        ? { providerType: 'other-provider', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }] }
        : this.mode === 'capabilities-unknown-model'
          ? { providerType: 'fixture', models: [{ id: 'other-model', displayName: 'Other', capabilities: { operations: ['image.generate'] } }] }
          : this.mode === 'capabilities-extra-operation'
            ? { providerType: 'fixture', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate', 'video.generate'] } }] }
            : this.mode === 'capabilities-extra-support'
              ? { providerType: 'fixture', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'], supportsCancel: true } }] }
      : completedAsset();
    this.emitMessage({ kind: 'result', requestId: this.data.requestId, value });
  }

  private emitMessage(message: unknown): void {
    if (this.terminated) return;
    for (const listener of this.messageListeners) listener(message);
  }

  public listenerCount(event: 'message' | 'error' | 'exit'): number {
    return (event === 'message' ? this.messageListeners : event === 'error' ? this.errorListeners : this.exitListeners).length;
  }
}

function completedAsset(): unknown {
  return { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'iVBORw0KGgo=' }] };
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...baseManifest, ...overrides };
}

async function makeStore(): Promise<AdapterStore> {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'imagine-worker-'));
  roots.push(root);
  const store = new AdapterStore(root, { adminEnabled: true, assertAdmin() {} });
  await store.install({ manifest: manifest(), source, adminEnabled: true });
  return store;
}

function factory(mode: FakeMode, captured: AdapterWorkerData[] = [], terminateDelayMs = 0): AdapterWorkerFactory {
  return (data) => {
    captured.push(data);
    return new FakeWorker(data, mode, terminateDelayMs);
  };
}

function httpPort(requests: AdapterHttpRequest[] = []): SafeHttpPort {
  return {
    async request(input): Promise<AdapterHttpResponse> {
      requests.push(input);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: new Uint8Array([123, 125]) };
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import('node:fs/promises');
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('AdapterWorkerHost', () => {
  it('does not expose provider secrets to capabilities and filters them for submit', async () => {
    const store = await makeStore();
    const captured: AdapterWorkerData[] = [];
    const host = new AdapterWorkerHost(store, httpPort(), factory('capabilities', captured));
    await expect(host.call('fixture-adapter', 'capabilities', context)).resolves.toMatchObject({ providerType: 'fixture' });
    expect(captured[0]?.provider).toBeUndefined();
    const submitCaptured: AdapterWorkerData[] = [];
    const submitHost = new AdapterWorkerHost(store, httpPort(), factory('submit', submitCaptured));
    await submitHost.call('fixture-adapter', 'submit', context);
    expect(submitCaptured[0]?.provider?.secrets).toEqual({ apiKey: 'real-secret' });
    expect(submitCaptured[0]?.provider?.config).toEqual({ mode: 'safe', nested: { value: 'bounded' } });
    expect(Object.getPrototypeOf(submitCaptured[0]?.provider?.config ?? {})).toBeNull();
    expect(JSON.stringify(captured[0])).not.toContain('must-not-cross');
    expect(JSON.stringify(submitCaptured[0])).not.toContain('discarded');
  });

  it('requires capabilities to stay within the manifest provider, models and operations', async () => {
    const store = await makeStore();
    for (const mode of ['capabilities-wrong-provider', 'capabilities-unknown-model', 'capabilities-extra-operation', 'capabilities-extra-support'] as const) {
      const host = new AdapterWorkerHost(store, httpPort(), factory(mode));
      await expect(host.call('fixture-adapter', 'capabilities', context)).rejects.toMatchObject({ code: 'adapter_result_invalid' });
    }
  });

  it('counts nested Uint8Array values by raw bytes and enforces the full worker message limit', async () => {
    expect(messageBytes({ body: new Uint8Array(100) })).toBeLessThan(200);
    const store = await makeStoreWithLimits({ maxMessageBytes: 128 });
    await expect(new AdapterWorkerHost(store, httpPort(), factory('submit')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterProtocolError);
  });

  it('rejects secret-like keys in provider config and required missing secrets', async () => {
    const store = await makeStore();
    const host = new AdapterWorkerHost(store, httpPort(), factory('submit'));
    await expect(host.call('fixture-adapter', 'submit', { ...context, config: { nested: { token: 'blocked' } } })).rejects.toThrow('forbidden key');
    await expect(host.call('fixture-adapter', 'submit', { ...context, secrets: {} })).rejects.toThrow('Required provider secret');
  });

  it('passes bounded bytes and returns a strictly validated submit result', async () => {
    const store = await makeStore();
    const captured: AdapterWorkerData[] = [];
    const host = new AdapterWorkerHost(store, httpPort(), factory('submit', captured));
    const invocation: AdapterInvocation = {
      request: { operation: 'image.generate', prompt: 'real-secret should be redacted' },
      files: [{ assetId: 'asset-1', role: 'source', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    };
    await expect(host.call('fixture-adapter', 'submit', context, invocation)).resolves.toMatchObject({ state: 'completed' });
    expect(captured[0]?.files?.[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(Object.getPrototypeOf(captured[0]?.files?.[0] ?? {})).toBeNull();
    expect(Object.getPrototypeOf(captured[0]?.request ?? {})).toBeNull();
    expect(JSON.stringify(captured[0]?.request)).not.toContain('real-secret');
    expect(JSON.stringify(captured[0])).not.toContain('must-not-cross');
  });

  it('dispatches poll, cancel and normalizeError through the same one-call worker boundary', async () => {
    const store = await makeStore();
    const pollHost = new AdapterWorkerHost(store, httpPort(), factory('submit'));
    await expect(pollHost.call('fixture-adapter', 'poll', context, { remoteJobId: 'remote-1' })).resolves.toMatchObject({ state: 'completed' });
    await expect(pollHost.call('fixture-adapter', 'cancel', context, { remoteJobId: 'remote-1' })).resolves.toBeUndefined();
    await expect(pollHost.call('fixture-adapter', 'normalizeError', context, { error: { message: 'upstream failed', status: 500 } })).resolves.toMatchObject({ code: 'normalized' });
  });

  it('routes HTTP only through the injected port and enforces manifest hosts', async () => {
    const store = await makeStore();
    const requests: AdapterHttpRequest[] = [];
    const host = new AdapterWorkerHost(store, httpPort(requests), factory('http'));
    await expect(host.call('fixture-adapter', 'submit', context)).resolves.toMatchObject({ state: 'completed' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.com/v1/generate');
    const blockedHost = new AdapterWorkerHost(store, httpPort(), factory('evil-http'));
    await expect(blockedHost.call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    const redirectPort: SafeHttpPort = { async request() { return { status: 302, headers: { location: 'https://evil.example' }, body: new Uint8Array() }; } };
    await expect(new AdapterWorkerHost(store, redirectPort, factory('redirect')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    const leakingPort: SafeHttpPort = { async request() { throw new Error('upstream real-secret leaked'); } };
    await expect(new AdapterWorkerHost(store, leakingPort, factory('http')).call('fixture-adapter', 'submit', context)).rejects.not.toThrow('real-secret');
  });

  it('rejects credential URLs, hop-by-hop headers and case-insensitive duplicates', () => {
    expect(() => validateHttpRequest({ method: 'GET', url: 'https://api.example.com/?token=secret', headers: {} })).toThrow(AdapterProtocolError);
    for (const name of ['api-key', 'api_key', 'access-token', 'auth-token', 'credential', 'credential-id', 'signature', 'x-amz', 'x_amz_signature', 'x-goog-credential', 'x_ms_token', 'oauth', 'oauth-token', 'oauth-signature']) {
      expect(() => validateHttpRequest({ method: 'GET', url: `https://api.example.com/?${name}=secret`, headers: {} })).toThrow(AdapterProtocolError);
    }
    expect(() => validateHttpRequest({ method: 'GET', url: 'https://api.example.com/', headers: { connection: 'close' } })).toThrow(AdapterHttpRequestError);
    expect(() => validateHttpRequest({ method: 'GET', url: 'https://api.example.com/', headers: { Accept: 'a', accept: 'b' } })).toThrow(AdapterHttpRequestError);
    const validatedResponse = validateHttpResponse({ status: 200, headers: { 'content-length': '2', 'transfer-encoding': 'chunked', 'set-cookie': 'cookie', 'x-request-id': 'id' }, body: new Uint8Array() });
    expect(Object.getPrototypeOf(validatedResponse.headers)).toBeNull();
    expect(validatedResponse.headers).toMatchObject({ 'content-length': '2', 'set-cookie': 'cookie', 'x-request-id': 'id' });
    expect(Object.getPrototypeOf(validateHttpRequest({ method: 'GET', url: 'https://api.example.com/', headers: {} }).headers)).toBeNull();
    expect(validateAdapterResult('poll', { state: 'remote_running', progress: 100 }, 1_048_576)).toMatchObject({ progress: 100 });
    expect(() => validateAdapterResult('poll', { state: 'completed', assets: [] }, 1_048_576)).toThrow(AdapterProtocolError);
    expect(() => validateAdapterResult('submit', { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=', metadata: { token: 'secret' } }] }, 1_048_576, ['secret'])).toThrow(AdapterProtocolError);
    expect(() => validateAdapterResult('submit', { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'url', url: 'https://media.example/x?x-amz-signature=signed' }] }, 1_048_576)).toThrow(AdapterProtocolError);
  });

  it('redacts credential-shaped errors before the public truncation boundary', () => {
    const longSecret = 's'.repeat(8_000);
    const error = sanitizeError(new Error(`prefix ${longSecret} suffix authorization=remote-token credential=other`), [longSecret]);
    expect(error.message).not.toContain(longSecret.slice(0, 32));
    expect(error.message).not.toContain('remote-token');
    expect(error.message).not.toContain('other');
    expect(error.message.length).toBeLessThanOrEqual(4_096);
    const unknownError = sanitizeError({ message: 'auth=auth-secret cookie=cookie-secret set-cookie=set-cookie-secret' });
    expect(unknownError.message).not.toContain('auth-secret');
    expect(unknownError.message).not.toContain('cookie-secret');
    expect(unknownError.message).not.toContain('set-cookie-secret');
  });

  it('resolves the production .js worker entry and permits explicit test injection', () => {
    expect(resolveAdapterWorkerEntry()).toEqual(DEFAULT_ADAPTER_WORKER_ENTRY);
    const injected = new URL('file:///tmp/test-worker-entry.mjs');
    expect(resolveAdapterWorkerEntry(injected)).toEqual(injected);
    expect(createAdapterWorkerFactory({ workerEntryUrl: injected })).toBeTypeOf('function');
  });

  it('maps timeout, abort, worker errors, output flood, message flood and id mismatch', async () => {
    const store = await makeStore();
    await expect(new AdapterWorkerHost(store, httpPort(), factory('timeout')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerTimeoutError);
    const controller = new AbortController();
    const abortHost = new AdapterWorkerHost(store, httpPort(), factory('timeout'));
    const pending = abortHost.call('fixture-adapter', 'submit', context, {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(AdapterWorkerAbortError);
    await expect(new AdapterWorkerHost(store, httpPort(), factory('oom')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    await expect(new AdapterWorkerHost(store, httpPort(), factory('flood')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    await expect(new AdapterWorkerHost(store, httpPort(), factory('mismatch')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    const smallOutputStore = await makeStoreWithLimits({ maxOutputBytes: 128 });
    await expect(new AdapterWorkerHost(smallOutputStore, httpPort(), factory('large-output')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    const smallLogStore = await makeStoreWithLimits({ maxLogBytes: 32 });
    await expect(new AdapterWorkerHost(smallLogStore, httpPort(), factory('stdout')).call('fixture-adapter', 'submit', context)).rejects.toThrow(AdapterWorkerFailure);
    const terminatingStore = await makeStore();
    let terminatingWorker: FakeWorker | undefined;
    await expect(new AdapterWorkerHost(terminatingStore, httpPort(), (data) => {
      terminatingWorker = new FakeWorker(data, 'terminate-reject');
      return terminatingWorker;
    }).call('fixture-adapter', 'submit', context)).rejects.toMatchObject({ code: 'adapter_terminate_failed' });
    expect(terminatingWorker?.terminateCalls).toBe(2);
    await expect(new AdapterWorkerHost(store, httpPort(), factory('post-fail-http')).call('fixture-adapter', 'submit', context)).rejects.toMatchObject({ code: 'adapter_worker_channel' });
  });

  it('removes worker listeners and stream listeners after a normal result', async () => {
    const store = await makeStore();
    let worker: FakeWorker | undefined;
    await expect(new AdapterWorkerHost(store, httpPort(), (data) => {
      worker = new FakeWorker(data, 'submit');
      return worker;
    }).call('fixture-adapter', 'submit', context)).resolves.toMatchObject({ state: 'completed' });
    expect(worker?.listenerCount('message')).toBe(0);
    expect(worker?.listenerCount('error')).toBe(0);
    expect(worker?.listenerCount('exit')).toBe(0);
    expect(worker?.stdout.listenerCount()).toBe(0);
    expect(worker?.stderr.listenerCount()).toBe(0);
  });

  it('awaits worker termination on abort and closes active workers', async () => {
    const store = await makeStore();
    const controller = new AbortController();
    let worker: FakeWorker | undefined;
    const host = new AdapterWorkerHost(store, httpPort(), (data) => {
      worker = new FakeWorker(data, 'timeout', 20);
      return worker;
    });
    const pending = host.call('fixture-adapter', 'submit', context, {}, controller.signal);
    await vi.waitFor(() => expect(worker).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toThrow(AdapterWorkerAbortError);
    expect(worker?.terminated).toBe(true);
    await host.close();
  });

  it('aborts and clears a pending host HTTP request when the parent closes', async () => {
    const store = await makeStore();
    let requestStarted = false;
    let requestAborted = false;
    const host = new AdapterWorkerHost(store, {
      request(_input, signal) {
        requestStarted = true;
        return new Promise<AdapterHttpResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            requestAborted = true;
            reject(new Error('pending request aborted'));
          }, { once: true });
        });
      },
    }, factory('http'));
    const pending = host.call('fixture-adapter', 'submit', context);
    const rejection = expect(pending).rejects.toThrow(AdapterWorkerAbortError);
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    await host.close();
    await rejection;
    expect(requestAborted).toBe(true);
  });

  it('executes the checked fixture through a real worker entry and RPCs HTTP', async () => {
    const store = await makeFixtureStore();
    const requests: AdapterHttpRequest[] = [];
    const host = new AdapterWorkerHost(
      store,
      {
        async request(input) {
          requests.push(input);
          return {
            status: 200,
            headers: { 'content-length': '2', 'content-type': 'application/json', 'set-cookie': 'secret-cookie' },
            body: new Uint8Array([123, 125]),
          };
        },
      },
      createAdapterWorkerFactory(new URL('worker-entry.mjs', new URL('../../../../fixtures/adapters/trusted-fixture-v1/', import.meta.url))),
    );
    const fixtureContext: AdapterProviderContext = {
      providerId: 'fixture-provider',
      baseUrl: 'https://api.example.com/v1',
      config: { region: 'test' },
      secrets: { apiKey: 'real-secret', other: 'discarded' },
    };
    const submitted = await host.submit('trusted-fixture-v1', fixtureContext, { request: { operation: 'image.generate', prompt: 'http' } });
    expect(submitted).toMatchObject({ state: 'completed', assets: [{ metadata: { httpHeaderCount: 1 } }] });
    await expect(host.poll('trusted-fixture-v1', fixtureContext, 'remote-1')).resolves.toMatchObject({ state: 'completed' });
    await expect(host.normalizeError('trusted-fixture-v1', fixtureContext, { message: 'remote error', status: 500 })).resolves.toMatchObject({ code: 'adapter_error' });
    await expect(host.cancel('trusted-fixture-v1', fixtureContext, 'remote-1')).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.com/v1/generate');
    expect(requests[0]?.headers.authorization).toBe('Bearer real-secret');
  });
});

async function makeStoreWithLimits(overrides: Partial<typeof limits>): Promise<AdapterStore> {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'imagine-worker-limits-'));
  roots.push(root);
  const store = new AdapterStore(root, { adminEnabled: true, assertAdmin() {} });
  await store.install({ manifest: manifest({ resourceLimits: { ...limits, ...overrides } }), source, adminEnabled: true });
  return store;
}

async function makeFixtureStore(): Promise<AdapterStore> {
  const { mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'imagine-real-worker-'));
  roots.push(root);
  const directory = new URL('../../../../fixtures/adapters/trusted-fixture-v1/', import.meta.url);
  const sourceBytes = await readFile(new URL('adapter.mjs', directory));
  const manifest = parseBoundedManifestJson(await readFile(new URL('manifest.json', directory)));
  const store = new AdapterStore(root, { adminEnabled: true, assertAdmin() {} });
  await store.install({ manifest, source: sourceBytes, adminEnabled: true });
  return store;
}
