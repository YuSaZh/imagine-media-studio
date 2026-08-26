import type { GenerationRequest } from '@imagine/shared';
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

import { ProviderHttpError } from '../provider-http-client.js';
import { UnsafeRemoteUrlError } from '../../security/network-policy.js';
import type {
  XaiImagineHttpClient,
  XaiImagineHttpHeaders,
  XaiImagineHttpRequest,
  XaiImagineHttpRequestExecutor,
  XaiImagineHttpResponse,
} from './xai-imagine-image.js';

export const XAI_IMAGINE_VIDEO_PROFILE = 'xai-imagine-video-v1' as const;
export const XAI_IMAGINE_VIDEO_MODEL = 'grok-imagine-video-1.5' as const;
export const XAI_IMAGINE_VIDEO_BASE_MODEL = 'grok-imagine-video' as const;
export const XAI_IMAGINE_VIDEO_DEFAULT_BASE_URL = 'https://api.x.ai/v1' as const;

const VIDEO_MODEL_IDS: ReadonlySet<string> = new Set([XAI_IMAGINE_VIDEO_BASE_MODEL, XAI_IMAGINE_VIDEO_MODEL]);
const DEFAULT_VIDEO_MODEL_IDS = [XAI_IMAGINE_VIDEO_BASE_MODEL, XAI_IMAGINE_VIDEO_MODEL] as const;
const KNOWN_NON_VIDEO_MODEL_IDS = new Set(['grok-imagine-image', 'grok-imagine-image-2.0', 'grok-imagine-image-quality']);
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
const VIDEO_INPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
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
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MAX_PROMPT_CHARS = 32_000;
const MAX_MODEL_ID_CHARS = 255;
const MAX_REMOTE_ID_CHARS = 255;
const MAX_ERROR_CHARS = 512;
const MAX_RESULT_URL_CHARS = 4_096;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_DEPTH = 12;
const MAX_RESPONSE_KEYS = 2_048;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 7;
const CREDENTIAL_QUERY_NAMES = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'key',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
]);

type JsonRecord = Record<string, unknown>;
type VideoHttpClient = XaiImagineHttpClient | XaiImagineHttpRequestExecutor;

function isSafeModelId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MODEL_ID_CHARS && SAFE_MODEL_ID_PATTERN.test(value);
}

export interface XaiImagineVideoInput extends ProviderInput {
  readonly dataUri?: string;
}

export interface XaiImagineVideoProviderContext extends ProviderContext {
  readonly baseUrl?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly http?: VideoHttpClient;
  readonly inputs?: readonly XaiImagineVideoInput[];
  readonly transport?: VideoHttpClient;
}

export interface XaiImagineVideoProviderOptions {
  readonly http?: VideoHttpClient;
  readonly transport?: VideoHttpClient;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly string[];
}

export type XaiImagineVideoHttpClient = XaiImagineHttpClient;
export type XaiImagineVideoHttpRequest = XaiImagineHttpRequest;
export type XaiImagineVideoHttpRequestExecutor = XaiImagineHttpRequestExecutor;
export type XaiImagineVideoHttpResponse = XaiImagineHttpResponse;
export type XaiImagineVideoHttpHeaders = XaiImagineHttpHeaders;
export type XaiVideoProviderContext = XaiImagineVideoProviderContext;
export type XaiVideoProviderOptions = XaiImagineVideoProviderOptions;

export class XaiImagineVideoValidationError extends Error {
  public override readonly name = 'XaiImagineVideoValidationError';
  public readonly providerError: ProviderError;

  public constructor(public readonly code: string, message: string) {
    super(message);
    this.providerError = { code, kind: 'rejected', message, retryable: false };
  }
}

export class XaiImagineVideoHttpError extends Error {
  public override readonly name = 'XaiImagineVideoHttpError';
  public readonly responseBody: string | undefined;
  public readonly responseHeaders: XaiImagineHttpResponse['headers'] | undefined;

  public constructor(
    public readonly statusCode: number,
    body?: unknown,
    responseHeaders?: XaiImagineHttpResponse['headers'],
    secrets: Readonly<Record<string, string>> = {},
  ) {
    super(`xAI Imagine video returned HTTP ${statusCode}.`);
    const retryAfter = headerValue(responseHeaders, 'retry-after');
    this.responseHeaders = retryAfter === undefined
      ? undefined
      : { 'retry-after': sanitizeMessage(retryAfter, secrets) };
    const message = errorMessageFromBody(body, secrets);
    this.responseBody = message === '' ? undefined : message;
  }
}

export class XaiImagineVideoTransportError extends Error {
  public override readonly name = 'XaiImagineVideoTransportError';
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class XaiImagineVideoResponseError extends Error {
  public override readonly name: string = 'XaiImagineVideoResponseError';
}

export class XaiImagineVideoExpiredError extends XaiImagineVideoResponseError {
  public override readonly name: string = 'XaiImagineVideoExpiredError';
}

interface ParsedVideoStatus {
  readonly status: 'pending' | 'running' | 'done' | 'failed' | 'expired';
  readonly progress: number;
  readonly resultExpiresAt?: Date;
  readonly model?: string;
  readonly duration?: number;
  readonly resultUrl?: string;
  readonly moderation?: boolean;
  readonly error?: ProviderError;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function safeHeaderValue(value: string, label: string): string {
  if (typeof value !== 'string' || value.length > 8_192 || /[\r\n]/u.test(value)) {
    throw new XaiImagineVideoValidationError('xai_invalid_header', `${label} is invalid.`);
  }
  return value;
}

function safeHeaderName(name: string): string {
  const normalized = name.toLowerCase();
  if (!HEADER_NAME_PATTERN.test(name) || PROTECTED_HEADERS.has(normalized) || HOP_BY_HOP_HEADERS.has(normalized)) {
    throw new XaiImagineVideoValidationError('xai_invalid_header', `Header ${name || '(empty)'} is invalid.`);
  }
  return name;
}

function normalizedMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength > 0 && bytes.toString('base64') === value;
}

function imageDataUri(input: XaiImagineVideoInput): string {
  if (Object.prototype.hasOwnProperty.call(input, 'url')) {
    throw new XaiImagineVideoValidationError(
      'xai_input_url_unsupported',
      `Image input ${input.assetId} must be supplied as loader bytes or a data URI, not a URL.`,
    );
  }
  const mimeType = normalizedMimeType(input.mimeType);
  if (!VIDEO_INPUT_MIME_TYPES.has(mimeType)) {
    throw new XaiImagineVideoValidationError(
      'xai_unsupported_input_type',
      `xAI video inputs do not accept ${input.mimeType || '(empty)'} image inputs.`,
    );
  }
  if (input.bytes instanceof Uint8Array) {
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_INPUT_BYTES) {
      throw new XaiImagineVideoValidationError('xai_input_size_invalid', 'xAI video input bytes are outside the allowed size range.');
    }
    return `data:${mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`;
  }
  if (typeof input.dataUri === 'string') {
    if (input.dataUri.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 128) {
      throw new XaiImagineVideoValidationError('xai_input_size_invalid', 'xAI video input data URI is too large.');
    }
    const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(input.dataUri);
    const dataMime = match?.[1] === undefined ? undefined : normalizedMimeType(match[1]);
    const data = match?.[2]?.replace(/\s/gu, '');
    if (dataMime !== mimeType || data === undefined || !validBase64(data)) {
      throw new XaiImagineVideoValidationError('xai_invalid_image_data', `Image input ${input.assetId} is not a valid image data URI.`);
    }
    const bytes = Buffer.byteLength(data, 'base64');
    if (bytes === 0 || bytes > MAX_INPUT_BYTES) {
      throw new XaiImagineVideoValidationError('xai_input_size_invalid', 'xAI video input data URI is outside the allowed size range.');
    }
    return `data:${mimeType};base64,${data}`;
  }
  throw new XaiImagineVideoValidationError(
    'xai_input_missing',
    `Image input ${input.assetId} was not resolved to bytes by the server.`,
  );
}

function inputByteLength(input: XaiImagineVideoInput): number {
  if (input.bytes instanceof Uint8Array) return input.bytes.byteLength;
  if (typeof input.dataUri === 'string') {
    const match = /^data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/u.exec(input.dataUri);
    const data = match?.[1]?.replace(/\s/gu, '');
    return data !== undefined && validBase64(data) ? Buffer.byteLength(data, 'base64') : MAX_INPUT_BYTES + 1;
  }
  return MAX_INPUT_BYTES + 1;
}

function assertTotalInputBytes(inputs: readonly XaiImagineVideoInput[]): void {
  let total = 0;
  for (const input of inputs) {
    total += inputByteLength(input);
    if (total > MAX_TOTAL_INPUT_BYTES) {
      throw new XaiImagineVideoValidationError('xai_input_size_invalid', 'The combined xAI video input bytes exceed the request limit.');
    }
  }
}

function requestInputs(
  request: GenerationRequest,
  context: XaiImagineVideoProviderContext,
): readonly XaiImagineVideoInput[] {
  const resolved = context.inputs ?? [];
  const requestedIds = new Set<string>();
  for (const input of request.inputs) {
    if (!input.assetId.trim() || requestedIds.has(input.assetId)) {
      throw new XaiImagineVideoValidationError('xai_input_duplicate', 'xAI video input asset ids must be unique.');
    }
    requestedIds.add(input.assetId);
  }
  const resolvedIds = new Set<string>();
  for (const input of resolved) {
    if (!input.assetId.trim() || resolvedIds.has(input.assetId)) {
      throw new XaiImagineVideoValidationError('xai_input_duplicate', 'xAI video input asset ids must be unique.');
    }
    resolvedIds.add(input.assetId);
    if (!requestedIds.has(input.assetId)) {
      throw new XaiImagineVideoValidationError('xai_input_unexpected', `Image input ${input.assetId} is not part of the request.`);
    }
  }
  return request.inputs.map((requested) => {
    const input = resolved.find((candidate) => candidate.assetId === requested.assetId);
    if (input === undefined) {
      throw new XaiImagineVideoValidationError('xai_input_missing', `Image input ${requested.assetId} was not resolved by the server.`);
    }
    if (input.role !== requested.role) {
      throw new XaiImagineVideoValidationError('xai_input_role_mismatch', `Image input ${requested.assetId} has a mismatched role.`);
    }
    return input;
  });
}

function configuredModelIds(
  context: XaiImagineVideoProviderContext,
  configured?: readonly string[],
): readonly string[] {
  const source = configured ?? (Array.isArray(context.config?.models) ? context.config.models : undefined);
  if (source === undefined) return DEFAULT_VIDEO_MODEL_IDS;
  return [...new Set(source
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => isSafeModelId(value) && !KNOWN_NON_VIDEO_MODEL_IDS.has(value)))];
}

function validateRequest(
  request: GenerationRequest,
  context: XaiImagineVideoProviderContext,
  configuredModels?: readonly string[],
): void {
  if (request.providerId !== context.providerId) {
    throw new XaiImagineVideoValidationError('xai_provider_mismatch', 'The request provider does not match the active xAI video provider.');
  }
  const explicitModels = configuredModels !== undefined || Array.isArray(context.config?.models);
  const allowedModels = configuredModelIds(context, configuredModels);
  if (explicitModels
    ? !allowedModels.includes(request.modelId)
    : !isSafeModelId(request.modelId) || KNOWN_NON_VIDEO_MODEL_IDS.has(request.modelId)) {
    throw new XaiImagineVideoValidationError('xai_model_unsupported', `xAI video model ${request.modelId} is not supported by this profile.`);
  }
  const capabilities = videoCapabilitiesFor(request.modelId);
  if (request.prompt.trim().length === 0 || request.prompt.length > MAX_PROMPT_CHARS) {
    throw new XaiImagineVideoValidationError('xai_prompt_invalid', 'xAI video prompts must contain 1 through 32000 characters.');
  }
  if (!capabilities.operations.includes(request.operation)) {
    throw new XaiImagineVideoValidationError('xai_operation_unsupported', 'This profile only supports xAI video generation, image-to-video, and reference-to-video.');
  }
  if (request.count !== undefined && request.count !== 1) {
    throw new XaiImagineVideoValidationError('xai_count_unsupported', 'xAI video generation creates exactly one video per request.');
  }
  if (request.durationSeconds !== undefined &&
    (!Number.isSafeInteger(request.durationSeconds) || request.durationSeconds < 1 || request.durationSeconds > 15)) {
    throw new XaiImagineVideoValidationError('xai_duration_unsupported', 'xAI video duration must be an integer from 1 through 15 seconds.');
  }
  if (request.aspectRatio !== undefined && !(VIDEO_ASPECT_RATIOS as readonly string[]).includes(request.aspectRatio)) {
    throw new XaiImagineVideoValidationError('xai_aspect_ratio_unsupported', 'xAI video aspect ratio is not supported.');
  }
  if (request.resolution !== undefined && !capabilities.resolutions?.includes(request.resolution)) {
    throw new XaiImagineVideoValidationError('xai_resolution_unsupported', 'xAI video resolution must be 480p, 720p, or 1080p.');
  }
  if (request.operation === 'video.reference_to_video' && request.resolution !== undefined && request.resolution !== '480p' && request.resolution !== '720p') {
    throw new XaiImagineVideoValidationError('xai_resolution_unsupported', 'xAI reference-to-video is limited to 720p.');
  }
  if (request.audio !== undefined && typeof request.audio !== 'boolean') {
    throw new XaiImagineVideoValidationError('xai_audio_unsupported', 'xAI video audio must be a boolean.');
  }
  const unsupported: Array<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt],
    ['width', request.width],
    ['height', request.height],
    ['fps', request.fps],
    ['quality', request.quality],
    ['format', request.format],
    ['seed', request.seed],
    ['extra', request.extra && Object.keys(request.extra).length > 0 ? request.extra : undefined],
  ];
  const unsupportedOption = unsupported.find(([, value]) => value !== undefined);
  if (unsupportedOption !== undefined) {
    throw new XaiImagineVideoValidationError('xai_option_unsupported', `xAI video does not support ${unsupportedOption[0]}.`);
  }

  const inputCount = request.inputs.length;
  if (request.operation === 'video.generate' && inputCount !== 0) {
    throw new XaiImagineVideoValidationError('xai_generation_inputs_unsupported', 'video.generate does not accept input images.');
  }
  if (request.operation === 'video.image_to_video' &&
    (inputCount !== 1 || request.inputs[0]?.role !== 'first_frame')) {
    throw new XaiImagineVideoValidationError('xai_first_frame_invalid', 'image-to-video requires exactly one first_frame input.');
  }
  if (request.operation === 'video.reference_to_video' &&
    (inputCount < 1 || inputCount > MAX_REFERENCE_IMAGES || request.inputs.some((input) => input.role !== 'reference'))) {
    throw new XaiImagineVideoValidationError('xai_reference_limit', 'reference-to-video requires 1 through 7 reference images.');
  }
  const ids = new Set<string>();
  for (const input of request.inputs) {
    if (input.assetId.trim() === '' || ids.has(input.assetId)) {
      throw new XaiImagineVideoValidationError('xai_input_duplicate', 'xAI video input asset ids must be unique and non-empty.');
    }
    ids.add(input.assetId);
  }
  if (request.operation !== 'video.generate') {
    const inputs = requestInputs(request, context);
    assertTotalInputBytes(inputs);
    for (const input of inputs) imageDataUri(input);
  }
}

function contextBaseUrl(context: XaiImagineVideoProviderContext, configured: string | undefined): string {
  return context.baseUrl?.trim() ||
    (typeof context.config?.baseUrl === 'string' ? context.config.baseUrl.trim() : '') ||
    configured?.trim() ||
    XAI_IMAGINE_VIDEO_DEFAULT_BASE_URL;
}

function endpointFor(baseUrl: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new XaiImagineVideoValidationError('xai_base_url_invalid', 'The xAI video base URL is invalid.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new XaiImagineVideoValidationError('xai_base_url_invalid', 'The xAI video base URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const prefix = parsed.pathname.replace(/\/+$/u, '') || '/v1';
  parsed.pathname = `${prefix}/${path.replace(/^\/+/, '')}`;
  return parsed.toString();
}

function customHeaders(
  context: XaiImagineVideoProviderContext,
  configured: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  const setHeader = (name: string, value: string): void => {
    safeHeaderName(name);
    safeHeaderValue(value, name);
    const normalized = name.toLowerCase();
    for (const existing of Object.keys(output)) {
      if (existing.toLowerCase() === normalized) delete output[existing];
    }
    output[name] = value;
  };
  for (const [name, value] of Object.entries(configured ?? {})) setHeader(name, value);
  for (const [name, value] of Object.entries(context.headers ?? {})) setHeader(name, value);
  const configHeaders = context.config?.headers;
  if (isRecord(configHeaders)) {
    for (const [name, value] of Object.entries(configHeaders)) {
      if (typeof value === 'string') setHeader(name, value);
    }
  }
  for (const [key, value] of Object.entries(context.secrets)) {
    if (key.startsWith('header:') && key.length > 'header:'.length) {
      setHeader(key.slice('header:'.length), value);
    }
  }
  return output;
}

function apiKey(context: ProviderContext): string {
  const value = context.secrets.apiKey;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new XaiImagineVideoValidationError('xai_api_key_missing', 'The xAI API key is not configured.');
  }
  return safeHeaderValue(value.trim(), 'API key');
}

function requestHeaders(
  context: XaiImagineVideoProviderContext,
  configured: Readonly<Record<string, string>> | undefined,
  includeContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
    ...customHeaders(context, configured),
    Authorization: `Bearer ${apiKey(context)}`,
  };
  if (includeContentType && context.idempotencyKey !== undefined) {
    if (context.idempotencyKey.trim() === '') {
      throw new XaiImagineVideoValidationError('xai_invalid_header', 'Idempotency key is invalid.');
    }
    headers['Idempotency-Key'] = safeHeaderValue(context.idempotencyKey, 'Idempotency key');
  }
  return headers;
}

function isReadableLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return typeof candidate.pipe === 'function' ||
    typeof candidate.getReader === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function';
}

function boundedResponseSize(value: unknown, seen = new Set<object>(), depth = 0): number {
  if (value === null || value === undefined || typeof value === 'boolean') return 4;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new XaiImagineVideoResponseError('xAI video response contains a non-finite number.');
    return 24;
  }
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') + 2;
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    throw new XaiImagineVideoResponseError('xAI video response contains an unsupported value.');
  }
  if (value instanceof Uint8Array) return value.byteLength;
  if (depth > MAX_RESPONSE_DEPTH || seen.has(value)) {
    throw new XaiImagineVideoResponseError('xAI video response nesting is invalid.');
  }
  if (isReadableLike(value)) throw new XaiImagineVideoResponseError('xAI video transport responses must be pre-parsed or bounded.');
  seen.add(value);
  try {
    const entries = Object.entries(value);
    if (entries.length > MAX_RESPONSE_KEYS) throw new XaiImagineVideoResponseError('xAI video response has too many fields.');
    let total = 2;
    for (const [key, child] of entries) {
      total += Buffer.byteLength(key, 'utf8') + 3 + boundedResponseSize(child, seen, depth + 1);
      if (total > MAX_RESPONSE_BYTES) throw new XaiImagineVideoResponseError('xAI video response is too large.');
    }
    return total;
  } finally {
    seen.delete(value);
  }
}

function assertBoundedResponse(value: unknown): unknown {
  boundedResponseSize(value);
  return value;
}

function parseResponseText(text: string, allowPlainText: boolean): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new XaiImagineVideoResponseError('xAI video response is too large.');
  }
  if (text.trim() === '') return undefined;
  try {
    return assertBoundedResponse(JSON.parse(text) as unknown);
  } catch (error) {
    if (allowPlainText) return text;
    if (error instanceof XaiImagineVideoResponseError) throw error;
    throw new XaiImagineVideoResponseError('xAI video response is not valid JSON.');
  }
}

async function responseBody(response: XaiImagineHttpResponse, allowPlainText = false): Promise<unknown> {
  let lastError: unknown;
  const tryCandidate = async (candidate: () => unknown | Promise<unknown>): Promise<unknown | undefined> => {
    try {
      const value = await candidate();
      return value === undefined ? undefined : assertBoundedResponse(value);
    } catch (error) {
      lastError = error;
      return undefined;
    }
  };

  let value: unknown;
  const jsonReader = response.json;
  if (typeof jsonReader === 'function') {
    value = await tryCandidate(() => jsonReader());
  } else if (jsonReader !== undefined) {
    value = await tryCandidate(() => jsonReader);
  }
  if (value !== undefined) return value;

  const textReader = response.text;
  if (typeof textReader === 'function') {
    value = await tryCandidate(async () => parseResponseText(await textReader(), allowPlainText));
  } else if (textReader !== undefined) {
    value = await tryCandidate(async () => parseResponseText(await textReader, allowPlainText));
  }
  if (value !== undefined) return value;

  const body = response.body;
  if (body instanceof Uint8Array) {
    value = await tryCandidate(() => parseResponseText(new TextDecoder().decode(body), allowPlainText));
  } else if (typeof body === 'string') {
    value = await tryCandidate(() => parseResponseText(body, allowPlainText));
  } else if (body !== undefined) {
    value = await tryCandidate(() => body);
  }
  if (value !== undefined) return value;
  if (!allowPlainText && lastError !== undefined) {
    if (lastError instanceof XaiImagineVideoResponseError) throw lastError;
    throw new XaiImagineVideoResponseError('xAI video response is not valid JSON.');
  }
  return undefined;
}

function headerValue(headers: XaiImagineHttpResponse['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
}

function retryAfterMs(headers: XaiImagineHttpResponse['headers']): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 86_400_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(Math.max(0, timestamp - Date.now()), 86_400_000) : undefined;
}

function sanitizeMessage(value: string, secrets: Readonly<Record<string, string>> = {}): string {
  let result = value;
  for (const secret of Object.values(secrets)) {
    if (secret.length > 0) result = result.split(secret).join('[REDACTED]');
  }
  return result
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[-_]?key|authorization|token|secret|password|credential|signature)\s*[:=]\s*\S+/giu, 'credential=[REDACTED]')
    .replace(/https?:\/\/\S+/giu, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .slice(0, MAX_ERROR_CHARS);
}

function errorMessageFromBody(body: unknown, secrets: Readonly<Record<string, string>>): string {
  if (typeof body === 'string') return sanitizeMessage(body, secrets);
  if (!isRecord(body)) return '';
  const nested = body.error;
  if (typeof nested === 'string') return sanitizeMessage(nested, secrets);
  if (isRecord(nested)) {
    const message = boundedString(nested.message, MAX_ERROR_CHARS) ?? boundedString(nested.detail, MAX_ERROR_CHARS);
    if (message !== undefined) return sanitizeMessage(message, secrets);
  }
  return sanitizeMessage(boundedString(body.message, MAX_ERROR_CHARS) ?? boundedString(body.detail, MAX_ERROR_CHARS) ?? '', secrets);
}

function assertRemoteId(value: unknown): string {
  const id = nonEmptyString(value)?.trim();
  if (id === undefined || id.length > MAX_REMOTE_ID_CHARS || !/^[A-Za-z0-9._:-]+$/u.test(id)) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid request id.');
  }
  return id;
}

function parseExpiry(value: unknown): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid expiry.');
  }
  const result = new Date(value * 1_000);
  if (!Number.isFinite(result.getTime())) throw new XaiImagineVideoResponseError('xAI video returned an invalid expiry.');
  return result;
}

function parseProgress(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new XaiImagineVideoResponseError('xAI video returned invalid progress.');
  }
  return Math.round(value);
}

function parseRemoteError(value: unknown, secrets: Readonly<Record<string, string>>): ProviderError {
  if (value !== undefined && value !== null && typeof value !== 'string' && !isRecord(value)) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid failure error.');
  }
  const source = isRecord(value) ? value : undefined;
  const rawCode = source?.code;
  if (rawCode !== undefined && boundedString(rawCode, 128) === undefined) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid failure code.');
  }
  const rawMessage = source?.message ?? source?.detail;
  if (rawMessage !== undefined && boundedString(rawMessage, MAX_ERROR_CHARS) === undefined) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid failure message.');
  }
  const code = sanitizeMessage(boundedString(rawCode, 128) ?? 'xai_video_failed', secrets);
  const message = sanitizeMessage(
    boundedString(source?.message, MAX_ERROR_CHARS) ??
      boundedString(source?.detail, MAX_ERROR_CHARS) ??
      (typeof value === 'string' ? value : 'xAI video generation failed.'),
    secrets,
  );
  const normalizedCode = code.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toLowerCase() || 'failed';
  return { code: `xai_${normalizedCode}`, kind: 'rejected', message, retryable: false };
}

function safeResultUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESULT_URL_CHARS) {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid result URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XaiImagineVideoResponseError('xAI video returned an invalid result URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new XaiImagineVideoResponseError('xAI video returned an unsafe result URL.');
  }
  for (const [name] of url.searchParams) {
    const normalized = name.trim().toLowerCase();
    if (
      CREDENTIAL_QUERY_NAMES.has(normalized) ||
      normalized.startsWith('x-amz-') ||
      normalized.startsWith('x-goog-') ||
      normalized.startsWith('x-ms-') ||
      normalized.startsWith('oauth_')
    ) {
      throw new XaiImagineVideoResponseError('xAI video result URL contains credential-like query data.');
    }
  }
  return url.toString();
}

function expiryFromResultUrl(resultUrl: string): Date | undefined {
  const raw = new URL(resultUrl).searchParams.get('expires');
  if (raw === null) return undefined;
  if (!/^\d+$/u.test(raw)) throw new XaiImagineVideoResponseError('xAI video returned an invalid result URL expiry.');
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new XaiImagineVideoResponseError('xAI video returned an invalid result URL expiry.');
  const result = new Date(seconds * 1_000);
  if (!Number.isFinite(result.getTime())) throw new XaiImagineVideoResponseError('xAI video returned an invalid result URL expiry.');
  return result;
}

function earliestExpiry(...values: readonly (Date | undefined)[]): Date | undefined {
  return values.filter((value): value is Date => value !== undefined)
    .sort((left, right) => left.getTime() - right.getTime())[0];
}

function isExpired(value: Date | undefined): boolean {
  return value !== undefined && value.getTime() <= Date.now();
}

function parseVideoStatus(
  value: unknown,
  expectedId: string | undefined,
  expectedModel: string | undefined,
  secrets: Readonly<Record<string, string>>,
): ParsedVideoStatus {
  if (!isRecord(value)) throw new XaiImagineVideoResponseError('xAI video response must be an object.');
  const responseId = value.request_id ?? value.id;
  if (expectedId !== undefined && responseId === undefined) {
    throw new XaiImagineVideoResponseError('xAI video response is missing the requested id.');
  }
  if (responseId !== undefined) {
    const id = assertRemoteId(responseId);
    if (expectedId !== undefined && id !== expectedId) {
      throw new XaiImagineVideoResponseError('xAI returned a different request id than requested.');
    }
  }
  const rawStatus = value.status;
  const status = rawStatus === 'pending' || rawStatus === 'running' || rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'expired'
    ? rawStatus
    : null;
  if (status === null) throw new XaiImagineVideoResponseError('xAI returned an unknown video status.');
  const model = value.model === undefined ? undefined : boundedString(value.model, MAX_MODEL_ID_CHARS);
  if (value.model !== undefined && model === undefined) throw new XaiImagineVideoResponseError('xAI returned an invalid video model.');
  if (expectedModel !== undefined && model !== undefined && model !== expectedModel) {
    throw new XaiImagineVideoResponseError('xAI returned a video model different from the request.');
  }
  const resultExpiresAt = parseExpiry(value.expires_at ?? value.expiresAt);
  const progress = parseProgress(value.progress, status === 'done' ? 100 : 0);
  if (status === 'failed') return { status, progress, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }), ...(model === undefined ? {} : { model }), error: parseRemoteError(value.error, secrets) };
  if (status === 'expired') return { status, progress, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }), ...(model === undefined ? {} : { model }) };
  if (status !== 'done') return { status, progress, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }), ...(model === undefined ? {} : { model }) };
  if (expectedModel !== undefined && model === undefined) {
    throw new XaiImagineVideoResponseError('xAI completed video response is missing its model.');
  }

  if (!isRecord(value.video)) throw new XaiImagineVideoResponseError('xAI completed video response is missing video metadata.');
  const video = value.video;
  const resultUrl = safeResultUrl(video.url);
  if (typeof video.duration !== 'number' || !Number.isSafeInteger(video.duration) || video.duration < 1 || video.duration > 15) {
    throw new XaiImagineVideoResponseError('xAI returned an invalid video duration.');
  }
  if (video.respect_moderation !== true) {
    throw new XaiImagineVideoResponseError('xAI completed video did not include a successful moderation result.');
  }
  const videoExpiry = parseExpiry(video.expires_at ?? video.expiresAt);
  const resultExpiry = earliestExpiry(resultExpiresAt, videoExpiry, expiryFromResultUrl(resultUrl));
  return {
    status,
    progress,
    resultUrl,
    duration: video.duration,
    moderation: true,
    ...(resultExpiry === undefined ? {} : { resultExpiresAt: resultExpiry }),
    ...(model === undefined ? {} : { model }),
  };
}

function videoCapabilities(modelId: string): ModelCapabilities {
  const supportsReferenceToVideo = modelId === XAI_IMAGINE_VIDEO_MODEL;
  const supports1080p = modelId === XAI_IMAGINE_VIDEO_MODEL;
  return {
    operations: supportsReferenceToVideo
      ? ['video.generate', 'video.image_to_video', 'video.reference_to_video']
      : ['video.generate', 'video.image_to_video'],
    aspectRatios: [...VIDEO_ASPECT_RATIOS],
    resolutions: supports1080p ? [...VIDEO_RESOLUTIONS] : ['480p', '720p'],
    durations: { min: 1, max: 15 },
    maxReferenceImages: supportsReferenceToVideo ? MAX_REFERENCE_IMAGES : 0,
    inputImageConstraints: {
      mimeTypes: [...VIDEO_INPUT_MIME_TYPES],
      maxBytes: MAX_INPUT_BYTES,
    },
    supportsMask: false,
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsAudio: true,
    supportsProgress: true,
    supportsCancel: false,
    supportsBatchCount: false,
    maxBatchCount: 1,
    customFields: {
      type: 'object',
      properties: {
        audio: { type: 'boolean' },
        referenceMaxResolution: { const: '720p' },
      },
      additionalProperties: false,
    },
  };
}

function conservativeVideoCapabilities(): ModelCapabilities {
  return {
    ...videoCapabilities(XAI_IMAGINE_VIDEO_BASE_MODEL),
    operations: ['video.generate'],
    aspectRatios: ['16:9'],
    resolutions: ['480p'],
    maxReferenceImages: 0,
    supportsAudio: true,
    customFields: { type: 'object', additionalProperties: false },
  };
}

function videoCapabilitiesFor(modelId: string): ModelCapabilities {
  return VIDEO_MODEL_IDS.has(modelId) ? videoCapabilities(modelId) : conservativeVideoCapabilities();
}

function displayName(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 255
    ? value.trim()
    : 'Grok Imagine Video 1.5';
}

function parseModels(value: unknown): readonly ProviderModel[] {
  if (!isRecord(value)) throw new XaiImagineVideoResponseError('xAI models response is invalid.');
  const entries = Array.isArray(value.models) ? value.models : undefined;
  if (entries === undefined || entries.length > 200) throw new XaiImagineVideoResponseError('xAI models response is invalid.');
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.id)?.trim();
    if (id === undefined || !isSafeModelId(id) || seen.has(id)) continue;
    const inputModalities = Array.isArray(entry.input_modalities)
      ? entry.input_modalities.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase())
      : [];
    const outputModalities = Array.isArray(entry.output_modalities)
      ? entry.output_modalities.filter((value): value is string => typeof value === 'string').map((value) => value.toLowerCase())
      : [];
    if (!outputModalities.includes('video') || !inputModalities.some((value) => value === 'text' || value === 'image')) continue;
    seen.add(id);
    models.push({
      id,
      displayName: displayName(entry.display_name ?? entry.displayName),
      capabilities: VIDEO_MODEL_IDS.has(id) ? videoCapabilities(id) : conservativeVideoCapabilities(),
    });
  }
  return models;
}

function catalogEntryIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > 200) {
    throw new XaiImagineVideoResponseError('xAI models response is invalid.');
  }
  return new Set(value.models.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = nonEmptyString(entry.id)?.trim();
    return id === undefined || !isSafeModelId(id) ? [] : [id];
  }));
}

function configuredModelCapabilities(
  context: XaiImagineVideoProviderContext,
  configuredModels?: readonly string[],
): readonly ProviderModel[] {
  return configuredModelIds(context, configuredModels).map((id) => ({
    id,
    displayName: id === XAI_IMAGINE_VIDEO_MODEL
      ? 'Grok Imagine Video 1.5'
      : id === XAI_IMAGINE_VIDEO_BASE_MODEL
        ? 'Grok Imagine Video'
        : `xAI Imagine Video (${id})`,
    capabilities: videoCapabilitiesFor(id),
  }));
}

export function getXaiImagineVideoCapabilities(): ProviderCapabilities {
  return {
    providerType: XAI_IMAGINE_VIDEO_PROFILE,
    models: [XAI_IMAGINE_VIDEO_BASE_MODEL, XAI_IMAGINE_VIDEO_MODEL].map((id) => ({
      id,
      displayName: id === XAI_IMAGINE_VIDEO_MODEL ? 'Grok Imagine Video 1.5' : 'Grok Imagine Video',
      capabilities: videoCapabilities(id),
    })),
  };
}

export interface XaiImagineVideoPayload {
  readonly body: JsonRecord;
}

export function buildXaiImagineVideoPayload(
  request: GenerationRequest,
  context: XaiImagineVideoProviderContext,
  configuredModels?: readonly string[],
): XaiImagineVideoPayload {
  validateRequest(request, context, configuredModels);
  const body: JsonRecord = {
    model: request.modelId,
    prompt: request.prompt,
  };
  if (request.durationSeconds !== undefined) body.duration = request.durationSeconds;
  if (request.aspectRatio !== undefined) body.aspect_ratio = request.aspectRatio;
  if (request.resolution !== undefined) body.resolution = request.resolution;
  if (request.audio !== undefined) body.generate_audio = request.audio;
  if (request.operation === 'video.generate') return { body };
  const inputs = requestInputs(request, context);
  assertTotalInputBytes(inputs);
  if (request.operation === 'video.image_to_video') {
    body.image = { url: imageDataUri(inputs[0]!) };
  } else {
    body.reference_images = inputs.map((input) => ({ url: imageDataUri(input) }));
  }
  return { body };
}

function providerErrorFromHttp(error: XaiImagineVideoHttpError): ProviderError {
  const status = error.statusCode;
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const message = error.responseBody ?? `xAI video request failed with HTTP ${status}.`;
  const code = status === 401 || status === 403
    ? 'xai_authentication_error'
    : status === 429
      ? 'xai_rate_limited'
      : `xai_http_${status}`;
  const retryAfter = retryAfterMs(error.responseHeaders);
  return {
    code,
    kind: retryable ? 'transient' : status >= 400 && status < 500 ? 'rejected' : 'unknown',
    message,
    retryable,
    statusCode: status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
  };
}

function normalizeVideoError(error: unknown): ProviderError {
  if (error instanceof XaiImagineVideoValidationError) return error.providerError;
  if (error instanceof XaiImagineVideoHttpError) return providerErrorFromHttp(error);
  if (error instanceof XaiImagineVideoExpiredError) {
    return { code: 'xai_result_expired', kind: 'expired', message: 'The xAI video result expired before download.', retryable: false };
  }
  if (error instanceof UnsafeRemoteUrlError) {
    return { code: 'xai_network_policy_denied', kind: 'rejected', message: 'The xAI video network policy denied the request.', retryable: false };
  }
  if (error instanceof ProviderHttpError) {
    if (error.code === 'aborted') return { code: 'xai_request_aborted', kind: 'transient', message: 'The xAI video request was aborted.', retryable: false };
    if (error.code === 'invalid_request' || error.code === 'request_body_too_large' || error.code === 'response_body_too_large' || error.code === 'response_invalid' || error.code === 'redirect_not_allowed') {
      return { code: `xai_provider_http_${error.code}`, kind: 'rejected', message: 'The xAI video HTTP request was rejected by safety validation.', retryable: false };
    }
    return { code: `xai_provider_http_${error.code}`, kind: 'transient', message: 'The xAI video HTTP request failed.', retryable: true };
  }
  if (error instanceof XaiImagineVideoResponseError) {
    return { code: 'xai_invalid_response', kind: 'rejected', message: sanitizeMessage(error.message), retryable: false };
  }
  if (error instanceof XaiImagineVideoTransportError) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'CanceledError')) {
      return { code: 'xai_request_aborted', kind: 'transient', message: 'The xAI video request was aborted.', retryable: false };
    }
    return { code: 'xai_transport_error', kind: 'transient', message: 'The xAI video request failed before a response was received.', retryable: true };
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')) {
    return { code: 'xai_request_aborted', kind: 'transient', message: 'The xAI video request was aborted.', retryable: false };
  }
  return { code: 'xai_network_error', kind: 'transient', message: 'The xAI video request failed before a response was received.', retryable: true };
}

function assetFor(context: ProviderContext, remoteJobId: string, parsed: ParsedVideoStatus): Extract<SubmittedAsset, { source: 'provider' }> {
  return {
    type: 'video',
    mimeType: 'video/mp4',
    source: 'provider',
    providerId: context.providerId,
    remoteJobId,
    resultId: remoteJobId,
    variant: 'video',
    metadata: {
      model: parsed.model ?? XAI_IMAGINE_VIDEO_MODEL,
      duration: parsed.duration,
      respectModeration: parsed.moderation === true,
    },
  };
}

function resultHeaders(
  context: XaiImagineVideoProviderContext,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
  resultUrl: string,
  baseUrl: string,
): Readonly<Record<string, string>> {
  const targetOrigin = new URL(resultUrl).origin;
  const providerOrigin = new URL(baseUrl).origin;
  if (targetOrigin !== providerOrigin) return { Accept: 'video/mp4' };
  return { ...requestHeaders(context, configuredHeaders, false), Accept: 'video/mp4' };
}

export class XaiImagineVideoProvider implements ProviderAdapter {
  public readonly type = XAI_IMAGINE_VIDEO_PROFILE;
  private readonly injectedHttp: VideoHttpClient | undefined;
  private readonly configuredBaseUrl: string | undefined;
  private readonly configuredHeaders: Readonly<Record<string, string>> | undefined;
  private readonly configuredModels: readonly string[] | undefined;

  public constructor(options: XaiImagineVideoProviderOptions = {}) {
    this.injectedHttp = options.http ?? options.transport;
    this.configuredBaseUrl = options.baseUrl;
    this.configuredHeaders = options.headers;
    this.configuredModels = options.models;
  }

  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = context as XaiImagineVideoProviderContext;
    return { providerType: this.type, models: configuredModelCapabilities(runtime, this.configuredModels) };
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = context as XaiImagineVideoProviderContext;
    const configured = configuredModelIds(runtime, this.configuredModels);
    const body = await this.requestJson(runtime, '/video-generation-models', false);
    const catalog = parseModels(body);
    const explicit = this.configuredModels !== undefined || Array.isArray(runtime.config?.models);
    const advertisedIds = catalogEntryIds(body);
    const missingConfigured = (explicit ? configured : [])
      .filter((id) => !advertisedIds.has(id))
      .map((id) => ({
        id,
        displayName: id === XAI_IMAGINE_VIDEO_MODEL
          ? 'Grok Imagine Video 1.5'
          : id === XAI_IMAGINE_VIDEO_BASE_MODEL
            ? 'Grok Imagine Video'
            : `xAI Imagine Video (${id})`,
        capabilities: videoCapabilitiesFor(id),
      }));
    return {
      providerType: this.type,
      models: explicit
        ? [...catalog.filter((model) => configured.includes(model.id)), ...missingConfigured]
        : catalog,
    };
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const runtime = context as XaiImagineVideoProviderContext;
    parseModels(await this.requestJson(runtime, '/video-generation-models', false));
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const runtime = context as XaiImagineVideoProviderContext;
    apiKey(runtime);
    validateRequest(request, runtime, this.configuredModels);
    endpointFor(contextBaseUrl(runtime, this.configuredBaseUrl), '/videos/generations');
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtime = context as XaiImagineVideoProviderContext;
    const payload = buildXaiImagineVideoPayload(request, runtime, this.configuredModels);
    const body = await this.requestJson(runtime, '/videos/generations', true, {
      method: 'POST',
      body: JSON.stringify(payload.body),
    });
    const source = isRecord(body) ? body : null;
    if (source === null || source.request_id === undefined) {
      throw new XaiImagineVideoResponseError('xAI video submit response is missing request_id.');
    }
    const remoteJobId = assertRemoteId(source.request_id);
    return { state: 'pending', remoteJobId, pollAfterMs: 5_000 };
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    const runtime = context as XaiImagineVideoProviderContext;
    const id = assertRemoteId(remoteJobId);
    const parsed = parseVideoStatus(
      await this.requestJson(runtime, `/videos/${encodeURIComponent(id)}`, false),
      id,
      runtime.modelId,
      runtime.secrets,
    );
    if (isExpired(parsed.resultExpiresAt)) {
      return { state: 'failed', error: { code: 'xai_result_expired', kind: 'expired', message: 'The xAI video result expired.', retryable: false } };
    }
    if (parsed.status === 'expired') {
      return { state: 'failed', error: { code: 'xai_result_expired', kind: 'expired', message: 'The xAI video request expired.', retryable: false } };
    }
    if (parsed.status === 'failed') return { state: 'failed', error: parsed.error! };
    if (parsed.status === 'done') {
      return {
        state: 'completed',
        assets: [assetFor(runtime, id, parsed)],
        ...(parsed.resultExpiresAt === undefined ? {} : { resultExpiresAt: parsed.resultExpiresAt }),
      };
    }
    return {
      state: parsed.status === 'running' ? 'remote_running' : 'remote_pending',
      progress: parsed.progress,
      pollAfterMs: 5_000,
      ...(parsed.resultExpiresAt === undefined ? {} : { resultExpiresAt: parsed.resultExpiresAt }),
    };
  }

  public async resolveResult(asset: ProviderAssetReference, context: ProviderContext): Promise<ProviderResultTarget> {
    const runtime = context as XaiImagineVideoProviderContext;
    if (asset.providerId !== runtime.providerId || asset.variant !== 'video' || asset.type !== 'video') {
      throw new XaiImagineVideoValidationError('xai_result_reference_invalid', 'The xAI video result reference is invalid.');
    }
    const id = assertRemoteId(asset.remoteJobId);
    if (asset.resultId !== undefined && assertRemoteId(asset.resultId) !== id) {
      throw new XaiImagineVideoResponseError('xAI video result id does not match the remote job id.');
    }
    const parsed = parseVideoStatus(
      await this.requestJson(runtime, `/videos/${encodeURIComponent(id)}`, false),
      id,
      runtime.modelId,
      runtime.secrets,
    );
    if (parsed.status === 'expired') throw new XaiImagineVideoExpiredError('The xAI video result expired before download.');
    if (parsed.status === 'failed') throw new XaiImagineVideoResponseError(parsed.error?.message ?? 'The xAI video result failed.');
    if (isExpired(parsed.resultExpiresAt)) throw new XaiImagineVideoExpiredError('The xAI video result expired before download.');
    if (parsed.status !== 'done' || parsed.resultUrl === undefined) throw new XaiImagineVideoResponseError('The xAI video result is not ready for download.');
    const baseUrl = contextBaseUrl(runtime, this.configuredBaseUrl);
    return {
      url: parsed.resultUrl,
      headers: resultHeaders(runtime, this.configuredHeaders, parsed.resultUrl, baseUrl),
      claimedMimeType: 'video/mp4',
    };
  }

  public normalizeError(error: unknown): ProviderError {
    return normalizeVideoError(error);
  }

  private async requestJson(
    context: XaiImagineVideoProviderContext,
    path: string,
    includeContentType: boolean,
    override: Partial<Pick<XaiImagineHttpRequest, 'method' | 'body'>> = {},
  ): Promise<unknown> {
    const http = context.http ?? context.transport ?? this.injectedHttp;
    if (http === undefined) throw new XaiImagineVideoValidationError('xai_http_not_configured', 'The xAI video secure HTTP client is not configured.');
    const request: XaiImagineHttpRequest = {
      method: override.method ?? 'GET',
      url: endpointFor(contextBaseUrl(context, this.configuredBaseUrl), path),
      headers: requestHeaders(context, this.configuredHeaders, includeContentType),
      ...(override.body === undefined ? {} : { body: override.body }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    context.signal?.throwIfAborted();
    let response: XaiImagineHttpResponse;
    try {
      response = typeof http === 'function' ? await http(request) : await http.request(request);
    } catch (error) {
      if (error instanceof XaiImagineVideoValidationError || error instanceof XaiImagineVideoTransportError || error instanceof ProviderHttpError || error instanceof UnsafeRemoteUrlError) throw error;
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')) throw error;
      throw new XaiImagineVideoTransportError('xAI video HTTP request failed.', { cause: error });
    }
    try {
      const status = response.statusCode ?? response.status;
      if (status === undefined || !Number.isSafeInteger(status) || status < 100 || status > 599) {
        throw new XaiImagineVideoResponseError('xAI video HTTP response did not include a valid status code.');
      }
      const body = await responseBody(response, status < 200 || status >= 300);
      if (status < 200 || status >= 300) throw new XaiImagineVideoHttpError(status, body, response.headers, context.secrets);
      return body;
    } finally {
      try {
        await response.dispose?.();
      } catch {
        // Disposal must not hide a bounded response or provider error.
      }
    }
  }
}

export function createXaiImagineVideoProvider(options: XaiImagineVideoProviderOptions = {}): XaiImagineVideoProvider {
  return new XaiImagineVideoProvider(options);
}

export function normalizeXaiImagineVideoError(error: unknown): ProviderError {
  return normalizeVideoError(error);
}

export { XaiImagineVideoProvider as XaiImagineVideoAdapter };
export default XaiImagineVideoProvider;
