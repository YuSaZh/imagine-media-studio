import { AccountResponseSchema, AccountListSchema } from '@imagine/shared';
import {
  AdapterDocumentFormatSchema,
  AdapterEmptyQuerySchema,
  AdapterIdParamsSchema,
  CustomAdapterCapabilityPreviewRequestSchema,
  CustomAdapterCapabilityPreviewResponseSchema,
  CustomAdapterCompiledPreviewSchema,
  CustomAdapterDeleteBodySchema,
  CustomAdapterDefinitionResponseSchema,
  CustomAdapterDocumentSchema,
  CustomAdapterDryRunRequestSchema,
  CustomAdapterDryRunResponseSchema,
  CustomAdapterExportQuerySchema,
  CustomAdapterExtractedResponseSchema,
  CustomAdapterImportEnvelopeSchema,
  CustomAdapterImportRequestSchema,
  CustomAdapterPathTestRequestSchema,
  CustomAdapterPathTestResponseSchema,
  CustomAdapterPreviewRequestSchema,
  CustomAdapterRefSchema,
  CustomAdapterRevisionListResponseSchema,
  CustomAdapterRevisionListQuerySchema,
  CustomAdapterSimulateRequestSchema,
  CustomAdapterValidateRequestSchema,
  CustomAdapterValidationResponseSchema,
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
  MaintenanceBackupResponseSchema,
  MaintenanceIntegrityResponseSchema,
  MaintenanceMediaResponseSchema,
  MaintenanceMediaReconcileResponseSchema,
  MaintenanceMediaRepairsResponseSchema,
  MaintenanceMediaRepairRunResponseSchema,
  ManualModelCreateSchema,
  ManualModelPatchSchema,
  ModelPageSchema,
  ModelResponseSchema,
  ModelsResponseSchema,
  ProviderPageSchema,
  ProviderCapabilitiesSchema,
  ProviderResponseSchema,
  ProviderTestResponseSchema,
  SettingsResponseSchema,
  TrustedAdapterBindRequestSchema,
  TrustedAdapterBindBodySchema,
  TrustedAdapterBindingPageSchema,
  TrustedAdapterBindingResponseSchema,
  TrustedAdapterDisableBodySchema,
  TrustedAdapterPageSchema,
  TrustedAdapterResponseSchema,
  TrustedAdapterManifestSchema,
  TrustedAdapterRevisionListQuerySchema,
  TrustedAdapterRevisionQuerySchema,
  TrustedAdapterUnbindQuerySchema,
  ProviderIdSchema,
  MAX_ADAPTER_DOCUMENT_BYTES,
  MAX_ADAPTER_RESPONSE_BYTES,
  type AssetDto,
  type AuthStatus,
  type CollectionDto,
  type CustomAdapterCapabilityPreviewRequest,
  type CustomAdapterDryRunRequest,
  type CustomAdapterDocument,
  type CustomAdapterImportEnvelope,
  type CustomAdapterPathTestRequest,
  type CustomAdapterPreviewRequest,
  type CustomAdapterRef,
  type CustomAdapterSimulateRequest,
  type CustomAdapterValidateRequest,
  type GenerationRequest,
  type JsonValue,
  type ManualModelCreate,
  type ManualModelPatch,
  type ProviderDto,
  type TrustedAdapterBindRequest,
  type TrustedAdapterManifest,
} from '@imagine/shared';
import { readExportedYamlEnvelopeVersion } from './adapter-document.js';
import { clearDerivedMediaRuntimeCache } from '../pwa-media-cache.js';
import {
  assertOnlineForWrite,
  broadcastOfflineSessionChange,
  clearOfflineBootstrapState,
  initializeOfflineSessionSync,
  isNetworkFailure,
  markNetworkAvailable,
  markNetworkFailure,
  markNetworkFailureError,
  rememberPublicOfflineBootstrap,
  rememberAuthenticatedSession,
  subscribeToOfflineSessionChange,
} from '../pwa-offline-snapshot.js';

interface Parser<T> {
  parse(value: unknown): T;
}

export interface InternalRequestOptions {
  readonly signal?: AbortSignal;
}

export interface CustomAdapterExportDownload {
  /** Raw UTF-8 document text returned by the server. */
  readonly text: string;
  /** Alias for callers that use the server's export `content` terminology. */
  readonly content: string;
  readonly filename: string | null;
  readonly contentType: string;
}

export interface CustomAdapterPutInput {
  readonly document: CustomAdapterDocument;
  readonly format?: 'json' | 'yaml';
  /** Required for raw (non-envelope) documents and sent as a strict query. */
  readonly version?: string;
}

export interface CustomAdapterPutOptions extends InternalRequestOptions {
  readonly format?: 'json' | 'yaml';
  readonly version?: string;
}

export interface CustomAdapterExportOptions {
  readonly ref?: CustomAdapterRef;
  readonly format?: 'json' | 'yaml';
}

export interface TrustedAdapterInstallInput {
  readonly manifest: TrustedAdapterManifest;
  readonly source: File;
  readonly providerId?: string;
}

export type AuthRequiredReason = 'login';
type AuthRequiredListener = (reason?: AuthRequiredReason) => void;
const authRequiredListeners = new Set<AuthRequiredListener>();

export type AuthSessionChange = 'login' | 'logout';
type AuthSessionChangeListener = (change: AuthSessionChange) => void;
const authSessionChangeListeners = new Set<AuthSessionChangeListener>();
let crossTabAuthSyncUnsubscribe: (() => void) | undefined;

function ensureCrossTabAuthSync(): void {
  initializeOfflineSessionSync();
  crossTabAuthSyncUnsubscribe ??= subscribeToOfflineSessionChange((change) => {
    // The PWA module has already cleared this realm's volatile and persistent
    // offline state. These events only fan out observable auth/query changes.
    void clearDerivedMediaRuntimeCache().catch(() => undefined);
    if (change === 'login') {
      for (const listener of authRequiredListeners) listener('login');
      publishAuthSessionChanged('login');
      return;
    }
    for (const listener of authRequiredListeners) listener();
    if (change === 'logout') publishAuthSessionChanged('logout');
  });
}

export function subscribeToAuthRequired(listener: AuthRequiredListener): () => void {
  ensureCrossTabAuthSync();
  authRequiredListeners.add(listener);
  return () => authRequiredListeners.delete(listener);
}

/**
 * Publishes payload-free session transitions for browser-only state that must
 * never cross an authenticated session boundary.
 */
export function subscribeToAuthSessionChanged(listener: AuthSessionChangeListener): () => void {
  ensureCrossTabAuthSync();
  authSessionChangeListeners.add(listener);
  return () => authSessionChangeListeners.delete(listener);
}

function publishAuthSessionChanged(change: AuthSessionChange): void {
  for (const listener of authSessionChangeListeners) listener(change);
}

async function publishAuthRequired(path: string, status: number): Promise<void> {
  if (
    status !== 401 ||
    path === '/internal/auth/status' ||
    path === '/internal/auth/login'
  ) {
    return;
  }
  try {
    await Promise.all([
      clearDerivedMediaRuntimeCache(),
      clearOfflineBootstrapState({ broadcast: true, change: 'unauthorized' }),
    ]);
  } catch {
    // The original 401 remains authoritative; login retries cleanup before
    // asking the server to create a replacement session.
  } finally {
    for (const listener of authRequiredListeners) listener();
  }
}

function publishAuthBoundary(reason?: AuthRequiredReason): void {
  for (const listener of authRequiredListeners) listener(reason);
}

function assertRequestNetworkAvailable(init: RequestInit): void {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  assertOnlineForWrite();
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

function providerPath(providerId: string): string {
  return encodeURIComponent(ProviderIdSchema.parse(providerId));
}

function adapterPath(adapterId: string): string {
  return encodeURIComponent(AdapterIdParamsSchema.parse({ adapterId }).adapterId);
}

function parseRef(ref: CustomAdapterRef): CustomAdapterRef {
  return CustomAdapterRefSchema.parse(ref);
}

function parseEmptyQuery(): void {
  AdapterEmptyQuerySchema.parse({});
}

function parseAdapterDocument(document: unknown): CustomAdapterDocument {
  return CustomAdapterDocumentSchema.parse(document);
}

function assertInputKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} input must be an object.`);
  }
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${label} input contains an unknown field.`);
  }
}

function parseAdapterRequest<T>(
  schema: Parser<T>,
  providerId: string,
  input: unknown,
): T & { providerId: string } {
  const parsedProviderId = ProviderIdSchema.parse(providerId);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Adapter request input must be an object.');
  }
  if (Object.hasOwn(input, 'providerId')) {
    throw new TypeError('Provider-scoped adapter requests must not include providerId in the body.');
  }
  return schema.parse({ ...(input as Record<string, unknown>), providerId: parsedProviderId }) as T & { providerId: string };
}

function withoutProviderId<T extends { providerId: string }>(input: T): Omit<T, 'providerId'> {
  const { providerId: _providerId, ...body } = input;
  return body;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (value === null) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(value)?.[1];
  const quoted = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/iu.exec(value)?.[1];
  const unquoted = /(?:^|;)\s*filename\s*=\s*([^;\s]+)/iu.exec(value)?.[1];
  let filename = encoded ?? quoted ?? unquoted;
  if (filename === undefined) return null;
  if (encoded !== undefined) {
    try {
      filename = decodeURIComponent(filename);
    } catch {
      return null;
    }
  }
  if (filename.length === 0 || filename.length > 255 || filename.includes('\\') || filename.includes('/')) return null;
  for (const character of filename) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return null;
  }
  return filename;
}

async function readTextSafely(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new InternalApiError(response.status, 'response_too_large', 'Internal API response is too large.');
    }
  }

  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new InternalApiError(response.status, 'response_too_large', 'Internal API response is too large.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof InternalApiError) throw error;
    throw new InternalApiError(response.status, 'invalid_response', 'Internal API response could not be read.');
  } finally {
    reader.releaseLock();
  }
}

async function readJsonSafely(response: Response, maxBytes = MAX_ADAPTER_RESPONSE_BYTES): Promise<unknown> {
  try {
    const text = await readTextSafely(response, maxBytes);
    if (text.trim().length === 0) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function requestJson<T>(
  path: string,
  parser: Parser<T>,
  init: RequestInit = {},
): Promise<T> {
  assertRequestNetworkAvailable(init);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch (error) {
    markNetworkFailureError(error);
    if (isNetworkFailure(error)) markNetworkFailure();
    throw error;
  }
  markNetworkAvailable();
  await publishAuthRequired(path, response.status);
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.toLowerCase().includes('application/json')
    ? await readJsonSafely(response)
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
  assertRequestNetworkAvailable(init);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch (error) {
    markNetworkFailureError(error);
    if (isNetworkFailure(error)) markNetworkFailure();
    throw error;
  }
  markNetworkAvailable();
  await publishAuthRequired(path, response.status);
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

async function requestExport(
  path: string,
  init: RequestInit = {},
): Promise<CustomAdapterExportDownload> {
  assertRequestNetworkAvailable(init);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json, application/yaml, text/yaml, text/plain');
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers,
    });
  } catch (error) {
    markNetworkFailureError(error);
    if (isNetworkFailure(error)) markNetworkFailure();
    throw error;
  }
  markNetworkAvailable();
  await publishAuthRequired(path, response.status);
  if (!response.ok) {
    const body = await readJsonSafely(response);
    const error = typeof body === 'object' && body !== null && 'error' in body
      ? String(body.error)
      : 'internal_api_error';
    const message = typeof body === 'object' && body !== null && 'message' in body
      ? String(body.message)
      : `Internal API request failed with status ${response.status}.`;
    throw new InternalApiError(response.status, error, message);
  }
  const text = await readTextSafely(response, MAX_ADAPTER_DOCUMENT_BYTES);
  CustomAdapterDocumentSchema.parse(text);
  const contentType = response.headers.get('content-type') ?? '';
  return {
    text,
    content: text,
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
    contentType,
  };
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

const CustomAdapterPreviewResponseSchema = CustomAdapterCompiledPreviewSchema.extend({
  capabilities: ProviderCapabilitiesSchema,
}).strict();

function adapterQueryForRef(ref: CustomAdapterRef): Record<string, string> {
  const parsed = parseRef(ref);
  return {
    kind: parsed.kind,
    adapterId: parsed.adapterId,
    version: parsed.version,
    digest: parsed.digest,
  };
}

function revisionQuery(
  options: Readonly<{
    cursor?: string;
    digest?: string;
    kind?: 'declarative-http' | 'trusted-javascript';
    adapterId?: string;
    limit?: number;
    version?: string;
    ref?: CustomAdapterRef;
  }> = {},
): Record<string, string | number | undefined> {
  assertInputKeys(options, ['cursor', 'digest', 'kind', 'adapterId', 'limit', 'version', 'ref', 'signal'], 'Adapter revision');
  const raw = options.ref === undefined
    ? options
    : { ...options, ...adapterQueryForRef(options.ref) };
  const parsed = CustomAdapterRevisionListQuerySchema.parse({
    ...(raw.kind === undefined ? {} : { kind: raw.kind }),
    ...(raw.adapterId === undefined ? {} : { adapterId: raw.adapterId }),
    ...(raw.version === undefined ? {} : { version: raw.version }),
    ...(raw.digest === undefined ? {} : { digest: raw.digest }),
    ...(raw.limit === undefined ? {} : { limit: raw.limit }),
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
  });
  return {
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.adapterId === undefined ? {} : { adapterId: parsed.adapterId }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
    limit: parsed.limit,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

function trustedRevisionQuery(
  options: Readonly<{
    cursor?: string;
    digest?: string;
    kind?: 'trusted-javascript';
    adapterId?: string;
    limit?: number;
    version?: string;
    ref?: CustomAdapterRef;
    signal?: AbortSignal;
  }> = {},
): Record<string, string | number | undefined> {
  assertInputKeys(options, ['cursor', 'digest', 'kind', 'adapterId', 'limit', 'version', 'ref', 'signal'], 'Trusted adapter revision');
  const ref = options.ref === undefined ? undefined : parseRef(options.ref);
  const parsed = TrustedAdapterRevisionListQuerySchema.parse({
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.kind === undefined && ref === undefined ? {} : { kind: ref?.kind ?? options.kind }),
    ...(options.adapterId === undefined && ref === undefined ? {} : { adapterId: ref?.adapterId ?? options.adapterId }),
    ...(options.version === undefined && ref === undefined ? {} : { version: ref?.version ?? options.version }),
    ...(options.digest === undefined && ref === undefined ? {} : { digest: ref?.digest ?? options.digest }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.adapterId === undefined ? {} : { adapterId: parsed.adapterId }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
    limit: parsed.limit,
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
  };
}

function trustedRefQuery(ref: CustomAdapterRef | undefined, exact: boolean): Record<string, string | undefined> {
  const parsed = exact
    ? TrustedAdapterUnbindQuerySchema.parse(ref)
    : TrustedAdapterRevisionQuerySchema.parse(ref === undefined ? {} : ref);
  return {
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.adapterId === undefined ? {} : { adapterId: parsed.adapterId }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
  };
}

function normalizePutInput(
  input: CustomAdapterPutInput | CustomAdapterDocument,
  formatOrOptions?: 'json' | 'yaml' | CustomAdapterPutOptions,
  suppliedOptions: InternalRequestOptions = {},
): { document: CustomAdapterDocument; format: 'json' | 'yaml'; version?: string; options: InternalRequestOptions } {
  const wrapped = input !== null && typeof input === 'object' && !Array.isArray(input) &&
    Object.hasOwn(input, 'document');
  if (wrapped) assertInputKeys(input, ['document', 'format', 'version'], 'Adapter PUT');
  const document = parseAdapterDocument(wrapped ? (input as CustomAdapterPutInput).document : input);
  const wrappedFormat = wrapped ? (input as CustomAdapterPutInput).format : undefined;
  const wrappedVersion = wrapped ? (input as CustomAdapterPutInput).version : undefined;
  const explicitFormat = typeof formatOrOptions === 'string'
    ? formatOrOptions
    : formatOrOptions?.format ?? wrappedFormat;
  const explicitVersion = formatOrOptions !== undefined && typeof formatOrOptions !== 'string'
    ? formatOrOptions.version ?? wrappedVersion
    : wrappedVersion;
  if (formatOrOptions !== undefined && typeof formatOrOptions === 'object' && formatOrOptions !== null) {
    assertInputKeys(formatOrOptions, ['format', 'version', 'signal'], 'Adapter PUT options');
  }
  const options = typeof formatOrOptions === 'object' && formatOrOptions !== null
    ? { ...suppliedOptions, ...formatOrOptions }
    : suppliedOptions;
  const format = AdapterDocumentFormatSchema.parse(explicitFormat ?? 'json');
  if (format === 'yaml' && typeof document !== 'string') {
    throw new TypeError('YAML adapter documents must be supplied as raw text.');
  }
  let envelope: CustomAdapterImportEnvelope | null = null;
  if (format === 'json' && typeof document === 'string') {
    try {
      const parsed = JSON.parse(document) as unknown;
      envelope = CustomAdapterImportEnvelopeSchema.parse(parsed);
    } catch {
      // Raw JSON is intentionally kept as text; the server parses it.
    }
  } else if (typeof document === 'object') {
    try {
      envelope = CustomAdapterImportEnvelopeSchema.parse(document);
    } catch {
      // Raw JSON objects are accepted when an explicit version is supplied.
    }
  }
  const yamlEnvelopeVersion = format === 'yaml' && typeof document === 'string'
    ? readExportedYamlEnvelopeVersion(document)
    : undefined;
  const parsedVersion = explicitVersion === undefined
    ? undefined
    : CustomAdapterImportRequestSchema.parse({ providerId: 'adapter-version-check', document, format, version: explicitVersion }).version;
  if (envelope !== null && parsedVersion !== undefined && envelope.version !== parsedVersion) {
    throw new TypeError('Adapter envelope version does not match the requested version.');
  }
  if (yamlEnvelopeVersion !== undefined && parsedVersion !== undefined && yamlEnvelopeVersion !== parsedVersion) {
    throw new TypeError('Adapter envelope version does not match the requested version.');
  }
  const isEnvelope = envelope !== null || yamlEnvelopeVersion !== undefined;
  if (!isEnvelope && parsedVersion === undefined) {
    throw new TypeError('Raw adapter documents require a bounded version.');
  }
  return {
    document,
    format,
    ...(!isEnvelope && parsedVersion !== undefined ? { version: parsedVersion } : {}),
    options,
  };
}

function requestSignal(options: InternalRequestOptions): Pick<RequestInit, 'signal'> {
  return options.signal === undefined ? {} : { signal: options.signal };
}

export const internalClient = {
  getMyAccount: () => requestJson('/internal/account', AccountResponseSchema),
  listAccounts: () => requestJson('/internal/accounts', AccountListSchema),
  createAccount: (username: string, password: string) => requestJson('/internal/accounts', AccountResponseSchema, { method: 'POST', body: jsonBody({ username, password }) }),
  updateAccount: (id: string, input: { enabled?: boolean; password?: string }) => requestJson(`/internal/accounts/${encodeURIComponent(id)}`, AccountListSchema, { method: 'PATCH', body: jsonBody(input) }),
  updateMyAccount: (input: { currentPassword: string; username?: string; password?: string }) => requestJson('/internal/account', AccountResponseSchema, { method: 'PATCH', body: jsonBody(input) }),
  getAuthStatus: async () => {
    let status: AuthStatus;
    try {
      status = await requestJson('/internal/auth/status', AuthStatusSchema);
    } catch (error) {
      if (error instanceof InternalApiError && error.status === 401) {
        await Promise.allSettled([
          clearDerivedMediaRuntimeCache(),
          clearOfflineBootstrapState({ broadcast: true, change: 'unauthorized' }),
        ]);
      }
      throw error;
    }
    if (!status.required) {
      // Public deployments get an explicit, identity-free offline marker. A
      // required=false response is never treated as an authenticated user.
      await clearOfflineBootstrapState({ broadcast: false });
      await clearDerivedMediaRuntimeCache();
      rememberPublicOfflineBootstrap();
    } else if (!status.authenticated) {
      await clearOfflineBootstrapState({ broadcast: true, change: 'logout' });
      await clearDerivedMediaRuntimeCache();
      publishAuthSessionChanged('logout');
      publishAuthBoundary();
    } else {
      rememberAuthenticatedSession();
    }
    return status;
  },
  login: async (password: string, username?: string) => {
    const input = AuthLoginSchema.parse({ password, ...(username ? { username } : {}) });
    await clearOfflineBootstrapState({ broadcast: true, change: 'logout' });
    await clearDerivedMediaRuntimeCache();
    const status = await requestJson('/internal/auth/login', AuthStatusSchema, {
      method: 'POST',
      body: jsonBody(input),
    });
    await clearDerivedMediaRuntimeCache();
    await clearOfflineBootstrapState();
    if (status.required && status.authenticated) rememberAuthenticatedSession();
    if (!status.required) rememberPublicOfflineBootstrap();
    broadcastOfflineSessionChange('login');
    publishAuthSessionChanged('login');
    return status;
  },
  logout: async () => {
    await clearOfflineBootstrapState({ broadcast: true, change: 'logout' });
    await clearDerivedMediaRuntimeCache();
    await requestEmpty('/internal/auth/logout', { method: 'POST' });
    publishAuthSessionChanged('logout');
    publishAuthBoundary();
    await clearOfflineBootstrapState({ broadcast: false });
    await clearDerivedMediaRuntimeCache();
  },
  getSettings: async () =>
    requestJson('/internal/settings', SettingsResponseSchema),
  patchSettings: async (values: Readonly<Record<string, JsonValue>>) =>
    requestJson('/internal/settings', SettingsResponseSchema, {
      method: 'PATCH',
      body: jsonBody({ values }),
    }),
  getDatabaseIntegrity: async () =>
    requestJson('/internal/maintenance/integrity', MaintenanceIntegrityResponseSchema),
  getMediaConsistency: async () =>
    requestJson('/internal/maintenance/media', MaintenanceMediaResponseSchema),
  reconcileMediaConsistency: async () =>
    requestJson('/internal/maintenance/media/reconcile', MaintenanceMediaReconcileResponseSchema, {
      method: 'POST',
    }),
  getMediaRepairs: async () =>
    requestJson('/internal/maintenance/media/repairs', MaintenanceMediaRepairsResponseSchema),
  runMediaRepairs: async () =>
    requestJson('/internal/maintenance/media/repairs/run', MaintenanceMediaRepairRunResponseSchema, {
      method: 'POST',
    }),
  createDatabaseBackup: async () =>
    requestJson('/internal/maintenance/backups', MaintenanceBackupResponseSchema, {
      method: 'POST',
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
  listTrustedAdapters: async (options: InternalRequestOptions = {}) => {
    parseEmptyQuery();
    return requestJson('/internal/adapters', TrustedAdapterPageSchema, requestSignal(options));
  },
  getTrustedAdapter: async (adapterId: string, options: InternalRequestOptions = {}) => {
    const path = `/internal/adapters/${adapterPath(adapterId)}`;
    parseEmptyQuery();
    return requestJson(path, TrustedAdapterResponseSchema, requestSignal(options));
  },
  installTrustedAdapter: async (
    input: TrustedAdapterInstallInput | TrustedAdapterManifest,
    sourceOrOptions?: File | InternalRequestOptions,
    providerIdOrOptions?: string | InternalRequestOptions,
    suppliedOptions: InternalRequestOptions = {},
  ) => {
    const positional = !Object.hasOwn(input, 'manifest');
    const manifest = TrustedAdapterManifestSchema.parse(positional ? input : (input as TrustedAdapterInstallInput).manifest);
    const source = positional ? sourceOrOptions : (input as TrustedAdapterInstallInput).source;
    if (typeof File === 'undefined' || !(source instanceof File)) {
      throw new TypeError('Trusted adapter source must be a File.');
    }
    const suppliedProviderId = positional
      ? typeof providerIdOrOptions === 'string' ? providerIdOrOptions : undefined
      : (input as TrustedAdapterInstallInput).providerId;
    const providerId = suppliedProviderId === undefined
      ? undefined
      : ProviderIdSchema.parse(suppliedProviderId);
    const options = positional && providerIdOrOptions !== undefined && providerIdOrOptions !== null && typeof providerIdOrOptions === 'object'
      ? providerIdOrOptions
      : positional ? suppliedOptions : sourceOrOptions !== undefined && sourceOrOptions !== null && typeof sourceOrOptions === 'object'
        ? sourceOrOptions as InternalRequestOptions
        : suppliedOptions;
    const body = new FormData();
    body.set('manifest', JSON.stringify(manifest));
    body.set('source', source, source.name);
    if (providerId !== undefined) body.set('providerId', providerId);
    return requestJson('/internal/adapters/trusted-javascript', TrustedAdapterResponseSchema, {
      method: 'POST',
      body,
      ...requestSignal(options),
    });
  },
  bindTrustedAdapter: async (
    input: TrustedAdapterBindRequest | string,
    refOrOptions?: CustomAdapterRef | InternalRequestOptions,
    suppliedOptions: InternalRequestOptions = {},
  ) => {
    const parsed = typeof input === 'string'
      ? TrustedAdapterBindRequestSchema.parse({ providerId: input, ref: refOrOptions })
      : TrustedAdapterBindRequestSchema.parse(input);
    const options = typeof input === 'string' && refOrOptions !== undefined && refOrOptions !== null &&
      typeof refOrOptions === 'object' && !('kind' in refOrOptions)
      ? refOrOptions
      : typeof input !== 'string' && refOrOptions !== undefined && refOrOptions !== null &&
        typeof refOrOptions === 'object' && !('kind' in refOrOptions)
        ? refOrOptions
        : suppliedOptions;
    const path = `/internal/providers/${providerPath(parsed.providerId)}/adapter/trusted-javascript`;
    parseEmptyQuery();
    const body = TrustedAdapterBindBodySchema.parse({ ref: parsed.ref });
    return requestJson(path, TrustedAdapterResponseSchema, {
      method: 'POST',
      body: jsonBody(body),
      ...requestSignal(options),
    });
  },
  getTrustedBinding: async (
    providerId: string,
    ref?: CustomAdapterRef,
    options: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const query = trustedRefQuery(ref, false);
    const path = `/internal/providers/${providerPath(parsedProviderId)}/adapter/trusted-javascript${queryString(query)}`;
    return requestJson(path, TrustedAdapterBindingResponseSchema, requestSignal(options));
  },
  listTrustedBindings: async (
    providerId: string,
    options: Readonly<{
      cursor?: string;
      digest?: string;
      kind?: 'trusted-javascript';
      adapterId?: string;
      limit?: number;
      version?: string;
      ref?: CustomAdapterRef;
      signal?: AbortSignal;
    }> = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const query = trustedRevisionQuery(options);
    const path = `/internal/providers/${providerPath(parsedProviderId)}/adapter/trusted-javascript/revisions${queryString(query)}`;
    return requestJson(path, TrustedAdapterBindingPageSchema, requestSignal(options));
  },
  disableTrustedBinding: async (
    providerId: string,
    ref?: CustomAdapterRef,
    options: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const parsedRef = ref === undefined ? undefined : CustomAdapterRefSchema.parse(ref);
    const body = TrustedAdapterDisableBodySchema.parse(parsedRef === undefined ? {} : { ref: parsedRef });
    parseEmptyQuery();
    return requestJson(`/internal/providers/${providerPath(parsedProviderId)}/adapter/trusted-javascript/disable`, TrustedAdapterBindingResponseSchema, {
      method: 'POST',
      ...(Object.keys(body).length === 0 ? {} : { body: jsonBody(body) }),
      ...requestSignal(options),
    });
  },
  unbindTrustedBinding: async (
    providerId: string,
    ref: CustomAdapterRef,
    options: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const query = trustedRefQuery(ref, true);
    return requestEmpty(`/internal/providers/${providerPath(parsedProviderId)}/adapter/trusted-javascript${queryString(query)}`, {
      method: 'DELETE',
      ...requestSignal(options),
    });
  },
  removeTrustedAdapter: async (adapterId: string, options: InternalRequestOptions = {}) => {
    const path = `/internal/adapters/${adapterPath(adapterId)}`;
    parseEmptyQuery();
    return requestEmpty(path, { method: 'DELETE', ...requestSignal(options) });
  },
  getCustomAdapter: async (providerId: string, options: InternalRequestOptions = {}) => {
    const path = `/internal/providers/${providerPath(providerId)}/adapter`;
    parseEmptyQuery();
    return requestJson(path, CustomAdapterDefinitionResponseSchema, requestSignal(options));
  },
  listCustomAdapterRevisions: async (
    providerId: string,
    options: Readonly<{
      cursor?: string;
      digest?: string;
      kind?: 'declarative-http' | 'trusted-javascript';
      adapterId?: string;
      limit?: number;
      version?: string;
      ref?: CustomAdapterRef;
    }> & InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const queryOptions = revisionQuery(options);
    const path = `/internal/providers/${encodeURIComponent(parsedProviderId)}/adapter/revisions${queryString(queryOptions)}`;
    return requestJson(path, CustomAdapterRevisionListResponseSchema, requestSignal(options));
  },
  getCustomAdapterRevision: async (
    providerId: string,
    ref: CustomAdapterRef,
    options: InternalRequestOptions = {},
  ) => {
    const exact = parseRef(ref);
    const page = await internalClient.listCustomAdapterRevisions(providerId, {
      ...exact,
      limit: 1,
      ...options,
    });
    const definition = page.items.find((item) =>
      item.ref.kind === exact.kind &&
      item.ref.adapterId === exact.adapterId &&
      item.ref.version === exact.version &&
      item.ref.digest === exact.digest,
    ) ?? null;
    return definition === null ? null : { definition };
  },
  putCustomAdapter: async (
    providerId: string,
    input: CustomAdapterPutInput | CustomAdapterDocument,
    formatOrOptions?: 'json' | 'yaml' | CustomAdapterPutOptions,
    suppliedOptions: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const normalized = normalizePutInput(input, formatOrOptions, suppliedOptions);
    const parsed = CustomAdapterImportRequestSchema.parse({
      providerId: parsedProviderId,
      document: normalized.document,
      format: normalized.format,
      ...(normalized.version === undefined ? {} : { version: normalized.version }),
    });
    const body = typeof parsed.document === 'string'
      ? parsed.document
      : jsonBody(parsed.document);
    const path = `/internal/providers/${encodeURIComponent(parsedProviderId)}/adapter${queryString(
      normalized.version === undefined ? {} : { version: parsed.version },
    )}`;
    return requestJson(path, CustomAdapterDefinitionResponseSchema, {
      method: 'PUT',
      headers: {
        'Content-Type': parsed.format === 'yaml' ? 'application/yaml; charset=utf-8' : 'application/json',
      },
      body,
      ...requestSignal(normalized.options),
    });
  },
  deleteCustomAdapter: async (providerId: string, ref: CustomAdapterRef, options: InternalRequestOptions = {}) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const parsedRef = parseRef(ref);
    const body = CustomAdapterDeleteBodySchema.parse({ ref: parsedRef });
    parseEmptyQuery();
    return requestEmpty(`/internal/providers/${encodeURIComponent(parsedProviderId)}/adapter`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: jsonBody(body),
      ...requestSignal(options),
    });
  },
  disableCustomAdapter: async (
    providerId: string,
    ref?: CustomAdapterRef,
    options: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    const parsedRef = ref === undefined ? undefined : parseRef(ref);
    parseEmptyQuery();
    return requestJson(`/internal/providers/${encodeURIComponent(parsedProviderId)}/adapter/disable`, CustomAdapterDefinitionResponseSchema, {
      method: 'POST',
      ...(parsedRef === undefined ? {} : { body: jsonBody({ ref: parsedRef }) }),
      ...requestSignal(options),
    });
  },
  exportCustomAdapter: async (
    providerId: string,
    options: CustomAdapterExportOptions | CustomAdapterRef = {},
    requestOptions: InternalRequestOptions = {},
  ) => {
    const parsedProviderId = ProviderIdSchema.parse(providerId);
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Adapter export options must be an object.');
    }
    const normalized = 'kind' in options ? { ref: parseRef(options) } : options;
    if (!('kind' in options)) assertInputKeys(options, ['ref', 'format'], 'Adapter export');
    const parsed = CustomAdapterExportQuerySchema.parse({
      ...(normalized.ref === undefined ? {} : adapterQueryForRef(normalized.ref)),
      ...(normalized.format === undefined ? {} : { format: normalized.format }),
    });
    const query: Record<string, string | undefined> = {
      ...('kind' in parsed ? {
        kind: parsed.kind,
        adapterId: parsed.adapterId,
        version: parsed.version,
        digest: parsed.digest,
      } : {}),
      ...(parsed.format === undefined ? {} : { format: parsed.format }),
    };
    const path = `/internal/providers/${encodeURIComponent(parsedProviderId)}/adapter/export${queryString(query)}`;
    return requestExport(path, requestSignal(requestOptions));
  },
  validateCustomAdapter: async (
    providerId: string,
    input: Omit<CustomAdapterValidateRequest, 'providerId'>,
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterValidateRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/validate`, CustomAdapterValidationResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
  previewCustomAdapter: async (
    providerId: string,
    input: Omit<CustomAdapterPreviewRequest, 'providerId'> = {},
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterPreviewRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/preview`, CustomAdapterPreviewResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
  dryRunCustomAdapter: async (
    providerId: string,
    input: Omit<CustomAdapterDryRunRequest, 'providerId'> = {},
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterDryRunRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/dry-run`, CustomAdapterDryRunResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
  simulateCustomAdapter: async (
    providerId: string,
    input: Omit<CustomAdapterSimulateRequest, 'providerId'>,
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterSimulateRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/simulate`, CustomAdapterExtractedResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
  testCustomAdapterPath: async (
    providerId: string,
    input: Omit<CustomAdapterPathTestRequest, 'providerId'>,
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterPathTestRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/path-test`, CustomAdapterPathTestResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
  previewCustomAdapterCapabilities: async (
    providerId: string,
    input: Omit<CustomAdapterCapabilityPreviewRequest, 'providerId'> = {},
    options: InternalRequestOptions = {},
  ) => {
    const parsed = parseAdapterRequest(CustomAdapterCapabilityPreviewRequestSchema, providerId, input);
    return requestJson(`/internal/providers/${providerPath(parsed.providerId)}/adapter/capabilities-preview`, CustomAdapterCapabilityPreviewResponseSchema, {
      method: 'POST',
      body: jsonBody(withoutProviderId(parsed)),
      ...requestSignal(options),
    });
  },
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
  listAssets: async (options: { collectionId?: string; cursor?: string; favorite?: boolean; jobId?: string; limit?: number; role?: string; type?: string; search?: string; includeJobs?: boolean } = {}) =>
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
