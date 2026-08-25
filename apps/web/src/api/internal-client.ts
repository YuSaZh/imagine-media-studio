import {
  AssetPageSchema,
  AssetResponseSchema,
  AuthLoginSchema,
  AuthStatusSchema,
  CollectionAssetsResponseSchema,
  CollectionPageSchema,
  CollectionResponseSchema,
  JobDetailResponseSchema,
  JobPageSchema,
  JobResponseSchema,
  JobRetryResponseSchema,
  ManualModelCreateSchema,
  ManualModelPatchSchema,
  ModelPageSchema,
  ModelResponseSchema,
  ModelsResponseSchema,
  ProviderPageSchema,
  ProviderResponseSchema,
  ProviderTestResponseSchema,
  SettingsResponseSchema,
  type AssetDto,
  type CollectionDto,
  type GenerationRequest,
  type JsonValue,
  type ManualModelCreate,
  type ManualModelPatch,
  type ProviderDto,
} from '@imagine/shared';

interface Parser<T> {
  parse(value: unknown): T;
}

type AuthRequiredListener = () => void;
const authRequiredListeners = new Set<AuthRequiredListener>();

export function subscribeToAuthRequired(listener: AuthRequiredListener): () => void {
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

function publishAuthRequired(path: string, status: number): void {
  if (
    status !== 401 ||
    path === '/internal/auth/status' ||
    path === '/internal/auth/login'
  ) {
    return;
  }
  for (const listener of authRequiredListeners) listener();
}

export class InternalApiError extends Error {
  public override readonly name = 'InternalApiError';

  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function queryString(values: Readonly<Record<string, boolean | number | string | undefined>>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const serialized = parameters.toString();
  return serialized.length > 0 ? `?${serialized}` : '';
}

async function requestJson<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  publishAuthRequired(path, response.status);
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body
      ? String(body.error)
      : 'internal_api_error';
    const message = typeof body === 'object' && body !== null && 'message' in body
      ? String(body.message)
      : `Internal API request failed with status ${response.status}.`;
    throw new InternalApiError(response.status, error, message);
  }
  return parser.parse(body);
}

async function requestEmpty(path: string, init: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...init.headers },
  });
  publishAuthRequired(path, response.status);
  if (!response.ok) {
    let code = 'internal_api_error';
    let message = `Internal API request failed with status ${response.status}.`;
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      if (body.error !== undefined) code = String(body.error);
      if (body.message !== undefined) message = String(body.message);
    } catch {
      // Empty error bodies keep the status-based message.
    }
    throw new InternalApiError(response.status, code, message);
  }
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const internalClient = {
  getAuthStatus: async () =>
    requestJson('/internal/auth/status', AuthStatusSchema),
  login: async (password: string) => {
    const input = AuthLoginSchema.parse({ password });
    return requestJson('/internal/auth/login', AuthStatusSchema, {
      method: 'POST',
      body: jsonBody(input),
    });
  },
  logout: async () =>
    requestEmpty('/internal/auth/logout', { method: 'POST' }),
  getSettings: async () =>
    requestJson('/internal/settings', SettingsResponseSchema),
  patchSettings: async (values: Readonly<Record<string, JsonValue>>) =>
    requestJson('/internal/settings', SettingsResponseSchema, {
      method: 'PATCH',
      body: jsonBody({ values }),
    }),
  listProviders: async (options: { cursor?: string; enabled?: boolean; limit?: number; type?: string } = {}) =>
    requestJson(`/internal/providers${queryString(options)}`, ProviderPageSchema),
  getProvider: async (providerId: string) =>
    requestJson(`/internal/providers/${encodeURIComponent(providerId)}`, ProviderResponseSchema),
  createProvider: async (input: Omit<ProviderDto, 'createdAt' | 'hasApiKey' | 'hasCustomHeaders' | 'id' | 'updatedAt'> & { apiKey?: string; headers?: Readonly<Record<string, string>> }) =>
    requestJson('/internal/providers', ProviderResponseSchema, {
      method: 'POST',
      body: jsonBody(input),
    }),
  patchProvider: async (providerId: string, input: Readonly<Record<string, unknown>>) =>
    requestJson(`/internal/providers/${encodeURIComponent(providerId)}`, ProviderResponseSchema, {
      method: 'PATCH',
      body: jsonBody(input),
    }),
  deleteProvider: async (providerId: string) =>
    requestEmpty(`/internal/providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' }),
  testProvider: async (providerId: string) =>
    requestJson(`/internal/providers/${encodeURIComponent(providerId)}/test`, ProviderTestResponseSchema, {
      method: 'POST',
      body: '{}',
    }),
  refreshProviderModels: async (providerId: string) =>
    requestJson(`/internal/providers/${encodeURIComponent(providerId)}/models/refresh`, ModelsResponseSchema, {
      method: 'POST',
      body: '{}',
    }),
  listModels: async (options: { cursor?: string; enabled?: boolean; limit?: number; operation?: string; providerId?: string } = {}) =>
    requestJson(`/internal/models${queryString(options)}`, ModelPageSchema),
  createModel: async (input: Omit<ManualModelCreate, 'enabled'> & { enabled?: boolean }) => {
    const parsed = ManualModelCreateSchema.parse(input);
    return requestJson('/internal/models', ModelResponseSchema, {
      method: 'POST',
      body: jsonBody(parsed),
    });
  },
  patchModel: async (modelId: string, input: ManualModelPatch) => {
    const parsed = ManualModelPatchSchema.parse(input);
    return requestJson(`/internal/models/${encodeURIComponent(modelId)}`, ModelResponseSchema, {
      method: 'PATCH',
      body: jsonBody(parsed),
    });
  },
  deleteModel: async (modelId: string) =>
    requestEmpty(`/internal/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' }),
  createJob: async (input: GenerationRequest, idempotencyKey?: string) =>
    requestJson('/internal/jobs', JobResponseSchema, {
      method: 'POST',
      body: jsonBody(input),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    }),
  listJobs: async (options: { cursor?: string; limit?: number; modelId?: string; providerId?: string; status?: string } = {}) =>
    requestJson(`/internal/jobs${queryString(options)}`, JobPageSchema),
  getJob: async (jobId: string) =>
    requestJson(`/internal/jobs/${encodeURIComponent(jobId)}`, JobDetailResponseSchema),
  retryJob: async (jobId: string) =>
    requestJson(`/internal/jobs/${encodeURIComponent(jobId)}/retry`, JobRetryResponseSchema, {
      method: 'POST',
      body: '{}',
    }),
  cancelJob: async (jobId: string) =>
    requestJson(`/internal/jobs/${encodeURIComponent(jobId)}/cancel`, JobResponseSchema, {
      method: 'POST',
      body: '{}',
    }),
  deleteJob: async (jobId: string) =>
    requestEmpty(`/internal/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  listAssets: async (options: { collectionId?: string; cursor?: string; favorite?: boolean; jobId?: string; limit?: number; role?: string; type?: string } = {}) =>
    requestJson(`/internal/assets${queryString(options)}`, AssetPageSchema),
  getAsset: async (assetId: string) =>
    requestJson(`/internal/assets/${encodeURIComponent(assetId)}`, AssetResponseSchema),
  uploadAsset: async (
    file: File,
    fields: { parentAssetId?: string; role?: string } = {},
    options: { signal?: AbortSignal } = {},
  ) => {
    const body = new FormData();
    if (fields.parentAssetId) body.set('parentAssetId', fields.parentAssetId);
    if (fields.role) body.set('role', fields.role);
    body.set('file', file, file.name);
    return requestJson('/internal/assets/upload', AssetResponseSchema, {
      method: 'POST',
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  },
  patchAsset: async (assetId: string, favorite: boolean) =>
    requestJson(`/internal/assets/${encodeURIComponent(assetId)}`, AssetResponseSchema, {
      method: 'PATCH',
      body: jsonBody({ favorite }),
    }),
  deleteAsset: async (assetId: string) =>
    requestEmpty(`/internal/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }),
  listCollections: async (options: { cursor?: string; limit?: number } = {}) =>
    requestJson(`/internal/collections${queryString(options)}`, CollectionPageSchema),
  createCollection: async (name: string) =>
    requestJson('/internal/collections', CollectionResponseSchema, {
      method: 'POST',
      body: jsonBody({ name }),
    }),
  patchCollection: async (collectionId: string, name: string) =>
    requestJson(`/internal/collections/${encodeURIComponent(collectionId)}`, CollectionResponseSchema, {
      method: 'PATCH',
      body: jsonBody({ name }),
    }),
  deleteCollection: async (collectionId: string) =>
    requestEmpty(`/internal/collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE' }),
  addCollectionAssets: async (collectionId: string, assetIds: readonly string[]) =>
    requestJson(`/internal/collections/${encodeURIComponent(collectionId)}/assets`, CollectionAssetsResponseSchema, {
      method: 'POST',
      body: jsonBody({ assetIds }),
    }),
  removeCollectionAsset: async (collectionId: string, assetId: string) =>
    requestEmpty(
      `/internal/collections/${encodeURIComponent(collectionId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' },
    ),
};

export type InternalAsset = AssetDto;
export type InternalCollection = CollectionDto;
