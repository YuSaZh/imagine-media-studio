import { describe, expect, it } from 'vitest';

import { PR1_MOCK_IMAGE_ASSETS, PR1_MOCK_VIDEO_ITEMS } from './fixtures.js';
import { canContinueWithImageInput } from './input-eligibility.js';

describe('gallery image input eligibility', () => {
  it('allows fixture images but rejects videos and non-persisted job slots', () => {
    expect(canContinueWithImageInput(PR1_MOCK_IMAGE_ASSETS[0]!)).toBe(true);
    expect(canContinueWithImageInput(PR1_MOCK_VIDEO_ITEMS[0]!)).toBe(false);
    expect(canContinueWithImageInput({
      ...PR1_MOCK_IMAGE_ASSETS[0]!,
      id: 'job-slot-job-1-0',
      inputDescriptor: null,
      persistedAsset: false,
    })).toBe(false);
  });
});
