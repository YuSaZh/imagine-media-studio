import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';
import type { ProviderContext, ProviderInput } from '@imagine/provider-contract';
import { OpenAiVideosProvider } from './openai/videos.js';
import { XaiImagineVideoProvider, buildXaiImagineVideoPayload } from './xai/xai-imagine-video.js';
import { GeminiOmniVideoProvider, buildOmniVideoPayload } from './gemini/omni-video-provider.js';
import { GeminiVeoProvider, buildVeoPayload } from './gemini/veo-provider.js';
import { videoOperationPolicies } from './video-operation-policy.js';
import type { XaiImagineVideoHttpRequest } from './xai/xai-imagine-video.js';
import type { GeminiHttpRequest } from './gemini/types.js';

const input: ProviderInput = { assetId: 'source', role: 'source', mimeType: 'video/mp4', bytes: new Uint8Array([1, 2, 3]), durationSeconds: 8, width: 1280, height: 720 };
const context: ProviderContext = { providerId: 'fixture', secrets: { apiKey: 'fixture-key' }, inputs: [input] };
function request(modelId: string, operation: GenerationRequest['operation'] = 'video.edit'): GenerationRequest {
  return { providerId: 'fixture', modelId, operation, prompt: 'change the lighting', inputs: [{ assetId: 'source', role: 'source' }] };
}
function generated(profile: string, modelId: string, remoteJobId: string): ProviderContext {
  return { ...context, modelId, inputs: [{ ...input, videoSource: { providerId: 'fixture', modelId, profile, remoteJobId, expiresAt: '2099-01-01T00:00:00Z' } }] };
}

describe('video continuation wire contracts', () => {
  it('routes Grok edits and extensions, preserving the source bytes', async () => {
    const http = { request: vi.fn(async (_request: XaiImagineVideoHttpRequest) => ({ statusCode: 200, json: { request_id: 'next-video' } })) };
    const adapter = new XaiImagineVideoProvider({ http });
    for (const operation of ['video.edit', 'video.extend'] as const) {
      const req = request('grok-imagine-video', operation);
      if (operation === 'video.extend') req.durationSeconds = 6;
      const payload = buildXaiImagineVideoPayload(req, context);
      expect(payload.body.video).toEqual({ url: 'data:video/mp4;base64,AQID' });
      await expect(adapter.submit(req, context)).resolves.toMatchObject({ state: 'pending', remoteJobId: 'next-video' });
      expect(http.request.mock.calls.at(-1)?.[0]).toMatchObject({ url: expect.stringMatching(operation === 'video.edit' ? /\/videos\/edits$/ : /\/videos\/extensions$/) });
    }
    expect(() => buildXaiImagineVideoPayload({ ...request('grok-imagine-video'), resolution: '720p' }, context)).toThrow();
    expect(() => buildXaiImagineVideoPayload(request('grok-imagine-video-1.5'), context)).toThrow();
    expect(() => buildXaiImagineVideoPayload(request('grok-imagine-video'), { ...context, inputs: [{ ...input, durationSeconds: 8.71 }] })).toThrow();
  });
  it('uses Sora source IDs and only permits uploaded edits when explicitly configured', async () => {
    const calls: Array<{ url: string; body?: unknown; bodyBytes?: unknown }> = [];
    const adapter = new OpenAiVideosProvider({ baseUrl: 'https://fixture.example/v1', http: async req => { calls.push(req); return { status: 200, json: { id: 'video_next', status: 'queued', model: 'sora-2' } }; } });
    const runtime = generated('openai-videos-v1-compatible', 'sora-2', 'video_source');
    await adapter.submit(request('sora-2'), runtime);
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ video: { id: 'video_source' }, prompt: 'change the lighting' });
    expect(calls[0]?.url).toMatch(/\/videos\/edits$/);
    await adapter.submit({ ...request('sora-2', 'video.extend'), durationSeconds: 8 }, runtime);
    expect(calls[1]?.url).toMatch(/\/videos\/extensions$/);
    expect(JSON.parse(String(calls[1]?.body))).toMatchObject({ seconds: '8' });
    await expect(adapter.validate(request('sora-2'), context)).rejects.toThrow();
    const policy = videoOperationPolicies('openai-videos-v1-compatible', 'sora-2')['video.edit']!;
    await adapter.submit(request('sora-2'), { ...context, operationPolicy: { ...policy, video: { ...policy.video!, allowUploaded: true } } });
    expect(Buffer.from(calls[2]?.bodyBytes as Uint8Array).toString()).toContain('name="video"');
    await expect(adapter.validate(request('sora-2'), { ...runtime, providerId: 'another-account-provider' })).rejects.toThrow();
  });
  it('builds Omni uploaded-video and same-connection stateful continuation requests', async () => {
    const req = request('gemini-omni-1.1-flash');
    const payload = buildOmniVideoPayload(req, context);
    expect(payload).toMatchObject({ input: [{ type: 'video', mime_type: 'video/mp4', data: 'AQID' }, { type: 'text' }], generation_config: { video_config: { task: 'edit' } } });
    const stateful = buildOmniVideoPayload({ ...req, operation: 'video.extend' }, generated('gemini-omni-interactions-video-v1', req.modelId, 'interaction:previous'));
    expect(stateful).toMatchObject({ previous_interaction_id: 'previous', input: req.prompt, generation_config: { video_config: { task: 'extend' } } });
    expect(() => buildOmniVideoPayload(req, { ...context, inputs: [{ ...input, durationSeconds: 11 }] })).toThrow();
    await expect(new GeminiOmniVideoProvider().validate(req, context)).resolves.toBeUndefined();
  });
  it('resolves only trusted Veo sources before extension and supports ordered first/last frames', async () => {
    const http = { request: vi.fn(async (_request: GeminiHttpRequest) => ({ statusCode: 200, body: { name: 'operations/next', done: false } })) };
    const adapter = new GeminiVeoProvider({ transport: http });
    const resolver = vi.spyOn(adapter, 'resolveResult').mockResolvedValue({ url: 'https://generativelanguage.googleapis.com/v1beta/files/source:download?alt=media' });
    const runtime = generated('gemini-veo-operation-v1', 'veo-3.1-generate-preview', 'operation:operations/source');
    await adapter.submit(request('veo-3.1-generate-preview', 'video.extend'), runtime);
    expect(resolver).toHaveBeenCalledOnce();
    const call = http.request.mock.calls[0]?.[0] as { body?: string } | undefined;
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ instances: [{ video: { uri: expect.stringContaining('/files/source'), mimeType: 'video/mp4' } }], parameters: { resolution: '720p', durationSeconds: '8' } });
    await expect(adapter.validate(request('veo-3.1-lite-generate-preview', 'video.extend'), runtime)).rejects.toThrow();
    await expect(adapter.validate(request('veo-3.1-generate-preview', 'video.extend'), context)).rejects.toThrow();
    const frames = [{ ...input, assetId: 'end', role: 'last_frame' as const, mimeType: 'image/png' }, { ...input, assetId: 'start', role: 'first_frame' as const, mimeType: 'image/png' }];
    const frameRequest = { ...request('veo-3.1-generate-preview', 'video.image_to_video'), inputs: frames.map(({ assetId, role }) => ({ assetId, role })) };
    expect(buildVeoPayload(frameRequest, { ...context, inputs: frames }).instances[0]).toHaveProperty('lastFrame');
    expect(buildOmniVideoPayload({ ...frameRequest, modelId: 'gemini-omni-1.1-flash' }, { ...context, inputs: frames }).input).toHaveLength(3);
  });
});
