import { Readable } from 'node:stream';

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
  const openAi: OpenAiHttpTransport = client;
  const gemini: GeminiHttpTransport = client;
  const xai: XaiImagineHttpClient = client;
  void [openAi, gemini, xai];
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
    }
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
