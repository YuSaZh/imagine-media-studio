import { readFileSync } from 'node:fs';

import type { GenerationRequest } from '@imagine/shared';
import type { ProviderContext } from '@imagine/provider-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  XaiImagineHttpError,
  XaiImagineImageProvider,
  XaiImagineResponseError,
  XaiImagineTransportError,
  parseXaiImagineImageResponse,
  type XaiImagineHttpRequest,
  type XaiImagineHttpResponse,
  type XaiImagineHttpClient,
  type XaiImagineImageInput,
  type XaiImagineProviderContext,
} from './xai-imagine-image.js';

const context: ProviderContext = {
  providerId: 'xai-provider',
  secrets: {
    apiKey: 'xai-test-only',
    'header:X-Trace-Id': 'fixture-trace',
  },
};

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'xai-provider',
    modelId: 'grok-imagine-image-2.0',
    prompt: 'A red kite above a quiet lake',
    inputs: [],
    ...overrides,
  };
}

class FixtureClient implements XaiImagineHttpClient {
  public readonly requests: XaiImagineHttpRequest[] = [];

  public constructor(private readonly response: XaiImagineHttpResponse) {}

  public async request(input: XaiImagineHttpRequest): Promise<XaiImagineHttpResponse> {
    this.requests.push(input);
    return this.response;
  }
}

function jsonResponse(value: unknown, statusCode = 200): XaiImagineHttpResponse {
  return { statusCode, json: value };
}

function fixture(path: string): string {
  return readFileSync(
    new URL(`../../../../../fixtures/providers/xai/xai-imagine-image-v1/${path}`, import.meta.url),
    'utf8',
  );
}

describe('XaiImagineImageProvider', () => {
  it('records synchronous poll as not applicable in the contract fixture', () => {
    expect(JSON.parse(fixture('poll-na.json'))).toEqual({
      status: 'not_applicable',
      reason: 'xAI Imagine image generation returns synchronous image results in this profile.',
    });
    expect('poll' in XaiImagineImageProvider.prototype).toBe(false);
  });

  it('builds the official generation payload and normalizes URL/base64 outputs', async () => {
    const client = new FixtureClient(jsonResponse(JSON.parse(fixture('submit-response.json'))));
    const provider = new XaiImagineImageProvider({ http: client });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access is forbidden'));
    const input = request({
      aspectRatio: '16:9',
      resolution: '2k',
      quality: 'low',
      format: 'b64_json',
      count: 2,
    });

    await provider.validate(input, context);
    const result = await provider.submit(input, context);

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual(
      JSON.parse(fixture('submit-request.json')),
    );
    expect(result).toEqual(JSON.parse(fixture('expected-normalized.json')));
    expect(client.requests[0]?.url).toBe('https://api.x.ai/v1/images/generations');
    expect(client.requests[0]?.headers.Authorization).toBe('Bearer xai-test-only');
    expect(client.requests[0]?.headers['X-Trace-Id']).toBe('fixture-trace');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('uses the singular official image field for a one-image edit', async () => {
    const client = new FixtureClient(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/one.png' }] }));
    const provider = new XaiImagineImageProvider({ http: client });
    const input = request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      prompt: 'Turn this into a pencil sketch',
      inputs: [{ assetId: 'source', role: 'source' }],
    });
    const result = await provider.submit(input, {
      ...context,
      inputs: [{
        assetId: 'source',
        role: 'source',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }],
    });

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual({
      model: 'grok-imagine-image',
      prompt: 'Turn this into a pencil sketch',
      image: { type: 'image_url', url: 'data:image/png;base64,AQID' },
    });
    expect(result).toMatchObject({
      state: 'completed',
      assets: [{ source: 'url', url: 'https://cdn.example.invalid/one.png', resultId: 'image-0' }],
    });
  });

  it('honors a context base URL and custom headers without placing the API key in the URL', async () => {
    const client = new FixtureClient(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/custom.png' }] }));
    const provider = new XaiImagineImageProvider({
      transport: client,
      headers: { 'X-Trace-Id': 'configured-trace' },
    });
    await provider.submit(request({ inputs: [] }), {
      ...context,
      baseUrl: 'https://proxy.example.test/xai/v1',
      headers: {
        'X-Client-Label': 'image-studio',
        'x-trace-id': 'context-trace',
      },
    } as XaiImagineProviderContext);

    expect(client.requests[0]?.url).toBe('https://proxy.example.test/xai/v1/images/generations');
    expect(client.requests[0]?.url).not.toContain('xai-test-only');
    expect(client.requests[0]?.headers['X-Client-Label']).toBe('image-studio');
    expect(client.requests[0]?.headers['X-Trace-Id']).toBe('fixture-trace');
    expect(Object.keys(client.requests[0]?.headers ?? {}).filter((name) => name.toLowerCase() === 'x-trace-id')).toHaveLength(1);
  });

  it('tests the models endpoint with an injected GET and never calls real fetch', async () => {
    const client = new FixtureClient(jsonResponse(JSON.parse(fixture('connection-success.json'))));
    const provider = new XaiImagineImageProvider({ http: client });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    await provider.testConnection({
      ...context,
      baseUrl: 'https://proxy.example.test/xai/v1',
    });

    expect(client.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/xai/v1/models',
      headers: { Authorization: 'Bearer xai-test-only' },
    });
    expect(client.requests[0]).not.toHaveProperty('body');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refreshes a live model catalog, filters non-image models, and keeps unknown image models conservative', async () => {
    const client = new FixtureClient(jsonResponse(JSON.parse(fixture('models-response.json'))));
    const provider = new XaiImagineImageProvider();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    const capabilities = await provider.getLiveCapabilities({
      ...context,
      baseUrl: 'https://proxy.example.test/xai/v1',
      http: client,
    } as XaiImagineProviderContext);

    expect(client.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/xai/v1/models',
      headers: { Authorization: 'Bearer xai-test-only' },
    });
    expect(client.requests[0]).not.toHaveProperty('body');
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'grok-imagine-image-2.0',
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-image-custom-preview',
    ]);
    expect(capabilities.models[0]?.capabilities.maxBatchCount).toBe(10);
    expect(capabilities.models[2]?.capabilities.maxBatchCount).toBe(1);
    expect(capabilities.models[3]?.capabilities).toMatchObject({
      aspectRatios: ['1:1'],
      resolutions: ['1k'],
      maxReferenceImages: 1,
      supportsBatchCount: false,
      maxBatchCount: 1,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    await expect(provider.validate(request({
      modelId: 'grok-imagine-image-custom-preview',
      aspectRatio: '16:9',
    }), context)).rejects.toThrow('aspect ratio');
    await expect(provider.validate(request({
      modelId: 'grok-imagine-image-custom-preview',
      count: 2,
    }), context)).rejects.toThrow('one generated image');
  });

  it('normalizes injected authentication failures without exposing the API key', async () => {
    const client = new FixtureClient(jsonResponse(JSON.parse(fixture('connection-unauthorized.json')), 401));
    const provider = new XaiImagineImageProvider({ http: client });
    let error: unknown;
    try {
      await provider.testConnection(context);
    } catch (caught) {
      error = caught;
    }

    expect(provider.normalizeError(error)).toMatchObject({
      code: 'xai_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(error)).not.toContain('xai-test-only');
  });

  it('falls back from an empty context base URL to the configured provider base URL', async () => {
    const client = new FixtureClient(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/fallback.png' }] }));
    const provider = new XaiImagineImageProvider({
      transport: client,
      baseUrl: 'https://proxy.example.test/xai/v1',
    });
    await provider.submit(request(), { ...context, baseUrl: '' } as XaiImagineProviderContext);

    expect(client.requests[0]?.url).toBe('https://proxy.example.test/xai/v1/images/generations');
  });

  it('uses the plural images field for up to three multi-reference inputs', async () => {
    const client = new FixtureClient(jsonResponse(JSON.parse(fixture('edit-submit-response.json'))));
    const provider = new XaiImagineImageProvider({ http: client });
    const input = request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      prompt: 'Place the subjects together in a sunny park',
      aspectRatio: '3:2',
      inputs: [
        { assetId: 'source', role: 'source' },
        { assetId: 'reference-1', role: 'reference' },
        { assetId: 'reference-2', role: 'reference' },
      ],
    });
    const bytes = [
      { assetId: 'source', role: 'source' as const, mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
      { assetId: 'reference-1', role: 'reference' as const, mimeType: 'image/jpeg', bytes: new Uint8Array([4, 5, 6]) },
      { assetId: 'reference-2', role: 'reference' as const, mimeType: 'image/png', bytes: new Uint8Array([7, 8, 9]) },
    ];
    const result = await provider.submit(input, { ...context, inputs: bytes });

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual(
      JSON.parse(fixture('edit-submit-request.json')),
    );
    expect(result).toEqual(JSON.parse(fixture('edit-expected-normalized.json')));
  });

  it('requires exactly one source and allows up to three references for edits', async () => {
    const provider = new XaiImagineImageProvider({ http: new FixtureClient(jsonResponse({ data: [] })) });
    const referenceOnly = request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      inputs: [{ assetId: 'reference-only', role: 'reference' }],
    });
    await expect(provider.validate(referenceOnly, context)).rejects.toThrow('exactly one source');

    const fourInputs = [
      { assetId: 'source', role: 'source' as const },
      { assetId: 'reference-1', role: 'reference' as const },
      { assetId: 'reference-2', role: 'reference' as const },
      { assetId: 'reference-3', role: 'reference' as const },
    ];
    await expect(provider.validate(request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      inputs: fourInputs,
    }), {
      ...context,
      inputs: fourInputs.map((input) => ({
        ...input,
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      })),
    })).resolves.toBeUndefined();
    await expect(provider.validate(request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      inputs: [...fourInputs, { assetId: 'reference-4', role: 'reference' as const }],
    }), context)).rejects.toThrow('at most three references');
  });

  it('exposes official model capabilities and rejects unsupported controls strictly', async () => {
    const provider = new XaiImagineImageProvider({ http: new FixtureClient(jsonResponse({ data: [] })) });
    const capabilities = await provider.getCapabilities(context);
    expect(capabilities).toMatchObject({
      providerType: 'xai-imagine-image-v1',
      models: expect.arrayContaining([
        expect.objectContaining({
          id: 'grok-imagine-image-2.0',
          capabilities: expect.objectContaining({
            operations: ['image.generate', 'image.edit'],
            maxReferenceImages: 3,
            maxBatchCount: 10,
            supportsMask: false,
          }),
        }),
      ]),
    });
    await expect(provider.validate(request({ negativePrompt: 'no text' }), context)).rejects.toThrow('negativePrompt');
    await expect(provider.validate(request({ extra: { unknown: true } }), context)).rejects.toThrow('extra');
    await expect(provider.validate(request({ aspectRatio: '5:7' }), context)).rejects.toThrow('aspect ratio');
    await expect(provider.validate(request({ count: 11 }), context)).rejects.toThrow('ten');
    await expect(provider.validate(request({ inputs: [{ assetId: 'reference', role: 'reference' }] }), context)).rejects.toThrow('reference');
    await expect(provider.validate(request({ operation: 'image.edit', inputs: [{ assetId: 'mask', role: 'mask' }] }), context)).rejects.toThrow('masks');
  });

  it('requires resolved input bytes and never falls back to an asset id', async () => {
    const client = new FixtureClient(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/out.png' }] }));
    const provider = new XaiImagineImageProvider({ http: client });
    const input = request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      inputs: [{ assetId: 'source', role: 'source' }],
    });
    await expect(provider.submit(input, context)).rejects.toThrow('not resolved');
    expect(client.requests).toHaveLength(0);
  });

  it('rejects ProviderInput URL bypasses and protects protocol headers', async () => {
    const client = new FixtureClient(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/out.png' }] }));
    const provider = new XaiImagineImageProvider({ http: client });
    const inputWithUrl = {
      assetId: 'source',
      role: 'source' as const,
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      url: 'https://private.example.invalid/source.png',
    } as unknown as XaiImagineImageInput;
    await expect(provider.submit(request({
      operation: 'image.edit',
      modelId: 'grok-imagine-image',
      inputs: [{ assetId: 'source', role: 'source' }],
    }), { ...context, inputs: [inputWithUrl] })).rejects.toThrow('not a URL');

    await expect(provider.submit(request(), {
      ...context,
      headers: {
        accept: 'text/plain',
        'Content-Type': 'text/plain',
        authorization: 'Bearer override',
        'idempotency-key': 'override',
      },
    } as XaiImagineProviderContext)).rejects.toThrow('invalid');
    expect(client.requests).toHaveLength(0);
  });

  it('normalizes rate limits, redacts credentials, and handles transport failures', async () => {
    const failed = new XaiImagineImageProvider({
      http: new FixtureClient({
        statusCode: 429,
        headers: { 'retry-after': '2' },
        json: { error: { message: 'rate limit for sk-super-secret-token' } },
      }),
    });
    let caught: unknown;
    try {
      await failed.submit(request(), context);
    } catch (error) {
      caught = error;
    }
    expect(failed.normalizeError(caught)).toMatchObject({
      code: 'xai_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 2_000,
      message: 'rate limit for [REDACTED]',
    });
    const provider = new XaiImagineImageProvider({ http: new FixtureClient(jsonResponse({ data: [] })) });
    expect(provider.normalizeError(new Error('socket closed'))).toMatchObject({
      code: 'xai_network_error',
      kind: 'transient',
      retryable: true,
    });
    expect(provider.normalizeError(new XaiImagineHttpError(400, { error: { message: 'bad request' } }))).toMatchObject({
      code: 'xai_http_400',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new XaiImagineResponseError('malformed response'))).toMatchObject({
      code: 'xai_invalid_response',
      retryable: false,
    });
  });

  it('bounds result count, result metadata strings, URLs, and rejects URL userinfo', () => {
    const image = { url: 'https://cdn.example.invalid/result.png' };
    expect(() => parseXaiImagineImageResponse({ data: Array.from({ length: 11 }, () => image) }))
      .toThrow('too many image results');
    expect(() => parseXaiImagineImageResponse({ data: [{ id: 'x'.repeat(257), ...image }] }))
      .toThrow('oversized id');
    expect(() => parseXaiImagineImageResponse({ data: [{ revised_prompt: 'x'.repeat(32_001), ...image }] }))
      .toThrow('oversized revised_prompt');
    expect(() => parseXaiImagineImageResponse({ data: [{ url: 'https://user:pass@cdn.example.invalid/result.png' }] }))
      .toThrow('cannot contain credentials');
    expect(() => parseXaiImagineImageResponse({ data: [{ url: `https://cdn.example.invalid/${'x'.repeat(8_200)}` }] }))
      .toThrow('oversized url');
  });

  it('preserves transport causes and maps abort/cancel failures as non-retryable', async () => {
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    const provider = new XaiImagineImageProvider({
      http: {
        async request(): Promise<XaiImagineHttpResponse> {
          throw abort;
        },
      },
    });
    let caught: unknown;
    try {
      await provider.submit(request(), context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XaiImagineTransportError);
    expect((caught as Error).cause).toBe(abort);
    expect(provider.normalizeError(caught)).toMatchObject({
      code: 'xai_request_aborted',
      kind: 'transient',
      retryable: false,
    });
    const canceled = new Error('cancelled');
    canceled.name = 'CanceledError';
    expect(provider.normalizeError(new XaiImagineTransportError('cancelled', { cause: canceled }))).toMatchObject({
      code: 'xai_request_aborted',
      retryable: false,
    });
  });

  it('rejects unparsed response streams instead of silently consuming them', async () => {
    const streamLike = {
      pipe: () => streamLike,
      [Symbol.asyncIterator]: async function* () {
        yield new Uint8Array();
      },
    };
    const provider = new XaiImagineImageProvider({
      http: new FixtureClient({ statusCode: 200, body: streamLike as unknown as Record<string, unknown> }),
    });
    await expect(provider.submit(request(), context)).rejects.toThrow('pre-parsed');
  });
});
