/*
 * Selectively adapted from CookSleep/gpt_image_playground src/lib/mask.ts.
 * Pinned revision: 997d79b35e60406d6ab6da26d0a9179a724820c7
 * Source blob: 3feb76d2b23e1f2c827735e091739217a11a3891
 * MIT License, Copyright (c) 2026 CookSleep.
 */

export type MaskCoverage = 'empty' | 'partial' | 'full';

export type MaskTargetErrorCode =
  | 'invalid_mask_alpha'
  | 'invalid_rgba_length'
  | 'mask_has_no_edit_area'
  | 'mask_target_not_found';

export class MaskTargetError extends Error {
  public override readonly name = 'MaskTargetError';

  public constructor(
    public readonly code: MaskTargetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MaskTargetIdentity {
  readonly id: string;
}

export function requireMaskTarget<T extends MaskTargetIdentity>(
  inputs: readonly T[],
  targetId: string,
): T {
  const target = inputs.find((input) => input.id === targetId);
  if (!target) {
    throw new MaskTargetError('mask_target_not_found', 'The mask target is not available.');
  }
  return target;
}

export function orderMaskTargetFirst<T extends MaskTargetIdentity>(
  inputs: readonly T[],
  targetId: string,
): readonly T[] {
  const target = requireMaskTarget(inputs, targetId);
  return [target, ...inputs.filter((input) => input.id !== targetId)];
}

/** Alpha 0 is edited, alpha 255 is preserved, and intermediate alpha is a partial edit. */
export function classifyMaskRgba(rgba: ArrayLike<number>): MaskCoverage {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new MaskTargetError(
      'invalid_rgba_length',
      'Mask RGBA data must contain one or more complete pixels.',
    );
  }

  let editedPixels = 0;
  let fullyEditedPixels = 0;
  const pixelCount = rgba.length / 4;
  for (let index = 3; index < rgba.length; index += 4) {
    const alpha = rgba[index];
    if (!Number.isInteger(alpha) || alpha === undefined || alpha < 0 || alpha > 255) {
      throw new MaskTargetError(
        'invalid_mask_alpha',
        'Mask alpha values must be integers from 0 through 255.',
      );
    }
    if (alpha < 255) editedPixels += 1;
    if (alpha === 0) fullyEditedPixels += 1;
  }

  if (editedPixels === 0) return 'empty';
  if (fullyEditedPixels === pixelCount) return 'full';
  return 'partial';
}

export function assertUsableMaskCoverage(coverage: MaskCoverage): void {
  if (coverage === 'empty') {
    throw new MaskTargetError(
      'mask_has_no_edit_area',
      'The mask must contain at least one edited pixel.',
    );
  }
}
