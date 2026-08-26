import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GenerationRequest } from '@imagine/shared';
import type { AssetRecord } from '../../database/assets.js';
import { describe, expect, it, vi } from 'vitest';

import { ProviderInputLoader } from '../provider-input-loader.js';
import { ProviderHttpError } from '../provider-http-client.js';
import { UnsafeRemoteUrlError } from '../../security/network-policy.js';

import {
  OpenAiHttpError,
  OpenAiImagesProvider,
  OpenAiResponsesImageProvider,
  OpenAiTransportError,
  OpenAiVideosProvider,
  assertImageGenerationPayload,
  normalizeImageResponse,
  parseOpenAiImageStream,
  parseSseChunk,
  type OpenAiHttpRequest,
  type OpenAiHttpResponse,
  type OpenAiHttpTransport,
  type OpenAiProviderContext,
} from './index.js';

const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const context: OpenAiProviderContext = { providerId: 'openai', secrets: { apiKey: 'sk-test-only' } };

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'openai',
    modelId: 'gpt-image-1',
    prompt: 'A small red kite over a quiet lake',
    inputs: [],
    ...overrides,
  };
}

class FixtureTransport implements OpenAiHttpTransport {
  public readonly requests: OpenAiHttpRequest[] = [];
  public constructor(private readonly response: OpenAiHttpResponse) {}

  public async request(input: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    this.requests.push(input);
    return this.response;
  }
}

class SequenceTransport implements OpenAiHttpTransport {
  public readonly requests: OpenAiHttpRequest[] = [];
  private index = 0;

  public constructor(private readonly responses: readonly OpenAiHttpResponse[]) {}

  public async request(input: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
    this.requests.push(input);
    const response = this.responses[Math.min(this.index++, this.responses.length - 1)];
    if (!response) throw new Error('Missing fixture response.');
    return response;
  }
}

function jsonResponse(value: unknown, statusCode = 200): OpenAiHttpResponse {
  return { statusCode, json: value };
}

function sseResponse(body: string, dispose = vi.fn()): OpenAiHttpResponse {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body,
    dispose,
  };
}

function storedAsset(
  id: string,
  bytes: Buffer,
  overrides: Partial<AssetRecord> = {},
): AssetRecord {
  return {
    id,
    jobId: null,
    parentAssetId: null,
    type: 'image',
    role: 'upload',
    filePath: `media/${id}.png`,
    thumbnailPath: null,
    posterPath: null,
    originalFilename: `${id}.png`,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    durationMs: null,
    fileSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata: {},
    favorite: false,
    createdAt: new Date(0),
    deletedAt: null,
    ...overrides,
  };
}

describe('OpenAI provider profiles', () => {
  it('constructs the official Images generation JSON payload and normalizes base64 output', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ b64_json: IMAGE_BASE64 }] }));
    const provider = new OpenAiImagesProvider({ http: transport });
    const input = request({
      count: 1,
      aspectRatio: '1:1',
      quality: 'medium',
      format: 'png',
    });

    await provider.validate(input, context);
    const result = await provider.submit(input, context);

    expect(JSON.parse(String(transport.requests[0]?.body))).toEqual(
      JSON.parse(readFileSync(new URL('../../../../../fixtures/providers/openai/openai-images-v1/submit-request.json', import.meta.url), 'utf8')),
    );
    expect(result).toEqual(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-images-v1/expected-normalized.json', import.meta.url),
      'utf8',
    )));
    expect(transport.requests[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(transport.requests[0]?.headers.Authorization).toBe('Bearer sk-test-only');
  });

  it('splits current GPT Image model capabilities and sends flexible GPT Image 2 sizes without response_format', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ b64_json: IMAGE_BASE64 }] }));
    const provider = new OpenAiImagesProvider({ http: transport });
    const capabilities = await provider.getCapabilities(context);
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-1',
      'gpt-image-1-mini',
    ]);
    expect(capabilities.models[0]?.capabilities).toMatchObject({
      resolutions: expect.arrayContaining(['2048x2048', '3840x2160']),
      aspectRatios: expect.not.arrayContaining(['4:3', '3:4']),
    });
    expect(capabilities.models[0]?.capabilities.customFields).not.toMatchObject({
      properties: { input_fidelity: expect.anything() },
    });
    expect(capabilities.models[1]?.capabilities.customFields).toMatchObject({
      properties: { input_fidelity: { enum: ['low', 'high'] } },
    });

    await expect(provider.validate(request({ modelId: 'gpt-image-2', extra: { input_fidelity: 'high' } }), context)).rejects.toThrow('input_fidelity');
    await expect(provider.validate(request({ modelId: 'gpt-image-1.5', extra: { input_fidelity: 'high' } }), context)).resolves.toBeUndefined();
    await expect(provider.validate(request({ modelId: 'dall-e-3' }), context)).rejects.toMatchObject({ code: 'openai_model_not_supported' });

    await provider.submit(request({
      modelId: 'gpt-image-2',
      width: 2048,
      height: 1152,
      format: 'webp',
    }), context);
    const payload = JSON.parse(String(transport.requests[0]?.body)) as Record<string, unknown>;
    expect(payload).toEqual(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-images-v1/gpt-image-2-flexible-request.json', import.meta.url),
      'utf8',
    )));
    expect(payload).not.toHaveProperty('response_format');
  });

  it('refreshes an injected OpenAI-compatible catalog and assigns conservative unknown capabilities', async () => {
    const transport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-images-v1/models-response.json', import.meta.url),
      'utf8',
    ))));
    const provider = new OpenAiImagesProvider({ http: transport });

    const capabilities = await provider.getLiveCapabilities({
      ...context,
      baseUrl: 'https://proxy.example.test/openai/v1',
    });

    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/openai/v1/models',
      headers: { Authorization: 'Bearer sk-test-only', Accept: 'application/json' },
    });
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gpt-image-2',
      'gpt-image-1.5',
      'gpt-image-compatible-preview',
    ]);
    expect(capabilities.models[0]?.capabilities.resolutions).toEqual(expect.arrayContaining(['3840x2160']));
    expect(capabilities.models[0]?.capabilities.supportsMask).toBe(true);
    expect(capabilities.models[2]?.displayName).toBe('Compatible Image Preview');
    expect(capabilities.models[2]?.capabilities).toMatchObject({
      aspectRatios: ['1:1'],
      resolutions: ['auto', '1024x1024'],
      maxReferenceImages: 1,
      supportsMask: false,
      supportsBatchCount: false,
      maxBatchCount: 1,
    });
    expect(capabilities.models[2]?.capabilities.customFields).toEqual({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('keeps profile defaults when live catalog HTTP is not configured', async () => {
    const provider = new OpenAiResponsesImageProvider();
    await expect(provider.getLiveCapabilities(context)).resolves.toEqual(
      await provider.getCapabilities(context),
    );
  });

  it('tests the configured endpoint with an injected GET without generating media', async () => {
    const transport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-images-v1/connection-success.json', import.meta.url),
      'utf8',
    ))));
    const provider = new OpenAiImagesProvider({ http: transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    await provider.testConnection({
      ...context,
      baseUrl: 'https://proxy.example.test/openai/v1',
    });

    expect(transport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/openai/v1/models',
      headers: { Authorization: 'Bearer sk-test-only' },
    });
    expect(transport.requests[0]).not.toHaveProperty('body');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('normalizes injected connection authentication failures without leaking the key', async () => {
    const transport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-images-v1/connection-unauthorized.json', import.meta.url),
      'utf8',
    )), 401));
    const provider = new OpenAiImagesProvider({ http: transport });
    let error: unknown;
    try {
      await provider.testConnection(context);
    } catch (caught) {
      error = caught;
    }

    expect(provider.normalizeError(error)).toMatchObject({
      code: 'openai_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(error)).not.toContain('sk-test-only');
  });

  it('tests the Responses models endpoint and normalizes authentication failures', async () => {
    const successTransport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/connection-success.json', import.meta.url),
      'utf8',
    ))));
    const provider = new OpenAiResponsesImageProvider({ http: successTransport });

    await provider.testConnection({
      ...context,
      baseUrl: 'https://proxy.example.test/openai/v1',
    });
    expect(successTransport.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://proxy.example.test/openai/v1/models',
      headers: { Authorization: 'Bearer sk-test-only' },
    });

    const failureTransport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/connection-unauthorized.json', import.meta.url),
      'utf8',
    )), 401));
    const failed = new OpenAiResponsesImageProvider({ http: failureTransport });
    await expect(failed.testConnection(context)).rejects.toBeInstanceOf(OpenAiHttpError);
    let error: unknown;
    try {
      await failed.testConnection(context);
    } catch (caught) {
      error = caught;
    }
    expect(failed.normalizeError(error)).toMatchObject({
      code: 'openai_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(error)).not.toContain('sk-test-only');
  });

  it('refreshes the Responses image catalog and filters non-image models', async () => {
    const transport = new FixtureTransport(jsonResponse(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/models-response.json', import.meta.url),
      'utf8',
    ))));
    const provider = new OpenAiResponsesImageProvider({ http: transport });

    const capabilities = await provider.getLiveCapabilities({
      ...context,
      baseUrl: 'https://compatible.example.test/v1',
    });

    expect(transport.requests[0]?.url).toBe('https://compatible.example.test/v1/models');
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'gpt-5.6',
      'gpt-image-compatible-preview',
    ]);
    expect(capabilities.models[0]?.capabilities.maxReferenceImages).toBe(4);
    expect(capabilities.models[1]?.capabilities).toMatchObject({
      aspectRatios: ['1:1'],
      resolutions: ['auto', '1024x1024'],
      maxReferenceImages: 1,
      supportsMask: false,
      supportsBatchCount: false,
    });
  });

  it('uses multipart Images edits for a source, references, and mask', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/out.png' }] }));
    const provider = new OpenAiImagesProvider({ http: transport });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const input = request({
      operation: 'image.edit',
      inputs: [
        { assetId: 'source', role: 'source' },
        { assetId: 'reference', role: 'reference' },
        { assetId: 'mask', role: 'mask' },
      ],
    });

    const result = await provider.submit({ ...input }, {
      ...context,
      inputs: [
        { assetId: 'source', role: 'source', mimeType: 'image/png', bytes, filename: 'source.png' },
        { assetId: 'reference', role: 'reference', mimeType: 'image/jpeg', bytes, filename: 'reference.jpg' },
        { assetId: 'mask', role: 'mask', mimeType: 'image/png', bytes, filename: 'mask.png' },
      ],
    });

    const submitted = transport.requests[0]!;
    expect(submitted.url).toBe('https://api.openai.com/v1/images/edits');
    expect(submitted.headers['Content-Type']).toContain('multipart/form-data; boundary=');
    const body = String(submitted.body);
    expect(body).toContain('name="image[]"; filename="source.png"');
    expect(body).toContain('name="image[]"; filename="reference.jpg"');
    expect(body).toContain('name="mask"; filename="mask.png"');
    expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'url', url: 'https://cdn.example.invalid/out.png' }] });
  });

  it('passes ProviderInputLoader source/mask metadata into the Images multipart submit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagine-openai-mask-'));
    try {
      await mkdir(join(root, 'media'), { recursive: true });
      const sourceBytes = Buffer.from(IMAGE_BASE64, 'base64');
      const maskBytes = Buffer.from(IMAGE_BASE64, 'base64');
      await writeFile(join(root, 'media', 'source.png'), sourceBytes);
      await writeFile(join(root, 'media', 'mask.png'), maskBytes);
      const source = storedAsset('source', sourceBytes);
      const mask = storedAsset('mask', maskBytes, {
        role: 'mask',
        parentAssetId: source.id,
      });
      const records = new Map([source, mask].map((asset) => [asset.id, asset]));
      const loader = new ProviderInputLoader({
        assets: { get: (assetId) => records.get(assetId) ?? null },
        dataRoot: root,
        maxBytesPerFile: 1024 * 1024,
        maxTotalBytes: 2 * 1024 * 1024,
      });
      const edit = request({
        operation: 'image.edit',
        inputs: [
          { assetId: source.id, role: 'source' },
          { assetId: mask.id, role: 'mask' },
        ],
      });
      const inputs = await loader.load(edit);
      expect(inputs[1]).toMatchObject({
        assetId: mask.id,
        parentAssetId: source.id,
        width: 1,
        height: 1,
        fileSize: maskBytes.byteLength,
        sha256: createHash('sha256').update(maskBytes).digest('hex'),
      });

      const transport = new FixtureTransport(jsonResponse({ data: [{ url: 'https://cdn.example.invalid/mask-edit.png' }] }));
      const provider = new OpenAiImagesProvider({ http: transport });
      const result = await provider.submit(edit, { ...context, inputs });
      const submitted = transport.requests[0]!;
      expect(submitted.bodyBytes).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(submitted.bodyBytes ?? []).includes(maskBytes)).toBe(true);
      expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'url' }] });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('requires source-first edits and validates mask parent, dimensions, and format', async () => {
    const provider = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse({ data: [] })) });
    await expect(provider.validate(request({
      operation: 'image.edit',
      inputs: [
        { assetId: 'reference', role: 'reference' },
        { assetId: 'source', role: 'source' },
      ],
    }), context)).rejects.toMatchObject({ code: 'openai_source_input_order' });

    const edit = request({
      operation: 'image.edit',
      inputs: [
        { assetId: 'source', role: 'source' },
        { assetId: 'mask', role: 'mask' },
      ],
    });
    await expect(provider.submit(edit, {
      ...context,
      inputs: [
        { assetId: 'source', role: 'source', mimeType: 'image/png', bytes: new Uint8Array([1]), width: 10, height: 10 },
        { assetId: 'mask', role: 'mask', mimeType: 'image/jpeg', bytes: new Uint8Array([1]), width: 10, height: 10 },
      ],
    })).rejects.toMatchObject({ code: 'openai_mask_type_invalid' });

    await expect(provider.submit(edit, {
      ...context,
      inputs: [
        { assetId: 'source', role: 'source', mimeType: 'image/png', bytes: new Uint8Array([1]), width: 10, height: 10 },
        { assetId: 'mask', role: 'mask', mimeType: 'image/png', bytes: new Uint8Array([1]), width: 9, height: 10 },
      ],
    })).rejects.toMatchObject({ code: 'openai_mask_dimensions_mismatch' });

    await expect(provider.validate(edit, {
      ...context,
      inputs: [
        { assetId: 'source', role: 'source', mimeType: 'image/png', bytes: new Uint8Array([1]), width: 10, height: 10 },
        { assetId: 'mask', role: 'mask', mimeType: 'image/png', bytes: new Uint8Array([1]), parentAssetId: null, width: 10, height: 10 },
      ],
    })).resolves.toBeUndefined();
  });

  it('constructs Responses image_generation input content for references', async () => {
    const transport = new FixtureTransport(jsonResponse({
      output: [{ type: 'image_generation_call', id: 'ig_fixture_1', result: IMAGE_BASE64 }],
    }));
    const provider = new OpenAiResponsesImageProvider({ http: transport });
    const input = request({
      modelId: 'gpt-5.6',
      inputs: [{ assetId: 'ref', role: 'reference' }],
    });

    const result = await provider.submit({ ...input }, {
      ...context,
      inputs: [{ assetId: 'ref', role: 'reference', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    });

    const payload = JSON.parse(String(transport.requests[0]?.body)) as Record<string, unknown>;
    expect(payload.tools).toEqual([{ type: 'image_generation' }]);
    expect(payload.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: input.prompt },
        { type: 'input_image', image_url: 'data:image/png;base64,AQID' },
      ],
    }]);
    expect(result).toEqual(JSON.parse(readFileSync(
      new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/expected-normalized.json', import.meta.url),
      'utf8',
    )));
    const capabilities = await provider.getCapabilities(context);
    expect(capabilities.models[0]?.capabilities).toMatchObject({ supportsMask: false });
  });

  it('submits the Images SSE fixture through the adapter and disposes the response', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport(sseResponse(
      readFileSync(new URL('../../../../../fixtures/providers/openai/openai-images-v1/stream.sse', import.meta.url), 'utf8'),
      dispose,
    ));
    const provider = new OpenAiImagesProvider({ http: transport });

    const result = await provider.submit(request({ extra: { stream: true } }), context);

    expect(result).toMatchObject({
      state: 'completed',
      assets: [{ source: 'url', url: 'https://cdn.example.invalid/image.png', mimeType: 'image/png' }],
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('submits an Images edit through the SSE branch and keeps multipart bytes binary', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport(sseResponse(
      readFileSync(new URL('../../../../../fixtures/providers/openai/openai-images-v1/stream.sse', import.meta.url), 'utf8'),
      dispose,
    ));
    const provider = new OpenAiImagesProvider({ http: transport });
    const edit = request({
      operation: 'image.edit',
      inputs: [{ assetId: 'source', role: 'source' }],
      extra: { stream: true },
    });

    const result = await provider.submit(edit, {
      ...context,
      inputs: [{
        assetId: 'source',
        role: 'source',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'source.png',
      }],
    });

    expect(transport.requests[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    expect(transport.requests[0]?.bodyBytes).toBeInstanceOf(Uint8Array);
    expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'url' }] });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('submits a partial Images SSE result with the requested output MIME', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport(sseResponse(
      `event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"${IMAGE_BASE64}"}\n\ndata: [DONE]\n\n`,
      dispose,
    ));
    const provider = new OpenAiImagesProvider({ http: transport });

    const result = await provider.submit(request({
      format: 'webp',
      extra: { partial_images: 1, stream: true },
    }), context);

    expect(result).toMatchObject({
      state: 'completed',
      assets: [{ source: 'base64', mimeType: 'image/webp', resultId: 'partial-0' }],
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('submits the Responses SSE fixture through the adapter and disposes the response', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport(sseResponse(
      readFileSync(new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/stream.sse', import.meta.url), 'utf8'),
      dispose,
    ));
    const provider = new OpenAiResponsesImageProvider({ http: transport });

    const result = await provider.submit(request({ modelId: 'gpt-5.6', extra: { stream: true } }), context);

    expect(result).toMatchObject({
      state: 'completed',
      assets: [{ resultId: 'ig_fixture_1', source: 'base64', mimeType: 'image/png' }],
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('submits a Responses image edit through the SSE branch', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport(sseResponse(
      readFileSync(new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/stream.sse', import.meta.url), 'utf8'),
      dispose,
    ));
    const provider = new OpenAiResponsesImageProvider({ http: transport });
    const edit = request({
      modelId: 'gpt-5.6',
      operation: 'image.edit',
      inputs: [{ assetId: 'source', role: 'source' }],
      extra: { stream: true },
    });

    const result = await provider.submit(edit, {
      ...context,
      inputs: [{
        assetId: 'source',
        role: 'source',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
      }],
    });

    const payload = JSON.parse(String(transport.requests[0]?.body)) as Record<string, unknown>;
    expect(payload.input).toMatchObject([{
      role: 'user',
      content: expect.arrayContaining([expect.objectContaining({ type: 'input_image' })]),
    }]);
    expect(result).toMatchObject({ state: 'completed', assets: [{ resultId: 'ig_fixture_1' }] });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects empty SSE results for both profiles and still disposes responses', async () => {
    const imagesDispose = vi.fn();
    const responsesDispose = vi.fn();
    const cases = [
      {
        provider: new OpenAiImagesProvider({ http: new FixtureTransport(sseResponse('data: [DONE]\n\n', imagesDispose)) }),
        dispose: imagesDispose,
        input: request({ extra: { stream: true } }),
      },
      {
        provider: new OpenAiResponsesImageProvider({ http: new FixtureTransport(sseResponse('data: [DONE]\n\n', responsesDispose)) }),
        dispose: responsesDispose,
        input: request({ modelId: 'gpt-5.6', extra: { stream: true } }),
      },
    ];
    for (const { provider, dispose, input } of cases) {
      await expect(provider.submit(input, context)).rejects.toMatchObject({ code: 'openai_invalid_response' });
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('accepts URL results and normalizes HTTP failures without leaking credentials', async () => {
    const transport = new FixtureTransport(jsonResponse({
      data: [{ url: 'https://cdn.example.invalid/result.webp', mime_type: 'image/webp' }],
    }));
    const provider = new OpenAiImagesProvider({ http: transport });
    const result = await provider.submit(request(), context);
    expect(result).toEqual({
      state: 'completed',
      assets: [{
        type: 'image',
        mimeType: 'image/webp',
        source: 'url',
        url: 'https://cdn.example.invalid/result.webp',
        resultId: 'image-0',
      }],
    });

    const failed = new OpenAiImagesProvider({
      http: new FixtureTransport({
        statusCode: 429,
        headers: { 'retry-after': '2' },
        json: { error: { message: 'rate limit for sk-super-secret-token' } },
      }),
    });
    let error: unknown;
    try {
      await failed.submit(request(), context);
    } catch (caught) {
      error = caught;
    }
    expect(failed.normalizeError(error)).toMatchObject({
      code: 'openai_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 2_000,
      message: 'rate limit for [REDACTED]',
    });
  });

  it('redacts custom API keys, secret headers, and signed URLs from HTTP errors', async () => {
    const apiKey = 'custom-provider-key';
    const headerSecret = 'custom-header-secret';
    const transport = new FixtureTransport({
      statusCode: 400,
      headers: { 'x-upstream-secret': headerSecret, 'retry-after': '1' },
      json: {
        error: {
          code: 'invalid_api_key',
          message: `invalid key ${apiKey}; signed https://cdn.example.invalid/result.png?token=${headerSecret}`,
        },
      },
    });
    const provider = new OpenAiImagesProvider({ http: transport });
    const errorContext = {
      ...context,
      secrets: { apiKey, 'header:X-Trace': headerSecret },
    };
    let error: unknown;
    try {
      await provider.submit(request(), errorContext);
    } catch (caught) {
      error = caught;
    }

    const normalized = provider.normalizeError(error);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(headerSecret);
    expect(JSON.stringify(error)).not.toContain('?token=');
    expect(normalized.message).not.toContain(apiKey);
    expect(normalized.message).not.toContain(headerSecret);
    expect(normalized.message).not.toContain('?token=');
    expect(normalized).toMatchObject({ code: 'openai_invalid_api_key', statusCode: 400 });
  });

  it('redacts an API-maximum 16384-character custom key without unbounded error text', async () => {
    const apiKey = `custom-${'x'.repeat(16_384 - 'custom-'.length)}`;
    const transport = new FixtureTransport({
      statusCode: 400,
      json: { error: { message: `invalid key ${apiKey}` } },
    });
    const provider = new OpenAiImagesProvider({ http: transport });
    let error: unknown;
    try {
      await provider.submit(request(), { ...context, secrets: { apiKey } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(apiKey);
    expect(String(error).length).toBeLessThanOrEqual(512 + 80);
  });

  it('accepts a Context-provided HTTP client, Base URL, and custom headers', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ b64_json: IMAGE_BASE64 }] }));
    const provider = new OpenAiImagesProvider();

    await provider.submit(request(), {
      ...context,
      baseUrl: 'https://proxy.example.test/openai/v1/',
      headers: { 'X-Client-Label': 'image-studio' },
      http: transport,
    });

    expect(transport.requests[0]?.url).toBe('https://proxy.example.test/openai/v1/images/generations');
    expect(transport.requests[0]?.headers).toMatchObject({
      Authorization: 'Bearer sk-test-only',
      'X-Client-Label': 'image-studio',
    });
    expect(transport.requests[0]?.url).not.toContain('sk-test-only');
  });

  it('rejects CRLF in credentials and keeps protected headers under provider control', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ b64_json: IMAGE_BASE64 }] }));
    const provider = new OpenAiImagesProvider({ http: transport });
    await expect(provider.submit(request(), {
      ...context,
      secrets: { apiKey: 'sk-valid\r\nX-Leak: yes' },
    })).rejects.toMatchObject({ code: 'openai_invalid_header' });
    await expect(provider.submit(request(), {
      ...context,
      idempotencyKey: 'request\nforged',
    })).rejects.toMatchObject({ code: 'openai_invalid_header' });

    await provider.submit(request(), {
      ...context,
      headers: {
        Accept: 'text/plain',
        Authorization: 'Bearer forged',
        'Content-Type': 'text/plain',
        'Idempotency-Key': 'forged',
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=5',
        'Proxy-Auth': 'forged',
        'Proxy-Authenticate': 'Basic forged',
        'Proxy-Connection': 'keep-alive',
        'Proxy-Authorization': 'Basic forged',
        TE: 'trailers',
        Trailer: 'X-Trailer',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket',
        'X-Client': 'ok',
        'x-client': 'latest',
      },
      idempotencyKey: 'real-key',
    });
    expect(transport.requests.at(-1)?.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test-only',
      'Idempotency-Key': 'real-key',
      'x-client': 'latest',
    });
  });

  it('strictly rejects unsupported controls and input roles', async () => {
    const provider = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse({ data: [] })) });
    await expect(provider.validate(request({ negativePrompt: 'no text' }), context)).rejects.toThrow('negativePrompt');
    await expect(provider.validate(request({ extra: { unknown: true } }), context)).rejects.toThrow('extra.unknown');
    await expect(provider.validate(request({ format: 'url' }), context)).rejects.toThrow('format');
    await expect(provider.validate(request({ format: 'b64_json' }), context)).rejects.toThrow('format');
    await expect(provider.validate(request({ inputs: [{ assetId: 'frame', role: 'first_frame' }] }), context)).rejects.toThrow('first_frame');
    await expect(provider.validate(request({ inputs: [{ assetId: 'unknown', role: 'unknown' as 'reference' }] }), context)).rejects.toThrow('input role');
    await expect(provider.validate(request({ extra: { partial_images: 1 } }), context)).rejects.toThrow('stream=true');
    await expect(provider.validate(request({ operation: 'image.edit', inputs: [{ assetId: 'source', role: 'source' }] }), context)).rejects.toThrow('not available');
    await expect(provider.validate(request({ inputs: [{ assetId: 'data:image/png;base64,AQID', role: 'reference' }] }), context)).rejects.toThrow('does not accept');
  });

  it('normalizes a transport failure as retryable and preserves explicit HTTP errors', () => {
    const provider = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse({ data: [] })) });
    expect(provider.normalizeError(new Error('socket closed'))).toMatchObject({
      code: 'openai_network_error',
      kind: 'transient',
      retryable: true,
    });
    expect(provider.normalizeError(new OpenAiHttpError(400, 'bad request'))).toMatchObject({
      code: 'openai_http_400',
      kind: 'rejected',
      retryable: false,
    });
  });

  it('strictly validates output Base64, derives MIME from output_format, and rejects non-image URLs', () => {
    expect(normalizeImageResponse({ data: [{ b64_json: IMAGE_BASE64 }] }, { outputFormat: 'jpeg' })[0]).toMatchObject({
      source: 'base64',
      mimeType: 'image/jpeg',
    });
    expect(() => normalizeImageResponse({ data: [{ b64_json: 'not-base64' }] })).toThrow('Base64');
    expect(() => normalizeImageResponse({ data: [{ url: 'https://cdn.example.invalid/result.txt', mime_type: 'text/plain' }] })).toThrow('non-image MIME');
    expect(() => parseOpenAiImageStream('data: {"type":"image_generation.partial_image","b64_json":"not-base64"}\n\n')).toThrow('Base64');
    expect(parseOpenAiImageStream(
      'data: {"type":"image_generation.partial_image","b64_json":"' + IMAGE_BASE64 + '"}\n\n',
      { outputFormat: 'webp' },
    ).partials[0]).toMatchObject({ mimeType: 'image/webp' });
  });

  it('bounds output counts, result IDs, metadata, and URL credentials while preserving signed URL queries', async () => {
    const twoImages = {
      data: [
        { id: 'image-0', b64_json: IMAGE_BASE64 },
        { id: 'image-1', b64_json: IMAGE_BASE64 },
      ],
    };
    const provider = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse(twoImages)) });
    await expect(provider.submit(request(), context)).rejects.toMatchObject({ code: 'openai_invalid_response' });

    const twoRequested = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse(twoImages)) });
    const twoResult = await twoRequested.submit(request({ count: 2 }), context);
    if (twoResult.state !== 'completed') throw new Error('Expected a completed image result.');
    expect(twoResult.assets.map((asset) => asset.resultId)).toEqual(['image-0', 'image-1']);

    const responses = new OpenAiResponsesImageProvider({
      http: new FixtureTransport(jsonResponse({
        output: [
          { type: 'image_generation_call', id: 'response-0', result: IMAGE_BASE64 },
          { type: 'image_generation_call', id: 'response-1', result: IMAGE_BASE64 },
        ],
      })),
    });
    await expect(responses.submit(request({ modelId: 'gpt-5.6' }), context))
      .rejects.toMatchObject({ code: 'openai_invalid_response' });

    const normalized = normalizeImageResponse({
      data: [{
        id: 'bounded-id',
        metadata: { revised_prompt: 'short prompt' },
        b64_json: IMAGE_BASE64,
      }],
    });
    expect(normalized[0]).toMatchObject({
      resultId: 'bounded-id',
      metadata: { revised_prompt: 'short prompt' },
    });
    expect(() => normalizeImageResponse({
      data: [{ id: 'x'.repeat(257), b64_json: IMAGE_BASE64 }],
    })).toThrow('result id');
    expect(() => normalizeImageResponse({
      data: [{ metadata: { oversized: 'x'.repeat(20_000) }, b64_json: IMAGE_BASE64 }],
    })).toThrow('metadata');
    expect(() => normalizeImageResponse({
      data: [{ url: 'https://user:pass@cdn.example.invalid/result.png?token=secret' }],
    })).toThrow('credentials');
    expect(normalizeImageResponse({
      data: [{ url: 'https://cdn.example.invalid/result.png?token=signed-secret&expires=1' }],
    })[0]).toMatchObject({
      source: 'url',
      url: 'https://cdn.example.invalid/result.png?token=signed-secret&expires=1',
    });
  });

  it('keeps image payload validation model-aware and limits compression to encoded formats', async () => {
    expect(() => assertImageGenerationPayload({
      model: 'gpt-image-1',
      prompt: 'a test image',
      size: '2048x2048',
    })).toThrow('size');
    expect(() => assertImageGenerationPayload({
      model: 'gpt-image-2',
      prompt: 'a test image',
      input_fidelity: 'high',
    })).toThrow('input_fidelity');
    expect(() => assertImageGenerationPayload({
      model: 'gpt-image-1',
      prompt: 'a test image',
      output_format: 'png',
      output_compression: 50,
    })).toThrow('output_compression');
    expect(() => assertImageGenerationPayload({
      model: 'gpt-image-1',
      prompt: 'a test image',
      output_format: 'jpeg',
      output_compression: 50,
      moderation: 'auto',
    })).not.toThrow();
    const provider = new OpenAiImagesProvider({ http: new FixtureTransport(jsonResponse({ data: [] })) });
    await expect(provider.validate(request({ extra: { output_format: 'png', output_compression: 50 } }), context)).rejects.toThrow('output_compression');
  });
});

describe('OpenAI stream parser', () => {
  it('retains incomplete lines across chunks', () => {
    const first = parseSseChunk('event: image_generation.partial_image\ndata: {"type":"image_generation.partial_');
    const second = parseSseChunk('image","b64_json":"AQ=="}\n\n', first.remainder);
    expect(first.events).toEqual([]);
    expect(second.events).toHaveLength(1);
    expect(parseOpenAiImageStream(second.events)).toMatchObject({
      partials: [{ index: 0, base64: 'AQ==' }],
      done: false,
    });

    const eventLine = parseSseChunk('event: image_generation.partial_image\n');
    const dataLine = parseSseChunk('data: {"type":"image_generation.partial_image","b64_json":"AQ=="}\n\n', eventLine.remainder);
    expect(parseOpenAiImageStream(dataLine.events).partials).toEqual([{ index: 0, base64: 'AQ==', mimeType: 'image/png' }]);
  });

  it('parses both official Images and Responses event names from fixed fixtures', () => {
    const images = readFileSync(new URL('../../../../../fixtures/providers/openai/openai-images-v1/stream.sse', import.meta.url), 'utf8');
    const responses = readFileSync(new URL('../../../../../fixtures/providers/openai/openai-responses-image-v1/stream.sse', import.meta.url), 'utf8');
    expect(parseOpenAiImageStream(images)).toMatchObject({ done: true, partials: [{ index: 0 }] });
    expect(parseOpenAiImageStream(responses)).toMatchObject({ done: true, assets: [{ resultId: 'ig_fixture_1' }] });
  });
});

describe('OpenAI Videos compatible profile', () => {
  const videoContext: OpenAiProviderContext = {
    baseUrl: 'https://api.openai.com/v1',
    providerId: 'openai-video',
    secrets: { apiKey: 'custom-video-key' },
  };

  function videoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
    return {
      operation: 'video.generate',
      providerId: 'openai-video',
      modelId: 'sora-2',
      prompt: 'A paper boat crossing a calm lake at sunrise',
      inputs: [],
      durationSeconds: 4,
      resolution: '1280x720',
      ...overrides,
    };
  }

  const fixture = (name: string) => JSON.parse(readFileSync(
    new URL(`../../../../../fixtures/providers/openai/openai-videos-v1-compatible/${name}`, import.meta.url),
    'utf8',
  )) as unknown;

  it('exposes conservative video capabilities and filters non-video catalog models', async () => {
    const transport = new FixtureTransport(jsonResponse(fixture('connection-success.json')));
    const provider = new OpenAiVideosProvider({ http: transport });
    const defaults = await provider.getCapabilities(videoContext);
    expect(defaults.models.map((model) => model.id)).toEqual(['sora-2', 'sora-2-pro', 'sora-2-2025-10-06', 'sora-2-pro-2025-10-06', 'sora-2-2025-12-08']);
    expect(defaults.models[0]?.capabilities).toMatchObject({
      operations: ['video.generate', 'video.image_to_video'],
      durations: [4, 8, 12, 16, 20],
      supportsProgress: true,
      supportsCancel: false,
      maxBatchCount: 1,
    });
    expect(defaults.models.find((model) => model.id === 'sora-2')?.capabilities.resolutions)
      .not.toContain('1920x1080');
    expect(defaults.models.find((model) => model.id === 'sora-2-pro')?.capabilities.resolutions)
      .toEqual(expect.arrayContaining(['1920x1080', '1080x1920']));
    const live = await provider.getLiveCapabilities(videoContext);
    expect(live.models.map((model) => model.id)).toEqual(['sora-2', 'sora-2-pro']);
    expect(live.models[0]?.capabilities.operations).toEqual(['video.generate', 'video.image_to_video']);
  });

  it('only admits an unknown catalog model when it is explicitly configured', async () => {
    const transport = new FixtureTransport(jsonResponse({ data: [{ id: 'custom-video-preview' }, { id: 'gpt-image-1' }] }));
    const provider = new OpenAiVideosProvider({ http: transport, models: ['custom-video-preview'] });
    const live = await provider.getLiveCapabilities(videoContext);
    expect(live.models.map((model) => model.id)).toEqual(['custom-video-preview']);
    expect(live.models[0]?.capabilities).toMatchObject({
      operations: ['video.generate'],
      durations: [4],
      resolutions: ['720x1280'],
    });
    await expect(provider.validate(videoRequest({ modelId: 'custom-video-preview', resolution: '720x1280' }), videoContext))
      .resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({
      modelId: 'custom-video-preview',
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), videoContext)).rejects.toMatchObject({ code: 'openai_operation_not_supported' });
  });

  it('requires explicit config models to match exactly instead of falling back to built-ins', async () => {
    const provider = new OpenAiVideosProvider({
      http: new FixtureTransport(jsonResponse({ data: [{ id: 'sora-2' }, { id: 'sora-2-pro' }, { id: 'custom-video-preview' }] })),
    });
    const configured: OpenAiProviderContext = {
      ...videoContext,
      config: { models: ['custom-video-preview'] },
    };
    await expect(provider.getCapabilities(configured)).resolves.toMatchObject({
      models: [{ id: 'custom-video-preview', capabilities: { operations: ['video.generate'] } }],
    });
    await expect(provider.validate(videoRequest({ modelId: 'custom-video-preview', resolution: '720x1280' }), configured))
      .resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({ modelId: 'sora-2' }), configured))
      .rejects.toMatchObject({ code: 'openai_model_not_supported' });
    const live = await provider.getLiveCapabilities(configured);
    expect(live.models.map((model) => model.id)).toEqual(['custom-video-preview']);
  });

  it('submits text-to-video JSON and persists only the bounded remote reference', async () => {
    const dispose = vi.fn();
    const transport = new FixtureTransport({
      ...jsonResponse(fixture('submit-response.json')),
      dispose,
    });
    const provider = new OpenAiVideosProvider({ http: transport });
    const result = await provider.submit(videoRequest(), videoContext);
    expect(JSON.parse(String(transport.requests[0]?.body))).toEqual(fixture('submit-request.json'));
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.openai.com/v1/videos',
      headers: { Authorization: 'Bearer custom-video-key', 'Content-Type': 'application/json' },
    });
    expect(result).toMatchObject({ state: 'pending', remoteJobId: 'video_fixture_001', pollAfterMs: 2_000 });
    expect(result).not.toHaveProperty('headers');
    expect(JSON.stringify(result)).not.toContain('custom-video-key');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit base URL for dynamic operations while keeping static capabilities pure', async () => {
    const transport = new FixtureTransport(jsonResponse(fixture('submit-response.json')));
    const provider = new OpenAiVideosProvider({ http: transport });
    const staticContext: OpenAiProviderContext = {
      providerId: 'openai-video',
      secrets: { apiKey: 'custom-video-key' },
    };
    await expect(provider.getCapabilities(staticContext)).resolves.toBeDefined();
    for (const operation of [
      () => provider.getLiveCapabilities(staticContext),
      () => provider.testConnection(staticContext),
      () => provider.submit(videoRequest(), staticContext),
      () => provider.poll('video_fixture_001', staticContext),
      () => provider.resolveResult({
        type: 'video',
        mimeType: 'video/mp4',
        source: 'provider',
        providerId: 'openai-video',
        remoteJobId: 'video_fixture_001',
        variant: 'video',
      }, staticContext),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'openai_missing_base_url' });
    }
    await expect(provider.testConnection({ ...staticContext, baseUrl: '   ' })).rejects.toMatchObject({
      code: 'openai_missing_base_url',
    });
  });

  it('uses the explicit compatibility base URL for video requests', async () => {
    const transport = new FixtureTransport(jsonResponse(fixture('submit-response.json')));
    await new OpenAiVideosProvider({ http: transport, baseUrl: 'https://proxy.example.test/v1' })
      .submit(videoRequest(), { providerId: 'openai-video', secrets: { apiKey: 'custom-video-key' } });
    expect(transport.requests[0]?.url).toBe('https://proxy.example.test/v1/videos');
  });

  it('preserves non-2xx status and headers when error bodies are empty or invalid', async () => {
    const empty429 = new OpenAiVideosProvider({
      http: new FixtureTransport({ statusCode: 429, headers: { 'retry-after': '7' } }),
    });
    let emptyError: unknown;
    try {
      await empty429.testConnection(videoContext);
    } catch (error) {
      emptyError = error;
    }
    expect(emptyError).toBeInstanceOf(OpenAiHttpError);
    expect(emptyError).toMatchObject({ statusCode: 429 });
    expect(empty429.normalizeError(emptyError)).toMatchObject({
      code: 'openai_rate_limited',
      statusCode: 429,
      retryAfterMs: 7_000,
      retryable: true,
    });

    const date429 = new OpenAiVideosProvider({
      http: new FixtureTransport({
        statusCode: 429,
        headers: { 'retry-after': new Date(Date.now() + 2_000).toUTCString() },
        text: 'rate limit',
      }),
    });
    let dateError: unknown;
    try {
      await date429.testConnection(videoContext);
    } catch (error) {
      dateError = error;
    }
    const normalizedDate = date429.normalizeError(dateError);
    expect(dateError).toMatchObject({ statusCode: 429 });
    expect(normalizedDate).toMatchObject({ code: 'openai_rate_limited', retryable: true });
    expect(normalizedDate.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(normalizedDate.retryAfterMs).toBeLessThanOrEqual(86_400_000);

    const malformed503 = new OpenAiVideosProvider({
      http: new FixtureTransport({ statusCode: 503, text: 'upstream unavailable' }),
    });
    let malformedError: unknown;
    try {
      await malformed503.testConnection(videoContext);
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toMatchObject({ statusCode: 503 });
    expect(malformed503.normalizeError(malformedError)).toMatchObject({
      code: 'openai_upstream_error',
      kind: 'transient',
      retryable: true,
      statusCode: 503,
    });
  });

  it('rejects unbounded successful JSON responses before parsing', async () => {
    const dispose = vi.fn();
    const provider = new OpenAiVideosProvider({
      http: new FixtureTransport({
        statusCode: 200,
        json: { data: [{ id: 'sora-2', description: 'x'.repeat(2 * 1024 * 1024) }] },
        dispose,
      }),
    });
    await expect(provider.testConnection(videoContext)).rejects.toMatchObject({
      code: 'openai_invalid_response',
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('strictly parses bounded text and binary success bodies', async () => {
    for (const response of [
      { statusCode: 200, text: 'not-json' },
      { statusCode: 200, body: new TextEncoder().encode('not-json') },
      { statusCode: 200, body: new Uint8Array(2 * 1024 * 1024 + 1) },
    ]) {
      const provider = new OpenAiVideosProvider({ http: new FixtureTransport(response) });
      await expect(provider.testConnection(videoContext)).rejects.toMatchObject({
        code: 'openai_invalid_response',
      });
    }
  });

  it('accepts current Sora 2 duration limits and Pro 1080p sizes while rejecting cross-model sizes', async () => {
    const transport = new FixtureTransport(jsonResponse(fixture('submit-response.json')));
    const provider = new OpenAiVideosProvider({ http: transport });
    await expect(provider.validate(videoRequest({ durationSeconds: 16 }), videoContext)).resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({ resolution: '1920x1080' }), videoContext)).rejects.toMatchObject({
      code: 'openai_invalid_option',
    });
    await expect(provider.validate(videoRequest({ resolution: '1024x1792' }), videoContext)).rejects.toMatchObject({
      code: 'openai_invalid_option',
    });
    await expect(provider.validate(videoRequest({ modelId: 'sora-2-pro', durationSeconds: 20, resolution: '1920x1080' }), videoContext)).resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({ modelId: 'sora-2-pro', resolution: '1024x1792' }), videoContext)).resolves.toBeUndefined();
    const proTransport = new FixtureTransport(jsonResponse(fixture('submit-pro-1080-response.json')));
    await new OpenAiVideosProvider({ http: proTransport }).submit(videoRequest({ modelId: 'sora-2-pro', durationSeconds: 16, resolution: '1920x1080' }), videoContext);
    expect(JSON.parse(String(proTransport.requests[0]?.body))).toMatchObject({
      model: 'sora-2-pro',
      seconds: '16',
      size: '1920x1080',
    });
  });

  it('rejects non-Pro portrait snapshots in responses as well as requests', async () => {
    const provider = new OpenAiVideosProvider({
      http: new FixtureTransport(jsonResponse({
        id: 'video_fixture_001',
        model: 'sora-2',
        status: 'completed',
        progress: 100,
        seconds: '4',
        size: '1024x1792',
      })),
    });
    await expect(provider.poll('video_fixture_001', {
      ...videoContext,
      modelId: 'sora-2',
    })).rejects.toMatchObject({ code: 'openai_invalid_response' });
  });

  it('submits one first-frame image as binary multipart input', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10]);
    const transport = new FixtureTransport(jsonResponse(fixture('submit-response.json')));
    const provider = new OpenAiVideosProvider({ http: transport });
    const result = await provider.submit(videoRequest({
      operation: 'video.image_to_video',
      prompt: 'Animate this still image with a slow camera move',
      durationSeconds: 8,
      resolution: '720x1280',
      inputs: [{ assetId: 'frame-1', role: 'first_frame' }],
    }), {
      ...videoContext,
      inputs: [{ assetId: 'frame-1', role: 'first_frame', mimeType: 'image/png', bytes, filename: 'frame.png', width: 720, height: 1280 }],
    });
    const requestBody = transport.requests[0];
    expect(requestBody?.bodyBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(requestBody?.bodyBytes ?? []).toString('latin1')).toContain('name="input_reference"; filename="frame.png"');
    expect(Buffer.from(requestBody?.bodyBytes ?? []).includes(Buffer.from(bytes))).toBe(true);
    expect(requestBody?.headers['Content-Type']).toContain('multipart/form-data; boundary=');
    expect(result).toMatchObject({ state: 'pending', remoteJobId: 'video_fixture_001' });
  });

  it('maps running, completed, failed, and expired fixtures without doing content fetches', async () => {
    const transport = new SequenceTransport([
      jsonResponse(fixture('poll-running.json')),
      jsonResponse(fixture('poll-completed.json')),
      jsonResponse(fixture('poll-failed.json')),
      jsonResponse(fixture('poll-expired.json')),
    ]);
    const provider = new OpenAiVideosProvider({ http: transport });
    await expect(provider.poll('video_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'remote_running',
      progress: 42,
      pollAfterMs: 5_000,
    });
    await expect(provider.poll('video_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'completed',
      assets: [{ source: 'provider', providerId: 'openai-video', remoteJobId: 'video_fixture_001', variant: 'video' }],
    });
    await expect(provider.poll('video_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'openai_content_policy_violation', retryable: false },
    });
    await expect(provider.poll('video_fixture_001', videoContext)).resolves.toMatchObject({ state: 'completed' });
    expect(transport.requests.map((request) => request.url)).toEqual([
      'https://api.openai.com/v1/videos/video_fixture_001',
      'https://api.openai.com/v1/videos/video_fixture_001',
      'https://api.openai.com/v1/videos/video_fixture_001',
      'https://api.openai.com/v1/videos/video_fixture_001',
    ]);
  });

  it('rejects a poll response whose id does not match the requested remote job', async () => {
    const provider = new OpenAiVideosProvider({
      http: new FixtureTransport(jsonResponse({ id: 'different-video', status: 'queued', progress: 0 })),
    });
    await expect(provider.poll('video_fixture_001', videoContext)).rejects.toMatchObject({
      code: 'openai_invalid_response',
    });
  });

  it('rejects a poll response whose model changes the requested capability profile', async () => {
    const provider = new OpenAiVideosProvider({
      http: new FixtureTransport(jsonResponse({
        id: 'video_fixture_001',
        model: 'sora-2-pro',
        size: '1920x1080',
        seconds: '16',
        status: 'in_progress',
        progress: 10,
      })),
    });
    await expect(provider.poll('video_fixture_001', {
      ...videoContext,
      modelId: 'sora-2',
    })).rejects.toMatchObject({ code: 'openai_invalid_response' });
  });

  it('resolves an authenticated content target ephemerally and never puts the key in its URL', async () => {
    const provider = new OpenAiVideosProvider();
    const content = fixture('content-response.json') as {
      contentType: string;
      requiresAuthorization: boolean;
      variant: string;
    };
    const target = await provider.resolveResult({
      type: 'video',
      mimeType: 'video/mp4',
      source: 'provider',
      providerId: 'openai-video',
      remoteJobId: 'video_fixture_001',
      variant: 'video',
    }, videoContext);
    expect(content).toMatchObject({
      contentType: 'video/mp4',
      requiresAuthorization: true,
      variant: 'video',
    });
    expect(target).toEqual({
      url: 'https://api.openai.com/v1/videos/video_fixture_001/content?variant=video',
      headers: { Authorization: 'Bearer custom-video-key', Accept: 'video/mp4' },
      claimedMimeType: 'video/mp4',
    });
    expect(target.url).not.toContain('custom-video-key');
  });

  it('rejects unsupported roles/options and normalizes connection auth failures without echoing keys', async () => {
    const provider = new OpenAiVideosProvider({ http: new FixtureTransport(jsonResponse(fixture('submit-response.json'))) });
    await expect(provider.validate(videoRequest({ inputs: [{ assetId: 'ref', role: 'reference' }] }), videoContext)).rejects.toMatchObject({ code: 'openai_input_role_not_allowed' });
    await expect(provider.validate(videoRequest({ durationSeconds: 5 }), videoContext)).rejects.toMatchObject({ code: 'openai_invalid_option' });
    await expect(provider.validate(videoRequest({ resolution: '1024x1024' }), videoContext)).rejects.toMatchObject({ code: 'openai_invalid_option' });
    await expect(provider.validate(videoRequest({ modelId: 'custom-video-preview' }), videoContext)).rejects.toMatchObject({ code: 'openai_model_not_supported' });
    await expect(provider.validate(videoRequest({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), {
      ...videoContext,
      inputs: [{ assetId: 'frame', role: 'first_frame', mimeType: 'image/png', bytes: new Uint8Array([1]), width: 1, height: 1 }],
    })).rejects.toMatchObject({ code: 'openai_input_dimensions_mismatch' });
    const failed = new OpenAiVideosProvider({ http: new FixtureTransport(jsonResponse(fixture('connection-unauthorized.json'), 401)) });
    let caught: unknown;
    try {
      await failed.testConnection(videoContext);
    } catch (error) {
      caught = error;
    }
    expect(failed.normalizeError(caught)).toMatchObject({
      code: 'openai_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(caught)).not.toContain('custom-video-key');
    const echoing = new OpenAiVideosProvider({
      http: new FixtureTransport(jsonResponse({
        id: 'video_fixture_001',
        status: 'failed',
        progress: 0,
        error: { code: 'upstream_error', message: 'provider echoed custom-video-key in its response' },
      })),
    });
    const failedPoll = await echoing.poll('video_fixture_001', videoContext);
    expect(failedPoll).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(failedPoll)).not.toContain('custom-video-key');
  });

  it('preserves deterministic Provider HTTP errors and maps their retry semantics', async () => {
    const invalid = new ProviderHttpError('invalid_request', 'invalid request');
    const provider = new OpenAiVideosProvider({
      http: {
        request: async () => {
          throw invalid;
        },
      },
    });
    await expect(provider.testConnection(videoContext)).rejects.toBe(invalid);
    expect(provider.normalizeError(new UnsafeRemoteUrlError('Remote hostname is not allowed.'))).toMatchObject({
      code: 'provider_network_policy_denied',
      kind: 'rejected',
      retryable: false,
    });
    for (const code of ['invalid_request', 'request_body_too_large', 'response_body_too_large', 'response_invalid', 'redirect_not_allowed'] as const) {
      expect(provider.normalizeError(new ProviderHttpError(code, 'bounded provider error'))).toMatchObject({
        code: `provider_http_${code}`,
        kind: 'rejected',
        retryable: false,
      });
    }
    expect(provider.normalizeError(new ProviderHttpError('timeout', 'timeout'))).toMatchObject({
      code: 'provider_http_timeout',
      kind: 'transient',
      retryable: true,
    });
    expect(provider.normalizeError(new ProviderHttpError('network_error', 'network'))).toMatchObject({
      code: 'provider_http_network_error',
      kind: 'transient',
      retryable: true,
    });
    expect(provider.normalizeError(new ProviderHttpError('aborted', 'aborted'))).toMatchObject({
      code: 'request_aborted',
      kind: 'unknown',
      retryable: false,
    });
  });

  it('keeps only safe transport cause metadata', () => {
    const wrapped = new OpenAiTransportError('OpenAI video request failed.', {
      cause: Object.assign(new Error('custom-video-key leaked by transport'), {
        code: 'ECONNRESET',
        statusCode: 502,
      }),
    });
    expect((wrapped as Error & { cause?: unknown }).cause).toEqual({
      name: 'Error',
      code: 'ECONNRESET',
      statusCode: 502,
    });
    expect(JSON.stringify(wrapped)).not.toContain('custom-video-key');
  });
});
