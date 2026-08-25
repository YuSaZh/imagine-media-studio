import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMAGE_INPUT_POLICY,
  assertNoImageUpscale,
  fitImageWithin,
  validateImageInputs,
  type ImageInputPolicy,
  type ImageInputPolicyError,
} from './image-input-policy.js';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 747_796_405) + 2_891_336_453) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const constrainedPolicy: ImageInputPolicy = {
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  maxCount: 2,
  maxFileBytes: 10,
  maxTotalBytes: 15,
  maxPixels: 100,
  maxWidth: 10,
  maxHeight: 10,
};

describe('image input policy and geometry', () => {
  it('accepts bounded image descriptors and normalizes MIME comparison', () => {
    expect(() => validateImageInputs([
      { mimeType: ' IMAGE/PNG ', bytes: 5, width: 5, height: 5 },
      { mimeType: 'image/jpeg', bytes: 10, width: 10, height: 10 },
    ], constrainedPolicy)).not.toThrow();
    expect(DEFAULT_IMAGE_INPUT_POLICY.maxCount).toBe(4);
  });

  it('reports count, MIME, file, total, dimension, and pixel violations', () => {
    const valid = { mimeType: 'image/png', bytes: 5, width: 5, height: 5 };
    const cases = [
      { inputs: [valid, valid, valid], code: 'image_count_exceeded' },
      { inputs: [{ ...valid, mimeType: 'image/svg+xml' }], code: 'unsupported_image_mime' },
      { inputs: [{ ...valid, bytes: 11 }], code: 'image_file_too_large' },
      { inputs: [{ ...valid, width: 11 }], code: 'image_dimensions_exceeded' },
      { inputs: [{ ...valid, width: 10, height: 11 }], code: 'image_dimensions_exceeded' },
      { inputs: [{ ...valid, bytes: 10, width: 10, height: 10 }, { ...valid, bytes: 6 }], code: 'image_total_bytes_exceeded' },
    ] as const;
    for (const testCase of cases) {
      expect(() => validateImageInputs(testCase.inputs, constrainedPolicy)).toThrowError(
        expect.objectContaining<Partial<ImageInputPolicyError>>({ code: testCase.code }),
      );
    }
    expect(() => validateImageInputs(
      [{ ...valid, width: 6, height: 6 }],
      { ...constrainedPolicy, maxPixels: 35 },
    )).toThrowError(expect.objectContaining<Partial<ImageInputPolicyError>>({
      code: 'image_pixels_exceeded',
    }));
    try {
      validateImageInputs([{ ...valid, width: 0 }], constrainedPolicy);
      throw new Error('Expected invalid dimensions to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_image_metadata', inputIndex: 0 });
    }
  });

  it('fits inside bounds and dimension multiples without upscaling', () => {
    expect(fitImageWithin({ width: 5_000, height: 3_333 }, { width: 1_920, height: 1_920 }, 16)).toEqual({
      width: 1_920,
      height: 1_264,
      scale: 1_264 / 3_333,
      wasResized: true,
    });
    expect(fitImageWithin({ width: 320, height: 240 }, { width: 1_920, height: 1_920 }, 16)).toEqual({
      width: 320,
      height: 240,
      scale: 1,
      wasResized: false,
    });
    expect(() => assertNoImageUpscale(
      { width: 100, height: 100 },
      { width: 101, height: 100 },
    )).toThrowError(expect.objectContaining<Partial<ImageInputPolicyError>>({
      code: 'image_upscale_forbidden',
    }));
  });

  it('never enlarges seeded source dimensions or exceeds requested bounds', () => {
    const random = seeded(0x1a2b3c4d);
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      const source = {
        width: 1 + Math.floor(random() * 20_000),
        height: 1 + Math.floor(random() * 20_000),
      };
      const bounds = {
        width: 1 + Math.floor(random() * 4_096),
        height: 1 + Math.floor(random() * 4_096),
      };
      const fitted = fitImageWithin(source, bounds);
      expect(fitted.width).toBeLessThanOrEqual(source.width);
      expect(fitted.height).toBeLessThanOrEqual(source.height);
      expect(fitted.width).toBeLessThanOrEqual(bounds.width);
      expect(fitted.height).toBeLessThanOrEqual(bounds.height);
      expect(fitted.scale).toBeGreaterThan(0);
      expect(fitted.scale).toBeLessThanOrEqual(1);
    }
  });
});
