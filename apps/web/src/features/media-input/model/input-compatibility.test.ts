import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_INPUT_POLICY } from '@imagine/shared';

import {
  hasExclusiveVideoInputConflict,
  descriptorsExceedingTotalBytes,
  storedInputAvailability,
} from './input-compatibility.js';

describe('Composer input compatibility', () => {
  it('marks first-frame plus stored or pending references incompatible only in video mode', () => {
    const firstFrame = [{ assetId: 'frame-1', role: 'first_frame' }] as const;
    const withReference = [
      ...firstFrame,
      { assetId: 'reference-1', role: 'reference' },
    ] as const;

    expect(hasExclusiveVideoInputConflict('video', withReference)).toBe(true);
    expect(hasExclusiveVideoInputConflict('video', firstFrame, 1)).toBe(true);
    expect(hasExclusiveVideoInputConflict('video', firstFrame)).toBe(false);
    expect(hasExclusiveVideoInputConflict('image', withReference)).toBe(false);
  });

  it('distinguishes loading, missing, non-persisted, and policy-incompatible Assets', () => {
    expect(storedInputAvailability(undefined, DEFAULT_IMAGE_INPUT_POLICY, false)).toBe('checking');
    expect(storedInputAvailability(undefined, DEFAULT_IMAGE_INPUT_POLICY, true)).toBe('missing');
    expect(storedInputAvailability({
      inputDescriptor: null,
      persistedAsset: false,
    }, DEFAULT_IMAGE_INPUT_POLICY, true)).toBe('incompatible');
    expect(storedInputAvailability({
      inputDescriptor: { fileSize: 4, height: 20, mimeType: 'image/png', width: 20 },
      persistedAsset: true,
    }, { ...DEFAULT_IMAGE_INPUT_POLICY, maxWidth: 10 }, true)).toBe('incompatible');
    expect(storedInputAvailability({
      inputDescriptor: { fileSize: 4, height: 20, mimeType: 'image/png', width: 20 },
      persistedAsset: true,
    }, DEFAULT_IMAGE_INPUT_POLICY, true)).toBe('ready');
  });

  it('marks only descriptors that exceed the aggregate byte budget', () => {
    const descriptor = { fileSize: 6, height: 2, mimeType: 'image/png', width: 2 };
    expect([...descriptorsExceedingTotalBytes(
      [descriptor, descriptor, { ...descriptor, fileSize: 4 }],
      { ...DEFAULT_IMAGE_INPUT_POLICY, maxFileBytes: 10, maxTotalBytes: 10 },
    )]).toEqual([1]);
  });
});
