import { Readable } from 'node:stream';
import type { ProviderContext, ProviderHttpClientPort } from '@imagine/provider-contract';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NetworkPolicy,
  type DnsResolver,
} from '../security/network-policy.js';
import type { GeminiHttpTransport } from './gemini/types.js';
import type { OpenAiHttpTransport } from './openai/types.js';
import type { XaiImagineHttpClient } from './xai/xai-imagine-image.js';
import {
  ProviderHttpClient,
  ProviderHttpError,
  type ProviderHttpExecutor,
  type ProviderHttpRawResponse,
  type ProviderHttpRequest,
} from './provider-http-client.js';

const PUBLIC_RESOLVER: DnsResolver = async (hostname) => [{
  address: hostname === 'second.example' ? '1.1.1.1' : '8.8.8.8',
  family: 4,
}];

const baseRequest = (overrides: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest => ({
  body: JSON.stringify({ prompt: 'a test image' }),
  headers: {
    Authorization: 'Bearer test-secret',
    'Content-Type': 'application/json',
  },
  method: 'POST',
  url: 'https://public.example/v1/images',
  ...overrides,
});

function assertAdapterPortCompatibility(client: ProviderHttpClient): void {
  const shared: ProviderHttpClientPort = client;
  const openAi: OpenAiHttpTransport = client;
  const gemini: GeminiHttpTransport = client;
  const xai: XaiImagineHttpClient = client;
  void [shared, openAi, gemini, xai];
}

function rawResponse(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array | string | AsyncIterable<Uint8Array | string> = '',
): ProviderHttpRawResponse & { disposed: () => boolean } {
  let disposed = false;
  return {
    body,
    dispose: () => {
      disposed = true;
    },
    headers,
    statusCode,
    disposed: () => disposed,
  };
}

function jsonResponse(value: unknown, statusCode = 200): ProviderHttpRawResponse & { disposed: () => boolean } {
  return rawResponse(
    statusCode,
    { 'content-type': 'application/json; charset=utf-8' },
    JSON.stringify(value),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProviderHttpClient', () => {
  it('is assignable to all three provider HTTP ports', () => {
    assertAdapterPortCompatibility(new ProviderHttpClient({ resolver: PUBLIC_RESOLVER }));
  });

  it('keeps legacy callable fixture transports out of the shared ProviderContext', () => {
    const client: NonNullable<ProviderContext['http']> = new ProviderHttpClient({ resolver: PUBLIC_RESOLVER });
    expect(typeof client).toBe('object');
    expect(typeof client.request).toBe('function');
    // @ts-expect-error ProviderContext only accepts the server-owned object port.
    const legacy: ProviderContext['http'] = async () => undefined;
    void legacy;
  });

  it('validates metadata/private targets before invoking the executor', async () => {
    const executor = vi.fn<ProviderHttpExecutor>();
    const client = new ProviderHttpClient({
      executor,
      resolver: async () => [{ address: '10.0.0.8', family: 4 }],
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({ name: 'UnsafeRemoteUrlError' });
    expect(executor).not.toHaveBeenCalled();

    const metadataClient = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });
    await expect(metadataClient.request(baseRequest({ url: 'https://metadata.google.internal/v1/images' }))).rejects.toThrow('not allowed');
    expect(executor).not.toHaveBeenCalled();
  });

  it('uses the policy-pinned DNS address and strips hop-by-hop headers', async () => {
    let capturedTarget: { pinnedAddress: { address: string; family: 4 | 6 } } | undefined;
    let capturedRequest: ProviderHttpRequest | undefined;
    const executor: ProviderHttpExecutor = async (target, request) => {
      capturedTarget = target;
      capturedRequest = request;
      return jsonResponse({ ok: true });
    };
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });

    const response = await client.request(baseRequest({
      headers: {
        Authorization: 'Bearer test-secret',
        Connection: 'keep-alive',
        'Content-Length': '999',
        'Content-Type': 'application/json',
        Host: 'forged.example',
        'Keep-Alive': 'timeout=5',
        'Proxy-Auth': 'forged',
        'Proxy-Authenticate': 'Basic forged',
        'Proxy-Connection': 'keep-alive',
        'Proxy-Authorization': 'Basic forged',
        TE: 'trailers',
        Trailer: 'X-Trailer',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket',
        'X-Trace': 'first',
        'x-trace': 'second',
      },
    }));

    expect(capturedTarget?.pinnedAddress).toEqual({ address: '8.8.8.8', family: 4 });
    expect(capturedRequest?.headers).toEqual({
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
      'x-trace': 'second',
    });
    expect(response.json).toEqual({ ok: true });
  });

  it('supports policy-checked GET requests without sending a request body', async () => {
    let capturedRequest: ProviderHttpRequest | undefined;
    const client = new ProviderHttpClient({
      executor: async (_target, request) => {
        capturedRequest = request;
        return jsonResponse({ models: [] });
      },
      resolver: PUBLIC_RESOLVER,
    });

    const response = await client.request({
      headers: { Authorization: 'Bearer test-secret', Accept: 'application/json' },
      method: 'GET',
      url: 'https://public.example/v1/models',
    });

    expect(response.json).toEqual({ models: [] });
    expect(capturedRequest).toMatchObject({ method: 'GET', url: 'https://public.example/v1/models' });
    expect(capturedRequest).not.toHaveProperty('body');
    expect(capturedRequest).not.toHaveProperty('bodyBytes');
  });

  it('rejects GET bodies before DNS resolution or executor invocation', async () => {
    const executor = vi.fn<ProviderHttpExecutor>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });

    await expect(client.request({
      body: '{}',
      headers: {},
      method: 'GET',
      url: 'https://public.example/v1/models',
    })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('supports every declared method, including empty non-GET requests', async () => {
    const requests: ProviderHttpRequest[] = [];
    const client = new ProviderHttpClient({
      executor: async (_target, request) => {
        requests.push(request);
        return jsonResponse({ ok: true });
      },
      resolver: PUBLIC_RESOLVER,
    });

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await expect(client.request({
        headers: {},
        method,
        url: 'https://public.example/v1/resource',
      })).resolves.toMatchObject({ status: 200 });
    }

    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(requests.every((request) => request.body === undefined && request.bodyBytes === undefined)).toBe(true);
  });

  it('forwards optional per-request timeout overrides to the injected executor', async () => {
    let received: { bodyTimeoutMs: number; connectTimeoutMs: number; headersTimeoutMs: number } | undefined;
    const client = new ProviderHttpClient({
      executor: async (_target, _request, options) => {
        received = options;
        return jsonResponse({ ok: true });
      },
      resolver: PUBLIC_RESOLVER,
    });

    await client.request(baseRequest({
      bodyTimeoutMs: 17,
      connectTimeoutMs: 19,
      headersTimeoutMs: 23,
    }));
    expect(received).toEqual({ bodyTimeoutMs: 17, connectTimeoutMs: 19, headersTimeoutMs: 23, signal: expect.any(AbortSignal) });
  });

  it('rejects per-request limits above the client hard limits', async () => {
    const executor = vi.fn<ProviderHttpExecutor>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ProviderHttpClient({
      bodyTimeoutMs: 10,
      connectTimeoutMs: 10,
      executor,
      headersTimeoutMs: 10,
      maxResponseBodyBytes: 64,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest({ maxResponseBodyBytes: 65 }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.request(baseRequest({ headersTimeoutMs: 11 }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.request(baseRequest({ bodyTimeoutMs: 11 }))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.request(baseRequest({ connectTimeoutMs: 11 }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(executor).not.toHaveBeenCalled();
  });

  it('enforces a smaller per-request response limit before parsing JSON or consuming chunks', async () => {
    const contentLengthResponse = rawResponse(
      200,
      { 'content-length': '16', 'content-type': 'application/json' },
      JSON.stringify({ oversized: true }),
    );
    const client = new ProviderHttpClient({
      executor: async () => contentLengthResponse,
      maxResponseBodyBytes: 64,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest({ maxResponseBodyBytes: 4 }))).rejects.toMatchObject({
      code: 'response_body_too_large',
    });
    expect(contentLengthResponse.disposed()).toBe(true);

    let yielded = false;
    const chunkedResponse = rawResponse(200, { 'content-type': 'application/json' }, (async function* () {
      yielded = true;
      yield '{"oversized":';
      yield 'true}';
    })());
    const chunkedClient = new ProviderHttpClient({
      executor: async () => chunkedResponse,
      maxResponseBodyBytes: 64,
      resolver: PUBLIC_RESOLVER,
    });
    await expect(chunkedClient.request(baseRequest({ maxResponseBodyBytes: 8 }))).rejects.toMatchObject({
      code: 'response_body_too_large',
    });
    expect(yielded).toBe(true);
    expect(chunkedResponse.disposed()).toBe(true);
  });

  it('uses bodyBytes as the binary request source and enforces request limits', async () => {
    let capturedRequest: ProviderHttpRequest | undefined;
    const executor: ProviderHttpExecutor = async (_target, request) => {
      capturedRequest = request;
      return jsonResponse({ ok: true });
    };
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });
    const binary = new Uint8Array([0, 255, 1]);

    await client.request(baseRequest({ body: 'text body is not sent', bodyBytes: binary }));
    expect(capturedRequest?.bodyBytes).toEqual(binary);

    await client.request({
      bodyBytes: binary,
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/octet-stream',
      },
      method: 'POST',
      url: 'https://public.example/v1/images',
    });
    expect(capturedRequest?.body).toBeUndefined();
    expect(capturedRequest?.bodyBytes).toEqual(binary);

    const limited = new ProviderHttpClient({
      executor,
      maxRequestBodyBytes: 2,
      resolver: PUBLIC_RESOLVER,
    });
    await expect(limited.request(baseRequest({ body: '123' }))).rejects.toMatchObject({
      code: 'request_body_too_large',
    });
  });

  it('bounds and disposes oversized response bodies', async () => {
    const response = rawResponse(
      200,
      { 'content-length': '4', 'content-type': 'application/json' },
      '1234',
    );
    const client = new ProviderHttpClient({
      executor: async () => response,
      maxResponseBodyBytes: 3,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({
      code: 'response_body_too_large',
    });
    expect(response.disposed()).toBe(true);
  });

  it('parses JSON, text, SSE, and binary responses without returning a stream', async () => {
    const cases: Array<{
      contentType: string;
      body: Uint8Array | string;
      assert: (response: Awaited<ReturnType<ProviderHttpClient['request']>>) => void;
    }> = [
      {
        contentType: 'application/json',
        body: JSON.stringify({ data: [{ ok: true }] }),
        assert: (response) => {
          expect(response.json).toEqual({ data: [{ ok: true }] });
          expect(response.body).toBeUndefined();
        },
      },
      {
        contentType: 'text/plain; charset=utf-8',
        body: 'plain provider error',
        assert: (response) => expect(response.text).toBe('plain provider error'),
      },
      {
        contentType: 'text/event-stream',
        body: 'event: image_generation.completed\ndata: {}\n\n',
        assert: (response) => expect(response.text).toContain('image_generation.completed'),
      },
      {
        contentType: 'application/octet-stream',
        body: new Uint8Array([0, 255, 2]),
        assert: (response) => expect(response.body).toEqual(new Uint8Array([0, 255, 2])),
      },
    ];

    for (const testCase of cases) {
      const response = await new ProviderHttpClient({
        executor: async () => rawResponse(200, { 'content-type': testCase.contentType }, testCase.body),
        resolver: PUBLIC_RESOLVER,
      }).request(baseRequest());
      testCase.assert(response);
      expect(Object.getPrototypeOf(response.headers)).toBeNull();
      expect(response.dispose).toEqual(expect.any(Function));
    }
  });

  it('allows ordinary query parameters but rejects credential-like query names', async () => {
    const executor = vi.fn<ProviderHttpExecutor>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });

    for (const name of ['variant', 'format', 'tokenizer', 'authenticity', 'keynote', 'signatured', 'client_secretary']) {
      await expect(client.request(baseRequest({ url: `https://public.example/v1/content?${name}=value` })))
        .resolves.toMatchObject({ status: 200 });
    }
    for (const name of ['token', 'api_key', 'api-key', 'apikey', 'APIKEY', 'access_token', 'access-token', 'access.key', 'authorization', 'credential_id', 'signature', 'signature.id', 'client_secret', 'client-secret', 'x-api-key', 'x_api_key', 'x-amz-signature', 'x_goog_credential', 'x-ms-token', 'oauth_token', 'oauth']) {
      await expect(client.request(baseRequest({ url: `https://public.example/v1/content?${name}=secret` })))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(executor).toHaveBeenCalledTimes(7);
  });

  it('rejects redirects and always disposes the redirect response', async () => {
    const redirect = rawResponse(302, {
      location: 'https://second.example/v1/images',
    });
    const executor = vi.fn<ProviderHttpExecutor>().mockResolvedValue(redirect);
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });

    await expect(client.request(baseRequest())).rejects.toMatchObject({
      code: 'redirect_not_allowed',
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(redirect.disposed()).toBe(true);
  });

  it('converts caller aborts and timeouts into reason-free errors', async () => {
    const controller = new AbortController();
    const executor: ProviderHttpExecutor = async (_target, request) => {
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('secret body')), { once: true });
      });
      throw new Error('unreachable');
    };
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });
    const pending = client.request(baseRequest({ signal: controller.signal }));
    controller.abort('secret abort reason');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'aborted' });

    const timedOut = new ProviderHttpClient({
      bodyTimeoutMs: 5,
      executor: async () => new Promise<ProviderHttpRawResponse>(() => undefined),
      headersTimeoutMs: 5,
      resolver: PUBLIC_RESOLVER,
    });
    await expect(timedOut.request(baseRequest())).rejects.toMatchObject({ code: 'timeout' });

    const dnsController = new AbortController();
    const dnsClient = new ProviderHttpClient({
      executor: async () => jsonResponse({ ok: true }),
      resolver: async () => new Promise(() => undefined),
    });
    const pendingDns = dnsClient.request(baseRequest({ signal: dnsController.signal }));
    dnsController.abort('secret DNS reason');
    await expect(pendingDns).rejects.toMatchObject({ name: 'AbortError', code: 'aborted' });
  });

  it('bounds a stalled response body and does not expose executor secrets', async () => {
    const response = rawResponse(200, { 'content-type': 'text/plain' }, Readable.from((async function* () {
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield 'late body';
    })()));
    const client = new ProviderHttpClient({
      bodyTimeoutMs: 5,
      executor: async () => response,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({ code: 'timeout' });
    expect(response.disposed()).toBe(true);

    const failed = new ProviderHttpClient({
      executor: async () => {
        throw new Error('Authorization: Bearer body-secret');
      },
      resolver: PUBLIC_RESOLVER,
    });
    await expect(failed.request(baseRequest())).rejects.toSatisfy((error: unknown) => {
      return error instanceof ProviderHttpError &&
        error.code === 'network_error' &&
        !error.message.includes('body-secret');
    });
  });

  it('disposes a response that arrives after the header timeout', async () => {
    const late = jsonResponse({ late: true });
    const client = new ProviderHttpClient({
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return late;
      },
      headersTimeoutMs: 5,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(late.disposed()).toBe(true);
  });

  it('rejects header injection before making a request', async () => {
    const executor = vi.fn<ProviderHttpExecutor>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ProviderHttpClient({ executor, resolver: PUBLIC_RESOLVER });

    await expect(client.request(baseRequest({
      headers: { Authorization: 'Bearer secret\r\nX-Leak: yes' },
    }))).rejects.toMatchObject({ code: 'invalid_request' });
    expect(executor).not.toHaveBeenCalled();

    const oversizedHeaders = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`X-Test-${index}`, 'value']),
    );
    await expect(client.request(baseRequest({ headers: oversizedHeaders }))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects dangerous response header names and still disposes the response', async () => {
    const headers = Object.create(null) as Record<string, string>;
    headers.__proto__ = 'not-a-prototype';
    const response = rawResponse(200, headers);
    const client = new ProviderHttpClient({
      executor: async () => response,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({ code: 'response_invalid' });
    expect(response.disposed()).toBe(true);
  });

  it('maps malformed async body chunks to response_invalid and disposes the response', async () => {
    const response = rawResponse(200, { 'content-type': 'application/json' }, (async function* () {
      yield 42 as unknown as string;
    })() as unknown as AsyncIterable<Uint8Array | string>);
    const client = new ProviderHttpClient({
      executor: async () => response,
      resolver: PUBLIC_RESOLVER,
    });

    await expect(client.request(baseRequest())).rejects.toMatchObject({ code: 'response_invalid' });
    expect(response.disposed()).toBe(true);
  });
});

describe('ProviderHttpClient network policy options', () => {
  it('allows explicit private HTTP targets only when both switches are enabled', async () => {
    const executor: ProviderHttpExecutor = async () => jsonResponse({ ok: true });
    const policy = new NetworkPolicy({
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      resolver: async () => [{ address: '192.168.1.20', family: 4 }],
    });
    const client = new ProviderHttpClient({ executor, policy });

    await expect(client.request(baseRequest({ url: 'http://lan.example/v1/images' }))).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});
