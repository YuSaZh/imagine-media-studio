import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';

import {
  assertGeminiGenerateContentPayload,
  buildGeminiGenerateContentPayload,
  buildGeminiGenerateContentUrl,
  GeminiHttpError,
  GeminiNativeImageProvider,
  GeminiResponseError,
  GeminiValidationError,
  normalizeGeminiImageResponse,
  type GeminiHttpRequest,
  type GeminiHttpResponse,
  type GeminiProviderContext,
} from './index.js';

const fixtureRoot = new URL(
  '../../../../../fixtures/providers/gemini/gemini-generate-content-image-v1/',
  import.meta.url,
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as unknown;
}

const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'gemini-provider',
    modelId: 'gemini-3.1-flash-image',
    prompt: 'A hand-painted red bicycle leaning against a white garden wall.',
    inputs: [{ assetId: 'reference-1', role: 'reference' }],
    aspectRatio: '16:9',
    resolution: '2K',
    seed: 7,
    ...overrides,
  };
}

function context(
  transport?: GeminiProviderContext['transport'],
  overrides: Partial<GeminiProviderContext> = {},
): GeminiProviderContext {
  return {
    providerId: 'gemini-provider',
    secrets: {
      apiKey: 'AIza-unit-test-secret-key-should-not-appear',
      'header:x-trace-id': 'trace-123',
    },
    inputs: [
      {
        assetId: 'reference-1',
        role: 'reference',
        mimeType: 'image/png',
        bytes: imageBytes,
      },
    ],
    ...(transport === undefined ? {} : { transport }),
    ...overrides,
  };
}

function fakeTransport(body: unknown, statusCode = 200, headers?: Readonly<Record<string, string>>): {
  requests: GeminiHttpRequest[];
  transport: { request(input: GeminiHttpRequest): Promise<GeminiHttpResponse> };
} {
  const requests: GeminiHttpRequest[] = [];
  return {
    requests,
    transport: {
      async request(input) {
        requests.push(input);
        return { statusCode, body, ...(headers === undefined ? {} : { headers }) };
      },
    },
  };
}

describe('GeminiNativeImageProvider', () => {
  it('declares native image generation/edit capabilities by model', async () => {
    const provider = new GeminiNativeImageProvider();
    const capabilities = await provider.getCapabilities({ providerId: 'gemini-provider', secrets: {} });

    expect(capabilities.providerType).toBe('gemini-generate-content-image-v1');
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'gemini-2.5-flash-image',
    ]);
    expect(capabilities.models[1]?.capabilities).toMatchObject({
      operations: ['image.generate', 'image.edit'],
      maxReferenceImages: 14,
      supportsMask: false,
      supportsNegativePrompt: false,
      supportsSeed: true,
    });
  });

  it('builds the documented generateContent payload and uses only injected HTTP', async () => {
    const expectedPayload = fixture('submit-request.json');
    const response = fixture('submit-response.json');
    const fake = fakeTransport(response);
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Real network access is forbidden in Gemini generateContent tests.'));

    const result = await provider.submit(request(), context());

    expect(JSON.parse(fake.requests[0]?.body ?? '{}')).toEqual(expectedPayload);
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-goog-api-key': 'AIza-unit-test-secret-key-should-not-appear',
        'x-trace-id': 'trace-123',
      },
    });
    expect(result).toEqual({ state: 'completed', assets: fixture('expected-normalized.json') });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('supports context base URL and custom headers without putting the API key in the URL', async () => {
    const fake = fakeTransport(fixture('submit-response.json'));
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });

    await provider.submit(
      request({ inputs: [] }),
      context(undefined, {
        baseUrl: 'https://proxy.example.test/gemini/v1beta',
        headers: { 'x-client-label': 'image-studio' },
        inputs: [],
      }),
    );

    expect(fake.requests[0]?.url).toBe(
      'https://proxy.example.test/gemini/v1beta/models/gemini-3.1-flash-image:generateContent',
    );
    expect(fake.requests[0]?.url).not.toContain('AIza');
    expect(fake.requests[0]?.headers).toMatchObject({ 'x-client-label': 'image-studio' });
  });

  it('tests the official models endpoint with an injected GET and no media request', async () => {
    const fake = fakeTransport(fixture('connection-success.json'));
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    await provider.testConnection(context(undefined, {
      baseUrl: 'https://proxy.example.test/gemini/v1beta',
    }));

    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/v1beta/models',
      headers: { 'x-goog-api-key': 'AIza-unit-test-secret-key-should-not-appear' },
    });
    expect(fake.requests[0]).not.toHaveProperty('body');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refreshes a live model catalog, filters non-image methods, and keeps unknown image models conservative', async () => {
    const fake = fakeTransport(fixture('models-response.json'));
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    const capabilities = await provider.getLiveCapabilities(context(fake.transport));

    expect(fake.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
    });
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gemini-3.1-flash-image',
      'gemini-custom-image-preview',
    ]);
    expect(capabilities.models[0]?.capabilities.maxReferenceImages).toBe(14);
    expect(capabilities.models[1]?.capabilities.maxReferenceImages).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects protected custom headers and de-duplicates ordinary names case-insensitively', async () => {
    const names = [
      'Accept', 'CONTENT-TYPE', 'Authorization', 'Idempotency-Key', 'Connection', 'Keep-Alive',
      'Proxy-Connection', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade', 'X-Goog-Api-Key',
    ];
    for (const name of names) {
      const fake = fakeTransport(fixture('connection-success.json'));
      const provider = new GeminiNativeImageProvider({ transport: fake.transport });
      await expect(provider.testConnection(context(fake.transport, { headers: { [name]: 'override' } })))
        .rejects.toMatchObject({ code: 'gemini_header_invalid' });
    }

    const fake = fakeTransport(fixture('connection-success.json'));
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    await provider.testConnection(context(fake.transport, { headers: { 'X-Trace-ID': 'context-value' } }));
    const headerEntries = Object.entries(fake.requests[0]?.headers ?? {})
      .filter(([name]) => name.toLowerCase() === 'x-trace-id');
    expect(headerEntries).toEqual([['x-trace-id', 'trace-123']]);
  });

  it('normalizes injected models authentication failures and keeps the API key out of errors', async () => {
    const fake = fakeTransport(fixture('connection-unauthorized.json'), 401);
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    let error: unknown;
    try {
      await provider.testConnection(context());
    } catch (caught) {
      error = caught;
    }

    expect(provider.normalizeError(error)).toMatchObject({
      code: 'gemini_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(error)).not.toContain('AIza-unit-test-secret-key-should-not-appear');
  });

  it('replaces the model in a complete generateContent endpoint and rejects an incomplete endpoint', () => {
    expect(buildGeminiGenerateContentUrl(
      'https://proxy.example.test/v1beta/models/wrong-model:generateContent',
      'gemini-3.1-flash-image',
    )).toBe('https://proxy.example.test/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(() => buildGeminiGenerateContentUrl(
      'https://proxy.example.test/v1beta/foo:generateContent',
      'gemini-3.1-flash-image',
    )).toThrow();
  });

  it('maps edit source and multiple references to ordered inlineData parts', () => {
    const editRequest = request({
      operation: 'image.edit',
      prompt: 'Place the second reference on the source image.',
      inputs: [
        { assetId: 'source-1', role: 'source' },
        { assetId: 'reference-1', role: 'reference' },
        { assetId: 'reference-2', role: 'reference' },
      ],
    });
    const editContext = context(undefined, {
      inputs: [
        { assetId: 'source-1', role: 'source', mimeType: 'image/jpeg', bytes: imageBytes },
        { assetId: 'reference-1', role: 'reference', mimeType: 'image/png', bytes: imageBytes },
        { assetId: 'reference-2', role: 'reference', mimeType: 'image/webp', bytes: imageBytes },
      ],
    });

    const payload = buildGeminiGenerateContentPayload(editRequest, editContext);
    expect(payload.contents[0].parts).toHaveLength(4);
    expect(payload.contents[0].parts.slice(1).map((part) => Object.keys(part))).toEqual([
      ['inlineData'],
      ['inlineData'],
      ['inlineData'],
    ]);
  });

  it('rejects unsupported options, unresolved inputs, masks, and non-image payload fields', async () => {
    const provider = new GeminiNativeImageProvider();
    await expect(provider.validate(request({ negativePrompt: 'no blur' }), context())).rejects.toMatchObject({
      code: 'gemini_option_unsupported',
    });
    await expect(provider.validate(request({ inputs: [{ assetId: 'missing', role: 'reference' }] }), context())).rejects.toMatchObject({
      code: 'gemini_input_unresolved',
    });
    await expect(provider.validate(request({ operation: 'image.edit' }), context())).rejects.toMatchObject({
      code: 'gemini_edit_inputs_invalid',
    });
    await expect(
      provider.validate(
        request({ inputs: [{ assetId: 'mask', role: 'mask' }] }),
        context(),
      ),
    ).rejects.toMatchObject({ code: 'gemini_input_role_unsupported' });
    await expect(provider.submit(request(), context(undefined, { secrets: { apiKey: 'bad\nkey' } }))).rejects.toMatchObject({
      code: 'gemini_header_invalid',
    });
    expect(() => assertGeminiGenerateContentPayload({
      contents: [{ role: 'user', parts: [{ text: 'prompt' }] }],
      generationConfig: { responseModalities: ['IMAGE'], unknown: true },
    })).toThrow(GeminiValidationError);
  });

  it('normalizes inlineData and fileData resources while removing secret query parameters', () => {
    const inline = normalizeGeminiImageResponse(fixture('submit-response.json'));
    const file = normalizeGeminiImageResponse(fixture('poll-completed.json'));
    const expected = fixture('expected-normalized.json') as readonly unknown[];

    expect(inline[0]).toEqual(expected[0]);
    expect(file).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        source: 'url',
        url: 'https://generativelanguage.googleapis.com/v1beta/files/generated-image?download=1',
      },
    ]);
    expect(() => normalizeGeminiImageResponse({
      candidates: [{ content: { parts: [{ fileData: {
        mimeType: 'image/png',
        fileUri: 'https://user:pass@generativelanguage.googleapis.com/v1beta/files/image',
      } }] } }],
    })).toThrow();
  });

  it('rejects more output images than the single-candidate profile allows', async () => {
    const imageBase64 = (fixture('expected-normalized.json') as Array<{ base64: string }>)[0]?.base64 ?? 'AQ==';
    const body = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: imageBase64 } }] } },
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }] } },
      ],
    };
    const fake = fakeTransport(body);
    const provider = new GeminiNativeImageProvider({ transport: fake.transport });
    await expect(provider.submit(request({ inputs: [] }), context(fake.transport, { inputs: [] })))
      .rejects.toMatchObject({ code: 'gemini_output_limit_exceeded' });
  });

  it('maps provider failures to retryable/rejected errors without leaking credentials', () => {
    const provider = new GeminiNativeImageProvider();
    const rateLimited = provider.normalizeError(
      new GeminiHttpError('quota key=AIza-unit-test-secret-key-should-not-appear', 429, 'RESOURCE_EXHAUSTED', 2_000),
    );
    expect(rateLimited).toMatchObject({
      code: 'gemini_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    });
    expect(rateLimited.message).not.toContain('AIza-unit-test');
    expect(provider.normalizeError(new GeminiResponseError('blocked', 'gemini_content_blocked'))).toMatchObject({
      code: 'gemini_content_blocked',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new GeminiHttpError(
      'upstream fetch https://example.test/image?key=fixture-secret&download=1',
      500,
    )).message).not.toContain('fixture-secret');
  });

  it('preserves retry semantics when non-2xx responses are empty or plain text', async () => {
    const rateLimited = fakeTransport('', 429, { 'retry-after': '999999' });
    const provider = new GeminiNativeImageProvider({ transport: rateLimited.transport });
    let error: unknown;
    try {
      await provider.submit(request(), context(rateLimited.transport));
    } catch (caught) {
      error = caught;
    }
    expect(provider.normalizeError(error)).toMatchObject({
      code: 'gemini_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 86_400_000,
      statusCode: 429,
    });

    const upstream = fakeTransport('upstream unavailable', 503);
    const failed = new GeminiNativeImageProvider({ transport: upstream.transport });
    let upstreamError: unknown;
    try {
      await failed.submit(request(), context(upstream.transport));
    } catch (caught) {
      upstreamError = caught;
    }
    expect(failed.normalizeError(upstreamError)).toMatchObject({
      kind: 'transient',
      retryable: true,
      statusCode: 503,
      message: 'upstream unavailable',
    });
  });

  it('rejects malformed image responses instead of returning text as an asset', async () => {
    expect(() => normalizeGeminiImageResponse({
      candidates: [{ content: { parts: [{ text: 'only text' }] }, finishReason: 'STOP' }],
    })).toThrow(GeminiResponseError);
    expect(() => normalizeGeminiImageResponse(fixture('poll-failed.json'))).toThrow(GeminiResponseError);
    expect(fixture('poll-not-applicable.json')).toMatchObject({ applicable: false });
    await expect(new GeminiNativeImageProvider().poll('synchronous', context())).rejects.toMatchObject({
      code: 'gemini_poll_unsupported',
    });
  });
});
