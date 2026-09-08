import { describe, expect, it, vi } from 'vitest';
import type { GenerationRequest, ImageResolutionCapability } from '@imagine/shared';
import { OpenAiProviderAdapter } from './openai/provider.js';
import { buildChatImagePayload } from './openai/chat.js';
import { buildGeminiGenerateContentPayload } from './gemini/payload.js';
import { GeminiInteractionsImageProvider } from './gemini/interactions-provider.js';
import { buildXaiImagineImagePayload } from './xai/xai-imagine-image.js';
import { FamilyProvider } from './family-provider.js';

const request: GenerationRequest = { providerId: 'fixture', modelId: 'private-alias', operation: 'image.generate', prompt: 'fixture', inputs: [] };
const native: ImageResolutionCapability = { mode: 'native', values: ['8K'], allowCustomDimensions: false };
const context = { providerId: 'fixture', modelId: 'private-alias', baseUrl: 'https://fixture.example/v1', secrets: { apiKey: 'fixture-key' }, imageResolution: native };

describe('configured image resolution contracts', () => {
  it('does not invent resolution tiers for an unknown Chat catalog model', async () => {
    const adapter = new OpenAiProviderAdapter({ profile: 'openai-chat-image-v1', models: ['private-future-image'] });
    const catalog = await adapter.getCapabilities(context);
    expect(catalog.models[0]?.capabilities.imageResolution).toEqual({ mode: 'native', values: ['auto'], allowCustomDimensions: false });
  });
  it('carries new native values through Chat and both Gemini protocols without model-name branches', async () => {
    const input = { ...request, resolution: '8K' };
    expect(buildChatImagePayload(input, [], native)).toMatchObject({ image_config: { image_size: '8K' } });
    const generated = buildGeminiGenerateContentPayload(input, context);
    expect(generated.generationConfig.imageConfig).toEqual({ imageSize: '8K' });
    await expect(new GeminiInteractionsImageProvider().validate(input, context)).resolves.toBeUndefined();
    expect(() => buildChatImagePayload({ ...input, resolution: '4K' }, [], native)).toThrow();
  });
  it('retains configured xAI native values for a stored custom model', () => {
    const capability = { ...native, values: ['8k'] };
    expect(buildXaiImagineImagePayload({ ...request, resolution: '8k' }, { ...context, imageResolution: capability })).toMatchObject({ body: { resolution: '8k' } });
  });
  it('converts strictly permitted legacy pixels while preserving their ratio and source objects', () => {
    const capability: ImageResolutionCapability = { mode: 'native', values: ['1024x1024'], allowCustomDimensions: false };
    const input = { ...request, resolution: '1024x1024' };
    expect(buildGeminiGenerateContentPayload(input, { ...context, imageResolution: capability }).generationConfig.imageConfig).toEqual({ imageSize: '1K', aspectRatio: '1:1' });
    expect(input.resolution).toBe('1024x1024');
    expect(capability.values).toEqual(['1024x1024']);
  });
  it('enforces the same pixel limits for arbitrary aliases before making HTTP requests', async () => {
    const http = vi.fn(async () => ({ status: 200, json: { data: [{ b64_json: 'aW1hZ2U=' }] } }));
    const adapter = new OpenAiProviderAdapter({ profile: 'openai-images-v1', http });
    const imageResolution: ImageResolutionCapability = { mode: 'pixels', values: [], allowCustomDimensions: true, dimensions: { multipleOf: 64, maxWidth: 2048, maxHeight: 2048, maxPixels: 3_000_000 } };
    for (const modelId of ['private-alias', 'gpt-image-2-2026-04-21']) {
      const runtime = { ...context, modelId, imageResolution };
      await expect(adapter.validate({ ...request, modelId, resolution: '2048x2048' }, runtime)).rejects.toThrow('resolution');
      await expect(adapter.validate({ ...request, modelId, resolution: '2048x1152' }, runtime)).resolves.toBeUndefined();
    }
    expect(http).not.toHaveBeenCalled();
  });
  it('does not send native-only sizes to pixel-only fallback endpoints', async () => {
    const http = vi.fn(async () => ({ status: 404, json: { error: { message: 'unsupported endpoint' } } }));
    const chat = new OpenAiProviderAdapter({ profile: 'openai-chat-image-v1', http });
    const images = new OpenAiProviderAdapter({ profile: 'openai-images-v1', http });
    const family = new FamilyProvider('openai', new Map([['openai-chat-image-v1', chat], ['openai-images-v1', images]]));
    await expect(family.submit({ ...request, profile: 'openai-chat-image-v1', resolution: '8K' }, context)).rejects.toThrow();
    expect(http).toHaveBeenCalledOnce();
  });
});
