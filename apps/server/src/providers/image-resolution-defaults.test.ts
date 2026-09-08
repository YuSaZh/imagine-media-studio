import { describe, expect, it } from 'vitest';
import { imageResolutionAllows } from '@imagine/shared';
import { builtinImageResolution, storedImageResolution } from './image-resolution-defaults.js';

describe('image resolution default templates', () => {
  it('supplies the same default limits for versioned aliases', () => {
    expect(builtinImageResolution('gpt-image-2-2026-04-21', 'openai-images-v1')).toEqual(builtinImageResolution('gpt-image-2', 'openai-images-v1'));
    expect(builtinImageResolution('gemini-2.5-flash-image-preview', 'gemini-generate-content-image-v1')).toEqual(builtinImageResolution('gemini-2.5-flash-image', 'gemini-generate-content-image-v1'));
  });
  it('preserves declared values for both known and unknown models', () => {
    const resolutions = ['auto', '1024x1024', '2048x2048'];
    for (const name of ['future-custom-model', 'gemini-3.1-flash-image']) {
      const capability = storedImageResolution({ resolutions }, name, 'openai-chat-image-v1');
      expect(capability.values).toEqual(resolutions);
      expect(imageResolutionAllows('4K', capability)).toBe(false);
    }
  });
  it('uses explicit capabilities independently of model ID and builtin defaults', () => {
    const imageResolution = { mode: 'pixels' as const, values: ['auto'], allowCustomDimensions: true, dimensions: { maxWidth: 2048, maxHeight: 2048, maxPixels: 3_000_000, multipleOf: 64 } };
    for (const name of ['gpt-image-2', 'renamed-private-model', 'future-image']) {
      const capability = storedImageResolution({ imageResolution }, name, 'openai-images-v1');
      expect(capability).toEqual(imageResolution);
      expect(imageResolutionAllows('2048x1152', capability)).toBe(true);
      expect(imageResolutionAllows('2048x2048', capability)).toBe(false);
    }
  });
  it('does not widen legacy parameter options when the top-level list is absent', () => {
    const capability = storedImageResolution({ parameters: [{ path: 'resolution', type: 'select', options: ['1K'] }] }, 'gemini-3.1-flash-image', 'openai-chat-image-v1');
    expect(capability.values).toEqual(['1K']);
    expect(imageResolutionAllows('4K', capability)).toBe(false);
  });
});
