import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';

import {
  assertInteractionsPayload,
  GeminiHttpError,
  GeminiInteractionsImageProvider,
  normalizeGeminiInteractionsImageResponse,
  type GeminiHttpRequest,
  type GeminiHttpResponse,
  type GeminiProviderContext,
} from './index.js';

const fixtureRoot = new URL(
  '../../../../../fixtures/providers/gemini/gemini-interactions-image-v1/',
  import.meta.url,
);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as unknown;
}

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'gemini-interactions',
    modelId: 'gemini-3.1-flash-image',
    prompt: 'Create a polished product scene combining the two reference images.',
    inputs: [
      { assetId: 'ref-1', role: 'reference' },
      { assetId: 'ref-2', role: 'reference' },
    ],
    aspectRatio: '16:9',
    resolution: '2K',
    ...overrides,
  };
}

function context(
  transport: NonNullable<GeminiProviderContext['transport']>,
  overrides: Partial<GeminiProviderContext> = {},
): GeminiProviderContext {
  return {
    providerId: 'gemini-interactions',
    secrets: {
      apiKey: 'AIza-interactions-fixture-secret',
      'header:x-trace-id': 'interaction-test',
    },
    inputs: [
      { assetId: 'ref-1', role: 'reference', mimeType: 'image/png', bytes },
      { assetId: 'ref-2', role: 'reference', mimeType: 'image/jpeg', bytes },
    ],
    transport,
    ...overrides,
  } as GeminiProviderContext;
}

function fixtureTransport(body: unknown, statusCode = 200, headers?: Readonly<Record<string, string>>): {
  requests: GeminiHttpRequest[];
  request(input: GeminiHttpRequest): Promise<GeminiHttpResponse>;
} {
  const requests: GeminiHttpRequest[] = [];
  return {
    requests,
    async request(input) {
      requests.push(input);
      return { statusCode, body, ...(headers === undefined ? {} : { headers }) };
    },
  };
}

describe('GeminiInteractionsImageProvider', () => {
  it('constructs the official Interactions image payload and normalizes output_image', async () => {
    const transport = fixtureTransport(fixture('submit-response.json'));
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Real network access is forbidden in Gemini Interactions tests.'));

    const result = await provider.submit(request(), context(transport));

    expect(JSON.parse(transport.requests[0]?.body ?? '{}')).toEqual(fixture('submit-request.json'));
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1/interactions',
      headers: {
        'x-goog-api-key': 'AIza-interactions-fixture-secret',
        'x-trace-id': 'interaction-test',
      },
    });
    expect(result).toEqual({ state: 'completed', assets: fixture('expected-normalized.json') });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('tests the Interactions account endpoint through an injected GET', async () => {
    const transport = fixtureTransport(fixture('connection-success.json'));
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    await provider.testConnection(context(transport, {
      baseUrl: 'https://proxy.example.test/gemini/v1beta',
    }));

    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/gemini/v1beta/models',
      headers: { 'x-goog-api-key': 'AIza-interactions-fixture-secret' },
    });
    expect(transport.requests[0]).not.toHaveProperty('body');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refreshes the live models endpoint and keeps only image-capable models', async () => {
    const transport = fixtureTransport(fixture('models-response.json'));
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    const capabilities = await provider.getLiveCapabilities(context(transport));

    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://generativelanguage.googleapis.com/v1/models',
    });
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gemini-3.1-flash-image',
      'gemini-custom-image-preview',
    ]);
    expect(capabilities.models[0]?.capabilities.maxReferenceImages).toBe(14);
    expect(capabilities.models[1]?.capabilities.maxReferenceImages).toBe(3);
    expect(capabilities.models[0]?.capabilities.supportsSeed).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects protected custom headers and de-duplicates ordinary names case-insensitively', async () => {
    const names = [
      'Accept', 'CONTENT-TYPE', 'Authorization', 'Idempotency-Key', 'Connection', 'Keep-Alive',
      'Proxy-Connection', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade', 'X-Goog-Api-Key',
    ];
    for (const name of names) {
      const transport = fixtureTransport(fixture('connection-success.json'));
      const provider = new GeminiInteractionsImageProvider({ http: transport });
      await expect(provider.testConnection(context(transport, { headers: { [name]: 'override' } })))
        .rejects.toMatchObject({ code: 'gemini_header_invalid' });
    }

    const transport = fixtureTransport(fixture('connection-success.json'));
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    await provider.testConnection(context(transport, { headers: { 'X-Trace-ID': 'context-value' } }));
    const headerEntries = Object.entries(transport.requests[0]?.headers ?? {})
      .filter(([name]) => name.toLowerCase() === 'x-trace-id');
    expect(headerEntries).toEqual([['x-trace-id', 'interaction-test']]);
  });

  it('normalizes Interactions authentication failures without exposing the API key', async () => {
    const transport = fixtureTransport(fixture('connection-unauthorized.json'), 403);
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    let error: unknown;
    try {
      await provider.testConnection(context(transport));
    } catch (caught) {
      error = caught;
    }

    expect(provider.normalizeError(error)).toMatchObject({
      code: 'gemini_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 403,
    });
    expect(JSON.stringify(error)).not.toContain('AIza-interactions-fixture-secret');
  });

  it('supports source edits and previous-interaction multi-turn edits', async () => {
    const transport = fixtureTransport(fixture('submit-response.json'));
    const provider = new GeminiInteractionsImageProvider({ http: transport });
    const edit = request({
      operation: 'image.edit',
      inputs: [{ assetId: 'ref-1', role: 'source' }, { assetId: 'ref-2', role: 'reference' }],
    });
    await provider.validate(edit, context(transport, {
      inputs: [
        { assetId: 'ref-1', role: 'source', mimeType: 'image/png', bytes },
        { assetId: 'ref-2', role: 'reference', mimeType: 'image/jpeg', bytes },
      ],
    }));
    const previous = request({
      operation: 'image.edit',
      inputs: [],
      extra: { previous_interaction_id: 'interaction-fixture-0' },
    });
    await provider.validate(previous, context(transport, { inputs: [] }));
    await provider.submit(previous, context(transport, { inputs: [] }));
    const payload = JSON.parse(transport.requests.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      input: previous.prompt,
      previous_interaction_id: 'interaction-fixture-0',
    });
  });

  it('keeps model-specific reference limits and rejects unsupported payload fields', async () => {
    const provider = new GeminiInteractionsImageProvider();
    const capabilities = await provider.getCapabilities({ providerId: 'gemini-interactions', secrets: {} });
    expect(capabilities.models.find((model) => model.id === 'gemini-2.5-flash-image')?.capabilities.maxReferenceImages).toBe(3);
    expect(capabilities.models.find((model) => model.id === 'gemini-3.1-flash-image')?.capabilities.maxReferenceImages).toBe(14);
    expect(() => assertInteractionsPayload({
      model: 'gemini-3.1-flash-image',
      input: 'prompt',
      response_format: { type: 'image' },
      unknown: true,
    })).toThrow();
    await expect(provider.validate(request({ extra: { unknown: true } }), context(fixtureTransport({}))))
      .rejects.toMatchObject({ code: 'gemini_extra_fields_unsupported' });
  });

  it('preserves retry semantics for empty/plain HTTP failures and caps Retry-After', async () => {
    const empty429 = fixtureTransport('', 429, { 'retry-after': '999999' });
    const provider = new GeminiInteractionsImageProvider({ http: empty429 });
    let error: unknown;
    try {
      await provider.submit(request(), context(empty429));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(provider.normalizeError(error)).toMatchObject({
      code: 'gemini_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 86_400_000,
      statusCode: 429,
    });

    const plain500 = fixtureTransport('upstream unavailable', 500);
    const failed = new GeminiInteractionsImageProvider({ http: plain500 });
    let upstreamError: unknown;
    try {
      await failed.submit(request(), context(plain500));
    } catch (caught) {
      upstreamError = caught;
    }
    expect(failed.normalizeError(upstreamError)).toMatchObject({
      kind: 'transient',
      retryable: true,
      statusCode: 500,
      message: 'upstream unavailable',
    });
  });

  it('normalizes step output and rejects unsafe file resources', async () => {
    expect(normalizeGeminiInteractionsImageResponse(fixture('poll-completed.json'))).toMatchObject([
      { type: 'image', mimeType: 'image/webp', source: 'base64' },
    ]);
    expect(() => normalizeGeminiInteractionsImageResponse({
      output_image: { type: 'image', uri: 'https://user:pass@generativelanguage.googleapis.com/v1beta/files/image' },
    })).toThrow();
    expect(() => normalizeGeminiInteractionsImageResponse(fixture('poll-failed.json'))).toThrow();
    expect(fixture('poll-not-applicable.json')).toMatchObject({ applicable: false });
    await expect(new GeminiInteractionsImageProvider().poll('synchronous', context(fixtureTransport({}))))
      .rejects.toMatchObject({ code: 'gemini_poll_unsupported' });
  });

  it('bounds interaction result metadata and rejects multiple output images', () => {
    const image = (fixture('expected-normalized.json') as Array<{ base64: string }>)[0]?.base64 ?? 'AQ==';
    expect(() => normalizeGeminiInteractionsImageResponse({
      id: 'x'.repeat(257),
      output_image: { type: 'image', mime_type: 'image/png', data: image },
    })).toThrow(expect.objectContaining({ code: 'gemini_output_metadata_invalid' }));
    expect(() => normalizeGeminiInteractionsImageResponse({
      output: [
        { type: 'image', mime_type: 'image/png', data: image },
        { type: 'image', mime_type: 'image/png', data: 'AQ==' },
      ],
    })).toThrow(expect.objectContaining({ code: 'gemini_output_limit_exceeded' }));
  });
});
