import { describe, expect, it } from 'vitest';

import { GenerationRequestSchema } from './generation.js';

describe('GenerationRequestSchema', () => {
  it('applies an empty input list to a valid mock request', () => {
    const request = GenerationRequestSchema.parse({
      operation: 'image.generate',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'A quiet test image',
    });

    expect(request.inputs).toEqual([]);
  });

  it('rejects an empty prompt', () => {
    expect(() =>
      GenerationRequestSchema.parse({
        operation: 'image.generate',
        providerId: 'mock',
        modelId: 'mock-image-v1',
        prompt: '   ',
      }),
    ).toThrow();
  });

  it('rejects unknown top-level and asset fields instead of silently stripping them', () => {
    expect(() =>
      GenerationRequestSchema.parse({
        operation: 'image.generate',
        providerId: 'mock',
        modelId: 'mock-image-v1',
        prompt: 'Strict request',
        typoCount: 2,
      }),
    ).toThrow();
    expect(() =>
      GenerationRequestSchema.parse({
        operation: 'image.edit',
        providerId: 'mock',
        modelId: 'mock-image-v1',
        prompt: 'Strict asset',
        inputs: [{ assetId: 'asset-1', role: 'source', typoRole: true }],
      }),
    ).toThrow();
  });

  it('rejects a generation count above the central persistence cap', () => {
    expect(() => GenerationRequestSchema.parse({
      operation: 'image.generate',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'Too many outputs',
      count: 33,
    })).toThrow();
  });
});
