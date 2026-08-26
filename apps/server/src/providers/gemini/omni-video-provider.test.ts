import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';

import {
  GeminiHttpError,
  GEMINI_VIDEO_MAX_INLINE_OUTPUT_BYTES,
  GeminiOmniVideoProvider,
  type GeminiHttpRequest,
  type GeminiHttpResponse,
  type GeminiProviderContext,
} from './index.js';

const fixtureRoot = new URL('../../../../../fixtures/providers/gemini/gemini-omni-interactions-video-v1/', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8')) as unknown;
}

const bytes = Uint8Array.from([1, 2, 3]);

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'video.generate',
    providerId: 'gemini-omni',
    modelId: 'gemini-omni-flash-preview',
    prompt: 'A quiet train passing through a snowy forest.',
    inputs: [],
    ...overrides,
  };
}

function context(
  transport?: GeminiProviderContext['http'],
  overrides: Partial<GeminiProviderContext> = {},
): GeminiProviderContext {
  return {
    providerId: 'gemini-omni',
    secrets: {
      apiKey: 'AIza-omni-fixture-secret',
      'header:x-trace-id': 'omni-test',
    },
    ...(transport === undefined ? {} : { http: transport }),
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

describe('GeminiOmniVideoProvider', () => {
  it('declares official text, image, and reference capabilities', async () => {
    const provider = new GeminiOmniVideoProvider();
    const capabilities = await provider.getCapabilities({ providerId: 'gemini-omni', secrets: {} });
    expect(provider.type).toBe('gemini-omni-interactions-video-v1');
    expect(capabilities.models[0]?.capabilities).toMatchObject({
      operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
      aspectRatios: ['9:16', '16:9'],
      maxReferenceImages: 3,
      supportsCancel: false,
    });
    expect((provider as unknown as { cancel?: unknown }).cancel).toBeUndefined();
  });

  it('uses the v1beta Interactions endpoint with text payload and injected HTTP only', async () => {
    const fake = transportFor([fixture('submit-response-pending.json')]);
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));

    const result = await provider.submit(request({ aspectRatio: '16:9' }), context());

    expect(JSON.parse(fake.requests[0]?.body ?? '{}')).toEqual(fixture('submit-text-request.json'));
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      headers: { 'x-goog-api-key': 'AIza-omni-fixture-secret', 'x-trace-id': 'omni-test' },
    });
    expect(fake.requests[0]?.url).not.toContain('?key=');
    expect(result).toEqual({ state: 'pending', remoteJobId: 'interaction:v1_fixture_001', pollAfterMs: 10_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('maps a queued submit response to a pending job', async () => {
    const fake = transportFor([fixture('submit-response-queued.json')]);
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });

    await expect(provider.submit(request(), context())).resolves.toEqual({
      state: 'pending',
      remoteJobId: 'interaction:v1_fixture_001',
      pollAfterMs: 10_000,
    });
  });

  it('encodes image and reference video inputs', async () => {
    const image = transportFor([fixture('submit-response-pending.json')]);
    const provider = new GeminiOmniVideoProvider({ transport: image.transport });
    await provider.submit(request({ operation: 'video.image_to_video', prompt: 'Animate this still image with a gentle breeze.', inputs: [{ assetId: 'first', role: 'first_frame' }] }), context(undefined, {
      inputs: [{ assetId: 'first', role: 'first_frame', mimeType: 'image/jpeg', bytes }],
    }));
    expect(JSON.parse(image.requests[0]?.body ?? '{}')).toEqual(fixture('submit-image-request.json'));

    const references = [
      { assetId: 'reference-a', role: 'reference' as const },
      { assetId: 'reference-b', role: 'reference' as const },
    ];
    const reference = transportFor([fixture('submit-response-pending.json')]);
    const referenceProvider = new GeminiOmniVideoProvider({ transport: reference.transport });
    await referenceProvider.submit(request({ operation: 'video.reference_to_video', prompt: 'Create a short scene using the subjects from these references.', inputs: references }), context(undefined, {
      inputs: [
        { assetId: 'reference-a', role: 'reference', mimeType: 'image/png', bytes },
        { assetId: 'reference-b', role: 'reference', mimeType: 'image/jpeg', bytes: Uint8Array.from([4, 5, 6]) },
      ],
    }));
    expect(JSON.parse(reference.requests[0]?.body ?? '{}')).toEqual(fixture('submit-reference-request.json'));

  });

  it('polls queued/pending/running/completed inline and maps failed/expired status', async () => {
    const fake = transportFor([
      fixture('poll-queued.json'),
      fixture('poll-pending.json'),
      fixture('poll-running.json'),
      fixture('poll-completed-inline.json'),
    ]);
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });
    const runtime = context();
    await expect(provider.poll('interaction:v1_fixture_001', runtime)).resolves.toMatchObject({ state: 'remote_pending', progress: 0 });
    await expect(provider.poll('interaction:v1_fixture_001', runtime)).resolves.toMatchObject({ state: 'remote_running', progress: 18 });
    await expect(provider.poll('interaction:v1_fixture_001', runtime)).resolves.toMatchObject({ state: 'remote_running', progress: 73 });
    await expect(provider.poll('interaction:v1_fixture_001', runtime)).resolves.toMatchObject({
      state: 'completed', assets: [{ type: 'video', source: 'base64', base64: 'AAAA', resultId: 'v1_fixture_001' }],
    });

    const failed = new GeminiOmniVideoProvider({ transport: transportFor([fixture('poll-failed.json')]).transport });
    await expect(failed.poll('interaction:v1_fixture_001', context())).resolves.toMatchObject({ state: 'failed', error: { code: 'gemini_safety_block', kind: 'rejected' } });
    const expired = new GeminiOmniVideoProvider({ transport: transportFor([fixture('poll-expired.json')]).transport });
    await expect(expired.poll('interaction:v1_fixture_001', context())).resolves.toMatchObject({ state: 'failed', error: { code: 'gemini_video_result_expired', kind: 'expired' } });

    for (const [name, code] of [
      ['poll-cancelled.json', 'gemini_cancelled'],
      ['poll-requires-action.json', 'gemini_requires_action'],
      ['poll-incomplete.json', 'gemini_incomplete'],
      ['poll-budget-exceeded.json', 'gemini_budget_exceeded'],
    ] as const) {
      const terminal = new GeminiOmniVideoProvider({ transport: transportFor([fixture(name)]).transport });
      await expect(terminal.poll('interaction:v1_fixture_001', context())).resolves.toMatchObject({ state: 'failed', error: { code, kind: 'rejected', retryable: false } });
    }
  });

  it('resolves file URI results only after the official Files state is active', async () => {
    const fake = transportFor([fixture('poll-completed-uri.json')]);
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });
    const result = await provider.poll('interaction:v1_fixture_001', context());
    expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'provider', remoteJobId: 'file:omni-file-001' }] });

    const processing = transportFor([fixture('file-processing.json')]);
    const processingProvider = new GeminiOmniVideoProvider({ transport: processing.transport });
    await expect(processingProvider.resolveResult({
      type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'gemini-omni', remoteJobId: 'file:omni-file-001', variant: 'video',
    }, context())).rejects.toMatchObject({ code: 'gemini_video_file_pending' });

    const active = transportFor([fixture('file-active.json')]);
    const activeProvider = new GeminiOmniVideoProvider({ transport: active.transport });
    const target = await activeProvider.resolveResult({
      type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'gemini-omni', remoteJobId: 'file:omni-file-001', variant: 'video',
    }, context());
    expect(active.requests[0]).toMatchObject({ method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/files/omni-file-001' });
    expect(target).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/files/omni-file-001:download?alt=media',
      headers: { 'x-goog-api-key': 'AIza-omni-fixture-secret' },
    });
  });

  it('restores fresh interaction and file references with current authentication', async () => {
    const interactionUnauthorized = transportFor([fixture('connection-unauthorized.json')], 403);
    const freshInteraction = new GeminiOmniVideoProvider({ transport: interactionUnauthorized.transport });
    let interactionError: unknown;
    try {
      await freshInteraction.poll('interaction:v1_fixture_001', context());
    } catch (caught) {
      interactionError = caught;
    }
    expect(freshInteraction.normalizeError(interactionError)).toMatchObject({ code: 'gemini_authentication_error', kind: 'rejected', statusCode: 403 });
    expect(JSON.stringify(interactionError)).not.toContain('AIza-omni-fixture-secret');

    const fileUnauthorized = transportFor([fixture('connection-unauthorized.json')], 401);
    const freshFile = new GeminiOmniVideoProvider({ transport: fileUnauthorized.transport });
    let fileError: unknown;
    try {
      await freshFile.resolveResult({ type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'gemini-omni', remoteJobId: 'file:omni-file-001', variant: 'video' }, context());
    } catch (caught) {
      fileError = caught;
    }
    expect(freshFile.normalizeError(fileError)).toMatchObject({ code: 'gemini_authentication_error', kind: 'rejected', statusCode: 401 });
  });

  it('refreshes only Interactions-capable models, tests connection, and rejects unsafe inputs', async () => {
    const fake = transportFor([fixture('models-response.json')]);
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));
    const live = await provider.getLiveCapabilities(context());
    expect(live.models.map((model) => model.id)).toEqual(['gemini-omni-flash-preview', 'gemini-omni-future-preview']);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    await expect(provider.validate(request({ operation: 'video.extend' }), context())).rejects.toMatchObject({ code: 'gemini_operation_unsupported' });
    await expect(provider.validate(request({ operation: 'video.reference_to_video', inputs: [{ assetId: 'a', role: 'reference' }], extra: { unknown: true } }), context(undefined, {
      inputs: [{ assetId: 'a', role: 'reference', mimeType: 'image/png', bytes }],
    }))).rejects.toMatchObject({ code: 'gemini_extra_fields_unsupported' });
  });

  it('preserves HTTP retry semantics and redacts API keys', async () => {
    const fake = transportFor(['upstream key=AIza-omni-fixture-secret unavailable'], 429, { 'retry-after': '999999' });
    const provider = new GeminiOmniVideoProvider({ transport: fake.transport });
    let error: unknown;
    try { await provider.submit(request(), context()); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(JSON.stringify(error)).not.toContain('AIza-omni-fixture-secret');
    expect(provider.normalizeError(error)).toMatchObject({ kind: 'transient', retryable: true, statusCode: 429, retryAfterMs: 86_400_000 });
  });

  it('rejects readable responses and inline output over the bounded 4 MiB limit', async () => {
    const dispose = vi.fn();
    const streamLike = { getReader: () => ({}) };
    const streamProvider = new GeminiOmniVideoProvider({ transport: { async request() { return { statusCode: 200, body: streamLike, dispose }; } } });
    await expect(streamProvider.poll('interaction:v1_fixture_001', context())).rejects.toMatchObject({ code: 'gemini_response_stream_unsupported' });
    expect(dispose).toHaveBeenCalledTimes(1);

    const oversized = Buffer.alloc(GEMINI_VIDEO_MAX_INLINE_OUTPUT_BYTES + 1).toString('base64');
    const output = { id: 'v1_fixture_001', status: 'completed', output_video: { type: 'video', mime_type: 'video/mp4', data: oversized } };
    const outputProvider = new GeminiOmniVideoProvider({ transport: transportFor([output]).transport });
    await expect(outputProvider.poll('interaction:v1_fixture_001', context())).rejects.toMatchObject({ code: 'gemini_video_data_invalid' });
  });

  it('replaces untrusted upstream error codes with the fixed safe fallback', async () => {
    const transport = transportFor([{
      id: 'v1_fixture_001',
      status: 'failed',
      error: { code: 'AIza-omni-fixture-secret?token=leak', message: 'key=AIza-omni-fixture-secret' },
    }]);
    const provider = new GeminiOmniVideoProvider({ transport: transport.transport });
    const result = await provider.poll('interaction:v1_fixture_001', context());
    expect(result).toMatchObject({ state: 'failed', error: { code: 'gemini_video_failed' } });
    expect(JSON.stringify(result)).not.toContain('AIza-omni-fixture-secret');
  });
});
