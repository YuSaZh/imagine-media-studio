import type {
  ModelCapabilities,
  ProviderAssetReference,
  ProviderError,
  ProviderInput,
  ProviderModel,
  ProviderResultTarget,
  SubmittedAsset,
} from '@imagine/provider-contract';

import {
  GeminiHttpError,
  GeminiResponseError,
  GeminiTransportError,
  GeminiValidationError,
  normalizeProviderCode,
  redactSensitiveText,
} from './errors.js';
import { buildGeminiHeaders } from './headers.js';
import type {
  GeminiHttpRequest,
  GeminiHttpRequestExecutor,
  GeminiHttpResponse,
  GeminiHttpTransport,
  GeminiProviderContext,
  GeminiProviderOptions,
} from './types.js';

export const GEMINI_VEO_PROFILE = 'gemini-veo-operation-v1' as const;
export const GEMINI_OMNI_VIDEO_PROFILE = 'gemini-omni-interactions-video-v1' as const;
export const GEMINI_VIDEO_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta' as const;

export const GEMINI_VIDEO_INPUT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const GEMINI_VIDEO_OUTPUT_MIME_TYPE = 'video/mp4' as const;
export const GEMINI_VIDEO_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const GEMINI_VIDEO_MAX_TOTAL_INPUT_BYTES = 48 * 1024 * 1024;
export const GEMINI_VIDEO_MAX_INLINE_OUTPUT_BYTES = 4 * 1024 * 1024;
export const GEMINI_VIDEO_MAX_PROMPT_CHARS = 32_000;
export const GEMINI_VIDEO_MAX_MODEL_ID_LENGTH = 255;
export const GEMINI_VIDEO_MAX_REMOTE_ID_LENGTH = 255;
export const GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH = 4_096;
// URI delivery is preferred for large Omni results; inline output is deliberately
// kept small enough that a provider result reference cannot inflate SQLite state.
export const GEMINI_VIDEO_MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const GEMINI_VIDEO_MAX_CATALOG_MODELS = 200;
export const GEMINI_VIDEO_MAX_OUTPUT_ASSETS = 1;
export const GEMINI_VIDEO_POLL_AFTER_MS = 10_000;
export const GEMINI_VIDEO_MAX_RESULT_ID_LENGTH = 255;

export type GeminiVideoHttp = GeminiHttpTransport | GeminiHttpRequestExecutor;

export interface GeminiVideoProviderOptions extends GeminiProviderOptions {
  readonly models?: readonly string[];
}

export interface GeminiVideoRuntimeContext extends GeminiProviderContext {
  readonly modelId?: string;
}

export interface GeminiVideoModelDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function boundedString(value: unknown, max = GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function isReadableLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return typeof candidate.pipe === 'function' ||
    typeof candidate.getReader === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function';
}

export function canonicalMimeType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

export function videoApiKey(context: GeminiVideoRuntimeContext): string {
  const key = (context.secrets.apiKey ?? context.secrets.api_key)?.trim();
  if (!key) throw new GeminiValidationError('Gemini API key is required.', 'gemini_api_key_missing');
  if (key.length > 16_384 || /[\r\n]/u.test(key)) throw new GeminiValidationError('Gemini API key is invalid.', 'gemini_header_invalid');
  return key;
}

function secretHeaders(context: GeminiVideoRuntimeContext): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(context.secrets)
      .filter(([name]) => name.startsWith('header:'))
      .map(([name, value]) => [name.slice('header:'.length), value]),
  );
}

export function videoRequestHeaders(
  context: GeminiVideoRuntimeContext,
  apiKey: string,
  configured: Readonly<Record<string, string>> | undefined,
  accept = 'application/json',
): Readonly<Record<string, string>> {
  for (const source of [configured, context.headers, context.config?.headers as Readonly<Record<string, unknown>> | undefined, secretHeaders(context)]) {
    for (const value of Object.values(source ?? {})) {
      if (typeof value === 'string' && value.length > 16_384) throw new GeminiValidationError('Gemini custom header is too large.', 'gemini_header_invalid');
    }
  }
  const headers = buildGeminiHeaders(
    apiKey,
    [configured, context.headers, context.config?.headers as Readonly<Record<string, unknown>> | undefined],
    secretHeaders(context),
  );
  return { ...headers, accept };
}

function validatedBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeminiValidationError('Gemini base URL is invalid.', 'gemini_base_url_invalid');
  }
  if (
    url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new GeminiValidationError(
      'Gemini base URL must use HTTP or HTTPS without credentials, query, or fragment.',
      'gemini_base_url_invalid',
    );
  }
  return url;
}

export function videoBaseUrl(
  context: GeminiVideoRuntimeContext,
  configured: string | undefined,
  terminalPaths: readonly string[] = [],
): string {
  const raw = context.baseUrl?.trim() ||
    (typeof context.config?.baseUrl === 'string' ? context.config.baseUrl.trim() : '') ||
    configured?.trim() || GEMINI_VIDEO_DEFAULT_BASE_URL;
  const url = validatedBaseUrl(raw);
  let path = url.pathname.replace(/\/+$/u, '');
  const predictLongRunning = path.search(/\/models\/[^/:]+:predictLongRunning$/u);
  if (predictLongRunning >= 0) path = path.slice(0, predictLongRunning).replace(/\/+$/u, '');
  for (const terminal of terminalPaths) {
    if (path.endsWith(terminal)) {
      path = path.slice(0, -terminal.length).replace(/\/+$/u, '');
      break;
    }
  }
  if (path.endsWith('/models')) path = path.slice(0, -'/models'.length).replace(/\/+$/u, '');
  if (path.endsWith('/interactions')) path = path.slice(0, -'/interactions'.length).replace(/\/+$/u, '');
  url.pathname = path || '/';
  return url.toString().replace(/\/$/u, '');
}

export function videoEndpoint(baseUrl: string, path: string): string {
  const url = validatedBaseUrl(baseUrl);
  const prefix = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${prefix}/${path.replace(/^\/+/, '')}`;
  return url.toString();
}

export function videoModelsUrl(baseUrl: string): string {
  return videoEndpoint(baseUrl, '/models');
}

export function resolveVideoTransport(
  context: GeminiVideoRuntimeContext,
  configured: GeminiVideoHttp | undefined,
): GeminiVideoHttp {
  const transport = configured ?? context.http ?? context.transport;
  if (!transport) throw new GeminiTransportError('Gemini requires an injected safe HTTP transport.');
  return transport;
}

function responseStatus(response: GeminiHttpResponse): number {
  const status = response.statusCode ?? response.status;
  if (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599) {
    throw new GeminiResponseError('Gemini HTTP response did not include a valid status code.');
  }
  return status as number;
}

function headerValue(response: GeminiHttpResponse, name: string): string | undefined {
  if (!response.headers) return undefined;
  if ('get' in response.headers && typeof response.headers.get === 'function') {
    return response.headers.get(name) ?? undefined;
  }
  const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return typeof found === 'string' ? found : found?.[0];
}

export function retryAfterMs(response: GeminiHttpResponse): number | undefined {
  const value = headerValue(response, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 86_400_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), 86_400_000);
}

function assertBoundedResponse(value: unknown): unknown {
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > GEMINI_VIDEO_MAX_JSON_RESPONSE_BYTES) {
    throw new GeminiResponseError('Gemini response body exceeds the video response limit.', 'gemini_response_too_large');
  }
  if (value instanceof Uint8Array && value.byteLength > GEMINI_VIDEO_MAX_JSON_RESPONSE_BYTES) {
    throw new GeminiResponseError('Gemini response body exceeds the video response limit.', 'gemini_response_too_large');
  }
  if (isReadableLike(value)) {
    throw new GeminiResponseError('Gemini response streams must be pre-parsed and bounded.', 'gemini_response_stream_unsupported');
  }
  if (isRecord(value) || Array.isArray(value)) {
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new GeminiResponseError('Gemini response body is not valid JSON.', 'gemini_response_invalid');
    }
    if (Buffer.byteLength(serialized, 'utf8') > GEMINI_VIDEO_MAX_JSON_RESPONSE_BYTES) {
      throw new GeminiResponseError('Gemini response body exceeds the video response limit.', 'gemini_response_too_large');
    }
  }
  return value;
}

export async function readVideoResponseBody(response: GeminiHttpResponse): Promise<unknown> {
  try {
    let value: unknown;
    if (typeof response.json === 'function') {
      try {
        value = await response.json();
      } catch {
        value = undefined;
      }
    } else if (response.json !== undefined) {
      value = response.json;
    }
    // Some transports expose a JSON reader that rejects on plain-text 429/5xx
    // bodies. Fall back to the text/body port before classifying the status.
    if (value === undefined && typeof response.text === 'function') {
      let text = '';
      try { text = await response.text(); } catch { text = ''; }
      if (text.trim() === '') value = undefined;
      else {
        try { value = JSON.parse(text); } catch { value = text; }
      }
    } else if (value === undefined && typeof response.text === 'string') {
      if (response.text.trim() === '') value = undefined;
      else {
        try { value = JSON.parse(response.text); } catch { value = response.text; }
      }
    } else if (value === undefined && typeof response.body === 'string') {
      if (response.body.trim() === '') value = undefined;
      else {
        try { value = JSON.parse(response.body); } catch { value = response.body; }
      }
    } else if (value === undefined && response.body instanceof Uint8Array) {
      if (response.body.byteLength === 0) value = undefined;
      else {
        const text = Buffer.from(response.body).toString('utf8');
        try { value = JSON.parse(text); } catch { value = text; }
      }
    } else {
      value = response.body;
    }
    return assertBoundedResponse(value);
  } finally {
    try { await response.dispose?.(); } catch { /* disposal cannot hide the API result */ }
  }
}

function apiError(value: unknown): { code?: string; message?: string } {
  const root = asRecord(value);
  const error = asRecord(root?.error);
  return {
    ...(typeof error?.status === 'string' ? { code: error.status } : {}),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(typeof error?.message === 'string' ? { message: error.message } : {}),
  };
}

function errorText(value: unknown, status: number): string {
  const fields = apiError(value);
  if (fields.message) return fields.message.slice(0, GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH);
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH);
  return `Gemini request failed with HTTP ${status}.`;
}

export async function requestVideoJson(
  context: GeminiVideoRuntimeContext,
  configured: GeminiVideoHttp | undefined,
  request: GeminiHttpRequest,
  label: string,
): Promise<unknown> {
  const transport = resolveVideoTransport(context, configured);
  context.signal?.throwIfAborted();
  let response: GeminiHttpResponse;
  try {
    response = typeof transport === 'function' ? await transport(request) : await transport.request(request);
  } catch (error) {
    if (error instanceof GeminiValidationError || error instanceof GeminiTransportError || error instanceof GeminiHttpError) throw error;
    throw new GeminiTransportError(`Gemini ${label} request failed.`, { cause: error });
  }
  let status: number;
  try {
    status = responseStatus(response);
  } catch (error) {
    try { await response.dispose?.(); } catch { /* best effort */ }
    throw error;
  }
  if (status < 200 || status >= 300) {
    const retry = retryAfterMs(response);
    const body = await readVideoResponseBody(response);
    const fields = apiError(body);
    throw new GeminiHttpError(
      redactSensitiveText(errorText(body, status), context.secrets),
      status,
      normalizeGeminiVideoHttpCode(fields.code),
      retry,
    );
  }
  const body = await readVideoResponseBody(response);
  if (body === undefined) throw new GeminiResponseError(`Gemini ${label} response body is empty.`);
  return body;
}

export function configuredVideoModels(
  options: GeminiVideoProviderOptions,
  context: GeminiVideoRuntimeContext,
  defaults: readonly string[],
): readonly string[] {
  const configured = options.models ?? (
    Array.isArray(context.config?.models) ? context.config.models : undefined
  );
  const values = configured ?? defaults;
  return [...new Set(values.filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= GEMINI_VIDEO_MAX_MODEL_ID_LENGTH))]
    .slice(0, GEMINI_VIDEO_MAX_CATALOG_MODELS);
}

export function canonicalModelId(value: string): string {
  return value.trim().replace(/^models\//u, '');
}

export function assertModelId(value: unknown): string {
  if (typeof value !== 'string') throw new GeminiValidationError('Gemini video model is invalid.', 'gemini_model_unsupported');
  const id = canonicalModelId(value);
  if (!id || id.length > GEMINI_VIDEO_MAX_MODEL_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/u.test(id)) {
    throw new GeminiValidationError('Gemini video model is invalid.', 'gemini_model_unsupported');
  }
  return id;
}

export function inputAssets(
  requestInputs: readonly { assetId: string; role: ProviderInput['role'] }[],
  context: GeminiVideoRuntimeContext,
): readonly ProviderInput[] {
  const available = context.inputs ?? [];
  const map = new Map<string, ProviderInput>();
  for (const input of available) {
    if (map.has(input.assetId)) throw new GeminiValidationError('Gemini video inputs must be unique.', 'gemini_input_duplicate');
    map.set(input.assetId, input);
  }
  const seen = new Set<string>();
  let total = 0;
  return requestInputs.map((requested) => {
    if (seen.has(requested.assetId)) throw new GeminiValidationError('Gemini video inputs must be unique.', 'gemini_input_duplicate');
    seen.add(requested.assetId);
    const input = map.get(requested.assetId);
    if (!input) throw new GeminiValidationError('Gemini video input bytes were not resolved.', 'gemini_input_unresolved');
    if (input.role !== requested.role) throw new GeminiValidationError('Gemini video input role does not match.', 'gemini_input_role_mismatch');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new GeminiValidationError('Gemini video input bytes are invalid.', 'gemini_input_bytes_invalid');
    }
    if (!GEMINI_VIDEO_INPUT_MIME_TYPES.includes(canonicalMimeType(input.mimeType) as (typeof GEMINI_VIDEO_INPUT_MIME_TYPES)[number])) {
      throw new GeminiValidationError('Gemini video input MIME type is unsupported.', 'gemini_input_mime_unsupported');
    }
    if (input.bytes.byteLength > GEMINI_VIDEO_MAX_INPUT_BYTES) {
      throw new GeminiValidationError('Gemini video input exceeds the size limit.', 'gemini_input_too_large');
    }
    total += input.bytes.byteLength;
    if (total > GEMINI_VIDEO_MAX_TOTAL_INPUT_BYTES) {
      throw new GeminiValidationError('Gemini video inputs exceed the aggregate size limit.', 'gemini_input_too_large');
    }
    return { ...input, mimeType: canonicalMimeType(input.mimeType) };
  });
}

export function inputInlineData(input: ProviderInput): { mimeType: string; data: string } {
  return { mimeType: canonicalMimeType(input.mimeType), data: Buffer.from(input.bytes).toString('base64') };
}

export function assertPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > GEMINI_VIDEO_MAX_PROMPT_CHARS) {
    throw new GeminiValidationError(`Gemini video prompt must contain 1 through ${GEMINI_VIDEO_MAX_PROMPT_CHARS} characters.`, 'gemini_prompt_invalid');
  }
  return prompt.trim();
}

export function validBase64(value: string, maxBytes = GEMINI_VIDEO_MAX_INLINE_OUTPUT_BYTES): boolean {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.byteLength <= maxBytes &&
    decoded.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '');
}

export function inlineVideoAsset(
  value: Record<string, unknown>,
  resultId?: string,
): SubmittedAsset {
  const raw = value.data ?? value.base64;
  if (typeof raw !== 'string' || !validBase64(raw)) throw new GeminiResponseError('Gemini returned invalid inline video data.', 'gemini_video_data_invalid');
  const mimeType = canonicalMimeType(value.mimeType ?? value.mime_type) || GEMINI_VIDEO_OUTPUT_MIME_TYPE;
  if (mimeType !== GEMINI_VIDEO_OUTPUT_MIME_TYPE) throw new GeminiResponseError('Gemini returned an unsupported video MIME type.', 'gemini_video_mime_unsupported');
  return {
    type: 'video', mimeType, source: 'base64', base64: raw,
    ...(resultId === undefined ? {} : { resultId }),
  };
}

export function boundedResultId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > GEMINI_VIDEO_MAX_RESULT_ID_LENGTH || /[\r\n]/u.test(value)) {
    throw new GeminiResponseError('Gemini video result id is invalid.', 'gemini_output_metadata_invalid');
  }
  return value;
}

export function parseResultExpiry(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 128) {
    throw new GeminiResponseError('Gemini video expiry is invalid.', 'gemini_expiry_invalid');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new GeminiResponseError('Gemini video expiry is invalid.', 'gemini_expiry_invalid');
  return new Date(timestamp);
}

export function isExpired(date: Date | undefined): boolean {
  return date !== undefined && date.getTime() <= Date.now();
}

export function safeProviderUri(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH) {
    throw new GeminiResponseError('Gemini returned an invalid video URI.', 'gemini_video_uri_invalid');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new GeminiResponseError('Gemini returned an invalid video URI.', 'gemini_video_uri_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new GeminiResponseError('Gemini video URI is unsafe.', 'gemini_video_uri_invalid');
  }
  for (const key of url.searchParams.keys()) {
    if (['key', 'api_key', 'apikey', 'access_token', 'token', 'secret', 'x-goog-api-key'].includes(key.toLowerCase())) {
      throw new GeminiResponseError('Gemini video URI contains sensitive query data.', 'gemini_video_uri_invalid');
    }
  }
  return url.toString();
}

export function fileIdFromUri(uri: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return undefined; }
  const match = /\/files\/([^/:?#]+)(?::|$)/u.exec(parsed.pathname);
  const id = match?.[1];
  if (!id || id.length > 160 || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined;
  return id;
}

export function assertOperationName(value: unknown): string {
  // The durable reference adds the "operation:" prefix and must remain within
  // the shared 255-character provider-reference bound.
  if (typeof value !== 'string' || value.length > GEMINI_VIDEO_MAX_REMOTE_ID_LENGTH - 'operation:'.length || !/^operations\/[A-Za-z0-9._~:/-]{1,230}$/u.test(value)) {
    throw new GeminiResponseError('Gemini returned an invalid operation name.', 'gemini_operation_invalid');
  }
  return value;
}

export function assertInteractionId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new GeminiResponseError('Gemini returned an invalid interaction id.', 'gemini_interaction_invalid');
  }
  return value;
}

export function assertFileId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 160 || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new GeminiResponseError('Gemini returned an invalid file id.', 'gemini_file_invalid');
  }
  return value;
}

export function providerVideoAsset(
  context: GeminiVideoRuntimeContext,
  remoteJobId: string,
  model: string,
  resultId?: string,
): Extract<SubmittedAsset, { source: 'provider' }> {
  return {
    type: 'video', mimeType: GEMINI_VIDEO_OUTPUT_MIME_TYPE, source: 'provider',
    providerId: context.providerId, remoteJobId, variant: 'video',
    ...(resultId === undefined ? {} : { resultId }),
    metadata: { model },
  };
}

export function providerTarget(
  context: GeminiVideoRuntimeContext,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
  baseUrl: string,
  uri: string,
): ProviderResultTarget {
  const safe = safeProviderUri(uri);
  const targetOrigin = new URL(safe).origin;
  const baseOrigin = new URL(baseUrl).origin;
  return {
    url: safe,
    headers: targetOrigin === baseOrigin
      ? videoRequestHeaders(context, videoApiKey(context), configuredHeaders, GEMINI_VIDEO_OUTPUT_MIME_TYPE)
      : { accept: GEMINI_VIDEO_OUTPUT_MIME_TYPE },
    claimedMimeType: GEMINI_VIDEO_OUTPUT_MIME_TYPE,
  };
}

export function fileDownloadTarget(
  context: GeminiVideoRuntimeContext,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
  baseUrl: string,
  fileId: string,
): ProviderResultTarget {
  const id = assertFileId(fileId);
  const url = new URL(videoEndpoint(baseUrl, `/files/${id}:download`));
  url.searchParams.set('alt', 'media');
  return {
    url: url.toString(),
    headers: videoRequestHeaders(context, videoApiKey(context), configuredHeaders, GEMINI_VIDEO_OUTPUT_MIME_TYPE),
    claimedMimeType: GEMINI_VIDEO_OUTPUT_MIME_TYPE,
  };
}

export function modelCapabilities(
  operations: ModelCapabilities['operations'],
  options: {
    readonly durations?: ModelCapabilities['durations'];
    readonly resolutions?: readonly string[] | undefined;
    readonly maxReferenceImages?: number;
    readonly supportsSeed?: boolean;
    readonly supportsAudio?: boolean;
    readonly customFields?: ModelCapabilities['customFields'];
    readonly aspectRatios?: readonly string[] | undefined;
  },
): ModelCapabilities {
  return {
    operations,
    ...(options.aspectRatios === undefined ? {} : { aspectRatios: options.aspectRatios }),
    ...(options.resolutions === undefined ? {} : { resolutions: options.resolutions }),
    ...(options.durations === undefined ? {} : { durations: options.durations }),
    ...(options.maxReferenceImages === undefined ? {} : { maxReferenceImages: options.maxReferenceImages }),
    inputImageConstraints: {
      mimeTypes: GEMINI_VIDEO_INPUT_MIME_TYPES,
      maxBytes: GEMINI_VIDEO_MAX_INPUT_BYTES,
    },
    supportsMask: false,
    supportsNegativePrompt: false,
    ...(options.supportsSeed === undefined ? {} : { supportsSeed: options.supportsSeed }),
    supportsAudio: options.supportsAudio ?? false,
    supportsProgress: true,
    supportsCancel: false,
    supportsBatchCount: false,
    maxBatchCount: 1,
    ...(options.customFields === undefined ? {} : { customFields: options.customFields }),
  };
}

export function catalogModels(
  value: unknown,
  known: ReadonlyMap<string, GeminiVideoModelDefinition>,
  isEligible: (entry: Record<string, unknown>) => boolean,
  conservative: (id: string) => GeminiVideoModelDefinition,
): readonly ProviderModel[] {
  const root = asRecord(value);
  if (!Array.isArray(root?.models)) throw new GeminiResponseError('Gemini models response is invalid.', 'gemini_catalog_invalid');
  if (root.models.length > GEMINI_VIDEO_MAX_CATALOG_MODELS) throw new GeminiResponseError('Gemini models response exceeds the model limit.', 'gemini_catalog_too_large');
  const result: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const candidate of root.models) {
    const entry = asRecord(candidate);
    if (!entry || typeof entry.name !== 'string') continue;
    const id = canonicalModelId(entry.name);
    if (!id || id.length > GEMINI_VIDEO_MAX_MODEL_ID_LENGTH || seen.has(id) || !isEligible(entry)) continue;
    const model = known.get(id) ?? conservative(id);
    seen.add(id);
    const displayName = boundedString(entry.displayName, 255) ?? model.displayName;
    result.push({ id, displayName, capabilities: model.capabilities });
  }
  return result;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function normalizeGeminiVideoError(error: unknown): ProviderError {
  if (error instanceof GeminiHttpError) {
    const retryable = retryableStatus(error.statusCode);
    const code = error.statusCode === 401 || error.statusCode === 403
      ? 'gemini_authentication_error'
      : error.statusCode === 429
        ? 'gemini_rate_limited'
        : normalizeGeminiVideoHttpCode(error.providerCode)
          ? `gemini_${normalizeGeminiVideoHttpCode(error.providerCode)}`
          : `gemini_http_${error.statusCode}`;
    return {
      code, kind: retryable ? 'transient' : 'rejected', retryable,
      message: redactSensitiveText(error.message), statusCode: error.statusCode,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (error instanceof GeminiValidationError || error instanceof GeminiResponseError) {
    const candidateCode = error.code;
    const code = /^gemini_[a-z0-9_]{1,80}$/u.test(candidateCode) && !/(?:api[_-]?key|token|secret|credential|authorization)/iu.test(candidateCode)
      ? candidateCode
      : 'gemini_response_invalid';
    const pending = code === 'gemini_video_file_pending';
    const expired = code === 'gemini_video_result_expired' || code === 'gemini_expired';
    return { code, kind: pending ? 'transient' : expired ? 'expired' : 'rejected', message: redactSensitiveText(error.message), retryable: pending };
  }
  if (error instanceof GeminiTransportError) {
    const cause = error.cause;
    if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'CanceledError')) {
      return { code: 'gemini_request_aborted', kind: 'unknown', message: 'The Gemini request was aborted.', retryable: false };
    }
    return { code: 'gemini_transport_error', kind: 'transient', message: redactSensitiveText(error.message), retryable: true };
  }
  return {
    code: 'gemini_network_error', kind: 'transient', retryable: true,
    message: redactSensitiveText(error instanceof Error ? error.message : 'Gemini video request failed.'),
  };
}

export function expiredProviderError(message = 'The Gemini video result expired.'): ProviderError {
  return { code: 'gemini_video_result_expired', kind: 'expired', message, retryable: false };
}

export function operationError(value: unknown): ProviderError {
  const error = asRecord(value);
  const rawCode = boundedString(error?.status ?? error?.code, 128) ?? 'video_failed';
  const rawMessage = boundedString(error?.message, GEMINI_VIDEO_MAX_RESPONSE_STRING_LENGTH) ?? 'Gemini video generation failed.';
  const expired = /(?:expired|deadline[_ -]?exceeded)/iu.test(`${rawCode} ${rawMessage}`);
  return expired
    ? expiredProviderError('The Gemini video operation expired.')
    : {
      code: `gemini_${safeProviderErrorCode(rawCode)}`,
      kind: 'rejected', retryable: false,
      message: redactSensitiveText(rawMessage),
    };
}

const SAFE_VIDEO_ERROR_CODES = new Set([
  'aborted', 'budget_exceeded', 'cancelled', 'content_policy_violation', 'deadline_exceeded',
  'failed_precondition', 'incomplete', 'internal', 'invalid_argument', 'not_found',
  'permission_denied', 'requires_action', 'resource_exhausted', 'safety_block', 'unauthenticated',
  'unavailable', 'video_failed',
]);

export function safeProviderErrorCode(value: unknown, fallback = 'video_failed'): string {
  const normalized = normalizeProviderCode(value);
  if (normalized === undefined || normalized.length > 64 || !/^[a-z0-9_]+$/u.test(normalized)) return fallback;
  return SAFE_VIDEO_ERROR_CODES.has(normalized) ? normalized : fallback;
}

export function normalizeGeminiVideoHttpCode(value: unknown): string | undefined {
  const normalized = safeProviderErrorCode(value, '');
  return normalized === '' ? undefined : normalized;
}

export function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

export function resultUri(value: Record<string, unknown>): string | undefined {
  const mimeType = canonicalMimeType(value.mimeType ?? value.mime_type);
  if (mimeType && mimeType !== GEMINI_VIDEO_OUTPUT_MIME_TYPE) {
    throw new GeminiResponseError('Gemini returned an unsupported video MIME type.', 'gemini_video_mime_unsupported');
  }
  const nested = asRecord(value.fileData ?? value.file_data);
  const raw = value.uri ?? value.url ?? value.fileUri ?? value.file_uri ?? nested?.uri ?? nested?.url ?? nested?.fileUri ?? nested?.file_uri;
  return typeof raw === 'string' ? safeProviderUri(raw) : undefined;
}

export function resultInline(value: Record<string, unknown>): SubmittedAsset | undefined {
  const nested = asRecord(value.inlineData ?? value.inline_data);
  if (nested) return inlineVideoAsset(nested);
  const data = value.data ?? value.base64;
  if (typeof data === 'string') return inlineVideoAsset(value);
  return undefined;
}

export function assertProviderVideoAsset(asset: ProviderAssetReference, context: GeminiVideoRuntimeContext): void {
  if (asset.providerId !== context.providerId || asset.type !== 'video' || asset.variant !== 'video') {
    throw new GeminiValidationError('Gemini video result reference is invalid.', 'gemini_result_reference_invalid');
  }
  if (asset.remoteJobId.length > GEMINI_VIDEO_MAX_REMOTE_ID_LENGTH || /[\r\n]/u.test(asset.remoteJobId)) {
    throw new GeminiValidationError('Gemini video result reference is invalid.', 'gemini_result_reference_invalid');
  }
}
