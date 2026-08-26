import type { IncomingHttpHeaders } from 'node:http';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';

import { Agent, request } from 'undici';

import type { NetworkPolicy, ValidatedRemoteTarget } from './network-policy.js';

export interface SafeHttpRequest {
  headers?: Readonly<Record<string, string>>;
  method?: 'GET' | 'HEAD';
  signal?: AbortSignal;
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
  | 'compressed_response'
  | 'download_error'
  | 'http_status'
  | 'invalid_content_length'
  | 'invalid_redirect'
  | 'redirect_limit'
  | 'response_body_too_large';

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

const defaultExecutor: PinnedRequestExecutor = async (target, input) => {
  const dispatcher = new Agent({
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

    for (let redirects = 0; ; redirects += 1) {
      input.signal?.throwIfAborted();
      const target = await this.policy.validate(current);
      const response = await this.executor(target, {
        headers,
        method: input.method ?? 'GET',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const location = locationHeader(response.headers);
      if (!REDIRECT_STATUS.has(response.statusCode) || location === null) {
        return { ...response, url: current };
      }

      if (redirects >= this.maxRedirects) {
        await response.dispose();
        throw new RemoteHttpError(
          'Remote media URL exceeded the redirect limit.',
          'redirect_limit',
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        await response.dispose();
        throw new RemoteHttpError(
          'Remote server returned an invalid redirect URL.',
          'invalid_redirect',
        );
      }
      if (next.origin !== current.origin) headers = stripCrossOriginSecrets(headers);
      await response.dispose();
      current = next;
    }
  }
}
