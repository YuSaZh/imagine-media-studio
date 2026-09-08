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
  it('derives compatible video constraints from the stored model and discards client policy', async () => {
    const app = Fastify({ logger: false });
    const adapter = new AsyncValidationProvider();
    Object.defineProperty(adapter, 'type', { value: 'openai' });
    const validate = vi.spyOn(adapter, 'validate');
    const capabilities = { profile: 'openai-videos-v1-compatible', operations: ['video.generate'], durations: [5, 7, 9], resolutions: ['1080p'], aspectRatios: ['1:1'] };
    const options = { providers: { resolve: () => ({ adapter, secrets: {}, submitReplaySafe: false }) }, inputResolver: { resolve: () => ({ model: { capabilities } }) }, inputLoader: { load: async () => [] } } as unknown as ResourceRoutesOptions;
    try {
      await registerResourceRoutes(app, options);
      const payload = { ...createMockGenerationRequest(), modelId: 'unknown-video', operation: 'video.generate', resolution: '1080p', aspectRatio: '1:1', durationSeconds: 7, operationPolicy: { durations: [100], resolutions: ['4k'] } };
      await app.inject({ method: 'POST', url: '/internal/jobs', payload });
      expect(validate).toHaveBeenCalledOnce();
      const policy = { durations: [5, 7, 9], resolutions: ['1080p'], aspectRatios: ['1:1'], inputRoles: [] };
      expect(validate.mock.calls[0]![0]).not.toHaveProperty('operationPolicy');
      expect(validate.mock.calls[0]![1]).toMatchObject({ modelId: 'unknown-video', operationPolicy: policy });
      validate.mockClear();
      expect((await app.inject({ method: 'POST', url: '/internal/jobs', payload: { ...payload, durationSeconds: 100 } })).statusCode).toBe(400);
      expect(validate).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('validates and snapshots stored resolution capabilities instead of client overrides', async () => {
    const app = Fastify({ logger: false });
    const adapter = new AsyncValidationProvider();
    const validate = vi.spyOn(adapter, 'validate');
    const imageResolution = { mode: 'pixels', values: ['1024x1024'], allowCustomDimensions: false, dimensions: { maxWidth: 1024, maxHeight: 1024 } };
    const options = {
      providers: { resolve: () => ({ adapter, secrets: {}, submitReplaySafe: false }) },
      inputResolver: { resolve: () => ({ model: { capabilities: { operations: ['image.generate'], imageResolution } } }) },
      inputLoader: { load: async () => [] },
    } as unknown as ResourceRoutesOptions;
    try {
      await registerResourceRoutes(app, options);
      const spoofed = { ...createMockGenerationRequest(), resolution: '3840x3840', imageResolutionPolicy: { mode: 'pixels', values: ['3840x3840'], allowCustomDimensions: true } };
      expect((await app.inject({ method: 'POST', url: '/internal/jobs', payload: spoofed })).statusCode).toBe(400);
      expect(validate).not.toHaveBeenCalled();
      await app.inject({ method: 'POST', url: '/internal/jobs', payload: { ...spoofed, resolution: '1024x1024' } });
      expect(validate).toHaveBeenCalledOnce();
      expect(validate.mock.calls[0]![0]).not.toHaveProperty('imageResolutionPolicy');
      expect(validate.mock.calls[0]![1]).toMatchObject({ imageResolution });
    } finally { await app.close(); }
  });
  it.each([false, true])('handles explicit auto after applying stored defaults (locked=%s)', async locked => {
    const app = Fastify({ logger: false });
    const adapter = new AsyncValidationProvider();
    const validate = vi.spyOn(adapter, 'validate');
    const options = {
      providers: { resolve: () => ({ adapter, secrets: {}, submitReplaySafe: false }) },
      inputResolver: { resolve: () => ({ model: { capabilities: { operations: ['image.generate'], parameters: [
        { path: 'aspectRatio', label: 'Ratio', type: 'select', options: ['1:1'], defaultValue: '1:1', locked },
        { path: 'resolution', label: 'Resolution', type: 'select', options: ['1024x1024'], defaultValue: '1024x1024', locked },
      ] } } }) },
      inputLoader: { load: async () => [] },
    } as unknown as ResourceRoutesOptions;
    try {
      await registerResourceRoutes(app, options);
      await app.inject({ method: 'POST', url: '/internal/jobs', payload: { ...createMockGenerationRequest(), aspectRatio: 'auto', resolution: 'auto' } });
      expect(validate).toHaveBeenCalledOnce();
      const input = validate.mock.calls[0]![0];
      if (locked) expect(input).toMatchObject({ aspectRatio: '1:1', resolution: '1024x1024' });
      else { expect(input).not.toHaveProperty('aspectRatio'); expect(input).not.toHaveProperty('resolution'); }
    } finally { await app.close(); }
  });
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
      expect(validate.mock.calls[0]?.[0]).toMatchObject({ count: 1, profile: 'xai-imagine-image-v1' });
      expect(validate.mock.calls[0]?.[1]).toMatchObject({ modelId: input.modelId });
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
