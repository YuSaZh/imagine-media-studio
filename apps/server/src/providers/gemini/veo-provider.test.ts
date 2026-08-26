import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';

import {
  GeminiHttpError,
  GEMINI_VEO_RESULT_RETENTION_MS,
  GeminiVeoProvider,
  type GeminiHttpRequest,
  type GeminiHttpResponse,
  type GeminiProviderContext,
} from './index.js';

const fixtureRoot = new URL('../../../../../fixtures/providers/gemini/gemini-veo-operation-v1/', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as unknown;
}

const imageBytes = Uint8Array.from([1, 2, 3]);

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'video.generate',
    providerId: 'gemini-veo',
    modelId: 'veo-3.1-generate-preview',
    prompt: 'A paper boat crossing a moonlit stream.',
    inputs: [],
    ...overrides,
  };
}

function context(
  transport?: GeminiProviderContext['transport'],
  overrides: Partial<GeminiProviderContext> = {},
): GeminiProviderContext {
  return {
    providerId: 'gemini-veo',
    secrets: {
      apiKey: 'AIza-veo-fixture-secret',
      'header:x-trace-id': 'veo-test',
    },
    ...(transport === undefined ? {} : { transport }),
    ...overrides,
  };
}

function transportFor(
  bodies: readonly unknown[],
  statusCode = 200,
  headers?: Readonly<Record<string, string>>,
): { requests: GeminiHttpRequest[]; transport: { request(input: GeminiHttpRequest): Promise<GeminiHttpResponse> } } {
  const requests: GeminiHttpRequest[] = [];
  let index = 0;
  return {
    requests,
    transport: {
      async request(input) {
        requests.push(input);
        const body = bodies[Math.min(index++, bodies.length - 1)];
        return { statusCode, body, ...(headers === undefined ? {} : { headers }), dispose: vi.fn() };
      },
    },
  };
}

describe('GeminiVeoProvider', () => {
  it('declares the official Veo operation profile and keeps cancel disabled', async () => {
    const provider = new GeminiVeoProvider();
    const capabilities = await provider.getCapabilities({ providerId: 'gemini-veo', secrets: {} });
    expect(provider.type).toBe('gemini-veo-operation-v1');
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'veo-3.1-generate-preview',
      'veo-3.1-fast-generate-preview',
      'veo-3.1-lite-generate-preview',
    ]);
    expect(capabilities.models[0]?.capabilities).toMatchObject({
      operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
      durations: [4, 6, 8],
      maxReferenceImages: 3,
      supportsCancel: false,
      supportsBatchCount: false,
    });
    expect(capabilities.models[2]?.capabilities).toMatchObject({
      operations: ['video.generate', 'video.image_to_video'],
      maxReferenceImages: 0,
    });
    expect((provider as unknown as { cancel?: unknown }).cancel).toBeUndefined();
  });

  it('refreshes the official models catalog and preserves unknown Veo models conservatively', async () => {
    const fake = transportFor([fixture('models-response.json')]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    const capabilities = await provider.getLiveCapabilities(context());
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models' });
    expect(capabilities.models.map((model) => model.id)).toEqual(['veo-3.1-generate-preview', 'veo-future-preview']);
    expect(capabilities.models[1]?.capabilities.operations).toEqual(['video.generate']);
  });

  it('uses predictLongRunning with the official text payload and injected HTTP only', async () => {
    const fake = transportFor([fixture('submit-response-pending.json')]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    const result = await provider.submit(request({ aspectRatio: '16:9', durationSeconds: 8, resolution: '720p', count: 1 }), context());

    expect(JSON.parse(fake.requests[0]?.body ?? '{}')).toEqual(fixture('submit-text-request.json'));
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning',
      headers: {
        'x-goog-api-key': 'AIza-veo-fixture-secret',
        'x-trace-id': 'veo-test',
      },
    });
    expect(fake.requests[0]?.url).not.toContain('AIza');
    expect(result).toEqual({ state: 'pending', remoteJobId: 'operation:operations/veo-fixture-001', pollAfterMs: 10_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('encodes first-frame and reference images as bounded inlineData', async () => {
    const first = transportFor([fixture('submit-response-pending.json')]);
    const provider = new GeminiVeoProvider({ transport: first.transport });
    await provider.submit(request({ operation: 'video.image_to_video', prompt: 'Animate the scene with a slow camera move.', durationSeconds: 8, inputs: [{ assetId: 'first', role: 'first_frame' }] }), context(undefined, {
      inputs: [{ assetId: 'first', role: 'first_frame', mimeType: 'image/jpeg', bytes: imageBytes }],
    }));
    expect(JSON.parse(first.requests[0]?.body ?? '{}')).toMatchObject(fixture('submit-image-request.json') as object);

    const references = [
      { assetId: 'reference-a', role: 'reference' as const },
      { assetId: 'reference-b', role: 'reference' as const },
    ];
    const second = transportFor([fixture('submit-response-pending.json')]);
    const secondProvider = new GeminiVeoProvider({ transport: second.transport });
    await secondProvider.submit(request({ operation: 'video.reference_to_video', prompt: 'Show the subject wearing the referenced clothing in a studio.', inputs: references }), context(undefined, {
      inputs: [
        { assetId: 'reference-a', role: 'reference', mimeType: 'image/png', bytes: imageBytes },
        { assetId: 'reference-b', role: 'reference', mimeType: 'image/jpeg', bytes: Uint8Array.from([4, 5, 6]) },
      ],
    }));
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual(fixture('submit-reference-request.json'));
  });

  it('polls pending, running, completes inline output, and maps remote failures', async () => {
    const fake = transportFor([
      fixture('poll-pending.json'),
      fixture('poll-running.json'),
      fixture('poll-completed-inline.json'),
    ]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    const runtime = context();
    await expect(provider.poll('operation:operations/veo-fixture-001', runtime)).resolves.toMatchObject({ state: 'remote_running', progress: 22 });
    await expect(provider.poll('operation:operations/veo-fixture-001', runtime)).resolves.toMatchObject({ state: 'remote_running', progress: 71 });
    const expectedInline = fixture('expected-normalized-inline.json') as unknown[];
    await expect(provider.poll('operation:operations/veo-fixture-001', runtime)).resolves.toEqual({ state: 'completed', assets: [expectedInline[0]] });

    const failedTransport = transportFor([fixture('poll-failed.json')]);
    const failedProvider = new GeminiVeoProvider({ transport: failedTransport.transport });
    await expect(failedProvider.poll('operation:operations/veo-fixture-001', context())).resolves.toMatchObject({
      state: 'failed', error: { code: 'gemini_invalid_argument', kind: 'rejected', retryable: false },
    });
    const expiredTransport = transportFor([fixture('poll-expired.json')]);
    const expiredProvider = new GeminiVeoProvider({ transport: expiredTransport.transport });
    await expect(expiredProvider.poll('operation:operations/veo-fixture-001', context())).resolves.toMatchObject({
      state: 'failed', error: { code: 'gemini_video_result_expired', kind: 'expired', retryable: false },
    });
  });

  it('normalizes provider file resources without persisting a URL or API key', async () => {
    const fake = transportFor([fixture('poll-completed-uri.json')]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    const result = await provider.poll('operation:operations/veo-fixture-001', context());
    expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'provider', remoteJobId: 'file:veo-file-001', variant: 'video' }] });
    const asset = (result as unknown as { assets: readonly [{ remoteJobId: string }] }).assets[0];
    expect(asset.remoteJobId).not.toContain('https://');
    expect(asset.remoteJobId).not.toContain('AIza');

    const target = await provider.resolveResult({
      type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'gemini-veo',
      remoteJobId: asset.remoteJobId, variant: 'video',
    }, context());
    expect(target).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/files/veo-file-001:download?alt=media',
      claimedMimeType: 'video/mp4',
      headers: { 'x-goog-api-key': 'AIza-veo-fixture-secret' },
    });
  });

  it('sets Veo URI result expiry to the documented two-day retention cap', async () => {
    const fake = transportFor([fixture('poll-completed-uri.json')]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    const before = Date.now();
    const result = await provider.poll('operation:operations/veo-fixture-001', context());
    const after = Date.now();
    const expiry = (result as { resultExpiresAt: Date }).resultExpiresAt;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + GEMINI_VEO_RESULT_RETENTION_MS);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + GEMINI_VEO_RESULT_RETENTION_MS);
  });

  it('enforces model, role, MIME, duration, and URI safety boundaries', async () => {
    const provider = new GeminiVeoProvider({ transport: transportFor([fixture('submit-response-pending.json')]).transport });
    await expect(provider.validate(request({ operation: 'video.edit' }), context())).rejects.toMatchObject({ code: 'gemini_operation_unsupported' });
    await expect(provider.validate(request({ operation: 'video.reference_to_video', inputs: [{ assetId: 'first', role: 'first_frame' }] }), context(undefined, {
      inputs: [{ assetId: 'first', role: 'first_frame', mimeType: 'image/jpeg', bytes: imageBytes }],
    }))).rejects.toMatchObject({ code: 'gemini_input_role_invalid' });
    await expect(provider.validate(request({ operation: 'video.reference_to_video', inputs: [{ assetId: 'a', role: 'reference' }] }), context(undefined, {
      inputs: [{ assetId: 'a', role: 'reference', mimeType: 'image/webp', bytes: imageBytes }],
    }))).rejects.toMatchObject({ code: 'gemini_input_mime_unsupported' });
    await expect(provider.validate(request({ durationSeconds: 6, resolution: '1080p' }), context())).rejects.toMatchObject({ code: 'gemini_resolution_duration_invalid' });
    await expect(provider.resolveResult({
      type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'gemini-veo',
      remoteJobId: 'file:bad/id', variant: 'video',
    }, context())).rejects.toThrow();
  });

  it('keeps HTTP failure retry semantics, caps Retry-After, and rejects unsafe headers', async () => {
    const fake = transportFor(['upstream unavailable'], 500, { 'retry-after': '999999' });
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    let error: unknown;
    try { await provider.submit(request(), context()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(provider.normalizeError(error)).toMatchObject({ kind: 'transient', retryable: true, statusCode: 500 });
    expect((provider.normalizeError(error).retryAfterMs)).toBe(86_400_000);
    await expect(provider.testConnection(context(undefined, { headers: { Authorization: 'bad' } }))).rejects.toMatchObject({ code: 'gemini_header_invalid' });
  });

  it('disposes bounded responses, propagates abort, and never falls back to fetch', async () => {
    const dispose = vi.fn();
    const transport = {
      async request(): Promise<GeminiHttpResponse> {
        return { statusCode: 200, body: fixture('submit-response-pending.json'), dispose };
      },
    };
    const provider = new GeminiVeoProvider({ transport });
    await provider.submit(request(), context());
    expect(dispose).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    await expect(provider.submit(request(), context(undefined, { signal: controller.signal }))).rejects.toThrow();
    expect((provider as unknown as { cancel?: unknown }).cancel).toBeUndefined();
  });

  it('rejects credential-bearing output URIs instead of persisting or forwarding them', async () => {
    const fake = transportFor([{
      name: 'operations/veo-fixture-001',
      done: true,
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.example.test/video.mp4?key=secret' } }] } },
    }]);
    const provider = new GeminiVeoProvider({ transport: fake.transport });
    await expect(provider.poll('operation:operations/veo-fixture-001', context())).rejects.toMatchObject({ code: 'gemini_video_uri_invalid' });
  });

  it('restores durable operation references with a fresh provider and maps unauthorized polling safely', async () => {
    const pending = transportFor([fixture('submit-response-pending.json')]);
    const original = new GeminiVeoProvider({ transport: pending.transport });
    const submitted = await original.submit(request(), context());
    expect(submitted).toMatchObject({ remoteJobId: 'operation:operations/veo-fixture-001' });

    const unauthorized = transportFor([fixture('connection-unauthorized.json')], 401);
    const fresh = new GeminiVeoProvider({ transport: unauthorized.transport });
    let error: unknown;
    try { await fresh.poll('operation:operations/veo-fixture-001', context()); } catch (caught) { error = caught; }
    expect(fresh.normalizeError(error)).toMatchObject({ code: 'gemini_authentication_error', kind: 'rejected', statusCode: 401 });
    expect(JSON.stringify(error)).not.toContain('AIza-veo-fixture-secret');
  });

  it('rejects stream-like responses after disposing them and bounds inline video data', async () => {
    const dispose = vi.fn();
    const streamLike = { pipe: () => streamLike };
    const streamProvider = new GeminiVeoProvider({ transport: { async request() { return { statusCode: 200, body: streamLike, dispose }; } } });
    await expect(streamProvider.poll('operation:operations/veo-fixture-001', context())).rejects.toMatchObject({ code: 'gemini_response_stream_unsupported' });
    expect(dispose).toHaveBeenCalledTimes(1);

    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    const output = { name: 'operations/veo-fixture-001', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { mimeType: 'video/mp4', inlineData: { mimeType: 'video/mp4', data: oversized } } }] } } };
    const outputProvider = new GeminiVeoProvider({ transport: transportFor([output]).transport });
    await expect(outputProvider.poll('operation:operations/veo-fixture-001', context())).rejects.toMatchObject({ code: 'gemini_video_data_invalid' });
  });
});
