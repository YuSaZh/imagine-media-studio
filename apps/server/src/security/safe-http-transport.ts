import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';

import { Agent, request } from 'undici';

import {
  UnsafeRemoteUrlError,
  type NetworkPolicy,
  type ValidatedRemoteTarget,
} from './network-policy.js';

export const SAFE_HTTP_DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const SAFE_HTTP_MAX_CONNECT_TIMEOUT_MS = 10 * 60 * 1_000;

export interface SafeHttpRequest {
  headers?: Readonly<Record<string, string>>;
  method?: 'GET' | 'HEAD';
  signal?: AbortSignal;
  /** Bounds DNS and TCP connection establishment for every redirect hop. */
  connectTimeoutMs?: number;
}

export interface RawPinnedResponse {
  body: Readable & { dump?: () => Promise<void> };
  dispose: () => Promise<void>;
  headers: IncomingHttpHeaders;
  statusCode: number;
}

export type PinnedRequestExecutor = (
  target: ValidatedRemoteTarget,
  request: SafeHttpRequest,
) => Promise<RawPinnedResponse>;

export interface SafeHttpResponse extends RawPinnedResponse {
  url: URL;
}

export interface SafeHttpTransportOptions {
  executor?: PinnedRequestExecutor;
  maxRedirects?: number;
  policy: NetworkPolicy;
}

export type RemoteHttpErrorCode =
  | 'aborted'
  | 'compressed_response'
  | 'download_error'
  | 'http_status'
  | 'invalid_content_length'
  | 'invalid_redirect'
  | 'redirect_limit'
  | 'response_body_too_large'
  | 'timeout';

export class RemoteHttpError extends Error {
  public override readonly name = 'RemoteHttpError';

  public constructor(
    message: string,
    public readonly code: RemoteHttpErrorCode = 'download_error',
    statusCode?: number,
  ) {
    super(message);
    if (statusCode !== undefined) this.statusCode = statusCode;
  }

  public readonly statusCode?: number;
}

function pinnedLookup(target: ValidatedRemoteTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [target.pinnedAddress]);
      return;
    }
    callback(null, target.pinnedAddress.address, target.pinnedAddress.family);
  };
}

function connectTimeout(value: number | undefined): number {
  const resolved = value ?? SAFE_HTTP_DEFAULT_CONNECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > SAFE_HTTP_MAX_CONNECT_TIMEOUT_MS) {
    throw new RangeError(`connectTimeoutMs must be a positive integer no larger than ${SAFE_HTTP_MAX_CONNECT_TIMEOUT_MS}.`);
  }
  return resolved;
}

function transportAbortError(): RemoteHttpError {
  return new RemoteHttpError('Remote media request was aborted.', 'aborted');
}

function transportTimeoutError(): RemoteHttpError {
  return new RemoteHttpError('Remote media request timed out.', 'timeout');
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout|timed.?out/i.test(error.name) || /timeout|timed.?out/i.test(error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function disposeResponse(response: RawPinnedResponse): Promise<void> {
  try {
    await response.dispose();
  } catch {
    // Disposal is best effort and must not mask the original policy/status
    // error. The response body is still destroyed by the default disposer.
  }
}

function executePinned(
  executor: PinnedRequestExecutor,
  target: ValidatedRemoteTarget,
  input: SafeHttpRequest,
  timeoutMs: number,
): Promise<RawPinnedResponse> {
  const controller = new AbortController();
  let settled = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const parentSignal = input.signal;
  const operation = Promise.resolve().then(() => executor(target, {
    ...input,
    connectTimeoutMs: timeoutMs,
    signal: controller.signal,
  }));
  return new Promise<RawPinnedResponse>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) parentSignal?.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      reject(error);
    };
    const resolveOnce = (response: RawPinnedResponse) => {
      if (settled) {
        void disposeResponse(response);
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };
    onAbort = () => rejectOnce(transportAbortError());
    if (parentSignal?.aborted) {
      rejectOnce(transportAbortError());
      return;
    }
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      rejectOnce(transportTimeoutError());
    }, timeoutMs);
    operation.then(resolveOnce, (error: unknown) => {
      if (settled) return;
      if (parentSignal?.aborted || (!timedOut && isAbortError(error))) {
        rejectOnce(transportAbortError());
        return;
      }
      if (timedOut || isTimeoutError(error)) {
        rejectOnce(transportTimeoutError());
        return;
      }
      if (error instanceof RemoteHttpError) {
        rejectOnce(error);
        return;
      }
      if (error instanceof UnsafeRemoteUrlError) {
        rejectOnce(error);
        return;
      }
      rejectOnce(new RemoteHttpError('Remote media request failed.', 'download_error'));
    });
  });
}

const defaultExecutor: PinnedRequestExecutor = async (target, input) => {
  const dispatcher = new Agent({
    connectTimeout: input.connectTimeoutMs ?? SAFE_HTTP_DEFAULT_CONNECT_TIMEOUT_MS,
    connect: {
      lookup: pinnedLookup(target),
      ...(target.hostname === target.pinnedAddress.address ? {} : { servername: target.hostname }),
    },
    pipelining: 0,
  });
  try {
    const response = await request(target.url, {
      bodyTimeout: 30_000,
      dispatcher,
      headersTimeout: 15_000,
      method: input.method ?? 'GET',
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
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

function locationHeader(headers: IncomingHttpHeaders): string | null {
  const value = headers.location;
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function stripHopByHopHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const hopByHop = new Set([
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
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hopByHop.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function stripCrossOriginSecrets(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() === 'accept'),
  );
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class SafeHttpTransport {
  private readonly executor: PinnedRequestExecutor;
  private readonly maxRedirects: number;
  private readonly policy: NetworkPolicy;

  public constructor(options: SafeHttpTransportOptions) {
    this.executor = options.executor ?? defaultExecutor;
    this.maxRedirects = options.maxRedirects ?? 5;
    if (!Number.isSafeInteger(this.maxRedirects) || this.maxRedirects < 0) {
      throw new RangeError('maxRedirects must be a non-negative safe integer.');
    }
    this.policy = options.policy;
  }

  public async fetch(rawUrl: string | URL, input: SafeHttpRequest = {}): Promise<SafeHttpResponse> {
    let current = rawUrl instanceof URL ? new URL(rawUrl) : new URL(rawUrl);
    let headers = stripHopByHopHeaders(input.headers ?? {});
    const connectTimeoutMs = connectTimeout(input.connectTimeoutMs);

    for (let redirects = 0; ; redirects += 1) {
      if (input.signal?.aborted) throw transportAbortError();
      let target: ValidatedRemoteTarget;
      try {
        target = await this.policy.validate(current, input.signal, connectTimeoutMs);
      } catch (error) {
        if (input.signal?.aborted || (error instanceof UnsafeRemoteUrlError && error.code === 'dns_aborted')) {
          throw transportAbortError();
        }
        if (error instanceof UnsafeRemoteUrlError && error.code === 'dns_timeout') {
          throw transportTimeoutError();
        }
        throw error;
      }
      const response = await executePinned(this.executor, target, {
        headers,
        method: input.method ?? 'GET',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, connectTimeoutMs);
      if (input.signal?.aborted) {
        await disposeResponse(response);
        throw transportAbortError();
      }
      const location = locationHeader(response.headers);
      if (!REDIRECT_STATUS.has(response.statusCode) || location === null) {
        return { ...response, url: current };
      }

      if (redirects >= this.maxRedirects) {
        await disposeResponse(response);
        throw new RemoteHttpError(
          'Remote media URL exceeded the redirect limit.',
          'redirect_limit',
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        await disposeResponse(response);
        throw new RemoteHttpError(
          'Remote server returned an invalid redirect URL.',
          'invalid_redirect',
        );
      }
      if (next.origin !== current.origin) headers = stripCrossOriginSecrets(headers);
      await disposeResponse(response);
      current = next;
    }
  }
}
