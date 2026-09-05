import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  SubmittedAsset,
  SubmitResult,
} from '@imagine/provider-contract';
import { createMockGenerationRequest } from '@imagine/testkit';

import type { ResourceRoutesOptions } from './resources.js';
import { registerResourceRoutes } from './resources.js';

const output: SubmittedAsset = {
  type: 'image',
  mimeType: 'image/png',
  source: 'base64',
  base64: 'aW1hZ2U=',
};

class AsyncValidationProvider implements ProviderAdapter {
  public readonly type = 'async-route-test';

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return { providerType: this.type, models: [] };
  }

  public async validate(_request: Parameters<ProviderAdapter['validate']>[0], _context: ProviderContext): Promise<void> {
    throw new Error('upstream validation failed');
  }

  public async submit(_request: Parameters<ProviderAdapter['submit']>[0], _context: ProviderContext): Promise<SubmitResult> {
    return { state: 'completed', assets: [output] };
  }

  public async normalizeError(_error: unknown): Promise<ProviderError> {
    await Promise.resolve();
    return {
      code: 'async_route_rate_limited',
      kind: 'transient',
      message: 'Try again later.',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    };
  }
}

describe('resource job route provider error normalization', () => {
  it('derives protocol and locked defaults from the stored model before validation', async () => {
    const app = Fastify({ logger: false });
    const adapter = new AsyncValidationProvider();
    Object.defineProperty(adapter, 'type', { value: 'xai' });
    const validate = vi.spyOn(adapter, 'validate');
    const options = {
      providers: { resolve: () => ({ adapter, secrets: {}, submitReplaySafe: false }) },
      inputResolver: { resolve: () => ({ model: { capabilities: { operations: ['image.generate'], profile: 'xai-imagine-image-v1', parameters: [{ path: 'count', label: 'Count', type: 'number', defaultValue: 2, locked: true }] } } }) },
      inputLoader: { load: async () => [] },
    } as unknown as ResourceRoutesOptions;
    try {
      await registerResourceRoutes(app, options);
      const input = { ...createMockGenerationRequest(), count: 1, profile: 'openai-images-v1' };
      await app.inject({ method: 'POST', url: '/internal/jobs', payload: input });
      expect(validate.mock.calls[0]?.[0]).toMatchObject({ count: 2, profile: 'xai-imagine-image-v1' });
      validate.mockClear();
      const rejected = await app.inject({ method: 'POST', url: '/internal/jobs', payload: { ...input, format: 'png' } });
      expect(rejected.statusCode).toBe(400);
      expect(validate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('awaits asynchronous adapter errors before choosing the response', async () => {
    const app = Fastify({ logger: false });
    const adapter = new AsyncValidationProvider();
    const options = {
      providers: {
        resolve: () => ({ adapter, secrets: {}, submitReplaySafe: true }),
      },
      inputResolver: { resolve: () => ({ model: { capabilities: { operations: ['image.generate'] } } }) },
      inputLoader: { load: async () => [] },
    } as unknown as ResourceRoutesOptions;

    try {
      await registerResourceRoutes(app, options);
      const response = await app.inject({
        method: 'POST',
        url: '/internal/jobs',
        payload: createMockGenerationRequest(),
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: 'async_route_rate_limited',
        message: 'Try again later.',
      });
    } finally {
      await app.close();
    }
  });
});
