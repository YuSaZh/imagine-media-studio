import { describe, expect, it } from 'vitest';
import { modelDisplayName } from './model-names.js';
import { resolveModelProfile } from './provider-protocols.js';

describe('model names and protocols', () => {
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
