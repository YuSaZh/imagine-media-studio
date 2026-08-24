import { describe, expect, it } from 'vitest';

import type { ModelCapabilities } from './provider.js';

describe('ModelCapabilities', () => {
  it('describes supported controls without binding them to a UI', () => {
    const capabilities: ModelCapabilities = {
      operations: ['image.generate'],
      aspectRatios: ['1:1', '16:9'],
      supportsBatchCount: true,
      maxBatchCount: 4,
    };

    expect(capabilities.operations).toContain('image.generate');
    expect(capabilities.maxBatchCount).toBe(4);
  });
});
