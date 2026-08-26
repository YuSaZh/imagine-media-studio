export const capabilities = {
  providerType: 'trusted-fixture-v1',
  models: [{
    id: 'trusted-fixture-model',
    displayName: 'Trusted fixture model',
    capabilities: { operations: ['image.generate', 'video.generate'], supportsCancel: true },
  }],
};

export async function submit({ request, provider, http, files }) {
  let httpHeaderCount = 0;
  if (request?.prompt === 'http') {
    const response = await http.request({
      method: 'POST',
      url: `${provider.baseUrl}/generate`,
      headers: { authorization: `Bearer ${provider.secrets.apiKey ?? ''}` },
      body: new Uint8Array([123, 125]),
    });
    httpHeaderCount = Object.keys(response.headers).length;
  }
  return {
    state: 'completed',
    assets: [{
      type: 'image',
      mimeType: 'image/png',
      source: 'base64',
      base64: 'iVBORw0KGgo=',
      metadata: { httpHeaderCount, inputCount: files.length },
    }],
  };
}

export async function poll() {
  return {
    state: 'completed',
    assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'iVBORw0KGgo=' }],
  };
}

export async function cancel() {
}

export function normalizeError() {
  return { code: 'adapter_error', kind: 'unknown', message: 'Adapter failed.', retryable: false };
}
