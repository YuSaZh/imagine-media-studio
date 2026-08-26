import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import type { AdapterRecord, AdapterRuntimeReader, AdapterRuntimeReference } from './store.js';
import type { AdapterOperation } from './manifest.js';
import {
  AdapterHttpRequestError,
  AdapterProtocolError,
  AdapterWorkerAbortError,
  AdapterWorkerFailure,
  AdapterWorkerTimeoutError,
  assertBoundedAdapterData,
  messageBytes,
  sanitizeError,
  validateAdapterProvider,
  validateAdapterResult,
  validateHttpRequest,
  validateHttpResponse,
  type AdapterCall,
  type AdapterErrorView,
  type AdapterFileView,
  type AdapterHttpResponse,
  type AdapterInvocation,
  type AdapterProviderView,
  type AdapterWorkerData,
  type SafeHttpPort,
} from './worker-protocol.js';

const SECRET_KEY_PATTERN = /(?:^|[-_.])(?:api[-_.]?key|authorization|cookie|password|secret|token|credential|headers?)(?:$|[-_.])/iu;
const MAX_CONFIG_DEPTH = 8;
const MAX_WORKER_MESSAGES = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const RESPONSE_STRIPPED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface AdapterProviderContext {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
}

interface AdapterWorkerStream {
  on(event: 'data', listener: (chunk: unknown) => void): unknown;
  off?(event: 'data', listener: (chunk: unknown) => void): unknown;
}

export interface AdapterWorkerLike {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  off?(event: 'message', listener: (message: unknown) => void): this;
  off?(event: 'error', listener: (error: Error) => void): this;
  off?(event: 'exit', listener: (code: number) => void): this;
  readonly stdout?: AdapterWorkerStream | null;
  readonly stderr?: AdapterWorkerStream | null;
}

export type AdapterWorkerFactory = (data: AdapterWorkerData, limits: AdapterRecord['manifest']['resourceLimits']) => AdapterWorkerLike;

export const DEFAULT_ADAPTER_WORKER_ENTRY = new URL('./worker-entry.js', import.meta.url);

export interface AdapterWorkerFactoryOptions {
  readonly workerEntryUrl?: URL;
}

export function resolveAdapterWorkerEntry(workerEntryUrl?: URL): URL {
  return workerEntryUrl ?? DEFAULT_ADAPTER_WORKER_ENTRY;
}

export function createAdapterWorkerFactory(entry?: URL): AdapterWorkerFactory;
export function createAdapterWorkerFactory(options?: AdapterWorkerFactoryOptions): AdapterWorkerFactory;
export function createAdapterWorkerFactory(input: URL | AdapterWorkerFactoryOptions = {}): AdapterWorkerFactory {
  const entry = input instanceof URL ? input : resolveAdapterWorkerEntry(input.workerEntryUrl);
  return (data, limits) => new Worker(entry, {
    workerData: data,
    execArgv: [],
    env: { NODE_ENV: 'production' },
    stdout: true,
    stderr: true,
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb,
    },
  }) as unknown as AdapterWorkerLike;
}

const defaultWorkerFactory = createAdapterWorkerFactory();

const TERMINATE_GRACE_MS = 250;

async function terminateWithGrace(worker: AdapterWorkerLike): Promise<void> {
  const waitForTermination = async (attempt: Promise<number>): Promise<'fulfilled' | 'rejected' | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      attempt.then(() => 'fulfilled' as const, () => 'rejected' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), TERMINATE_GRACE_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  };

  let first: Promise<number>;
  try {
    first = Promise.resolve(worker.terminate());
  } catch (error) {
    first = Promise.reject(error);
  }
  const firstResult = await waitForTermination(first);
  if (firstResult === 'fulfilled') return;

  let second: Promise<number>;
  try {
    second = Promise.resolve(worker.terminate());
  } catch (error) {
    second = Promise.reject(error);
  }
  const secondResult = await waitForTermination(second);
  if (secondResult !== 'fulfilled') throw new Error(`Adapter worker termination ${secondResult}.`);
}

function secretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || key.toLowerCase().startsWith('env:');
}

function sanitizeJson(value: unknown, secrets: readonly string[], depth = 0, seen = new Set<object>()): unknown {
  if (depth > MAX_CONFIG_DEPTH) throw new AdapterProtocolError('Provider config is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new AdapterProtocolError('Provider config contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 16_384 || CONTROL_PATTERN.test(value)) throw new AdapterProtocolError('Provider config contains an invalid string.');
    let output = value;
    for (const secret of secrets) if (secret.length > 0) output = output.split(secret).join('[REDACTED]');
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new AdapterProtocolError('Provider config is not bounded JSON.');
  if (value instanceof Uint8Array) throw new AdapterProtocolError('Provider config may not contain raw bytes.');
  seen.add(value);
  let output: unknown;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new AdapterProtocolError('Provider config array is too large.');
    output = value.map((item) => sanitizeJson(item, secrets, depth + 1, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new AdapterProtocolError('Provider config must be JSON objects.');
    const record = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value);
    if (entries.length > 128) throw new AdapterProtocolError('Provider config object is too large.');
    for (const [key, item] of entries) {
      if (key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype' || secretLikeKey(key)) {
        throw new AdapterProtocolError('Provider data contains a forbidden key.');
      }
      record[key] = sanitizeJson(item, secrets, depth + 1, seen);
    }
    output = record;
  }
  seen.delete(value);
  return output;
}

function sanitizeRequest(value: unknown, secrets: readonly string[]): unknown {
  return sanitizeJson(value, secrets);
}

function providerView(record: AdapterRecord, context: AdapterProviderContext): AdapterProviderView {
  const requestedSecrets = Object.create(null) as Record<string, string>;
  for (const key of record.manifest.requiredSecrets) {
    const value = Object.hasOwn(context.secrets, key) ? context.secrets[key] : undefined;
    if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
      throw new AdapterProtocolError(`Required provider secret '${key}' is unavailable.`);
    }
    requestedSecrets[key] = value;
  }
  const secretValues = Object.values(requestedSecrets);
  const config = sanitizeJson(context.config ?? {}, secretValues);
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new AdapterProtocolError('Provider config must be an object.');
  const candidate = {
    providerId: context.providerId,
    ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
    config: config as Readonly<Record<string, unknown>>,
    secrets: requestedSecrets,
  };
  return validateAdapterProvider(candidate) as AdapterProviderView;
}

function filesView(files: readonly AdapterFileView[] | undefined, secrets: readonly string[]): readonly AdapterFileView[] {
  if (files === undefined) return [];
  if (files.length > 128) throw new AdapterProtocolError('Too many adapter input files.');
  let total = 0;
  return files.map((file) => {
    if (typeof file.assetId !== 'string' || file.assetId.length === 0 || file.assetId.length > 255) throw new AdapterProtocolError('Adapter input assetId is invalid.');
    if (typeof file.role !== 'string' || file.role.length === 0 || file.role.length > 128) throw new AdapterProtocolError('Adapter input role is invalid.');
    if (typeof file.mimeType !== 'string' || file.mimeType.length === 0 || file.mimeType.length > 128) throw new AdapterProtocolError('Adapter input MIME type is invalid.');
    if (file.filename !== undefined && (file.filename.length === 0 || file.filename.length > 255 || file.filename.includes('/') || CONTROL_PATTERN.test(file.filename))) throw new AdapterProtocolError('Adapter input filename is invalid.');
    if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 16 * 1024 * 1024) throw new AdapterProtocolError('Adapter input bytes are invalid.');
    total += file.bytes.byteLength;
    if (total > 32 * 1024 * 1024) throw new AdapterProtocolError('Adapter input bytes exceed the total limit.');
    const safeFilename = file.filename === undefined ? undefined : sanitizeJson(file.filename, secrets) as string;
    const output = Object.create(null) as Record<string, unknown>;
    output.assetId = sanitizeJson(file.assetId, secrets) as string;
    output.role = sanitizeJson(file.role, secrets) as string;
    output.mimeType = sanitizeJson(file.mimeType, secrets) as string;
    output.bytes = Uint8Array.from(file.bytes);
    if (safeFilename !== undefined) output.filename = safeFilename;
    return output as unknown as AdapterFileView;
  });
}

function validHostForUrl(url: string, allowedHosts: readonly string[]): boolean {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  return allowedHosts.includes(host);
}

function redactResponseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (RESPONSE_STRIPPED_HEADERS.has(normalized)) continue;
    result[name] = value;
  }
  return result;
}

function postWorkerMessage(worker: AdapterWorkerLike, value: unknown): boolean {
  try {
    worker.postMessage(value);
    return true;
  } catch {
    return false;
  }
}

export class AdapterWorkerHost {
  private readonly activeWorkers = new Set<AdapterWorkerLike>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly workerFactory: AdapterWorkerFactory;

  public constructor(
    private readonly runtimeReader: AdapterRuntimeReader,
    private readonly http: SafeHttpPort,
    workerFactory: AdapterWorkerFactory = defaultWorkerFactory,
  ) {
    this.workerFactory = workerFactory;
  }

  public capabilities(reference: AdapterRuntimeReference, context: AdapterProviderContext, signal?: AbortSignal): Promise<unknown> {
    return this.call(reference, 'capabilities', context, {}, signal);
  }

  public submit(reference: AdapterRuntimeReference, context: AdapterProviderContext, invocation: AdapterInvocation, signal?: AbortSignal): Promise<unknown> {
    return this.call(reference, 'submit', context, invocation, signal);
  }

  public poll(reference: AdapterRuntimeReference, context: AdapterProviderContext, remoteJobId: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(reference, 'poll', context, { remoteJobId }, signal);
  }

  public cancel(reference: AdapterRuntimeReference, context: AdapterProviderContext, remoteJobId: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(reference, 'cancel', context, { remoteJobId }, signal);
  }

  public normalizeError(reference: AdapterRuntimeReference, context: AdapterProviderContext, error: AdapterErrorView, signal?: AbortSignal): Promise<unknown> {
    return this.call(reference, 'normalizeError', context, { error }, signal);
  }

  public async call(
    reference: AdapterRuntimeReference,
    call: AdapterCall,
    context: AdapterProviderContext,
    invocation: AdapterInvocation = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const runtime = await this.runtimeReader.readByRef(reference);
    const record: AdapterRecord = runtime;
    const source = runtime.source;
    const secrets = Object.values(context.secrets);
    const provider = call === 'capabilities' || call === 'normalizeError' ? undefined : providerView(record, context);
    const request = call === 'submit' && invocation.request !== undefined ? sanitizeRequest(invocation.request, secrets) : undefined;
    if (request !== undefined) assertBoundedAdapterData(request, Math.min(record.manifest.resourceLimits.maxMessageBytes, 2 * 1024 * 1024));
    if (call === 'submit' && request !== undefined && typeof request === 'object' && request !== null && 'operation' in request) {
      const operation = (request as Record<string, unknown>).operation;
      if (typeof operation === 'string' && !record.manifest.operations.includes(operation as AdapterOperation)) {
        throw new AdapterProtocolError('Adapter manifest does not declare this operation.');
      }
    }
    const files = call === 'submit' ? filesView(invocation.files, secrets) : [];
    const remoteJobId = (call === 'poll' || call === 'cancel') && invocation.remoteJobId !== undefined
      ? this.safeRemoteId(invocation.remoteJobId)
      : undefined;
    const error = call === 'normalizeError' && invocation.error !== undefined
      ? sanitizeError(invocation.error, secrets)
      : undefined;
    const data: AdapterWorkerData = {
      source: new TextDecoder().decode(source),
      call,
      requestId: randomUUID(),
      ...(provider === undefined ? {} : { provider }),
      ...(request === undefined ? {} : { request }),
      ...(files.length === 0 ? {} : { files }),
      ...(remoteJobId === undefined ? {} : { remoteJobId }),
      ...(error === undefined ? {} : { error }),
    };
    if (messageBytes(data) > record.manifest.resourceLimits.maxMessageBytes) throw new AdapterProtocolError('Adapter worker data exceeds the message limit.');
    if (signal?.aborted) throw new AdapterWorkerAbortError();
    const worker = this.workerFactory(data, record.manifest.resourceLimits);
    if (signal?.aborted) {
      try {
        await terminateWithGrace(worker);
      } catch (error) {
        throw new AdapterWorkerFailure('Adapter worker termination failed.', 'adapter_terminate_failed', { cause: error });
      }
      throw new AdapterWorkerAbortError();
    }
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (signal !== undefined) signal.addEventListener('abort', onExternalAbort, { once: true });
    if (signal?.aborted) onExternalAbort();
    this.activeWorkers.add(worker);
    this.activeControllers.add(controller);
    try {
      return await this.execute(worker, record, data, controller, secrets);
    } finally {
      this.activeControllers.delete(controller);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  public async close(): Promise<void> {
    for (const controller of this.activeControllers) controller.abort();
    const workers = [...this.activeWorkers];
    await Promise.allSettled(workers.map(async (worker) => {
      try {
        await terminateWithGrace(worker);
      } finally {
        this.activeWorkers.delete(worker);
      }
    }));
  }

  private async execute(
    worker: AdapterWorkerLike,
    record: AdapterRecord,
    data: AdapterWorkerData,
    controller: AbortController,
    secrets: readonly string[],
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let messageCount = 0;
      let logBytes = 0;
      const pendingHttp = new Set<string>();
      const timer = setTimeout(() => {
        void finish(new AdapterWorkerTimeoutError());
      }, record.manifest.resourceLimits.timeoutMs);

      const finish = async (error?: Error, value?: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        controller.signal.removeEventListener('abort', onAbort);
        pendingHttp.clear();
        worker.off?.('message', onMessage);
        worker.off?.('error', onError);
        worker.off?.('exit', onExit);
        worker.stdout?.off?.('data', onLog);
        worker.stderr?.off?.('data', onLog);
        try {
          await terminateWithGrace(worker);
        } catch (terminationError) {
          if (error === undefined) error = new AdapterWorkerFailure('Adapter worker termination failed.', 'adapter_terminate_failed', { cause: terminationError });
        } finally {
          this.activeWorkers.delete(worker);
        }
        if (error === undefined) resolve(value);
        else reject(error);
      };

      const onAbort = (): void => {
        void finish(new AdapterWorkerAbortError());
      };

      const onLog = (chunk: unknown): void => {
        if (settled) return;
        const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
        logBytes += bytes;
        if (logBytes > record.manifest.resourceLimits.maxLogBytes) void finish(new AdapterWorkerFailure('Adapter worker output exceeded the log limit.', 'adapter_log_limit'));
      };

      const onMessage = (message: unknown): void => {
        if (settled) return;
        messageCount += 1;
        if (messageCount > MAX_WORKER_MESSAGES || messageBytes(message) > record.manifest.resourceLimits.maxMessageBytes) {
          void finish(new AdapterWorkerFailure('Adapter worker message limit exceeded.', 'adapter_message_limit'));
          return;
        }
        if (message === null || typeof message !== 'object') {
          void finish(new AdapterWorkerFailure('Adapter worker sent an invalid message.', 'adapter_protocol'));
          return;
        }
        const value = message as Record<string, unknown>;
        if (value.kind === 'http-request') {
          const requestId = typeof value.requestId === 'string' ? value.requestId : '';
          if (requestId.length > 0) pendingHttp.add(requestId);
          void this.handleHttpMessage(
            worker,
            record,
            data.requestId,
            value,
            controller.signal,
            secrets,
            () => settled,
            () => pendingHttp.delete(requestId),
            (error) => { void finish(error); },
          );
          return;
        }
        if (value.requestId !== data.requestId) {
          void finish(new AdapterWorkerFailure('Adapter worker request id mismatch.', 'adapter_protocol'));
          return;
        }
        if (value.kind === 'error') {
          const errorValue = value.error;
          const sanitized = sanitizeError(errorValue, secrets);
          void finish(new AdapterWorkerFailure(sanitized.message, sanitized.code ?? 'adapter_worker_error'));
          return;
        }
        if (value.kind !== 'result') {
          void finish(new AdapterWorkerFailure('Adapter worker sent an unknown message.', 'adapter_protocol'));
          return;
        }
        try {
          const result = validateAdapterResult(data.call, value.value, record.manifest.resourceLimits.maxOutputBytes, secrets, record.manifest);
          void finish(undefined, result);
        } catch (error) {
          void finish(new AdapterWorkerFailure(error instanceof Error ? error.message : 'Adapter result is invalid.', 'adapter_result_invalid', { cause: error }));
        }
      };

      const onError = (error: Error): void => {
        void finish(new AdapterWorkerFailure(sanitizeError(error, secrets).message, 'adapter_worker_error', { cause: error }));
      };
      const onExit = (code: number): void => {
        if (!settled) void finish(new AdapterWorkerFailure(`Adapter worker exited before responding (code ${code}).`, 'adapter_worker_exit'));
      };

      worker.on('message', onMessage).on('error', onError).on('exit', onExit);
      worker.stdout?.on('data', onLog);
      worker.stderr?.on('data', onLog);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted === true) void onAbort();
    });
  }

  private async handleHttpMessage(
    worker: AdapterWorkerLike,
    record: AdapterRecord,
    callRequestId: string,
    message: Record<string, unknown>,
    signal: AbortSignal,
    secrets: readonly string[],
    isSettled: () => boolean,
    onComplete: () => void,
    onPostFailure: (error: AdapterWorkerFailure) => void,
  ): Promise<void> {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    try {
      if (requestId.length === 0 || !requestId.startsWith(`${callRequestId}:http:`)) throw new AdapterHttpRequestError('HTTP request id is invalid.');
      const input = validateHttpRequest(message.input);
      if (!validHostForUrl(input.url, record.manifest.allowedHosts)) throw new AdapterHttpRequestError('HTTP URL host is not allowed by the adapter manifest.');
      const response = await this.http.request(input, signal ?? new AbortController().signal);
      if (isSettled()) return;
      const validated = validateHttpResponse(response);
      if (validated.status >= 300 && validated.status < 400) throw new AdapterHttpRequestError('Redirect responses are not accepted from an adapter HTTP port.');
      const safeResponse: AdapterHttpResponse = {
        status: validated.status,
        headers: redactResponseHeaders(validated.headers),
        body: validated.body,
      };
      if (messageBytes(safeResponse) > record.manifest.resourceLimits.maxMessageBytes) throw new AdapterHttpRequestError('HTTP response exceeds the message limit.');
      if (!postWorkerMessage(worker, { kind: 'http-result', requestId, ok: true, value: safeResponse }) && !isSettled()) {
        onPostFailure(new AdapterWorkerFailure('Adapter worker channel closed.', 'adapter_worker_channel'));
      }
    } catch (error) {
      if (isSettled()) return;
      const errorView: AdapterErrorView = sanitizeError(error, secrets);
      if (!postWorkerMessage(worker, { kind: 'http-result', requestId, ok: false, error: errorView })) {
        onPostFailure(new AdapterWorkerFailure('Adapter worker channel closed.', 'adapter_worker_channel'));
      }
    } finally {
      onComplete();
    }
  }

  private safeRemoteId(value: string): string {
    if (value.length === 0 || value.length > 255 || CONTROL_PATTERN.test(value)) throw new AdapterProtocolError('Remote job id is invalid.');
    return value;
  }
}

export type { AdapterProviderContext };
