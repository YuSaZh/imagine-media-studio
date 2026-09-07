import { describe, expect, it, vi } from 'vitest';
import { imagePresetDimensions, type GenerationRequest } from '@imagine/shared';
import { OpenAiProviderAdapter } from './provider.js';
import { buildChatImagePayload, normalizeChatImageResponse } from './chat.js';
import type { OpenAiHttpRequest, OpenAiRuntimeContext } from './types.js';

const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' } };
const request: GenerationRequest = { providerId: 'cpa', modelId: 'gemini-3.1-flash-image', operation: 'image.generate', prompt: 'a mountain', inputs: [] };

describe('chat image protocol', () => {
  it('advertises image models and chat-compatible controls', async () => {
    const adapter = new OpenAiProviderAdapter('openai-chat-image-v1');
    const catalog = await adapter.getCapabilities({ providerId: 'cpa', secrets: {} });
    expect(catalog.models[0]).toMatchObject({ id: request.modelId, capabilities: { supportsMask: false, resolutions: ['auto', '512', '1K', '2K', '4K'] } });
    expect(catalog.models.every(model => model.id.includes('image'))).toBe(true);
  });
  it('submits CPA image modalities, dimensions and reference inputs through the protected transport', async () => {
    const dispose = vi.fn();
    const http = vi.fn(async (sent: OpenAiHttpRequest) => {
      expect(sent.url).toBe('https://cpa.example/v1/chat/completions');
      expect(sent.headers.Authorization).toBe('Bearer fixture-key');
      expect(sent.headers['Idempotency-Key']).toBe('job-1');
      expect(JSON.parse(sent.body!)).toMatchObject({ model: request.modelId, modalities: ['image', 'text'], stream: false, image_config: { aspect_ratio: '16:9', image_size: '2K' }, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aW5wdXQ=' } }] }] });
      return { status: 200, json: { choices: [{ message: { content: 'Generated.', images: [image] }, finish_reason: 'stop' }] }, dispose };
    });
    const adapter = new OpenAiProviderAdapter({ profile: 'openai-chat-image-v1', http });
    const context: OpenAiRuntimeContext = { providerId: 'cpa', baseUrl: 'https://cpa.example/v1', secrets: { apiKey: 'fixture-key' }, idempotencyKey: 'job-1', inputs: [{ assetId: 'source', role: 'source', mimeType: 'image/png', bytes: Buffer.from('input') }] };
    const result = await adapter.submit({ ...request, operation: 'image.edit', inputs: [{ assetId: 'source', role: 'source' }], resolution: '2048x1152' }, context);
    expect(result).toMatchObject({ state: 'completed', assets: [{ source: 'base64', mimeType: 'image/jpeg', base64: 'aW1hZ2U=' }] });
    expect(http).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('normalizes structured content and complete CPA image SSE events', () => {
    expect(normalizeChatImageResponse({ choices: [{ message: { content: [image] } }] })).toHaveLength(1);
    const stream = [
      { choices: [{ index: 0, delta: { content: 'Generated.' } }] },
      { choices: [{ index: 0, delta: { images: [{ ...image, index: 0 }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
    expect(normalizeChatImageResponse(`${stream}data: [DONE]\n\n`)).toMatchObject([{ mimeType: 'image/jpeg' }]);
    expect(() => normalizeChatImageResponse(`data: ${JSON.stringify({ choices: [{ delta: { images: [image] } }] })}\n\n`)).toThrow('before completion');
    expect(() => normalizeChatImageResponse(`${stream}data: {"error":{"message":"secret"}}\n\n`)).toThrow('upstream error');
  });

  it('rejects text-only, filtered, excess and unsafe image responses', () => {
    expect(() => normalizeChatImageResponse({ choices: [{ message: { content: 'No image.' } }] })).toThrow('no image');
    expect(() => normalizeChatImageResponse({ choices: [{ finish_reason: 'content_filter', message: { images: [image] } }] })).toThrow('filtered');
    expect(() => normalizeChatImageResponse({ choices: [{ message: { images: [image, image] } }] })).toThrow('more images');
    expect(() => normalizeChatImageResponse({ choices: [{ message: { images: [{ image_url: { url: 'https://example.com/image.png?api_key=secret' } }] } }] })).toThrow('credential');
    expect(() => normalizeChatImageResponse({ choices: [{ message: { images: [{ image_url: { url: 'data:image/jpeg;base64,invalid!' } }] } }] })).toThrow('invalid');
  });

  it('omits automatic dimensions and rejects options it cannot preserve', () => {
    expect(buildChatImagePayload({ ...request, aspectRatio: 'auto', resolution: 'auto' }, [])).not.toHaveProperty('image_config');
    for (const options of [{ count: 2 }, { width: 1024 }, { resolution: '1234x567' }, { resolution: '3840x2160', aspectRatio: '1:1' }, { extra: { quality: 'high' } }]) {
      expect(() => buildChatImagePayload({ ...request, ...options }, [])).toThrow();
    }
  });

  it.each([
    ['1024x1024', '1K', '1:1'], ['3840x2160', '4K', '16:9'],
    ['2160x3840', '4K', '9:16'], ['2048x1152', '2K', '16:9'],
  ])('maps %s to the upstream Chat contract', (resolution, preset, ratio) => {
    expect(buildChatImagePayload({ ...request, resolution }, [])).toMatchObject({ image_config: { image_size: preset, aspect_ratio: ratio } });
  });

  it('preserves native size presets directly', () => {
    expect(buildChatImagePayload({ ...request, resolution: '2K', aspectRatio: '16:9' }, [])).toMatchObject({ image_config: { image_size: '2K', aspect_ratio: '16:9' } });
  });

  it('sends identical image settings to CPA and the New API Gemini bridge', () => {
    const payload = buildChatImagePayload({ ...request, resolution: '3840x2160' }, []);
    expect(payload).toMatchObject({ image_config: { image_size: '4K', aspect_ratio: '16:9' }, extra_body: { google: { image_config: { image_size: '4K', aspect_ratio: '16:9' } } } });
    expect(buildChatImagePayload({ ...request, resolution: 'auto', aspectRatio: 'auto' }, [])).not.toHaveProperty('extra_body');
  });

  it('reads New API Markdown inline images from non-streaming content', () => {
    const content = 'Generated.\n![image](data:image/png;base64,aW1hZ2U=)';
    for (const value of [content, [{ type: 'text', text: content }]]) {
      expect(normalizeChatImageResponse({ choices: [{ message: { content: value }, finish_reason: 'stop' }] })).toMatchObject([{ mimeType: 'image/png', base64: 'aW1hZ2U=' }]);
    }
  });

  it('joins split Markdown data URLs across SSE chunks and keeps choices separate', () => {
    const content = '![image](data:image/png;base64,aW1hZ2U=)';
    const stream = [...content].map(char => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: char } }] })}\n\n`).join('');
    const stop = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    expect(normalizeChatImageResponse(stream + stop)).toMatchObject([{ base64: 'aW1hZ2U=' }]);
    expect(() => normalizeChatImageResponse(stream)).toThrow('before completion');
    const splitChoices = { choices: [{ index: 0, message: { content: content.slice(0, 20) } }, { index: 1, message: { content: content.slice(20) } }] };
    expect(() => normalizeChatImageResponse(splitChoices)).toThrow('no image');
  });

  it('rejects invalid, excess and filtered Markdown images without fetching text links', () => {
    const markdown = '![image](data:image/png;base64,aW1hZ2U=)';
    for (const content of ['![image](data:image/png;base64,invalid!)', markdown + markdown, '![image](http://169.254.169.254/image.png)', '![image](data:text/html;base64,aW1hZ2U=)']) {
      expect(() => normalizeChatImageResponse({ choices: [{ message: { content } }] })).toThrow();
    }
    expect(() => normalizeChatImageResponse({ choices: [{ message: { content: markdown }, finish_reason: 'content_filter' }] })).toThrow('filtered');
  });

  it.each(['1K', '2K', '4K'])('sends %s wide pixel dimensions unchanged through Images', async preset => {
    const resolution = imagePresetDimensions(preset, '16:9')!;
    const http = vi.fn(async (sent: OpenAiHttpRequest) => {
      expect(sent.url).toBe('https://cpa.example/v1/images/generations');
      expect(JSON.parse(sent.body!)).toMatchObject({ model: 'gpt-image-2', size: resolution });
      return { status: 200, json: { data: [{ b64_json: 'aW1hZ2U=' }] } };
    });
    const adapter = new OpenAiProviderAdapter({ profile: 'openai-images-v1', http });
    await adapter.submit({ ...request, modelId: 'gpt-image-2', resolution }, { providerId: 'cpa', baseUrl: 'https://cpa.example/v1', secrets: { apiKey: 'fixture-key' } });
    expect(http).toHaveBeenCalledOnce();
  });
});
