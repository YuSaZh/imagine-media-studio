import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createMockGenerationRequest } from '@imagine/testkit';
import type { GenerationRequest } from '@imagine/shared';
import type { ProviderContext } from '@imagine/provider-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  MOCK_VIDEO_MP4_SHA256,
  MOCK_VIDEO_PENDING_MS,
  MOCK_VIDEO_PROFILE,
  MOCK_VIDEO_RUNNING_MS,
  MOCK_VIDEO_TRANSIENT_RETRY_MS,
  MockProviderAdapter,
  MockProviderValidationError,
} from './mock-provider.js';

const context = { providerId: 'mock', secrets: {} };
const VIDEO_FIXTURE_ROOT = new URL(
  '../../../../fixtures/providers/mock/mock-video-v1/',
  import.meta.url,
);
const imageInput = (assetId: string, role: 'first_frame' | 'reference' = 'reference') => ({
  assetId,
  role,
  mimeType: 'image/png',
  bytes: new Uint8Array([137, 80, 78, 71]),
});

function videoRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'video.generate',
    providerId: 'mock',
    modelId: MOCK_VIDEO_PROFILE,
    prompt: 'A fixed mock video',
    inputs: [],
    ...overrides,
  };
}

function videoContext(
  inputs: ProviderContext['inputs'] = [],
  config: ProviderContext['config'] = {},
): ProviderContext {
  return {
    providerId: 'mock',
    baseUrl: 'https://provider.invalid/v1',
    config,
    idempotencyKey: 'safe-idempotency-key',
    inputs,
    jobId: 'safe-job-id',
    secrets: { apiKey: 'do-not-put-this-in-the-remote-id' },
  };
}

describe('MockProviderAdapter', () => {
  it('reads every Mock video contract fixture directly', () => {
    const fixture = (name: string) =>
      JSON.parse(readFileSync(new URL(name, VIDEO_FIXTURE_ROOT), 'utf8')) as Record<string, unknown>;
    const submit = fixture('submit-request.json');
    const imageSubmit = fixture('submit-image-request.json');
    const referenceSubmit = fixture('submit-reference-request.json');
    expect(submit).toMatchObject({
      operation: 'video.generate',
      providerId: 'mock',
      modelId: MOCK_VIDEO_PROFILE,
      count: 1,
    });
    expect(imageSubmit).toMatchObject({
      operation: 'video.image_to_video',
      inputs: [{ role: 'first_frame' }],
    });
    expect(referenceSubmit).toMatchObject({
      operation: 'video.reference_to_video',
      inputs: [{ role: 'reference' }, { role: 'reference' }],
    });
    const submitResponse = fixture('submit-response.json');
    const running = fixture('poll-running.json');
    const completed = fixture('poll-completed.json');
    const failed = fixture('poll-failed.json');
    const expired = fixture('poll-expired.json');

    expect(submitResponse).toMatchObject({ state: 'pending', pollAfterMs: MOCK_VIDEO_PENDING_MS });
    expect(running).toMatchObject({ state: 'remote_running', progress: 50 });
    expect(completed).toMatchObject({ state: 'completed' });
    expect(failed).toMatchObject({ state: 'failed', error: { retryable: false } });
    expect(expired).toMatchObject({ state: 'failed', error: { kind: 'expired' } });
    expect(fixture('expected-normalized.json')).toMatchObject({
      mimeType: 'video/mp4',
      sha256: MOCK_VIDEO_MP4_SHA256,
      type: 'video',
    });
  });

  it('returns a deterministic local fixture without using fetch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network access is forbidden in the Mock Provider test.'));
    const provider = new MockProviderAdapter();
    const request = createMockGenerationRequest();

    await provider.validate(request, context);
    const first = await provider.submit(request, context);
    const second = await provider.submit(request, context);

    expect(first).toEqual(second);
    expect(first.state).toBe('completed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects unsupported model inputs and options', async () => {
    const provider = new MockProviderAdapter();

    await expect(
      provider.validate(createMockGenerationRequest({ modelId: 'unknown' }), context),
    ).rejects.toThrow();
    await expect(provider.validate(createMockGenerationRequest({
      inputs: Array.from({ length: 5 }, (_, index) => ({
        assetId: `asset-${index}`,
        role: 'reference' as const,
      })),
    }), context)).rejects.toThrow();
    await expect(provider.validate(createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [{ assetId: 'asset-1', role: 'reference' }],
    }), context)).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ aspectRatio: '16:9' }), context),
    ).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ seed: 42 }), context),
    ).rejects.toThrow();
  });

  it('supports references and the source plus optional mask edit shape without network access', async () => {
    const provider = new MockProviderAdapter();
    await expect(provider.validate(createMockGenerationRequest({
      inputs: [{ assetId: 'reference', role: 'reference' }],
    }), context)).resolves.toBeUndefined();
    await expect(provider.validate(createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [
        { assetId: 'source', role: 'source' },
        { assetId: 'reference', role: 'reference' },
        { assetId: 'mask', role: 'mask' },
      ],
    }), context)).resolves.toBeUndefined();

    const capabilities = await provider.getCapabilities(context);
    expect(capabilities.models[0]?.capabilities).toMatchObject({
      operations: ['image.generate', 'image.edit'],
      maxReferenceImages: 4,
      supportsMask: true,
      inputImageConstraints: { maxBytes: 32 * 1024 * 1024 },
    });
    expect(capabilities.models[1]).toMatchObject({
      id: MOCK_VIDEO_PROFILE,
      capabilities: {
        operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
        aspectRatios: ['16:9', '9:16', '1:1'],
        resolutions: ['720p'],
        durations: [1, 5, 10],
        maxReferenceImages: 4,
        supportsProgress: true,
        supportsCancel: true,
        supportsBatchCount: false,
        maxBatchCount: 1,
      },
    });
  });

  it('validates text-to-video, one first frame, and bounded reference inputs', async () => {
    const provider = new MockProviderAdapter();
    await expect(provider.validate(videoRequest(), videoContext())).resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), videoContext([imageInput('frame', 'first_frame')]))).resolves.toBeUndefined();
    await expect(provider.validate(videoRequest({
      operation: 'video.reference_to_video',
      inputs: [
        { assetId: 'one', role: 'reference' },
        { assetId: 'two', role: 'reference' },
      ],
    }), videoContext([imageInput('one'), imageInput('two')]))).resolves.toBeUndefined();

    await expect(provider.validate(videoRequest({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), videoContext())).rejects.toThrow('loaded inputs');
    await expect(provider.validate(videoRequest({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'reference' }],
    }), videoContext([imageInput('frame')]))).rejects.toThrow('first_frame');
    await expect(provider.validate(videoRequest({
      operation: 'video.reference_to_video',
      inputs: [],
    }), videoContext())).rejects.toThrow('one to four');
    await expect(provider.validate(videoRequest({ resolution: '1080p' }), videoContext()))
      .rejects.toThrow('720p');
    await expect(provider.validate(videoRequest({ durationSeconds: 2 }), videoContext()))
      .rejects.toThrow('1, 5, or 10');
    await expect(provider.validate(videoRequest({ extra: { hidden: true } }), videoContext()))
      .rejects.toThrow('extra');
  });

  it('polls with deterministic IDs and completes after a fresh adapter is created', async () => {
    let now = 10_000;
    const clock = () => now;
    const provider = new MockProviderAdapter({ clock });
    const request = videoRequest({ aspectRatio: '16:9', resolution: '720p', durationSeconds: 1 });
    const operationContext = videoContext();
    const submitted = await provider.submit(request, operationContext);
    if (submitted.state !== 'pending') throw new Error('Expected pending mock video.');

    expect(submitted.remoteJobId).toMatch(/^mock-video-success-[0-9a-z]+-[a-f0-9]{32}$/);
    expect(submitted.remoteJobId).not.toContain('provider.invalid');
    expect(submitted.remoteJobId).not.toContain('do-not-put-this');
    expect(submitted.remoteJobId).not.toContain('safe-idempotency-key');
    expect(submitted.pollAfterMs).toBe(MOCK_VIDEO_PENDING_MS);

    now += MOCK_VIDEO_PENDING_MS - 1;
    await expect(provider.poll(submitted.remoteJobId, operationContext)).resolves.toMatchObject({
      state: 'remote_pending',
      progress: 0,
    });
    now += 1;
    await expect(provider.poll(submitted.remoteJobId, operationContext)).resolves.toMatchObject({
      state: 'remote_running',
      progress: 50,
    });
    now += MOCK_VIDEO_RUNNING_MS - MOCK_VIDEO_PENDING_MS;
    const resumed = new MockProviderAdapter({ clock });
    const completed = await resumed.poll(submitted.remoteJobId, operationContext);
    expect(completed.state).toBe('completed');
    if (completed.state !== 'completed') throw new Error('Expected completed mock video.');
    const asset = completed.assets[0];
    if (asset?.source !== 'base64') throw new Error('Expected Base64 mock video.');
    const bytes = Buffer.from(asset.base64, 'base64');
    expect(bytes.byteLength).toBe(1_525);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(MOCK_VIDEO_MP4_SHA256);
    expect(bytes).toEqual(readFileSync(new URL('../../../../fixtures/providers/mock/mock-video-v1/tiny.mp4', import.meta.url)));
    expect(asset.resultId).toBe(submitted.remoteJobId);
    await expect(resumed.cancel(submitted.remoteJobId, operationContext)).resolves.toBeUndefined();
  });

  it('exposes deterministic failed, transient, and expired scenarios', async () => {
    for (const scenario of ['failed', 'expired'] as const) {
      let now = 1_000;
      const provider = new MockProviderAdapter({ clock: () => now, videoScenario: scenario });
      const scenarioContext = videoContext([], { mockScenario: 'ignored-by-production' });
      const submitted = await provider.submit(videoRequest(), scenarioContext);
      if (submitted.state !== 'pending') throw new Error('Expected pending mock video.');
      now += MOCK_VIDEO_RUNNING_MS;
      const result = await provider.poll(submitted.remoteJobId, scenarioContext);
      expect(result).toMatchObject({
        state: 'failed',
        error: {
          code: 'mock_video_' + scenario,
          retryable: false,
          kind: scenario === 'expired' ? 'expired' : 'rejected',
        },
      });
    }

    let now = 2_000;
    const provider = new MockProviderAdapter({ clock: () => now, videoScenario: 'transient' });
    const scenarioContext = videoContext([], { mockScenario: 'ignored-by-production' });
    const submitted = await provider.submit(videoRequest(), scenarioContext);
    if (submitted.state !== 'pending') throw new Error('Expected pending mock video.');
    now += 300;
    await expect(provider.poll(submitted.remoteJobId, scenarioContext)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'mock_video_transient', retryable: true, retryAfterMs: MOCK_VIDEO_PENDING_MS },
    });
    now += MOCK_VIDEO_TRANSIENT_RETRY_MS - 300;
    await expect(provider.poll(submitted.remoteJobId, scenarioContext)).resolves.toMatchObject({
      state: 'completed',
    });
  });

  it('uses success when production context contains no test-only scenario injection', async () => {
    const provider = new MockProviderAdapter({ clock: () => 1_000 });
    const submitted = await provider.submit(
      videoRequest(),
      videoContext([], { mockScenario: 'failed' }),
    );
    if (submitted.state !== 'pending') throw new Error('Expected pending mock video.');
    expect(submitted.remoteJobId).toMatch(/^mock-video-success-/);
  });

  it('normalizes validation failures as non-retryable rejections', () => {
    const provider = new MockProviderAdapter();

    expect(provider.normalizeError(new MockProviderValidationError('unsupported'))).toMatchObject({
      code: 'mock_validation_error',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new Error('unexpected'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    });
  });
});
