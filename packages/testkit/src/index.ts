import type { GenerationRequest } from '@imagine/shared';

export function createMockGenerationRequest(
  overrides: Partial<GenerationRequest> = {},
): GenerationRequest {
  return {
    operation: 'image.generate',
    providerId: 'mock',
    modelId: 'mock-image-v1',
    prompt: 'A fixed mock generation request',
    inputs: [],
    ...overrides,
  };
}
