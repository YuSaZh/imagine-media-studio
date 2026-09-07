import { describe, expect, it } from 'vitest';
import { imageDimensionsPreset, imagePresetDimensions } from './image-resolution.js';

describe('image resolution presets', () => {
  it.each([
    ['1K', '1:1', '1024x1024'], ['2K', '1:1', '2048x2048'],
    ['1K', '16:9', '1280x720'], ['2K', '16:9', '2048x1152'],
    ['4K', '16:9', '3840x2160'], ['4K', '9:16', '2160x3840'],
    ['4K', '4:3', '4096x3072'],
  ])('maps %s at %s and recovers its preset', (preset, ratio, dimensions) => {
    expect(imagePresetDimensions(preset, ratio)).toBe(dimensions);
    expect(imageDimensionsPreset(dimensions)).toEqual({ preset, ratio });
  });
  it('recognizes saved legacy dimensions without treating arbitrary sizes as presets', () => {
    expect(imageDimensionsPreset('4096x2304')).toEqual({ preset: '4K', ratio: '16:9' });
    for (const value of ['0x0', '999999x999999', '1024x1', '1k']) expect(imageDimensionsPreset(value)).toBeUndefined();
  });
});
