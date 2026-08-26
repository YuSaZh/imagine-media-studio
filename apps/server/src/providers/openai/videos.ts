import type {
  GenerationRequest,
} from '@imagine/shared';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderAssetReference,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderInput,
  ProviderModel,
  ProviderResultTarget,
  PollResult,
  SubmitResult,
  SubmittedAsset,
} from '@imagine/provider-contract';

import { encodeMultipart } from './protocol.js';
import { ProviderHttpError } from '../provider-http-client.js';
import { UnsafeRemoteUrlError } from '../../security/network-policy.js';
import {
  OpenAiHttpError,
  OpenAiResponseError,
  OpenAiTransportError,
  OpenAiValidationError,
  redactOpenAiErrorText,
  type OpenAiHttpHeaders,
  type OpenAiHttpRequest,
  type OpenAiHttpRequestExecutor,
  type OpenAiHttpResponse,
  type OpenAiHttpTransport,
  type OpenAiMultipartPart,
  type OpenAiRuntimeContext,
  OPENAI_VIDEOS_PROFILE,
  type OpenAiVideoProfile,
} from './types.js';

const VIDEO_MODELS = [
  'sora-2',
  'sora-2-pro',
  'sora-2-2025-10-06',
  'sora-2-pro-2025-10-06',
  'sora-2-2025-12-08',
] as const;
const VIDEO_SECONDS = new Set(['4', '8', '12', '16', '20']);
const SORA2_SIZES = ['720x1280', '1280x720'] as const;
const SORA2_PRO_SIZES = [
  ...SORA2_SIZES,
  '1024x1792',
  '1792x1024',
  '1920x1080',
  '1080x1920',
] as const;
const VIDEO_INPUT_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROTECTED_HEADERS = new Set(['accept', 'authorization', 'content-type', 'idempotency-key']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'host',
  'proxy-auth',
  'proxy-authenticate',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_PROMPT_CHARS = 32_000;
const MAX_MODEL_ID_CHARS = 255;
const MAX_REMOTE_ID_CHARS = 255;
const MAX_ERROR_CHARS = 512;
const MAX_CATALOG_MODELS = 200;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_DEPTH = 12;
const MAX_RESPONSE_KEYS = 2_048;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;

type HttpClient = OpenAiHttpTransport | OpenAiHttpRequestExecutor;

export interface OpenAiVideoProviderOptions {
  readonly http?: HttpClient;
  readonly transport?: HttpClient;
  readonly profile?: OpenAiVideoProfile;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly string[];
}

interface VideoRecord {
  readonly id: string;
  readonly status: 'queued' | 'in_progress' | 'completed' | 'failed';
  readonly progress: number;
  readonly resultExpiresAt?: Date;
  readonly error?: ProviderError;
  readonly model?: string;
  readonly seconds?: string;
  readonly size?: string;
}

function runtimeContext(context: ProviderContext): OpenAiRuntimeContext {
  return context as OpenAiRuntimeContext;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function headerEntries(headers: OpenAiHttpHeaders | undefined): Array<[string, string]> {
  if (headers === undefined) return [];
  if ('get' in headers && typeof headers.get === 'function') return [];
  const result: Array<[string, string]> = [];
  for (const [name, raw] of Object.entries(headers)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string') result.push([name, value]);
  }
  return result;
}

function headerValue(headers: OpenAiHttpHeaders | undefined, name: string): string | undefined {
  if (headers !== undefined && 'get' in headers && typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const wanted = name.toLowerCase();
  return headerEntries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function assertHeaderValue(value: string, label: string): string {
  if (/\r|\n/.test(value)) {
    throw new OpenAiValidationError('invalid_header', `${label} contains an invalid newline.`);
  }
  return value;
}

function normalizedHeaders(...sources: Array<OpenAiHttpHeaders | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of headerEntries(source)) {
      if (!HEADER_NAME_PATTERN.test(name)) {
        throw new OpenAiValidationError('invalid_header', 'OpenAI header name is invalid.');
      }
      assertHeaderValue(value, name);
      const normalized = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(normalized) || PROTECTED_HEADERS.has(normalized)) continue;
      for (const existing of Object.keys(output)) {
        if (existing.toLowerCase() === normalized) delete output[existing];
      }
      output[name] = value;
    }
  }
  return output;
}

function baseUrlFor(options: OpenAiVideoProviderOptions, context: OpenAiRuntimeContext): string {
  const configured = options.baseUrl?.trim() || context.baseUrl?.trim();
  if (!configured) {
    throw new OpenAiValidationError(
      'missing_base_url',
      'The OpenAI Videos compatibility profile requires an explicit base URL.',
    );
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new OpenAiValidationError('invalid_base_url', 'OpenAI video base URL is invalid.');
  }
  if (
    url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new OpenAiValidationError(
      'invalid_base_url',
      'OpenAI video base URL must be an HTTP(S) URL without credentials.',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, '')}`;
}

function explicitModels(
  options: OpenAiVideoProviderOptions,
  context: OpenAiRuntimeContext,
): readonly string[] | undefined {
  const configured = options.models ?? (
    context.config !== undefined && Object.prototype.hasOwnProperty.call(context.config, 'models')
      ? context.config.models
      : undefined
  );
  if (configured === undefined) return undefined;
  if (!Array.isArray(configured)) return [];
  return [...new Set(
    configured
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= MAX_MODEL_ID_CHARS),
  )].slice(0, MAX_CATALOG_MODELS);
}

function configuredModels(options: OpenAiVideoProviderOptions, context: OpenAiRuntimeContext): readonly string[] {
  return explicitModels(options, context) ?? VIDEO_MODELS;
}

function modelId(value: unknown): string | undefined {
  const id = nonEmptyString(record(value)?.id ?? value)?.trim();
  return id !== undefined && id.length <= MAX_MODEL_ID_CHARS ? id : undefined;
}

function isKnownVideoModel(id: string): boolean {
  return (VIDEO_MODELS as readonly string[]).includes(id);
}

function isSora2ProModel(id: string): boolean {
  return id === 'sora-2-pro' || id.startsWith('sora-2-pro-');
}

function sizesForModel(model: string, conservative = false): readonly string[] {
  if (conservative) return [SORA2_SIZES[0]];
  return isSora2ProModel(model) ? SORA2_PRO_SIZES : SORA2_SIZES;
}

function secondsForModel(_model: string, conservative = false): readonly string[] {
  return conservative ? ['4'] : [...VIDEO_SECONDS];
}

function displayName(id: string): string {
  return `OpenAI Videos compatible (deprecated) (${id})`;
}

function videoCapabilities(model: string, conservative = false): ModelCapabilities {
  const capabilities: ModelCapabilities = {
    operations: conservative ? ['video.generate'] : ['video.generate', 'video.image_to_video'],
    resolutions: [...sizesForModel(model, conservative)],
    durations: secondsForModel(model, conservative).map(Number),
    maxReferenceImages: 0,
    supportsMask: false,
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsAudio: false,
    supportsProgress: true,
    supportsCancel: false,
    supportsBatchCount: false,
    maxBatchCount: 1,
    inputImageConstraints: {
      mimeTypes: [...VIDEO_INPUT_MIMES],
      maxBytes: MAX_INPUT_BYTES,
      maxPixels: 100_000_000,
      maxWidth: 16_384,
      maxHeight: 16_384,
    },
    customFields: {
      type: 'object',
      properties: {
        videoModel: { const: model },
        inputReference: { type: 'string', const: 'first_frame' },
      },
      additionalProperties: false,
    },
  };
  if (!conservative) return capabilities;
  return {
    ...capabilities,
    customFields: { type: 'object', additionalProperties: false },
  };
}

function assertRemoteId(value: unknown): string {
  const id = nonEmptyString(value)?.trim() ?? null;
  if (
    id === null || id.length > MAX_REMOTE_ID_CHARS ||
    !/^[A-Za-z0-9._:-]+$/u.test(id)
  ) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video id.');
  }
  return id;
}

function parseExpiry(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video expiry.');
  }
  const date = new Date(value * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video expiry.');
  }
  return date;
}

function parseProgress(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned invalid video progress.');
  }
  return Math.round(value);
}

function parseRemoteError(
  value: unknown,
  secrets: Readonly<Record<string, string>> = {},
): ProviderError | undefined {
  const source = record(value);
  if (!source) return undefined;
  const code = boundedString(source.code, 128) ?? 'openai_video_failed';
  const message = boundedString(source.message, MAX_ERROR_CHARS) ?? 'OpenAI video generation failed.';
  return {
    code: `openai_${code.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toLowerCase()}`,
    kind: 'rejected',
    message: redactOpenAiErrorText(message, secrets),
    retryable: false,
  };
}

function parseVideo(
  value: unknown,
  secrets: Readonly<Record<string, string>> = {},
  expectedModel?: string,
  expectedRemoteId?: string,
): VideoRecord {
  const source = record(value);
  if (source === null) throw new OpenAiResponseError('invalid_response', 'OpenAI video response must be an object.');
  const id = assertRemoteId(source.id);
  if (expectedRemoteId !== undefined && id !== expectedRemoteId) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a different video id than requested.');
  }
  const status = source.status;
  if (status !== 'queued' && status !== 'in_progress' && status !== 'completed' && status !== 'failed') {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an unknown video status.');
  }
  const model = source.model === undefined ? undefined : boundedString(source.model, MAX_MODEL_ID_CHARS);
  if (source.model !== undefined && model === undefined) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video model.');
  }
  if (expectedModel !== undefined && model !== undefined && model !== expectedModel) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a video model different from the request.');
  }
  const seconds = source.seconds === undefined ? undefined : boundedString(source.seconds, 8);
  if (source.seconds !== undefined && (seconds === undefined || !VIDEO_SECONDS.has(seconds))) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video duration.');
  }
  const size = source.size === undefined ? undefined : boundedString(source.size, 32);
  if (source.size !== undefined && size === undefined) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid video size.');
  }
  const resultExpiresAt = parseExpiry(source.expires_at);
  const responseModel = model ?? expectedModel ?? '';
  const validSizes = sizesForModel(responseModel, !isKnownVideoModel(responseModel));
  const validSeconds = secondsForModel(responseModel, !isKnownVideoModel(responseModel));
  if (seconds !== undefined && !validSeconds.includes(seconds)) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a duration unsupported by the video model.');
  }
  if (size !== undefined && !validSizes.includes(size)) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a size unsupported by the video model.');
  }
  return {
    id,
    status,
    progress: parseProgress(source.progress),
    ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }),
    ...(model === undefined ? {} : { model }),
    ...(seconds === undefined ? {} : { seconds }),
    ...(size === undefined ? {} : { size }),
    ...(status === 'failed'
      ? { error: parseRemoteError(source.error, secrets) ?? {
          code: 'openai_video_failed',
          kind: 'rejected' as const,
          message: 'OpenAI video generation failed.',
          retryable: false,
        } }
      : {}),
  };
}

function boundedResponseSize(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (value === undefined || value === null || typeof value === 'boolean') return 4;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new OpenAiResponseError('invalid_response', 'OpenAI response contains a non-finite number.');
    return 24;
  }
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 2;
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new OpenAiResponseError('invalid_response', 'OpenAI response contains an unsupported value.');
  }
  if (value instanceof Uint8Array) return value.byteLength;
  if (depth > MAX_RESPONSE_DEPTH) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI response nesting is too deep.');
  }
  if (seen.has(value)) throw new OpenAiResponseError('invalid_response', 'OpenAI response contains a cycle.');
  seen.add(value);
  try {
    const candidate = value as { readonly [Symbol.asyncIterator]?: unknown; readonly pipe?: unknown };
    if (typeof candidate[Symbol.asyncIterator] === 'function' || typeof candidate.pipe === 'function') {
      throw new OpenAiResponseError('invalid_response', 'OpenAI response streams are not accepted.');
    }
    const entries = Object.entries(value);
    if (entries.length > MAX_RESPONSE_KEYS) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI response contains too many fields.');
    }
    let total = 2;
    for (const [key, child] of entries) {
      total += Buffer.byteLength(key, 'utf8') + 3 + boundedResponseSize(child, seen, depth + 1);
      if (total > MAX_JSON_RESPONSE_BYTES) {
        throw new OpenAiResponseError('invalid_response', 'OpenAI response is too large.');
      }
    }
    return total;
  } finally {
    seen.delete(value);
  }
}

function assertBoundedResponse(value: unknown): unknown {
  try {
    if (boundedResponseSize(value) > MAX_JSON_RESPONSE_BYTES) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is too large.');
    }
    return value;
  } catch (error) {
    if (error instanceof OpenAiResponseError) throw error;
    throw new OpenAiResponseError('invalid_response', 'OpenAI response could not be safely bounded.');
  }
}

async function responsePayload(response: OpenAiHttpResponse, allowPlainText = false): Promise<unknown> {
  if (response.json !== undefined) {
    let value: unknown;
    try {
      value = typeof response.json === 'function' ? await response.json() : response.json;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new OpenAiResponseError('invalid_response', 'OpenAI response JSON could not be read.');
    }
    return assertBoundedResponse(value);
  }
  if (response.text !== undefined) {
    let text: unknown;
    try {
      text = typeof response.text === 'function' ? await response.text() : response.text;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new OpenAiResponseError('invalid_response', 'OpenAI response text could not be read.');
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is too large.');
    }
    if (text.trim() === '') return undefined;
    try {
      return assertBoundedResponse(JSON.parse(text) as unknown);
    } catch {
      if (allowPlainText) return text;
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is not valid JSON.');
    }
  }
  if (response.body instanceof Uint8Array) {
    if (response.body.byteLength > MAX_JSON_RESPONSE_BYTES) throw new OpenAiResponseError('invalid_response', 'OpenAI response is too large.');
    const text = new TextDecoder().decode(response.body);
    if (text.trim() === '') return undefined;
    try {
      return assertBoundedResponse(JSON.parse(text) as unknown);
    } catch {
      if (allowPlainText) return text;
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is not valid JSON.');
    }
  }
  if (typeof response.body === 'string') {
    if (Buffer.byteLength(response.body, 'utf8') > MAX_JSON_RESPONSE_BYTES) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is too large.');
    }
    if (response.body.trim() === '') return undefined;
    try {
      return assertBoundedResponse(JSON.parse(response.body) as unknown);
    } catch {
      if (allowPlainText) return response.body;
      throw new OpenAiResponseError('invalid_response', 'OpenAI response is not valid JSON.');
    }
  }
  if (response.body !== undefined && response.body !== null && typeof response.body === 'object') {
    return assertBoundedResponse(response.body);
  }
  return assertBoundedResponse(response.body);
}

function errorMessage(value: unknown): string {
  const source = record(value);
  const error = record(source?.error);
  return boundedString(error?.message, MAX_ERROR_CHARS) ??
    boundedString(source?.message, MAX_ERROR_CHARS) ??
    'OpenAI video request failed.';
}

function retryAfterMs(headers: OpenAiHttpHeaders | undefined): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 86_400_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), 86_400_000);
}

function providerErrorFromHttp(error: OpenAiHttpError): ProviderError {
  const status = error.statusCode;
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const retryAfter = retryAfterMs(error.responseHeaders);
  return {
    code: status === 429
      ? 'openai_rate_limited'
      : status === 401 || status === 403
        ? 'openai_authentication_error'
        : status >= 500
          ? 'openai_upstream_error'
          : `openai_http_${status}`,
    kind: status === 401 || status === 403 || (status >= 400 && status < 500 && !retryable)
      ? 'rejected'
      : retryable
        ? 'transient'
        : 'unknown',
    message: redactOpenAiErrorText(error.message),
    retryable,
    statusCode: status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
  };
}

function inputFromContext(
  request: GenerationRequest,
  context: OpenAiRuntimeContext,
): ProviderInput {
  const requested = request.inputs[0];
  if (!requested) throw new OpenAiValidationError('input_required', 'video.image_to_video requires a first frame.');
  const input = context.inputs?.find((candidate) => candidate.assetId === requested.assetId);
  if (!input) throw new OpenAiValidationError('input_asset_missing', 'The first-frame input is not loaded.');
  if (input.role !== 'first_frame' || requested.role !== 'first_frame') {
    throw new OpenAiValidationError('input_role_invalid', 'OpenAI Videos accepts one first_frame input only.');
  }
  const mimeType = input.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!VIDEO_INPUT_MIMES.has(mimeType) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_INPUT_BYTES) {
    throw new OpenAiValidationError('input_asset_invalid', 'The first-frame input must be a bounded JPEG, PNG, or WebP image.');
  }
  return { ...input, mimeType };
}

function requestOptions(request: GenerationRequest, model: string): { seconds: string; size: string } {
  if (request.count !== undefined && request.count !== 1) {
    throw new OpenAiValidationError('unsupported_option', 'OpenAI Videos creates exactly one video per call.');
  }
  if (request.negativePrompt !== undefined || request.fps !== undefined || request.quality !== undefined ||
    request.format !== undefined || request.seed !== undefined || request.audio !== undefined ||
    request.extra !== undefined && Object.keys(request.extra).length > 0) {
    throw new OpenAiValidationError('unsupported_option', 'This OpenAI Videos profile does not support the requested option.');
  }
  const duration = request.durationSeconds ?? 4;
  const allowedSeconds = secondsForModel(model, !isKnownVideoModel(model));
  if (!Number.isSafeInteger(duration) || !allowedSeconds.includes(String(duration))) {
    throw new OpenAiValidationError('invalid_option', 'OpenAI Videos duration is not supported by the selected model.');
  }
  const requestedSize = request.resolution ?? (
    request.width !== undefined || request.height !== undefined
      ? `${request.width ?? ''}x${request.height ?? ''}`
      : request.aspectRatio === '16:9'
        ? '1280x720'
        : request.aspectRatio === '9:16'
          ? '720x1280'
          : request.aspectRatio === undefined
            ? '720x1280'
            : ''
  );
  const allowedSizes = sizesForModel(model, !isKnownVideoModel(model));
  if (!allowedSizes.includes(requestedSize)) {
    throw new OpenAiValidationError('invalid_option', 'OpenAI Videos size is not supported.');
  }
  return { seconds: String(duration), size: requestedSize };
}

function videoAsset(context: OpenAiRuntimeContext, video: VideoRecord): Extract<SubmittedAsset, { source: 'provider' }> {
  return {
    type: 'video',
    mimeType: 'video/mp4',
    source: 'provider',
    providerId: context.providerId,
    remoteJobId: video.id,
    variant: 'video',
    resultId: video.id,
    metadata: {
      ...(video.model === undefined ? {} : { model: video.model }),
      ...(video.seconds === undefined ? {} : { seconds: video.seconds }),
      ...(video.size === undefined ? {} : { size: video.size }),
    },
  };
}

function catalogModels(
  value: unknown,
  configured: readonly string[],
  hasExplicitModels: boolean,
): readonly ProviderModel[] {
  const source = record(value);
  if (!Array.isArray(source?.data)) throw new OpenAiResponseError('invalid_response', 'OpenAI models response is invalid.');
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const candidate of source.data.slice(0, MAX_CATALOG_MODELS)) {
    const id = modelId(candidate);
    if (!id || seen.has(id) || (hasExplicitModels ? !configured.includes(id) : !isKnownVideoModel(id))) continue;
    seen.add(id);
    models.push({
      id,
      displayName: displayName(id),
      capabilities: videoCapabilities(id, !isKnownVideoModel(id)),
    });
  }
  return models;
}

/**
 * Compatibility profile for the OpenAI Videos/Sora request shape. The
 * upstream API is asynchronous and its DELETE endpoint is destructive
 * cleanup, not cancellation, so this adapter intentionally has no cancel().
 * OpenAI documents the Videos/Sora shutdown for 2026-09-24; the explicit
 * compatibility name must remain distinct from a long-lived default provider.
 */
export class OpenAiVideosProvider implements ProviderAdapter {
  public readonly type = OPENAI_VIDEOS_PROFILE;
  private readonly http: HttpClient | undefined;
  private readonly options: OpenAiVideoProviderOptions;

  public constructor(options: OpenAiVideoProviderOptions = {}) {
    this.options = options;
    this.http = options.http ?? options.transport;
  }

  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = runtimeContext(context);
    const models = configuredModels(this.options, runtime).map((id) => ({
      id,
      displayName: displayName(id),
      capabilities: videoCapabilities(id, !isKnownVideoModel(id)),
    }));
    return { providerType: this.type, models };
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = runtimeContext(context);
    const baseUrl = baseUrlFor(this.options, runtime);
    const http = this.http ?? runtime.http ?? runtime.transport;
    if (http === undefined) return this.getCapabilities(runtime);
    const explicit = explicitModels(this.options, runtime);
    return { providerType: this.type, models: catalogModels(await this.requestJson(runtime, http, {
      method: 'GET',
      url: endpoint(baseUrl, '/models'),
      headers: { ...this.requestHeaders(runtime), Accept: 'application/json' },
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    }), explicit ?? VIDEO_MODELS, explicit !== undefined) };
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const runtime = runtimeContext(context);
    const baseUrl = baseUrlFor(this.options, runtime);
    const http = this.http ?? runtime.http ?? runtime.transport;
    if (http === undefined) throw new OpenAiTransportError('OpenAI Videos requires an injected HTTP transport.');
    await this.requestJson(runtime, http, {
      method: 'GET',
      url: endpoint(baseUrl, '/models'),
      headers: { ...this.requestHeaders(runtime), Accept: 'application/json' },
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const runtime = runtimeContext(context);
    const explicit = explicitModels(this.options, runtime);
    const configured = explicit ?? VIDEO_MODELS;
    if (request.providerId !== runtime.providerId) {
      throw new OpenAiValidationError('provider_mismatch', 'Generation request providerId does not match ProviderContext.');
    }
    if (request.modelId.length === 0 || request.modelId.length > MAX_MODEL_ID_CHARS ||
      (!configured.includes(request.modelId) && (explicit !== undefined || !isKnownVideoModel(request.modelId)))) {
      throw new OpenAiValidationError('model_not_supported', 'The OpenAI Videos model is not enabled for this profile.');
    }
    if (request.prompt.trim().length === 0 || request.prompt.length > MAX_PROMPT_CHARS) {
      throw new OpenAiValidationError('invalid_prompt', `Prompt must contain 1 through ${MAX_PROMPT_CHARS} characters.`);
    }
    if (request.operation !== 'video.generate' && request.operation !== 'video.image_to_video') {
      throw new OpenAiValidationError('operation_not_supported', 'This OpenAI Videos profile supports video.generate and video.image_to_video only.');
    }
    if (!isKnownVideoModel(request.modelId) && request.operation !== 'video.generate') {
      throw new OpenAiValidationError(
        'operation_not_supported',
        'Explicit compatible video models conservatively support video.generate only.',
      );
    }
    if (request.operation === 'video.generate' && request.inputs.length > 0) {
      throw new OpenAiValidationError('input_role_not_allowed', 'video.generate does not accept input assets.');
    }
    if (request.operation === 'video.image_to_video') {
      if (request.inputs.length !== 1 || request.inputs[0]?.role !== 'first_frame') {
        throw new OpenAiValidationError('input_role_invalid', 'video.image_to_video requires one first_frame input.');
      }
      const input = inputFromContext(request, runtime);
      const options = requestOptions(request, request.modelId);
      const [width, height] = options.size.split('x').map(Number);
      if (input.width !== width || input.height !== height) {
        throw new OpenAiValidationError(
          'input_dimensions_mismatch',
          'The first-frame image dimensions must match the requested video size.',
        );
      }
    }
    requestOptions(request, request.modelId);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtime = runtimeContext(context);
    await this.validate(request, runtime);
    const baseUrl = baseUrlFor(this.options, runtime);
    const http = this.http ?? runtime.http ?? runtime.transport;
    if (http === undefined) throw new OpenAiTransportError('OpenAI Videos requires an injected HTTP transport.');
    const options = requestOptions(request, request.modelId);
    const headers = this.requestHeaders(runtime);
    let input: ProviderInput | undefined;
    let requestBody: OpenAiHttpRequest;
    if (request.operation === 'video.image_to_video') {
      input = inputFromContext(request, runtime);
      const parts: OpenAiMultipartPart[] = [
        { name: 'model', bytes: new TextEncoder().encode(request.modelId) },
        { name: 'prompt', bytes: new TextEncoder().encode(request.prompt) },
        { name: 'seconds', bytes: new TextEncoder().encode(options.seconds) },
        { name: 'size', bytes: new TextEncoder().encode(options.size) },
        {
          name: 'input_reference',
          filename: input.filename ?? `${input.assetId}.bin`,
          contentType: input.mimeType,
          bytes: input.bytes,
        },
      ];
      const boundary = '----imagine-openai-videos-v1';
      const bodyBytes = encodeMultipart(parts, boundary);
      requestBody = {
        method: 'POST',
        url: endpoint(baseUrl, '/videos'),
        headers: { ...headers, Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        bodyBytes,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      };
    } else {
      requestBody = {
        method: 'POST',
        url: endpoint(baseUrl, '/videos'),
        headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: request.modelId, prompt: request.prompt, seconds: options.seconds, size: options.size }),
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      };
    }
    const payload = await this.requestJson(runtime, http, requestBody);
    const video = parseVideo(payload, runtime.secrets, request.modelId);
    if (video.status === 'failed') {
      throw new OpenAiResponseError(
        video.error?.code ?? 'video_failed',
        video.error?.message ?? 'OpenAI video generation failed.',
      );
    }
    if (video.status === 'completed') {
      return {
        state: 'completed',
        assets: [videoAsset(runtime, video)],
        ...(video.resultExpiresAt === undefined ? {} : { resultExpiresAt: video.resultExpiresAt }),
      };
    }
    return {
      state: 'pending',
      remoteJobId: video.id,
      pollAfterMs: video.status === 'in_progress' ? 5_000 : 2_000,
      ...(video.resultExpiresAt === undefined ? {} : { resultExpiresAt: video.resultExpiresAt }),
    };
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    const runtime = runtimeContext(context);
    const id = assertRemoteId(remoteJobId);
    const baseUrl = baseUrlFor(this.options, runtime);
    const http = this.http ?? runtime.http ?? runtime.transport;
    if (http === undefined) throw new OpenAiTransportError('OpenAI Videos requires an injected HTTP transport.');
    const payload = await this.requestJson(runtime, http, {
      method: 'GET',
      url: endpoint(baseUrl, `/videos/${encodeURIComponent(id)}`),
      headers: { ...this.requestHeaders(runtime), Accept: 'application/json' },
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    });
    const video = parseVideo(payload, runtime.secrets, runtime.modelId, id);
    if (video.status === 'failed') return { state: 'failed', error: video.error! };
    if (video.status === 'completed') {
      return {
        state: 'completed',
        assets: [videoAsset(runtime, video)],
        ...(video.resultExpiresAt === undefined ? {} : { resultExpiresAt: video.resultExpiresAt }),
      };
    }
    return {
      state: video.status === 'in_progress' ? 'remote_running' : 'remote_pending',
      progress: video.progress,
      pollAfterMs: video.status === 'in_progress' ? 5_000 : 2_000,
      ...(video.resultExpiresAt === undefined ? {} : { resultExpiresAt: video.resultExpiresAt }),
    };
  }

  /** Only resolves a target; the actual authenticated download stays in the media layer. */
  public async resolveResult(
    asset: ProviderAssetReference,
    context: ProviderContext,
  ): Promise<ProviderResultTarget> {
    const runtime = runtimeContext(context);
    if (asset.providerId !== runtime.providerId || asset.variant !== 'video') {
      throw new OpenAiValidationError('result_reference_invalid', 'OpenAI video result reference is invalid.');
    }
    const id = assertRemoteId(asset.remoteJobId);
    return {
      url: endpoint(baseUrlFor(this.options, runtime), `/videos/${encodeURIComponent(id)}/content?variant=video`),
      headers: { ...this.requestHeaders(runtime), Accept: 'video/mp4' },
      claimedMimeType: 'video/mp4',
    };
  }

  public normalizeError(error: unknown): ProviderError {
    if (error instanceof OpenAiHttpError) return providerErrorFromHttp(error);
    if (error instanceof UnsafeRemoteUrlError) {
      return {
        code: 'provider_network_policy_denied',
        kind: 'rejected',
        message: 'OpenAI provider network policy denied the request.',
        retryable: false,
      };
    }
    if (error instanceof ProviderHttpError) {
      if (error.code === 'aborted') {
        return {
          code: 'request_aborted',
          kind: 'unknown',
          message: 'OpenAI video request was aborted.',
          retryable: false,
        };
      }
      const deterministic = new Set([
        'invalid_request',
        'request_body_too_large',
        'response_body_too_large',
        'response_invalid',
        'redirect_not_allowed',
      ]);
      if (deterministic.has(error.code)) {
        return {
          code: `provider_http_${error.code}`,
          kind: 'rejected',
          message: 'OpenAI provider HTTP request was rejected by safety validation.',
          retryable: false,
        };
      }
      return {
        code: `provider_http_${error.code}`,
        kind: 'transient',
        message: 'OpenAI provider HTTP request failed.',
        retryable: true,
      };
    }
    if (error instanceof OpenAiResponseError || error instanceof OpenAiValidationError) {
      return {
        code: error.code,
        kind: 'rejected',
        message: redactOpenAiErrorText(error.message),
        retryable: false,
      };
    }
    if (error instanceof OpenAiTransportError || (error instanceof Error && error.name === 'AbortError')) {
      return {
        code: error instanceof Error && error.name === 'AbortError' ? 'request_aborted' : 'openai_network_error',
        kind: error instanceof Error && error.name === 'AbortError' ? 'unknown' : 'transient',
        message: error instanceof Error && error.name === 'AbortError'
          ? 'OpenAI video request was aborted.'
          : 'OpenAI video request failed.',
        retryable: !(error instanceof Error && error.name === 'AbortError'),
      };
    }
    return {
      code: 'openai_network_error',
      kind: 'transient',
      message: 'OpenAI video request failed.',
      retryable: true,
    };
  }

  private requestHeaders(context: OpenAiRuntimeContext): Record<string, string> {
    const secretHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(context.secrets)) {
      if (key.startsWith('header:')) secretHeaders[key.slice('header:'.length)] = value;
    }
    const headers = normalizedHeaders(this.options.headers, context.headers, secretHeaders);
    const apiKey = context.secrets.apiKey ?? context.secrets.api_key;
    if (apiKey !== undefined) {
      assertHeaderValue(apiKey, 'API key');
      if (apiKey.trim() === '') throw new OpenAiValidationError('missing_api_key', 'OpenAI API key is not configured.');
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    if (headers.Authorization === undefined || headers.Authorization.trim() === '') {
      throw new OpenAiValidationError('missing_api_key', 'OpenAI API key is not configured.');
    }
    return headers;
  }

  private async requestJson(
    context: OpenAiRuntimeContext,
    http: HttpClient,
    request: OpenAiHttpRequest,
  ): Promise<unknown> {
    let response: OpenAiHttpResponse;
    try {
      response = typeof http === 'function' ? await http(request) : await http.request(request);
    } catch (error) {
      if (
        error instanceof OpenAiValidationError ||
        error instanceof OpenAiTransportError ||
        error instanceof OpenAiHttpError ||
        error instanceof ProviderHttpError ||
        error instanceof UnsafeRemoteUrlError
      ) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new OpenAiTransportError('OpenAI video request failed.', { cause: error });
    }
    try {
      const status = response.statusCode ?? response.status;
      if (status === undefined || !Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new OpenAiTransportError('OpenAI HTTP transport returned no status code.');
      }
      if (status < 200 || status >= 300) {
        let payload: unknown;
        try {
          payload = await responsePayload(response, true);
        } catch {
          payload = undefined;
        }
        throw new OpenAiHttpError(status, redactOpenAiErrorText(errorMessage(payload), context.secrets), payload, response.headers, context.secrets);
      }
      const payload = await responsePayload(response);
      return payload;
    } finally {
      try {
        await response.dispose?.();
      } catch {
        // Disposal must not hide the bounded response or HTTP error.
      }
    }
  }
}

export function createOpenAiVideosProvider(options: Omit<OpenAiVideoProviderOptions, 'profile'> = {}): OpenAiVideosProvider {
  return new OpenAiVideosProvider(options);
}
