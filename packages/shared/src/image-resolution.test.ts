import { describe, expect, it } from 'vitest';
import { imageDimensionsPreset, imagePresetDimensions, imageDimensionsAllowed, imageResolutionAllows, inferImageResolution, prepareNativeImageResolution, ImageResolutionCapabilitySchema } from './image-resolution.js';

describe('image resolution presets', () => {
  it.each(['openai-chat-image-v1', 'gemini-generate-content-image-v1', 'gemini-interactions-image-v1'])('preserves declared legacy limits for %s', profile => {
    const values = ['auto', '1024x1024', '2048x2048'];
    const capability = inferImageResolution({ resolutions: values }, profile);
    expect(capability.values).toEqual(values);
    expect(imageResolutionAllows('4K', capability)).toBe(false);
    expect(imageResolutionAllows('3840x3840', capability)).toBe(false);
    const mapped = prepareNativeImageResolution({ resolution: '1024x1024' }, capability);
    expect(mapped.request).toEqual({ resolution: '1K', aspectRatio: '1:1' });
    expect(capability.values).toEqual(values);
  });
  it('allows explicitly configured future native values without inferring additional tiers', () => {
    const imageResolution = ImageResolutionCapabilitySchema.parse({ mode: 'native', values: ['auto', '8K'] });
    expect(inferImageResolution({ resolutions: ['1K'], imageResolution }).values).toEqual(['auto', '8K']);
    expect(imageResolutionAllows('8K', imageResolution)).toBe(true);
    expect(imageResolutionAllows('4K', imageResolution)).toBe(false);
    expect(inferImageResolution({ resolutions: ['8K'] }).mode).toBe('native');
  });
  it('enforces configured pixel bounds independently of a model name', () => {
    const constraints = { multipleOf: 16, maxWidth: 3840, maxHeight: 3840, minPixels: 655360, maxPixels: 8294400, maxAspectRatio: 3 };
    for (const size of ['1024x688', '1360x2048', '3840x2160', '2160x3840']) expect(imageDimensionsAllowed(size, constraints)).toBe(true);
    for (const size of ['1024x683', '3840x3840', '3840x2560', '2560x3840', '4096x2048', '16x16', '3840x1024', 'auto']) expect(imageDimensionsAllowed(size, constraints)).toBe(false);
    expect(imageDimensionsAllowed('2048x1152', { multipleOf: 64, maxPixels: 3_000_000 })).toBe(true);
    expect(imageDimensionsAllowed('2048x1168', { multipleOf: 64 })).toBe(false);
  });
  it.each([
    ['1K', '1:1', '1024x1024'], ['2K', '1:1', '2048x2048'],
    ['1K', '16:9', '1280x720'], ['2K', '16:9', '2048x1152'],
    ['4K', '16:9', '3840x2160'], ['4K', '9:16', '2160x3840'],
    ['4K', '1:1', '3840x3840'], ['4K', '4:3', '3840x2880'], ['4K', '3:4', '2880x3840'],
    ['1K', '3:2', '1024x688'], ['1K', '2:3', '688x1024'],
    ['2K', '3:2', '2048x1360'], ['2K', '2:3', '1360x2048'],
    ['4K', '3:2', '3840x2560'], ['4K', '2:3', '2560x3840'],
  ])('maps %s at %s and recovers its preset', (preset, ratio, dimensions) => {
    expect(imagePresetDimensions(preset, ratio)).toBe(dimensions);
    expect(imageDimensionsPreset(dimensions)).toEqual({ preset, ratio });
  });
  it('never derives square dimensions from an automatic or missing ratio', () => {
    for (const preset of ['1K', '2K', '4K']) {
      for (const ratio of ['auto', '', 'invalid']) expect(imagePresetDimensions(preset, ratio)).toBeUndefined();
    }
  });
  it('recognizes saved legacy dimensions without treating arbitrary sizes as presets', () => {
    expect(imageDimensionsPreset('4096x2304')).toEqual({ preset: '4K', ratio: '16:9' });
    expect(imageDimensionsPreset('1024x683')).toEqual({ preset: '1K', ratio: '3:2' });
    expect(imageDimensionsPreset('4096x4096')).toEqual({ preset: '4K', ratio: '1:1' });
    for (const value of ['0x0', '999999x999999', '1024x1', '1k']) expect(imageDimensionsPreset(value)).toBeUndefined();
  });
});
