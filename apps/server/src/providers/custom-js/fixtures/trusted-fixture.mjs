export const capabilities = {
  providerType: 'fixture-provider',
  models: [{
    id: 'fixture-model',
    displayName: 'Fixture model',
    capabilities: {
      operations: ['image.generate', 'video.generate'],
      supportsProgress: true,
      supportsCancel: true,
    },
  }],
};

export async function submit({ request }) {
  if (request?.prompt === 'pending') {
    return {
      state: 'pending',
      remoteJobId: 'fixture-job',
      pollAfterMs: 100,
      resultExpiresAt: '2030-01-01T00:00:00.000Z',
    };
  }
  return {
    state: 'completed',
    assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }],
  };
}

export async function poll({ remoteJobId }) {
  if (remoteJobId === 'fixture-fail') {
    return {
      state: 'failed',
      error: { code: 'fixture_failed', kind: 'rejected', message: 'Fixture failed.', retryable: false },
    };
  }
  if (remoteJobId === 'fixture-running') return { state: 'remote_running', progress: 42, pollAfterMs: 100 };
  return {
    state: 'completed',
    assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }],
  };
}

export async function cancel() {
}

export async function normalizeError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.status === 429 || message.includes('status=429')) {
    return {
      code: 'fixture_rate_limited',
      kind: 'transient',
      message: 'Try again later.',
      retryable: true,
      retryAfterMs: 2000,
      statusCode: 429,
    };
  }
  if (error?.code === 'fixture-invalid' || message.includes('code=fixture-invalid')) {
    return {
      code: 'fixture_invalid',
      kind: 'unknown',
      message: 'Invalid fixture result.',
      retryable: false,
      unexpected: true,
    };
  }
  if (error?.code === 'fixture-fail' || message.includes('code=fixture-fail')) throw new Error('raw cause includes secret=fixture-secret');
  return { code: 'fixture_error', kind: 'unknown', message: 'Fixture adapter failed.', retryable: false };
}
