import { describe, expect, it } from 'vitest';

import {
  assertUsableMaskCoverage,
  classifyMaskRgba,
  orderMaskTargetFirst,
  requireMaskTarget,
} from './mask-target.js';
import type { MaskTargetError } from './mask-target.js';

describe('mask target and canonical alpha coverage', () => {
  const inputs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }] as const;

  it('requires an existing target and keeps every reference in stable target-first order', () => {
    expect(requireMaskTarget(inputs, 'b')).toBe(inputs[1]);
    expect(orderMaskTargetFirst(inputs, 'b').map((input) => input.id)).toEqual(['b', 'a', 'c']);
    expect(orderMaskTargetFirst(inputs, 'a')).toEqual(inputs);
    expect(() => requireMaskTarget(inputs, 'missing')).toThrowError(
      expect.objectContaining<Partial<MaskTargetError>>({ code: 'mask_target_not_found' }),
    );
  });

  it('classifies alpha 0 as edited and alpha 255 as preserved', () => {
    expect(classifyMaskRgba(new Uint8ClampedArray([255, 255, 255, 255]))).toBe('empty');
    expect(classifyMaskRgba(new Uint8ClampedArray([255, 255, 255, 0]))).toBe('full');
    expect(
      classifyMaskRgba(new Uint8ClampedArray([
        255, 255, 255, 255,
        255, 255, 255, 128,
        255, 255, 255, 0,
      ])),
    ).toBe('partial');
  });

  it('rejects malformed RGBA and non-byte alpha values with structured errors', () => {
    expect(() => classifyMaskRgba([])).toThrowError(
      expect.objectContaining<Partial<MaskTargetError>>({ code: 'invalid_rgba_length' }),
    );
    expect(() => classifyMaskRgba([255, 255, 255])).toThrowError(
      expect.objectContaining<Partial<MaskTargetError>>({ code: 'invalid_rgba_length' }),
    );
    expect(() => classifyMaskRgba([255, 255, 255, 12.5])).toThrowError(
      expect.objectContaining<Partial<MaskTargetError>>({ code: 'invalid_mask_alpha' }),
    );
  });

  it('rejects only masks with no edit area', () => {
    expect(() => assertUsableMaskCoverage('empty')).toThrowError(
      expect.objectContaining<Partial<MaskTargetError>>({ code: 'mask_has_no_edit_area' }),
    );
    expect(() => assertUsableMaskCoverage('partial')).not.toThrow();
    expect(() => assertUsableMaskCoverage('full')).not.toThrow();
  });
});
