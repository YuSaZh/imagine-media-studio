import { describe, expect, it } from 'vitest';
import { matchModelProtocol, modelDisplayName } from './model-names.js';
import { resolveModelProfile } from './provider-protocols.js';

describe('model names and protocols', () => {
  it('matches model families independently of the connection and preserves explicit overrides', () => {
    for (const [id, profile] of [
      ['gpt-image-2-auto', 'openai-images-v1'], ['gpt-4.1', 'openai-responses-image-v1'],
      ['grok-imagine-image-2.0', 'xai-imagine-image-v1'], ['grok-imagine-video-1.5', 'xai-imagine-video-v1'],
      ['models/gemini-3.1-flash-image', 'gemini-generate-content-image-v1'], ['veo-3.1-generate-preview', 'gemini-veo-operation-v1'], ['sora-2', 'openai-videos-v1-compatible'],
    ]) expect(matchModelProtocol(id!)).toBe(profile);
    expect(matchModelProtocol('private-gpt-image')).toBeUndefined();
    expect(resolveModelProfile('openai', 'image.generate', 'gemini-3.1-flash-image')).toBe('gemini-generate-content-image-v1');
    expect(resolveModelProfile('openai', 'image.generate', 'grok-imagine-image')).toBe('xai-imagine-image-v1');
    expect(resolveModelProfile('xai', 'image.generate', 'gpt-image-2')).toBe('openai-images-v1');
    expect(resolveModelProfile('openai', 'image.generate', 'gemini-3.1-flash-image', 'openai-responses-image-v1')).toBe('openai-responses-image-v1');
    expect(resolveModelProfile('xai', 'image.generate', 'unlisted')).toBe('xai-imagine-image-v1');
  });
  it('maps known IDs exactly and preserves unknown IDs', () => {
    expect(modelDisplayName('gpt-image-2')).toBe('GPT Image 2');
    expect(modelDisplayName('models/gemini-3.1-flash-image')).toBe('Nano Banana 2');
    for (const id of ['gpt-image-2-auto', 'custom/model', 'constructor', 'toString']) expect(modelDisplayName(id)).toBe(id);
  });
  it('uses explicit protocols across families while rejecting media kind mismatches', () => {
    expect(resolveModelProfile('openai', 'image.generate', 'gemini-3.1-flash-image', 'gemini-generate-content-image-v1')).toBe('gemini-generate-content-image-v1');
    expect(resolveModelProfile('openai', 'video.generate', 'grok-imagine-video', 'xai-imagine-video-v1')).toBe('xai-imagine-video-v1');
    expect(resolveModelProfile('openai', 'image.generate', 'custom')).toBe('openai-images-v1');
    expect(() => resolveModelProfile('openai', 'image.generate', 'custom', 'xai-imagine-video-v1')).toThrow();
  });
});
