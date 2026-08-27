/* eslint-disable no-undef */

// This is trusted server-side application code, not an untrusted sandbox.
// Network access is available only through the host-injected SafeHttpPort.

export const capabilities = {
  providerType: 'example-video-v1',
  models: [{
    id: 'video-model',
    displayName: 'Video Model',
    capabilities: {
      operations: ['video.generate'],
      aspectRatios: ['16:9', '9:16'],
      durations: [4, 8],
      supportsProgress: true,
      supportsCancel: true,
      supportsBatchCount: false,
      maxBatchCount: 1,
    },
  }],
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(provider, path) {
  if (!isRecord(provider) || typeof provider.baseUrl !== 'string' || provider.baseUrl.length === 0) {
    throw new Error('Provider Base URL is not configured.');
  }
  return new URL(path, provider.baseUrl).toString();
}

function headers(provider) {
  const apiKey = isRecord(provider?.secrets) ? provider.secrets.apiKey : undefined;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('Provider API key is not configured.');
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function jsonBody(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function providerError(status) {
  const error = new Error('Provider request failed.');
  error.code = 'provider_http';
  error.status = status;
  return error;
}

async function requestJson(http, provider, method, path, body) {
  const response = await http.request({
    method,
    url: endpoint(provider, path),
    headers: headers(provider),
    ...(body === undefined ? {} : { body: jsonBody(body) }),
  });
  if (response.status < 200 || response.status >= 300) throw providerError(response.status);
  return response;
}

function responseJson(response) {
  try {
    const value = JSON.parse(new TextDecoder().decode(response.body));
    if (!isRecord(value)) throw new Error('Provider response must be an object.');
    return value;
  } catch {
    throw new Error('Provider response is not valid JSON.');
  }
}

function remoteId(value) {
  return typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
}

export async function submit({ request, provider, http }) {
  const response = await requestJson(http, provider, 'POST', '/v1/videos', {
    model: request.modelId,
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio,
    duration: request.durationSeconds,
  });
  const value = responseJson(response);
  const id = remoteId(value);
  if (id === null) throw new Error('Provider response did not contain a remote job id.');
  return { state: 'pending', remoteJobId: id, pollAfterMs: 1000 };
}

export async function poll({ remoteJobId, provider, http }) {
  const response = await requestJson(http, provider, 'GET', `/v1/videos/${encodeURIComponent(remoteJobId)}`);
  const value = responseJson(response);
  const status = typeof value.status === 'string' ? value.status : '';
  if (status === 'queued' || status === 'pending') return { state: 'remote_pending', pollAfterMs: 1000 };
  if (status === 'running') {
    const progress = typeof value.progress === 'number' ? value.progress : undefined;
    return { state: 'remote_running', ...(progress === undefined ? {} : { progress }), pollAfterMs: 1000 };
  }
  if (status === 'failed') {
    return { state: 'failed', error: { code: 'provider_failed', kind: 'rejected', message: 'Provider rejected the generation.', retryable: false } };
  }
  if (status === 'expired') {
    return { state: 'failed', error: { code: 'provider_expired', kind: 'expired', message: 'Provider result expired.', retryable: false } };
  }
  if (status === 'completed' && isRecord(value.video) && typeof value.video.url === 'string') {
    return {
      state: 'completed',
      assets: [{ type: 'video', mimeType: 'video/mp4', source: 'url', url: value.video.url, resultId: remoteJobId }],
    };
  }
  throw new Error('Provider returned an unknown or incomplete job status.');
}

export async function cancel({ remoteJobId, provider, http }) {
  await requestJson(http, provider, 'POST', `/v1/videos/${encodeURIComponent(remoteJobId)}/cancel`);
}

export function normalizeError(error) {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  if (status === 429) {
    return { code: 'provider_rate_limited', kind: 'transient', message: 'Provider rate limit reached.', retryable: true, retryAfterMs: 2000, statusCode: 429 };
  }
  return { code: 'provider_unknown', kind: 'unknown', message: 'Trusted Provider operation failed.', retryable: false };
}
