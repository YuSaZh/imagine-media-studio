import { createMockGenerationRequest } from '@imagine/testkit';
import { describe, expect, it, vi } from 'vitest';

import { MockProviderAdapter, MockProviderValidationError } from './mock-provider.js';

const context = { providerId: 'mock', secrets: {} };

describe('MockProviderAdapter', () => {
  it('returns a deterministic local fixture without using fetch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network access is forbidden in the Mock Provider test.'));
    const provider = new MockProviderAdapter();
    const request = createMockGenerationRequest();

    await provider.validate(request, context);
    const first = await provider.submit(request, context);
    const second = await provider.submit(request, context);

    expect(first).toEqual(second);
    expect(first.state).toBe('completed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects unsupported model inputs and options', async () => {
    const provider = new MockProviderAdapter();

    await expect(
      provider.validate(createMockGenerationRequest({ modelId: 'unknown' }), context),
    ).rejects.toThrow();
    await expect(
      provider.validate(
        createMockGenerationRequest({
          inputs: [{ assetId: 'asset-1', role: 'reference' }],
        }),
        context,
      ),
    ).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ aspectRatio: '16:9' }), context),
    ).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ seed: 42 }), context),
    ).rejects.toThrow();
  });

  it('normalizes validation failures as non-retryable rejections', () => {
    const provider = new MockProviderAdapter();

    expect(provider.normalizeError(new MockProviderValidationError('unsupported'))).toMatchObject({
      code: 'mock_validation_error',
      kind: 'rejected',
      retryable: false,
    });
    expect(provider.normalizeError(new Error('unexpected'))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    });
  });
});
