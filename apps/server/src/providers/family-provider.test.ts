import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter, ProviderContext, ProviderHttpClientPort } from '@imagine/provider-contract';
import { FamilyProvider } from './family-provider.js';
import { XaiImagineImageProvider, XaiImagineVideoProvider } from './xai/index.js';

describe('shared provider connections', () => {
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
