import { describe, expect, it } from 'vitest';

import type {
  ModelCapabilities,
  PollResult,
  ProviderContext,
  ProviderError,
  SubmittedAsset,
  SubmitResult,
} from './provider.js';

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

  it('carries durable runner context and normalized asynchronous scheduling hints', () => {
    const controller = new AbortController();
    const context: ProviderContext = {
      providerId: 'mock',
      jobId: 'job-1',
      idempotencyKey: 'key-1',
      attempt: 2,
      signal: controller.signal,
      secrets: {},
    };
    const submit: SubmitResult = {
      state: 'pending',
      remoteJobId: 'remote-1',
      pollAfterMs: 750,
    };
    const poll: PollResult = {
      state: 'remote_running',
      progress: 45,
      pollAfterMs: 1_000,
    };
    const error: ProviderError = {
      code: 'rate_limited',
      kind: 'transient',
      message: 'Try later',
      retryable: true,
      retryAfterMs: 2_000,
      statusCode: 429,
    };

    expect(context).toMatchObject({ jobId: 'job-1', idempotencyKey: 'key-1', attempt: 2 });
    expect(submit.pollAfterMs).toBe(750);
    expect(poll.state).toBe('remote_running');
    expect(error).toMatchObject({ kind: 'transient', retryAfterMs: 2_000 });
  });

  it('retains optional provider result identity and metadata on submitted assets', () => {
    const asset: SubmittedAsset = {
      type: 'image',
      mimeType: 'image/png',
      source: 'url',
      url: 'https://provider.invalid/result.png',
      resultId: 'result-1',
      filename: 'result.png',
      metadata: { width: 1024, height: 1024 },
    };

    expect(asset).toMatchObject({ resultId: 'result-1', filename: 'result.png' });
  });
});
