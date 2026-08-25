import { Agent, request as undiciRequest } from 'undici';
import type { LookupFunction } from 'node:net';

import {
  NetworkPolicy,
  UnsafeRemoteUrlError,
  type DnsResolver,
  type NetworkPolicyOptions,
  type ValidatedRemoteTarget,
} from '../security/network-policy.js';

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'host',
  'proxy-auth',
  'proxy-authenticate',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const PROVIDER_HTTP_DEFAULTS = Object.freeze({
  bodyTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 15_000,
  maxRequestBodyBytes: 64 * 1024 * 1024,
  maxResponseBodyBytes: 96 * 1024 * 1024,
});

export type ProviderHttpHeaderValue = string | readonly string[] | undefined;
export type ProviderHttpHeaders = Readonly<Record<string, ProviderHttpHeaderValue>>;
export type ProviderHttpBodySource = Uint8Array | string | AsyncIterable<Uint8Array | string>;
export type ProviderHttpResponseBody = Record<string, unknown> | string | Uint8Array;

/** Request shape accepted by the OpenAI, Gemini, and xAI adapter ports. */
export interface ProviderHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** When present, these bytes are sent instead of the textual body. */
  readonly bodyBytes?: Uint8Array;
  readonly signal?: AbortSignal;
}

/** Raw response shape used only by the injected/default executor. */
export interface ProviderHttpRawResponse {
  readonly statusCode: number;
  readonly headers?: ProviderHttpHeaders;
  readonly body?: ProviderHttpBodySource;
  readonly dispose?: () => Promise<void> | void;
}

export interface ProviderHttpResponse {
  readonly status: number;
  readonly statusCode: number;
  readonly headers: ProviderHttpHeaders;
  readonly body?: ProviderHttpResponseBody;
  readonly json?: unknown;
  readonly text?: string;
  /** Kept for adapter compatibility; the body is already disposed before return. */
  readonly dispose: () => Promise<void>;
}

export interface ProviderHttpExecutorOptions {
  readonly signal: AbortSignal;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
  readonly connectTimeoutMs: number;
}

export type ProviderHttpExecutor = (
  target: ValidatedRemoteTarget,
  request: ProviderHttpRequest,
  options: ProviderHttpExecutorOptions,
) => Promise<ProviderHttpRawResponse>;

export interface ProviderHttpClientOptions {
  readonly policy?: NetworkPolicy;
  readonly allowInsecureHttp?: boolean;
  readonly allowLoopback?: boolean;
  readonly allowPrivateNetwork?: boolean;
  readonly allowedHosts?: readonly string[];
  readonly resolver?: DnsResolver;
  readonly executor?: ProviderHttpExecutor;
  readonly maxRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
  readonly headersTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export type ProviderHttpErrorCode =
  | 'aborted'
  | 'invalid_request'
  | 'network_error'
  | 'redirect_not_allowed'
  | 'request_body_too_large'
  | 'response_body_too_large'
  | 'response_invalid'
  | 'timeout';

export class ProviderHttpError extends Error {
  public override readonly name: string = 'ProviderHttpError';

  public constructor(
    public readonly code: ProviderHttpErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Safe, reason-free abort error so a caller's abort reason cannot leak. */
export class ProviderHttpAbortError extends ProviderHttpError {
  public override readonly name = 'AbortError';

  public constructor() {
    super('aborted', 'Provider HTTP request was aborted.');
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function normalizedHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP header name is invalid.');
    }
    if (typeof value !== 'string' || /\r|\n/.test(value)) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP header value is invalid.');
    }
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    for (const existingName of Object.keys(result)) {
      if (existingName.toLowerCase() === normalized) delete result[existingName];
    }
    result[name] = value;
  }
  return result;
}

function bodyBytes(input: ProviderHttpRequest): Uint8Array {
  return input.bodyBytes ?? Buffer.from(input.body ?? '', 'utf8');
}

function normalizedHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function pinnedLookup(target: ValidatedRemoteTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: target.pinnedAddress.address, family: target.pinnedAddress.family }]);
      return;
    }
    callback(null, target.pinnedAddress.address, target.pinnedAddress.family);
  };
}

const defaultExecutor: ProviderHttpExecutor = async (target, input, options) => {
  const dispatcher = new Agent({
    bodyTimeout: options.bodyTimeoutMs,
    connectTimeout: options.connectTimeoutMs,
    connect: {
      lookup: pinnedLookup(target),
      ...(normalizedHost(target.hostname) === normalizedHost(target.pinnedAddress.address)
        ? {}
        : { servername: normalizedHost(target.hostname) }),
    },
    pipelining: 0,
  });
  try {
    const response = await undiciRequest(target.url, {
      ...(input.method === 'POST' ? { body: bodyBytes(input) } : {}),
      bodyTimeout: options.bodyTimeoutMs,
      dispatcher,
      headers: input.headers,
      headersTimeout: options.headersTimeoutMs,
      method: input.method,
      signal: options.signal,
    });
    return {
      body: response.body,
      dispose: async () => {
        response.body.destroy();
        await dispatcher.close();
      },
      headers: response.headers,
      statusCode: response.statusCode,
    };
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }
};

function headerValue(headers: ProviderHttpHeaders | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === 'string' ? first : undefined;
    }
    return undefined;
  }
  return undefined;
}

function copyHeaders(headers: ProviderHttpHeaders | undefined): Record<string, ProviderHttpHeaderValue> {
  const result: Record<string, ProviderHttpHeaderValue> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[name] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

function parseContentLength(headers: ProviderHttpHeaders): number | undefined {
  const raw = headerValue(headers, 'content-length');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new ProviderHttpError('response_invalid', 'Provider HTTP Content-Length is invalid.');
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new ProviderHttpError('response_invalid', 'Provider HTTP Content-Length is invalid.');
  return length;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType === 'application/json' || contentType?.endsWith('+json') === true;
}

function isTextContentType(contentType: string | undefined): boolean {
  return contentType === 'text/event-stream' || contentType?.startsWith('text/') === true;
}

function asBytes(chunk: Uint8Array | string): Uint8Array {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function abortError(): ProviderHttpAbortError {
  return new ProviderHttpAbortError();
}

function waitFor<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  onTimeout?: () => void,
  onLateValue?: (value: T) => void,
  onError?: (error: unknown) => unknown,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      rejectOnce(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        onTimeout?.();
        rejectOnce(new ProviderHttpError('timeout', 'Provider HTTP request timed out.'));
      }, timeoutMs);
    }
    operation.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        rejectOnce(onError?.(error) ?? new ProviderHttpError('network_error', 'Provider HTTP request failed.'));
      },
    );
  });
}

function createRequestSignal(inputSignal: AbortSignal | undefined): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (inputSignal === undefined) return { controller, cleanup: () => undefined };
  const onAbort = () => controller.abort();
  if (inputSignal.aborted) controller.abort();
  else inputSignal.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    cleanup: () => inputSignal.removeEventListener('abort', onAbort),
  };
}

async function readBody(
  source: ProviderHttpBodySource | undefined,
  maxBytes: number,
  signal: AbortSignal,
  bodyTimeoutMs: number,
  onBodyTimeout: () => void,
): Promise<Uint8Array> {
  if (source === undefined) return new Uint8Array(0);
  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) throw new ProviderHttpError('response_body_too_large', 'Provider HTTP response body is too large.');
    return source;
  }
  if (typeof source === 'string') {
    const bytes = Buffer.from(source, 'utf8');
    if (bytes.byteLength > maxBytes) throw new ProviderHttpError('response_body_too_large', 'Provider HTTP response body is too large.');
    return bytes;
  }

  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await waitFor(iterator.next(), signal, bodyTimeoutMs, onBodyTimeout);
      if (next.done) break;
      const chunk = asBytes(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) throw new ProviderHttpError('response_body_too_large', 'Provider HTTP response body is too large.');
      chunks.push(chunk);
    }
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // The response disposer remains authoritative when an iterator is broken.
    }
  }
  return concatBytes(chunks, total);
}

function parsedResponse(
  statusCode: number,
  headers: ProviderHttpHeaders,
  bytes: Uint8Array,
): ProviderHttpResponse {
  const base = {
    dispose: async () => undefined,
    headers,
    status: statusCode,
    statusCode,
  };
  if (bytes.byteLength === 0) return base;
  const contentType = headerValue(headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!isJsonContentType(contentType) && !isTextContentType(contentType)) {
    return { ...base, body: bytes };
  }
  const text = new TextDecoder().decode(bytes);
  if (isJsonContentType(contentType)) {
    try {
      return { ...base, json: JSON.parse(text) as unknown };
    } catch {
      return { ...base, text };
    }
  }
  if (isTextContentType(contentType)) return { ...base, text };
  return { ...base, body: bytes };
}

async function disposeRaw(response: ProviderHttpRawResponse): Promise<void> {
  try {
    await response.dispose?.();
  } catch {
    // Disposal must not hide the provider response or validation error.
  }
}

function safeExecutorError(error: unknown): ProviderHttpError {
  if (error instanceof ProviderHttpAbortError || (error instanceof Error && error.name === 'AbortError')) {
    return abortError();
  }
  if (error instanceof ProviderHttpError && error.code === 'timeout') {
    return new ProviderHttpError('timeout', 'Provider HTTP request timed out.');
  }
  if (error instanceof Error && /timeout/i.test(error.name)) {
    return new ProviderHttpError('timeout', 'Provider HTTP request timed out.');
  }
  return new ProviderHttpError('network_error', 'Provider HTTP request failed.');
}

export class ProviderHttpClient {
  private readonly policy: NetworkPolicy;
  private readonly executor: ProviderHttpExecutor;
  private readonly maxRequestBodyBytes: number;
  private readonly maxResponseBodyBytes: number;
  private readonly headersTimeoutMs: number;
  private readonly bodyTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  public constructor(options: ProviderHttpClientOptions = {}) {
    const policyOptions: NetworkPolicyOptions = {
      ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }),
      ...(options.allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork: options.allowPrivateNetwork }),
      ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
    };
    this.policy = options.policy ?? new NetworkPolicy(policyOptions);
    this.executor = options.executor ?? defaultExecutor;
    this.maxRequestBodyBytes = positiveLimit(options.maxRequestBodyBytes, PROVIDER_HTTP_DEFAULTS.maxRequestBodyBytes, 'maxRequestBodyBytes');
    this.maxResponseBodyBytes = positiveLimit(options.maxResponseBodyBytes, PROVIDER_HTTP_DEFAULTS.maxResponseBodyBytes, 'maxResponseBodyBytes');
    this.headersTimeoutMs = positiveLimit(options.headersTimeoutMs, PROVIDER_HTTP_DEFAULTS.headersTimeoutMs, 'headersTimeoutMs');
    this.bodyTimeoutMs = positiveLimit(options.bodyTimeoutMs, PROVIDER_HTTP_DEFAULTS.bodyTimeoutMs, 'bodyTimeoutMs');
    this.connectTimeoutMs = positiveLimit(options.connectTimeoutMs, PROVIDER_HTTP_DEFAULTS.connectTimeoutMs, 'connectTimeoutMs');
  }

  public async request(input: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    if ((input.method !== 'GET' && input.method !== 'POST') || typeof input.url !== 'string') {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP request method or URL is invalid.');
    }
    if (input.method === 'POST' && input.body === undefined && input.bodyBytes === undefined) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP POST requests require a body.');
    }
    if (input.body !== undefined && typeof input.body !== 'string') {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP POST body must be text when provided.');
    }
    if (input.method === 'GET' && (input.body !== undefined || input.bodyBytes !== undefined)) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP GET requests cannot include a body.');
    }
    if (input.bodyBytes !== undefined && !(input.bodyBytes instanceof Uint8Array)) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP bodyBytes must be binary data.');
    }
    if (input.headers === null || typeof input.headers !== 'object' || Array.isArray(input.headers)) {
      throw new ProviderHttpError('invalid_request', 'Provider HTTP headers must be an object.');
    }
    const headers = normalizedHeaders(input.headers);
    const bytes = bodyBytes(input);
    if (bytes.byteLength > this.maxRequestBodyBytes) {
      throw new ProviderHttpError('request_body_too_large', 'Provider HTTP request body is too large.');
    }
    if (input.signal?.aborted) throw abortError();

    const { controller, cleanup: cleanupSignal } = createRequestSignal(input.signal);
    let raw: ProviderHttpRawResponse | undefined;
    let headerTimedOut = false;
    let bodyTimedOut = false;
    try {
      const target = await waitFor(
        this.policy.validate(input.url),
        controller.signal,
        undefined,
        undefined,
        undefined,
        (error) => error,
      );
      const request: ProviderHttpRequest = {
        ...(input.bodyBytes === undefined ? {} : { bodyBytes: input.bodyBytes }),
        ...(input.body === undefined ? {} : { body: input.body }),
        headers,
        method: input.method,
        signal: controller.signal,
        url: input.url,
      };
      try {
        raw = await waitFor(
          this.executor(target, request, {
            bodyTimeoutMs: this.bodyTimeoutMs,
            connectTimeoutMs: this.connectTimeoutMs,
            headersTimeoutMs: this.headersTimeoutMs,
            signal: controller.signal,
          }),
          controller.signal,
          this.headersTimeoutMs,
          () => {
            headerTimedOut = true;
            controller.abort();
          },
          (lateResponse) => {
            void disposeRaw(lateResponse);
          },
          safeExecutorError,
        );
      } catch (error) {
        if (headerTimedOut) throw new ProviderHttpError('timeout', 'Provider HTTP request timed out.');
        if (input.signal?.aborted) throw abortError();
        throw safeExecutorError(error);
      }
      if (!raw || !Number.isSafeInteger(raw.statusCode) || raw.statusCode < 100 || raw.statusCode > 599) {
        throw new ProviderHttpError('response_invalid', 'Provider HTTP response status is invalid.');
      }
      if (raw.statusCode >= 300 && raw.statusCode < 400) {
        throw new ProviderHttpError('redirect_not_allowed', 'Provider HTTP redirects are not allowed.');
      }
      const responseHeaders = copyHeaders(raw.headers);
      const contentEncoding = headerValue(responseHeaders, 'content-encoding');
      if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity') {
        throw new ProviderHttpError('response_invalid', 'Compressed Provider HTTP responses are not accepted.');
      }
      const contentLength = parseContentLength(responseHeaders);
      if (contentLength !== undefined && contentLength > this.maxResponseBodyBytes) {
        throw new ProviderHttpError('response_body_too_large', 'Provider HTTP response body is too large.');
      }
      const body = await readBody(
        raw.body,
        this.maxResponseBodyBytes,
        controller.signal,
        this.bodyTimeoutMs,
        () => {
          bodyTimedOut = true;
          controller.abort();
        },
      );
      if (bodyTimedOut) throw new ProviderHttpError('timeout', 'Provider HTTP request timed out.');
      return parsedResponse(raw.statusCode, responseHeaders, body);
    } catch (error) {
      if (bodyTimedOut) throw new ProviderHttpError('timeout', 'Provider HTTP request timed out.');
      if (input.signal?.aborted) throw abortError();
      if (error instanceof UnsafeRemoteUrlError) throw error;
      if (error instanceof ProviderHttpError) throw error;
      throw safeExecutorError(error);
    } finally {
      cleanupSignal();
      if (raw !== undefined) await disposeRaw(raw);
    }
  }
}

export type ProviderHttpTransport = ProviderHttpClient;

export function createProviderHttpClient(options: ProviderHttpClientOptions = {}): ProviderHttpClient {
  return new ProviderHttpClient(options);
}

export const createProviderHttpTransport = createProviderHttpClient;
