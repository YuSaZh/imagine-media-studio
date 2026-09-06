import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderContext, ProviderHttpClientPort } from '@imagine/provider-contract';
import { FamilyProvider } from './family-provider.js';
import { XaiImagineImageProvider, XaiImagineVideoProvider } from './xai/index.js';
import { OpenAiProviderAdapter } from './openai/provider.js';
import { GeminiInteractionsImageProvider } from './gemini/index.js';

describe('shared provider connections', () => {
  const request = { providerId: 'cpa', modelId: 'gemini-3.1-flash-image', operation: 'image.generate' as const, prompt: 'test', inputs: [] };
  const context = { providerId: 'cpa', modelId: request.modelId, baseUrl: 'https://cpa.example/v1', secrets: { apiKey: 'fixture-key' } };
  function fallbackFixture(status: number, message = 'Not found') {
    const calls: string[] = [];
    const dispose = vi.fn();
    const http: ProviderHttpClientPort = { request: async sent => {
      calls.push(sent.url);
      const chat = sent.url.endsWith('/chat/completions');
      return { status: chat ? 200 : status, statusCode: chat ? 200 : status, headers: { 'content-type': 'application/json' }, json: chat ? { choices: [{ message: { images: [{ image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' } }] }, finish_reason: 'stop' }] } : { error: { message } }, dispose };
    } };
    const family = new FamilyProvider('openai', new Map<string, ProviderAdapter>([
      ['gemini-interactions-image-v1', new GeminiInteractionsImageProvider()],
      ['openai-images-v1', new OpenAiProviderAdapter('openai-images-v1')],
      ['openai-chat-image-v1', new OpenAiProviderAdapter('openai-chat-image-v1')],
    ]));
    return { family, calls, dispose, runtime: { ...context, http } };
  }

  it('recovers the deployed CPA Interactions 404 through chat image generation', async () => {
    const { family, calls, dispose, runtime } = fallbackFixture(404);
    const result = await family.submit({ ...request, profile: 'gemini-interactions-image-v1', aspectRatio: '16:9', resolution: '2K' }, runtime);
    expect(result).toMatchObject({ state: 'completed', assets: [{ mimeType: 'image/jpeg' }] });
    expect(calls).toEqual(['https://cpa.example/v1/interactions', 'https://cpa.example/v1/chat/completions']);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it.each([404, 405, 415, 501])('switches protocols on Images HTTP %s', async status => {
    const { family, calls, runtime } = fallbackFixture(status);
    expect(await family.submit({ ...request, profile: 'openai-images-v1' }, runtime)).toMatchObject({ state: 'completed' });
    expect(calls).toHaveLength(2);
  });

  it('recognizes the explicit Images rejection even when the gateway reports 500', async () => {
    const { family, calls, runtime } = fallbackFixture(500, 'not supported model for image generation, only imagen models are supported');
    expect(await family.submit({ ...request, profile: 'openai-images-v1' }, runtime)).toMatchObject({ state: 'completed' });
    expect(calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 408, 409, 422, 429, 500, 502, 503, 504])('does not replay ambiguous, authentication or quota failures on HTTP %s', async status => {
    const { family, calls, runtime } = fallbackFixture(status, 'Request failed');
    await expect(family.submit({ ...request, profile: 'openai-images-v1' }, runtime)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('preserves unsupported options and aborts instead of sending a lossy fallback', async () => {
    const { family, calls, runtime } = fallbackFixture(404);
    await expect(family.submit({ ...request, profile: 'openai-images-v1', extra: { quality: 'high' } }, runtime)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(family.submit({ ...request, profile: 'openai-images-v1' }, { ...runtime, signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('stops after the fallback returns a successful response without an image', async () => {
    const { family, calls, runtime } = fallbackFixture(404);
    const original = runtime.http.request;
    runtime.http.request = async sent => {
      const response = await original(sent);
      return sent.url.endsWith('/chat/completions') ? { ...response, json: { choices: [{ message: { content: 'No image' } }] } } : response;
    };
    await expect(family.submit({ ...request, profile: 'openai-images-v1' }, runtime)).rejects.toThrow('no image');
    expect(calls).toHaveLength(2);
  });
  it('discovers image and video models from one compatible xAI endpoint', async () => {
    const urls: string[] = [];
    const http: ProviderHttpClientPort = { request: async request => {
      urls.push(request.url);
      expect(request.headers.Authorization ?? request.headers.authorization).toBe('Bearer shared-key');
      const missing = request.url.endsWith('/video-generation-models');
      return { status: missing ? 404 : 200, statusCode: missing ? 404 : 200, headers: { 'content-type': 'application/json' }, json: missing ? {} : { data: [{ id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video-1.5' }] }, dispose: async () => {} };
    } };
    const family = new FamilyProvider('xai', new Map<string, ProviderAdapter>([['xai-imagine-image-v1', new XaiImagineImageProvider()], ['xai-imagine-video-v1', new XaiImagineVideoProvider()]]));
    const context: ProviderContext = { providerId: 'shared', baseUrl: 'https://example.com/v1', secrets: { apiKey: 'shared-key' }, http };
    await family.testConnection(context);
    const catalog = await family.getLiveCapabilities(context);
    expect(catalog.providerType).toBe('xai');
    expect(catalog.models.map(model => [model.id, model.capabilities.profile])).toEqual(expect.arrayContaining([
      ['grok-imagine-image-2.0', 'xai-imagine-image-v1'], ['grok-imagine-video-1.5', 'xai-imagine-video-v1'],
    ]));
    expect(urls.every(url => url.startsWith('https://example.com/v1/'))).toBe(true);
  });
  it('routes submit and recovery using the server snapshot and strips internal fields', async () => {
    const image: ProviderAdapter = { type: 'openai-responses-image-v1', getCapabilities: vi.fn(), validate: vi.fn(), submit: vi.fn().mockResolvedValue({ state: 'completed', assets: [] }), normalizeError: vi.fn() };
    const video: ProviderAdapter = { ...image, type: 'xai-imagine-video-v1', submit: vi.fn().mockResolvedValue({ state: 'pending', remoteJobId: 'job' }), poll: vi.fn().mockResolvedValue({ state: 'remote_running' }), cancel: vi.fn().mockResolvedValue(undefined) };
    const family = new FamilyProvider('openai', new Map([[image.type, image], [video.type, video]]));
    const context = { providerId: 'shared', secrets: {} };
    const request = { providerId: 'shared', modelId: 'my-model', operation: 'image.generate' as const, prompt: 'test', inputs: [], profile: 'openai-responses-image-v1' as const };
    await family.submit(request, context);
    expect(image.submit).toHaveBeenCalledWith({ providerId: 'shared', modelId: 'my-model', operation: 'image.generate', prompt: 'test', inputs: [] }, context);
    await family.submit({ ...request, operation: 'video.generate', profile: 'xai-imagine-video-v1' }, context);
    expect(video.submit).toHaveBeenCalledOnce();
    await family.poll('job', { ...context, modelId: 'video', profile: 'xai-imagine-video-v1' });
    await family.cancel('job', { ...context, modelId: 'video', profile: 'xai-imagine-video-v1' });
    expect(video.cancel).toHaveBeenCalledOnce();
    expect(video.poll).toHaveBeenCalledOnce();
    await expect(family.submit({ ...request, profile: 'xai-imagine-image-v1' }, context)).rejects.toThrow();
  });
});
