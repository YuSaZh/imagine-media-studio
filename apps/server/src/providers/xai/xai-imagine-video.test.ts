import { readFileSync } from 'node:fs';

import type { GenerationRequest } from '@imagine/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderHttpError } from '../provider-http-client.js';
import { UnsafeRemoteUrlError } from '../../security/network-policy.js';
import {
  XaiImagineVideoHttpError,
  XaiImagineVideoProvider,
  XaiImagineVideoResponseError,
  XaiImagineVideoTransportError,
  XaiImagineVideoValidationError,
  buildXaiImagineVideoPayload,
  getXaiImagineVideoCapabilities,
  type XaiImagineVideoHttpClient,
  type XaiImagineVideoHttpRequest,
  type XaiImagineVideoHttpResponse,
  type XaiImagineVideoInput,
  type XaiImagineVideoProviderContext,
} from './xai-imagine-video.js';

const videoContext: XaiImagineVideoProviderContext = {
  providerId: 'xai-video-provider',
  modelId: 'grok-imagine-video-1.5',
  secrets: {
    apiKey: 'xai-video-test-key',
    'header:X-Trace-Id': 'fixture-trace',
  },
};

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    operation: 'video.generate',
    providerId: 'xai-video-provider',
    modelId: 'grok-imagine-video-1.5',
    prompt: 'A paper boat crossing a quiet lake at sunrise',
    inputs: [],
    ...overrides,
  };
}

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(
    new URL(`../../../../../fixtures/providers/xai/xai-imagine-video-v1/${path}`, import.meta.url),
    'utf8',
  )) as unknown;
}

function jsonResponse(value: unknown, statusCode = 200): XaiImagineVideoHttpResponse {
  return { statusCode, json: value };
}

class FixtureClient implements XaiImagineVideoHttpClient {
  public readonly requests: XaiImagineVideoHttpRequest[] = [];
  private readonly responses: XaiImagineVideoHttpResponse[];

  public constructor(...responses: XaiImagineVideoHttpResponse[]) {
    this.responses = [...responses];
  }

  public async request(input: XaiImagineVideoHttpRequest): Promise<XaiImagineVideoHttpResponse> {
    this.requests.push(input);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fixture response remains.');
    return response;
  }
}

function input(assetId: string, role: XaiImagineVideoInput['role'], mimeType = 'image/png'): XaiImagineVideoInput {
  return { assetId, role, mimeType, bytes: new Uint8Array([1, 2, 3]) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('XaiImagineVideoProvider', () => {
  it('exposes the current official model and omits remote cancel support', async () => {
    const provider = new XaiImagineVideoProvider();
    expect(getXaiImagineVideoCapabilities()).toMatchObject({
      providerType: 'xai-imagine-video-v1',
      models: [
        {
          id: 'grok-imagine-video',
          capabilities: {
            operations: ['video.generate', 'video.image_to_video'],
            resolutions: ['480p', '720p'],
            maxReferenceImages: 0,
          },
        },
        {
          id: 'grok-imagine-video-1.5',
          capabilities: {
            operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
            aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
            resolutions: ['480p', '720p', '1080p'],
            durations: { min: 1, max: 15 },
            maxReferenceImages: 7,
            supportsAudio: true,
            supportsProgress: true,
            supportsCancel: false,
            maxBatchCount: 1,
          },
        },
      ],
    });
    await expect(provider.getCapabilities(videoContext)).resolves.toEqual(getXaiImagineVideoCapabilities());
    expect('cancel' in XaiImagineVideoProvider.prototype).toBe(false);
  });

  it('submits official text-to-video JSON using only injected HTTP', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));
    const result = await provider.submit(request({
      durationSeconds: 10,
      aspectRatio: '16:9',
      resolution: '720p',
    }), videoContext);

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual(fixture('submit-text-request.json'));
    expect(client.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.x.ai/v1/videos/generations',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer xai-video-test-key',
      },
    });
    expect(result).toEqual(fixture('expected-normalized.json'));
    expect(JSON.stringify(result)).not.toContain('xai-video-test-key');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serializes one loader-resolved first frame as an image data URI', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const firstFrame = request({
      operation: 'video.image_to_video',
      prompt: 'Animate this still image with a slow camera move',
      durationSeconds: 12,
      inputs: [{ assetId: 'frame-1', role: 'first_frame' }],
    });
    await expect(provider.submit(firstFrame, {
      ...videoContext,
      inputs: [input('frame-1', 'first_frame')],
    })).resolves.toMatchObject({ state: 'pending', remoteJobId: 'req_fixture_001' });

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual(fixture('submit-image-request.json'));
    expect(client.requests[0]?.body).not.toContain('xai-video-test-key');
  });

  it('serializes one through seven reference images without persisting source URLs', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const referenceRequest = request({
      operation: 'video.reference_to_video',
      prompt: 'Place the subjects together in a sunny park',
      durationSeconds: 8,
      aspectRatio: '9:16',
      resolution: '720p',
      inputs: [
        { assetId: 'reference-1', role: 'reference' },
        { assetId: 'reference-2', role: 'reference' },
      ],
    });
    const result = await provider.submit(referenceRequest, {
      ...videoContext,
      inputs: [
        { ...input('reference-1', 'reference', 'image/jpeg'), bytes: new Uint8Array([4, 5, 6]) },
        { ...input('reference-2', 'reference'), bytes: new Uint8Array([7, 8, 9]) },
      ],
    });

    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toEqual(fixture('submit-reference-request.json'));
    expect(result).toMatchObject({ state: 'pending', remoteJobId: 'req_fixture_001' });
    expect(JSON.stringify(result)).not.toContain('data:image');
  });

  it('maps pending, running, done, failed, and expired poll fixtures', async () => {
    const client = new FixtureClient(
      jsonResponse(fixture('poll-pending.json')),
      jsonResponse(fixture('poll-running.json')),
      jsonResponse(fixture('poll-done.json')),
      jsonResponse(fixture('poll-failed.json')),
      jsonResponse(fixture('poll-expired.json')),
    );
    const provider = new XaiImagineVideoProvider({ http: client });

    await expect(provider.poll('req_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'remote_pending',
      progress: 12,
      pollAfterMs: 5_000,
    });
    await expect(provider.poll('req_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'remote_running',
      progress: 42,
    });
    const completed = await provider.poll('req_fixture_001', videoContext);
    expect(completed).toMatchObject({
      state: 'completed',
      assets: [{
        source: 'provider',
        providerId: 'xai-video-provider',
        remoteJobId: 'req_fixture_001',
        resultId: 'req_fixture_001',
        variant: 'video',
      }],
    });
    expect(JSON.stringify(completed)).not.toContain('vidgen.x.ai');
    await expect(provider.poll('req_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'xai_content_policy_violation', retryable: false },
    });
    await expect(provider.poll('req_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'xai_result_expired', kind: 'expired', retryable: false },
    });
    expect(client.requests.map((item) => [item.method, item.url])).toEqual([
      ['GET', 'https://api.x.ai/v1/videos/req_fixture_001'],
      ['GET', 'https://api.x.ai/v1/videos/req_fixture_001'],
      ['GET', 'https://api.x.ai/v1/videos/req_fixture_001'],
      ['GET', 'https://api.x.ai/v1/videos/req_fixture_001'],
      ['GET', 'https://api.x.ai/v1/videos/req_fixture_001'],
    ]);
  });

  it('re-resolves a completed result URL ephemerally and never stores it in the asset', async () => {
    const client = new FixtureClient(jsonResponse(fixture('poll-done.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const target = await provider.resolveResult({
      type: 'video',
      mimeType: 'video/mp4',
      source: 'provider',
      providerId: 'xai-video-provider',
      remoteJobId: 'req_fixture_001',
      resultId: 'req_fixture_001',
      variant: 'video',
    }, videoContext);

    expect(target).toEqual({
      url: 'https://vidgen.x.ai/videos/req_fixture_001.mp4?expires=1999999999',
      headers: {
        Accept: 'video/mp4',
      },
      claimedMimeType: 'video/mp4',
    });
    expect(JSON.stringify(target)).toContain('expires=');
    expect(JSON.stringify(target)).not.toContain('xai-video-test-key');
    expect(JSON.stringify(target)).not.toContain('fixture-trace');
    expect(client.requests[0]?.url).toBe('https://api.x.ai/v1/videos/req_fixture_001');
  });

  it('only sends authenticated custom headers to same-origin result targets', async () => {
    const client = new FixtureClient(jsonResponse({
      request_id: 'req_fixture_001',
      status: 'done',
      model: 'grok-imagine-video-1.5',
      video: {
        url: 'https://api.x.ai/v1/videos/req_fixture_001.mp4?expires=1999999999',
        duration: 1,
        respect_moderation: true,
      },
    }));
    const provider = new XaiImagineVideoProvider({ http: client });
    const target = await provider.resolveResult({
      type: 'video', mimeType: 'video/mp4', source: 'provider', providerId: 'xai-video-provider',
      remoteJobId: 'req_fixture_001', resultId: 'req_fixture_001', variant: 'video',
    }, videoContext);
    expect(target.headers).toMatchObject({
      Authorization: 'Bearer xai-video-test-key',
      'X-Trace-Id': 'fixture-trace',
      Accept: 'video/mp4',
    });
  });

  it('maps an expired result observed during re-resolution to the terminal expiry kind', async () => {
    const client = new FixtureClient(jsonResponse(fixture('poll-expired.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    let caught: unknown;
    try {
      await provider.resolveResult({
        type: 'video',
        mimeType: 'video/mp4',
        source: 'provider',
        providerId: 'xai-video-provider',
        remoteJobId: 'req_fixture_001',
        resultId: 'req_fixture_001',
        variant: 'video',
      }, videoContext);
    } catch (error) {
      caught = error;
    }
    expect(provider.normalizeError(caught)).toMatchObject({
      code: 'xai_result_expired',
      kind: 'expired',
      retryable: false,
    });
  });

  it('uses custom base URL and headers while rejecting protected header overrides', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({
      http: client,
      baseUrl: 'https://proxy.example.test/xai/v1',
      headers: { 'X-Configured': 'yes' },
    });
    await provider.submit(request({ audio: false }), {
      ...videoContext,
      baseUrl: '   ',
      headers: { 'X-Request': 'yes', 'x-configured': 'context' },
      idempotencyKey: 'idempotency-fixture',
    } as XaiImagineVideoProviderContext);
    expect(client.requests[0]).toMatchObject({
      url: 'https://proxy.example.test/xai/v1/videos/generations',
      headers: {
        'x-configured': 'context',
        'X-Request': 'yes',
        'X-Trace-Id': 'fixture-trace',
        'Idempotency-Key': 'idempotency-fixture',
      },
    });
    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toMatchObject({ generate_audio: false });

    for (const name of ['accept', 'authorization', 'content-type', 'idempotency-key']) {
      const blocked = new XaiImagineVideoProvider({ http: client });
      await expect(blocked.submit(request(), {
        ...videoContext,
        headers: { [name]: 'override' },
      } as XaiImagineVideoProviderContext)).rejects.toBeInstanceOf(XaiImagineVideoValidationError);
    }
  });

  it('rejects URL input bypasses and enforces operation cardinality and options', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    await expect(provider.validate(request({ inputs: [input('unexpected', 'reference')] }), videoContext))
      .rejects.toMatchObject({ code: 'xai_generation_inputs_unsupported' });
    await expect(provider.validate(request({ operation: 'video.image_to_video' }), videoContext))
      .rejects.toMatchObject({ code: 'xai_first_frame_invalid' });
    await expect(provider.validate(request({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'reference' }],
    }), videoContext)).rejects.toMatchObject({ code: 'xai_first_frame_invalid' });
    await expect(provider.validate(request({
      operation: 'video.reference_to_video',
      inputs: [],
    }), videoContext)).rejects.toMatchObject({ code: 'xai_reference_limit' });
    await expect(provider.validate(request({
      operation: 'video.reference_to_video',
      resolution: '1080p',
      inputs: [{ assetId: 'ref', role: 'reference' }],
    }), videoContext)).rejects.toMatchObject({ code: 'xai_resolution_unsupported' });
    const longReference = request({
      operation: 'video.reference_to_video',
      durationSeconds: 15,
      inputs: [{ assetId: 'ref', role: 'reference' }],
    });
    const resolvedReferenceContext = { ...videoContext, inputs: [input('ref', 'reference')] };
    await expect(provider.validate(longReference, resolvedReferenceContext)).resolves.toBeUndefined();
    await provider.submit(longReference, resolvedReferenceContext);
    expect(JSON.parse(client.requests[0]?.body ?? '{}'))
      .toMatchObject({ duration: 15, reference_images: [{ url: expect.stringMatching(/^data:image\/png;base64,/u) }] });
    await expect(provider.validate(request({ durationSeconds: 16 }), videoContext))
      .rejects.toMatchObject({ code: 'xai_duration_unsupported' });
    await expect(provider.validate(request({ durationSeconds: 1.5 }), videoContext))
      .rejects.toMatchObject({ code: 'xai_duration_unsupported' });
    await expect(provider.validate(request({ count: 2 }), videoContext))
      .rejects.toMatchObject({ code: 'xai_count_unsupported' });
    await expect(provider.validate(request({ negativePrompt: 'no text' }), videoContext))
      .rejects.toMatchObject({ code: 'xai_option_unsupported' });
    await expect(provider.validate(request({ format: 'mp4' }), videoContext))
      .rejects.toMatchObject({ code: 'xai_option_unsupported' });

    const withUrl = {
      ...input('frame', 'first_frame'),
      url: 'https://private.example.test/frame.png',
    } as unknown as XaiImagineVideoInput;
    await expect(provider.submit(request({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), { ...videoContext, inputs: [withUrl] })).rejects.toThrow('not a URL');

    await expect(provider.validate(request({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), videoContext)).rejects.toMatchObject({ code: 'xai_input_missing' });
  });

  it('requires bytes/data URI resolved by the loader and validates MIME and size bounds', async () => {
    const provider = new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse(fixture('submit-response.json'))) });
    const imageRequest = request({
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    });
    await expect(provider.submit(imageRequest, videoContext)).rejects.toThrow('not resolved');
    await expect(provider.submit(imageRequest, {
      ...videoContext,
      inputs: [input('frame', 'first_frame', 'application/pdf')],
    })).rejects.toMatchObject({ code: 'xai_unsupported_input_type' });
    await expect(provider.submit(imageRequest, {
      ...videoContext,
      inputs: [{ ...input('frame', 'first_frame'), bytes: new Uint8Array() }],
    })).rejects.toMatchObject({ code: 'xai_input_size_invalid' });
    await expect(provider.submit(imageRequest, {
      ...videoContext,
      inputs: [{
        ...input('frame', 'first_frame'),
        bytes: undefined,
        dataUri: 'data:image/png;base64,AQID',
      } as unknown as XaiImagineVideoInput],
    })).resolves.toMatchObject({ state: 'pending' });
  });

  it('rejects malformed bounded responses, mismatched ids, unsafe URLs, and failed moderation', async () => {
    const cases: Array<[unknown, string]> = [
      [{ request_id: 'other', status: 'pending' }, 'different request id'],
      [{ request_id: 'req_fixture_001', status: 'unknown' }, 'unknown video status'],
      [{ status: 'pending' }, 'missing the requested id'],
      [{ request_id: 'req_fixture_001', status: 'pending', progress: 101 }, 'invalid progress'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://user:pass@vidgen.x.ai/a.mp4', duration: 4, respect_moderation: true } }, 'unsafe result URL'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://vidgen.x.ai/a.mp4?signature=secret', duration: 4, respect_moderation: true } }, 'credential-like query'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: `https://vidgen.x.ai/${'x'.repeat(4_100)}.mp4`, duration: 4, respect_moderation: true } }, 'invalid result URL'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'http://vidgen.x.ai/a.mp4', duration: 4, respect_moderation: true } }, 'unsafe result URL'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://vidgen.x.ai/a.mp4', duration: 16, respect_moderation: true } }, 'invalid video duration'],
      [{ request_id: 'req_fixture_001', status: 'done', model: 'grok-imagine-video-1.5', video: { url: 'https://vidgen.x.ai/a.mp4', duration: 4, respect_moderation: false } }, 'successful moderation'],
    ];
    for (const [body, message] of cases) {
      const provider = new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse(body)) });
      await expect(provider.poll('req_fixture_001', videoContext)).rejects.toThrow(message);
    }
    const huge = { request_id: 'req_fixture_001', status: 'pending', detail: 'x'.repeat(2 * 1024 * 1024) };
    await expect(new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse(huge)) }).poll('req_fixture_001', videoContext))
      .rejects.toBeInstanceOf(XaiImagineVideoResponseError);
    const streamLike = { pipe: () => streamLike };
    await expect(new XaiImagineVideoProvider({ http: new FixtureClient({ statusCode: 200, body: streamLike as never }) }).poll('req_fixture_001', videoContext))
      .rejects.toThrow('pre-parsed');

    await expect(new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse({
      request_id: 'req_fixture_001',
      status: 'done',
      model: 'grok-imagine-video-1.5',
      video: { url: 'https://vidgen.x.ai/a.mp4', duration: 1.5, respect_moderation: true },
    })) }).poll('req_fixture_001', videoContext)).rejects.toThrow('duration');

    const expiredUrl = `https://vidgen.x.ai/a.mp4?expires=${Math.floor(Date.now() / 1_000) - 1}`;
    await expect(new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse({
      request_id: 'req_fixture_001',
      status: 'done',
      model: 'grok-imagine-video-1.5',
      video: { url: expiredUrl, duration: 1, respect_moderation: true },
    })) }).poll('req_fixture_001', videoContext)).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'xai_result_expired', kind: 'expired', retryable: false },
    });

    const invalidJsonProvider = new XaiImagineVideoProvider({ http: new FixtureClient({
      statusCode: 200,
      json: async () => { throw new Error('malformed response'); },
    }) });
    let invalidJsonError: unknown;
    try {
      await invalidJsonProvider.poll('req_fixture_001', videoContext);
    } catch (error) {
      invalidJsonError = error;
    }
    expect(invalidJsonProvider.normalizeError(invalidJsonError)).toMatchObject({
      code: 'xai_invalid_response',
      kind: 'rejected',
      retryable: false,
    });
  });

  it('refreshes all bounded video models without config and tests connection through injected GET', async () => {
    const client = new FixtureClient(jsonResponse(fixture('models-response-safe-id.json')), jsonResponse(fixture('connection-success.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real network is forbidden'));
    const live = await provider.getLiveCapabilities({ ...videoContext, baseUrl: 'https://proxy.example.test/xai/v1' });
    expect(live).toMatchObject({
      providerType: 'xai-imagine-video-v1',
      models: [
        { id: 'grok-imagine-video', capabilities: { operations: ['video.generate', 'video.image_to_video'], maxReferenceImages: 0 } },
        { id: 'grok-imagine-video-1.5', capabilities: { operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'], maxReferenceImages: 7 } },
        { id: 'grok-video-unknown-preview', capabilities: { operations: ['video.generate'], maxReferenceImages: 0 } },
        { id: 'video-model', capabilities: { operations: ['video.generate'], maxReferenceImages: 0 } },
      ],
    });
    await expect(provider.validate(request({ modelId: 'grok-video-unknown-preview' }), videoContext)).resolves.toBeUndefined();
    await expect(provider.validate(request({ modelId: 'video-model' }), videoContext)).resolves.toBeUndefined();
    await expect(provider.validate(request({ modelId: 'video-model?token=secret' }), videoContext))
      .rejects.toMatchObject({ code: 'xai_model_unsupported' });
    const customClient = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const customProvider = new XaiImagineVideoProvider({ http: customClient });
    await expect(customProvider.submit(request({ modelId: 'video-model' }), videoContext)).resolves.toMatchObject({
      state: 'pending',
      remoteJobId: 'req_fixture_001',
    });
    expect(JSON.parse(customClient.requests[0]?.body ?? '{}')).toMatchObject({ model: 'video-model' });
    await provider.testConnection(videoContext);
    expect(client.requests.map((item) => ({ method: item.method, url: item.url, hasBody: item.body !== undefined }))).toEqual([
      { method: 'GET', url: 'https://proxy.example.test/xai/v1/video-generation-models', hasBody: false },
      { method: 'GET', url: 'https://api.x.ai/v1/video-generation-models', hasBody: false },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps explicitly configured unknown video models conservative and filters non-video models', async () => {
    const client = new FixtureClient(jsonResponse(fixture('models-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    const capabilities = await provider.getLiveCapabilities({
      ...videoContext,
      config: { models: ['grok-video-unknown-preview'] },
    });
    expect(capabilities.models).toMatchObject([{
      id: 'grok-video-unknown-preview',
      capabilities: {
        operations: ['video.generate'],
        resolutions: ['480p'],
        maxReferenceImages: 0,
      },
    }]);
    await expect(provider.validate(request({ modelId: 'grok-imagine-image-2.0' }), {
      ...videoContext,
      config: { models: ['grok-imagine-image-2.0'] },
    })).rejects.toMatchObject({ code: 'xai_model_unsupported' });

    const knownClient = new FixtureClient(jsonResponse(fixture('models-response.json')));
    const knownProvider = new XaiImagineVideoProvider({ http: knownClient });
    await expect(knownProvider.getLiveCapabilities({
      ...videoContext,
      config: { models: ['grok-imagine-video-1.5'] },
    })).resolves.toMatchObject({ models: [{ id: 'grok-imagine-video-1.5' }] });
  });

  it('accepts the official base video model and keeps configured model validation consistent', async () => {
    const client = new FixtureClient(jsonResponse(fixture('submit-response.json')));
    const provider = new XaiImagineVideoProvider({ http: client });
    await provider.submit(request({ modelId: 'grok-imagine-video', resolution: '720p' }), videoContext);
    expect(JSON.parse(client.requests[0]?.body ?? '{}')).toMatchObject({
      model: 'grok-imagine-video',
      resolution: '720p',
    });
    await expect(provider.validate(request({ modelId: 'grok-imagine-video', resolution: '1080p' }), videoContext))
      .rejects.toMatchObject({ code: 'xai_resolution_unsupported' });
    await expect(provider.validate(request({
      modelId: 'grok-imagine-video',
      operation: 'video.reference_to_video',
      inputs: [{ assetId: 'reference', role: 'reference' }],
    }), { ...videoContext, inputs: [input('reference', 'reference')] }))
      .rejects.toMatchObject({ code: 'xai_operation_unsupported' });
    await expect(provider.validate(request({
      modelId: 'grok-imagine-video',
      operation: 'video.image_to_video',
      inputs: [{ assetId: 'frame', role: 'first_frame' }],
    }), { ...videoContext, inputs: [input('frame', 'first_frame')] })).resolves.toBeUndefined();

    const configured = new XaiImagineVideoProvider({
      http: new FixtureClient(jsonResponse(fixture('submit-response.json'))),
    });
    await expect(configured.validate(request({ modelId: 'grok-video-custom' }), {
      ...videoContext,
      config: { models: ['grok-video-custom'] },
    })).resolves.toBeUndefined();
  });

  it('normalizes HTTP, central transport, abort, and response errors without leaking secrets', async () => {
    const client = new FixtureClient(jsonResponse(fixture('connection-unauthorized.json'), 401));
    const provider = new XaiImagineVideoProvider({ http: client });
    let caught: unknown;
    try {
      await provider.testConnection(videoContext);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(XaiImagineVideoHttpError);
    expect(provider.normalizeError(caught)).toMatchObject({
      code: 'xai_authentication_error',
      kind: 'rejected',
      retryable: false,
      statusCode: 401,
    });
    expect(JSON.stringify(caught)).not.toContain('xai-video-test-key');

    expect(provider.normalizeError(new XaiImagineVideoHttpError(429, { error: { message: 'rate limited' } }, { 'retry-after': '2' }))).toMatchObject({
      code: 'xai_rate_limited',
      kind: 'transient',
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(provider.normalizeError(new ProviderHttpError('invalid_request', 'unsafe'))).toMatchObject({
      code: 'xai_provider_http_invalid_request',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new ProviderHttpError('timeout', 'timeout'))).toMatchObject({
      code: 'xai_provider_http_timeout',
      kind: 'transient',
      retryable: true,
    });
    expect(provider.normalizeError(new UnsafeRemoteUrlError('unsafe'))).toMatchObject({
      code: 'xai_network_policy_denied',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new XaiImagineVideoResponseError('malformed response'))).toMatchObject({
      code: 'xai_invalid_response',
      retryable: false,
    });
    const abort = new Error('cancelled');
    abort.name = 'AbortError';
    expect(provider.normalizeError(new XaiImagineVideoTransportError('aborted', { cause: abort }))).toMatchObject({
      code: 'xai_request_aborted',
      retryable: false,
    });

    const fallbackClient = new FixtureClient({
      statusCode: 503,
      json: async () => { throw new Error('invalid json'); },
      text: 'upstream temporarily unavailable',
      headers: { 'retry-after': '2' },
    });
    let fallbackError: unknown;
    try {
      await new XaiImagineVideoProvider({ http: fallbackClient }).testConnection(videoContext);
    } catch (error) {
      fallbackError = error;
    }
    expect(fallbackError).toBeInstanceOf(XaiImagineVideoHttpError);
    expect((fallbackError as XaiImagineVideoHttpError).statusCode).toBe(503);
    expect(provider.normalizeError(fallbackError)).toMatchObject({ retryable: true, retryAfterMs: 2_000 });
  });

  it('rejects invalid base URL and preserves a safe ephemeral provider target', async () => {
    const provider = new XaiImagineVideoProvider({
      http: new FixtureClient(jsonResponse(fixture('submit-response.json'))),
      baseUrl: 'https://user:pass@proxy.example.test/v1',
    });
    await expect(provider.submit(request(), videoContext)).rejects.toMatchObject({ code: 'xai_base_url_invalid' });
    const targetProvider = new XaiImagineVideoProvider({ http: new FixtureClient(jsonResponse(fixture('poll-done.json'))) });
    await expect(targetProvider.resolveResult({
      type: 'video',
      mimeType: 'video/mp4',
      source: 'provider',
      providerId: 'xai-video-provider',
      remoteJobId: 'req_fixture_001',
      resultId: 'different',
      variant: 'video',
    }, videoContext)).rejects.toThrow('result id');
  });

  it('builds payloads without HTTP access and never uses request asset ids as bytes', () => {
    const payload = buildXaiImagineVideoPayload(request({ audio: true }), videoContext);
    expect(payload.body).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'A paper boat crossing a quiet lake at sunrise',
      generate_audio: true,
    });
    expect(JSON.stringify(payload)).not.toContain('xai-video-test-key');
  });
});
