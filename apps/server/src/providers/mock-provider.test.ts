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
    await expect(provider.validate(createMockGenerationRequest({
      inputs: Array.from({ length: 5 }, (_, index) => ({
        assetId: `asset-${index}`,
        role: 'reference' as const,
      })),
    }), context)).rejects.toThrow();
    await expect(provider.validate(createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [{ assetId: 'asset-1', role: 'reference' }],
    }), context)).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ aspectRatio: '16:9' }), context),
    ).rejects.toThrow();
    await expect(
      provider.validate(createMockGenerationRequest({ seed: 42 }), context),
    ).rejects.toThrow();
  });

  it('supports references and the source plus optional mask edit shape without network access', async () => {
    const provider = new MockProviderAdapter();
    await expect(provider.validate(createMockGenerationRequest({
      inputs: [{ assetId: 'reference', role: 'reference' }],
    }), context)).resolves.toBeUndefined();
    await expect(provider.validate(createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [
        { assetId: 'source', role: 'source' },
        { assetId: 'reference', role: 'reference' },
        { assetId: 'mask', role: 'mask' },
      ],
    }), context)).resolves.toBeUndefined();

    const capabilities = await provider.getCapabilities(context);
    expect(capabilities.models[0]?.capabilities).toMatchObject({
      operations: ['image.generate', 'image.edit'],
      maxReferenceImages: 4,
      supportsMask: true,
      inputImageConstraints: { maxBytes: 32 * 1024 * 1024 },
    });
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
