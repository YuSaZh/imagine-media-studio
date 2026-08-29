import type {
  GenerationRequest,
  MediaOperation,
} from '@imagine/shared';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderModel,
  SubmitResult,
} from '@imagine/provider-contract';

import {
  buildImageEditMultipart,
  buildImageGenerationPayload,
  buildResponsesPayload,
  assertImageGenerationPayload,
  assertResponsesImagePayload,
  imageRequestOptions,
  normalizeImageResponse,
  RESPONSES_EXTRA_KEYS,
} from './protocol.js';
import { parseOpenAiImageStream } from './stream.js';
import {
  OpenAiHttpError,
  OpenAiResponseError,
  OpenAiTransportError,
  OpenAiValidationError,
  redactOpenAiErrorText,
  type OpenAiAssetResolver,
  type OpenAiHttpResponse,
  type OpenAiHttpRequest,
  type OpenAiHttpRequestExecutor,
  type OpenAiHttpTransport,
  type OpenAiImagePartial,
  type OpenAiInputAsset,
  type OpenAiProfile,
  type OpenAiProviderOptions,
  type OpenAiRuntimeContext,
  OPENAI_DEFAULT_BASE_URL,
} from './types.js';

const IMAGE_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'] as const;
const RESPONSES_MODELS = ['gpt-5.6'] as const;
const OPENAI_IMAGE_MODEL_PATTERN = /(?:^|[-_.])images?(?:$|[-_.])/iu;
const MAX_DYNAMIC_MODEL_COUNT = 200;
const MAX_MODEL_ID_CHARS = 255;
const MAX_MODEL_DISPLAY_NAME_CHARS = 255;
const MAX_PROMPT_CHARS = 32_000;
const MAX_REFERENCES = 16;
const INPUT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PROTECTED_HEADER_NAMES = new Set(['accept', 'authorization', 'content-type', 'idempotency-key']);
const HOP_BY_HOP_HEADER_NAMES = new Set([
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
const IMAGE_INPUT_ROLES = new Set(['source', 'reference', 'mask']);
const REQUEST_KEYS = new Set([
  'operation',
  'providerId',
  'modelId',
  'prompt',
  'negativePrompt',
  'inputs',
  'aspectRatio',
  'width',
  'height',
  'resolution',
  'count',
  'durationSeconds',
  'fps',
  'quality',
  'format',
  'seed',
  'audio',
  'extra',
]);

type HeadersLike = OpenAiHttpResponse['headers'];
type HttpClient = OpenAiHttpTransport | OpenAiHttpRequestExecutor;

function asRuntimeContext(context: ProviderContext): OpenAiRuntimeContext {
  return context as OpenAiRuntimeContext;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function headersEntries(headers: HeadersLike): Array<[string, string]> {
  if (headers === undefined) return [];
  if ('get' in headers && typeof headers.get === 'function') {
    return [];
  }
  const entries: Array<[string, string]> = [];
  for (const [key, rawValue] of Object.entries(headers)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (typeof value === 'string') entries.push([key, value]);
  }
  return entries;
}

function headerValue(headers: HeadersLike, name: string): string | null {
  const wanted = name.toLowerCase();
  if (headers !== undefined && 'get' in headers && typeof headers.get === 'function') {
    return headers.get(name);
  }
  for (const [key, value] of headersEntries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function assertHeaderValue(value: string, label: string): string {
  if (/\r|\n/.test(value)) {
    throw new OpenAiValidationError('invalid_header', `${label} contains an invalid newline.`);
  }
  return value;
}

function normalizedHeaders(...sources: HeadersLike[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of headersEntries(source)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new OpenAiValidationError('invalid_header', `Invalid OpenAI header name ${name}.`);
      }
      assertHeaderValue(value, name);
      const normalized = name.toLowerCase();
      if (HOP_BY_HOP_HEADER_NAMES.has(normalized) || PROTECTED_HEADER_NAMES.has(normalized)) continue;
      for (const existingName of Object.keys(output)) {
        if (existingName.toLowerCase() === normalized) delete output[existingName];
      }
      output[name] = value;
    }
  }
  return output;
}

function configValue(context: OpenAiRuntimeContext, key: string): unknown {
  return context.config === undefined ? undefined : context.config[key];
}

function baseUrlFor(options: OpenAiProviderOptions, context: OpenAiRuntimeContext): string {
  const candidate =
    options.baseUrl?.trim() ||
    context.baseUrl?.trim() ||
    stringValue(configValue(context, 'baseUrl'))?.trim() ||
    OPENAI_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new OpenAiValidationError('invalid_base_url', 'OpenAI base URL is invalid.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new OpenAiValidationError('invalid_base_url', 'OpenAI base URL must be an HTTP(S) URL without credentials.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, '')}`;
}

function modelIds(options: OpenAiProviderOptions, context: OpenAiRuntimeContext): readonly string[] {
  if (options.models !== undefined) {
    return options.profile === 'openai-images-v1'
      ? options.models.filter((model) => !/^dall-e(?:-|$)/i.test(model))
      : options.models;
  }
  const configured = configValue(context, 'models');
  if (Array.isArray(configured) && configured.every((model) => typeof model === 'string')) {
    return options.profile === 'openai-images-v1'
      ? (configured as string[]).filter((model) => !/^dall-e(?:-|$)/i.test(model))
      : configured as string[];
  }
  return options.profile === 'openai-images-v1' ? IMAGE_MODELS : RESPONSES_MODELS;
}

function displayName(profile: OpenAiProfile, model: string): string {
  return profile === 'openai-images-v1' ? `OpenAI Images (${model})` : `OpenAI Responses Image (${model})`;
}

type ImageModelId = (typeof IMAGE_MODELS)[number];

function imageModelId(modelId: string): ImageModelId | undefined {
  return (IMAGE_MODELS as readonly string[]).includes(modelId) ? modelId as ImageModelId : undefined;
}

function isKnownResponsesModel(modelId: string): boolean {
  return (RESPONSES_MODELS as readonly string[]).includes(modelId);
}

function isCompatibleImageModel(profile: OpenAiProfile, modelId: string): boolean {
  if (profile === 'openai-images-v1') {
    return imageModelId(modelId) !== undefined || OPENAI_IMAGE_MODEL_PATTERN.test(modelId);
  }
  return isKnownResponsesModel(modelId) || OPENAI_IMAGE_MODEL_PATTERN.test(modelId);
}

function imageCapabilities(
  profile: OpenAiProfile,
  modelId?: string,
  conservative = false,
): ModelCapabilities {
  // Responses image_generation intentionally has no mask or Files API path in PR4;
  // mask editing is provided by the Images multipart profile below.
  const imageModel = profile === 'openai-images-v1' ? imageModelId(modelId ?? '') : undefined;
  const flexibleSize = imageModel === 'gpt-image-2';
  const supportsInputFidelity = imageModel !== 'gpt-image-2' && imageModel !== undefined;
  const resolutions = flexibleSize
    ? ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840']
    : ['auto', '1024x1024', '1536x1024', '1024x1536'];
  const customProperties: Record<string, unknown> = {
    quality: { enum: ['low', 'medium', 'high', 'auto'] },
    background: { enum: ['transparent', 'opaque', 'auto'] },
    partial_images: { type: 'integer', minimum: 0, maximum: 3 },
  };
  if (profile === 'openai-images-v1') {
    customProperties.output_format = { enum: ['png', 'jpeg', 'webp'] };
    customProperties.output_compression = { type: 'integer', minimum: 0, maximum: 100 };
    customProperties.size = flexibleSize
      ? { type: 'string', pattern: '^[0-9]{2,4}x[0-9]{2,4}$|^auto$' }
      : { enum: resolutions };
    if (supportsInputFidelity) customProperties.input_fidelity = { enum: ['low', 'high'] };
  }
  const capabilities: ModelCapabilities = {
    operations: ['image.generate', 'image.edit'],
    aspectRatios: ['1:1', '16:9', '9:16', 'auto'],
    resolutions,
    maxReferenceImages: profile === 'openai-images-v1' ? MAX_REFERENCES : 4,
    supportsMask: profile === 'openai-images-v1',
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsAudio: false,
    supportsProgress: false,
    supportsCancel: false,
    supportsBatchCount: profile === 'openai-images-v1',
    maxBatchCount: profile === 'openai-images-v1' ? 10 : 1,
    inputImageConstraints: {
      mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: 50 * 1024 * 1024,
      maxPixels: 100_000_000,
      maxWidth: 16_384,
      maxHeight: 16_384,
    },
    customFields: {
      type: 'object',
      properties: customProperties,
      additionalProperties: false,
    },
  };
  if (!conservative) return capabilities;
  return {
    ...capabilities,
    aspectRatios: ['1:1'],
    resolutions: ['auto', '1024x1024'],
    maxReferenceImages: 1,
    supportsMask: false,
    supportsBatchCount: false,
    maxBatchCount: 1,
    customFields: { type: 'object', additionalProperties: false },
  };
}

function requestOperationError(operation: MediaOperation): OpenAiValidationError {
  return new OpenAiValidationError('operation_not_supported', `OpenAI image profile does not support ${operation}.`);
}

function countRole(request: GenerationRequest, role: GenerationRequest['inputs'][number]['role']): number {
  return request.inputs.filter((input) => input.role === role).length;
}

function validateInputs(request: GenerationRequest, profile: OpenAiProfile): void {
  const ids = new Set<string>();
  for (const candidate of request.inputs as readonly unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new OpenAiValidationError('invalid_inputs', 'OpenAI input entries must be objects.');
    }
    const input = candidate as GenerationRequest['inputs'][number];
    if (typeof input.assetId !== 'string' || input.assetId.trim() === '') {
      throw new OpenAiValidationError('invalid_inputs', 'OpenAI input assetId must be a non-empty string.');
    }
    if (typeof input.role !== 'string' || !IMAGE_INPUT_ROLES.has(input.role)) {
      throw new OpenAiValidationError('unsupported_input_role', `OpenAI images do not support input role ${String(input.role)}.`);
    }
    if (ids.has(input.assetId)) {
      throw new OpenAiValidationError('duplicate_input', `Input asset ${input.assetId} is duplicated.`);
    }
    ids.add(input.assetId);
  }
  const references = countRole(request, 'reference');
  if (references > (profile === 'openai-images-v1' ? MAX_REFERENCES : 4)) {
    throw new OpenAiValidationError('reference_limit_exceeded', 'OpenAI image profiles accept too many reference images.');
  }
  if (request.operation === 'image.generate') {
    if (profile === 'openai-images-v1' && request.inputs.length > 0) {
      throw new OpenAiValidationError('input_role_not_allowed', 'OpenAI Images generation does not accept input images; use image.edit.');
    }
    if (countRole(request, 'source') > 0 || countRole(request, 'mask') > 0) {
      throw new OpenAiValidationError('input_role_not_allowed', 'image.generate accepts reference inputs only for Responses image_generation.');
    }
  } else if (request.operation === 'image.edit') {
    if (countRole(request, 'source') !== 1) {
      throw new OpenAiValidationError('source_input_required', 'image.edit requires exactly one source image.');
    }
    if (countRole(request, 'mask') > 1) {
      throw new OpenAiValidationError('mask_limit_exceeded', 'image.edit accepts at most one mask.');
    }
    if (request.inputs[0]?.role !== 'source') {
      throw new OpenAiValidationError('source_input_order', 'image.edit requires the source image to be first.');
    }
    if (countRole(request, 'mask') > 0 && profile !== 'openai-images-v1') {
      throw new OpenAiValidationError('mask_not_supported', 'Responses image_generation does not accept a mask part.');
    }
  }
}

function modelAllowed(model: string, configured: readonly string[], profile: OpenAiProfile): boolean {
  if (profile === 'openai-images-v1') {
    if (/^dall-e(?:-|$)/i.test(model)) return false;
    return configured.includes(model) || isCompatibleImageModel(profile, model);
  }
  if (configured.includes(model)) return true;
  return /^gpt-[a-z0-9._-]+$/i.test(model);
}

function requestPolicy(profile: OpenAiProfile, modelId: string): { flexibleSize?: boolean; supportsInputFidelity?: boolean } {
  if (profile !== 'openai-images-v1') return {};
  return {
    flexibleSize: imageModelId(modelId) === 'gpt-image-2',
    supportsInputFidelity: imageModelId(modelId) !== 'gpt-image-2',
  };
}

function validateRequest(request: GenerationRequest, context: OpenAiRuntimeContext, profile: OpenAiProfile, configuredModels: readonly string[]): void {
  const rawRequest = request as unknown as Record<string, unknown>;
  if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new OpenAiValidationError('invalid_request', 'OpenAI generation request must be a JSON object.');
  }
  for (const key of Object.keys(rawRequest)) {
    if (!REQUEST_KEYS.has(key)) throw new OpenAiValidationError('invalid_request', `Unknown generation request field ${key}.`);
  }
  if (typeof rawRequest.providerId !== 'string' || typeof rawRequest.modelId !== 'string' || typeof rawRequest.prompt !== 'string') {
    throw new OpenAiValidationError('invalid_request', 'providerId, modelId, and prompt must be strings.');
  }
  if (!Array.isArray(rawRequest.inputs)) {
    throw new OpenAiValidationError('invalid_request', 'inputs must be an array.');
  }
  if (request.providerId !== context.providerId) {
    throw new OpenAiValidationError('provider_mismatch', 'Generation request providerId does not match ProviderContext.');
  }
  if (!modelAllowed(request.modelId, configuredModels, profile)) {
    throw new OpenAiValidationError('model_not_supported', `OpenAI model ${request.modelId} is not enabled for this profile.`);
  }
  if (request.prompt.trim().length === 0 || request.prompt.length > MAX_PROMPT_CHARS) {
    throw new OpenAiValidationError('invalid_prompt', `Prompt must contain 1 through ${MAX_PROMPT_CHARS} characters.`);
  }
  if (request.operation !== 'image.generate' && request.operation !== 'image.edit') {
    throw requestOperationError(request.operation);
  }
  validateInputs(request, profile);
  if (profile === 'openai-responses-image-v1' && request.count !== undefined && request.count !== 1) {
    throw new OpenAiValidationError('unsupported_option', 'Responses image_generation creates one image per call.');
  }
  const options = imageRequestOptions(
    request,
    profile === 'openai-images-v1' ? undefined : RESPONSES_EXTRA_KEYS,
    requestPolicy(profile, request.modelId),
  );
  if (profile === 'openai-responses-image-v1' && options.outputFormat !== undefined) {
    throw new OpenAiValidationError('unsupported_option', 'Responses image_generation does not accept output format options.');
  }
  if (profile === 'openai-responses-image-v1' && request.operation === 'image.edit' && countRole(request, 'source') !== 1) {
    throw new OpenAiValidationError('source_input_required', 'Responses image edits require one source image.');
  }
}

async function resolveInputs(
  request: GenerationRequest,
  context: OpenAiRuntimeContext,
  resolver: OpenAiAssetResolver | undefined,
): Promise<readonly OpenAiInputAsset[]> {
  if (request.inputs.length === 0) return [];
  const contextInputs = context.inputs ?? [];
  const result: OpenAiInputAsset[] = [];
  for (const requested of request.inputs) {
    const fromContext = contextInputs.find((input) => input.assetId === requested.assetId);
    const requestedRole: OpenAiInputAsset['role'] = requested.role === 'source'
      ? 'source'
      : requested.role === 'mask'
        ? 'mask'
        : 'reference';
    const resolved = fromContext ?? (resolver === undefined ? null : await resolver(requested.assetId, context));
    if (!resolved) {
      throw new OpenAiValidationError('input_asset_missing', `Input asset ${requested.assetId} is not available to the OpenAI adapter.`);
    }
    if (resolved.role !== requested.role) {
      throw new OpenAiValidationError('input_role_mismatch', `Input asset ${requested.assetId} has a mismatched role.`);
    }
    if (!resolved.bytes || !(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength === 0) {
      throw new OpenAiValidationError('input_asset_invalid', `Input asset ${requested.assetId} has no byte content.`);
    }
    const mimeType = resolved.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!INPUT_MIME_TYPES.has(mimeType)) {
      throw new OpenAiValidationError('input_asset_invalid', `Input asset ${requested.assetId} is not an image.`);
    }
    if (requested.role === 'mask' && mimeType !== 'image/png') {
      throw new OpenAiValidationError('mask_type_invalid', 'OpenAI masks must be PNG images.');
    }
    result.push({ ...resolved, mimeType, role: requestedRole });
  }
  assertResolvedInputShape(request, result);
  return result;
}

function assertResolvedInputShape(
  request: GenerationRequest,
  inputs: readonly OpenAiInputAsset[],
): void {
  if (request.operation !== 'image.edit') return;
  const source = inputs.filter((input) => input.role === 'source');
  const masks = inputs.filter((input) => input.role === 'mask');
  if (source.length !== 1 || inputs[0]?.role !== 'source') {
    throw new OpenAiValidationError('source_input_order', 'image.edit requires one source image first.');
  }
  if (masks.length > 1) {
    throw new OpenAiValidationError('mask_limit_exceeded', 'image.edit accepts at most one mask.');
  }
  const mask = masks[0];
  if (!mask) return;
  if (mask.mimeType.toLowerCase() !== 'image/png') {
    throw new OpenAiValidationError('mask_type_invalid', 'OpenAI masks must be PNG images.');
  }
  const sourceAsset = source[0]!;
  if (mask.parentAssetId != null && mask.parentAssetId !== sourceAsset.assetId) {
    throw new OpenAiValidationError('mask_parent_mismatch', 'Mask parent must match the source image.');
  }
  if (
    mask.width !== undefined &&
    mask.height !== undefined &&
    sourceAsset.width !== undefined &&
    sourceAsset.height !== undefined &&
    (mask.width !== sourceAsset.width || mask.height !== sourceAsset.height)
  ) {
    throw new OpenAiValidationError('mask_dimensions_mismatch', 'Mask dimensions must match the source image.');
  }
}

async function responsePayload(response: OpenAiHttpResponse): Promise<unknown> {
  if (response.json !== undefined) {
    return typeof response.json === 'function' ? await response.json() : response.json;
  }
  if (response.text !== undefined) {
    const text = typeof response.text === 'function' ? await response.text() : response.text;
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  if (response.body !== undefined) {
    if (response.body === null || (typeof response.body !== 'string' && !(response.body instanceof Uint8Array) && typeof (response.body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function')) {
      return response.body;
    }
    const chunks: Uint8Array[] = [];
    const body = typeof response.body === 'string' || response.body instanceof Uint8Array
      ? [response.body]
      : response.body as AsyncIterable<Uint8Array | string>;
    for await (const chunk of body) {
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    }
    const text = new TextDecoder().decode(concat(chunks));
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return undefined;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function streamPayload(response: OpenAiHttpResponse): Promise<string> {
  if (response.body === undefined) {
    const payload = await responsePayload(response);
    return typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
  }
  if (typeof response.body === 'string') return response.body;
  if (response.body instanceof Uint8Array) return new TextDecoder().decode(response.body);
  if (response.body === null || typeof (response.body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    return JSON.stringify(response.body ?? {});
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  }
  return new TextDecoder().decode(concat(chunks));
}

function errorMessage(payload: unknown): string {
  const record = asRecord(payload);
  const error = asRecord(record?.error);
  const message = stringValue(error?.message) ?? stringValue(record?.message) ?? stringValue(payload);
  return message ?? 'OpenAI returned an invalid response.';
}

function sanitizedMessage(message: string): string {
  return redactOpenAiErrorText(message);
}

function retryAfterMs(headers: HeadersLike): number | undefined {
  const value = headerValue(headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 86_400_000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 86_400_000));
  return undefined;
}

function upstreamErrorCode(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const error = asRecord(record?.error);
  const raw = stringValue(error?.code) ?? stringValue(error?.type);
  if (raw === null) return undefined;
  const normalized = raw.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return normalized === '' ? undefined : `openai_${normalized}`;
}

function statusError(statusCode: number, message: string, headers: HeadersLike, payload?: unknown): ProviderError {
  const retryable = statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  const retryAfter = retryAfterMs(headers);
  const kind = statusCode === 401 || statusCode === 403 || statusCode === 404 || (statusCode >= 400 && statusCode < 500 && !retryable)
    ? 'rejected'
    : retryable
      ? 'transient'
      : 'unknown';
  return {
    code: statusCode === 429
      ? 'openai_rate_limited'
      : statusCode === 401 || statusCode === 403
        ? 'openai_authentication_error'
        : statusCode >= 500
          ? 'openai_upstream_error'
          : upstreamErrorCode(payload) ?? `openai_http_${statusCode}`,
    kind,
    message: sanitizedMessage(message),
    retryable,
    statusCode,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
  };
}

function outputCountLimit(profile: OpenAiProfile, request: GenerationRequest): number {
  const profileLimit = profile === 'openai-images-v1' ? 10 : 1;
  return Math.min(request.count ?? 1, profileLimit);
}

function assertOutputCount(assets: readonly unknown[], limit: number): void {
  if (assets.length > limit) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned more images than requested.');
  }
}

function boundedModelText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_MODEL_DISPLAY_NAME_CHARS) {
    return fallback.slice(0, MAX_MODEL_DISPLAY_NAME_CHARS);
  }
  return value.trim();
}

function modelEntryId(value: unknown): string | undefined {
  const record = asRecord(value);
  const raw = stringValue(record?.id);
  if (raw === null) return undefined;
  const id = raw.trim();
  return id.length > 0 && id.length <= MAX_MODEL_ID_CHARS ? id : undefined;
}

function modelIsAvailable(value: unknown): boolean {
  const record = asRecord(value);
  const shutdownDate = record?.shutdown_date;
  if (shutdownDate === undefined || shutdownDate === null) return true;
  if (typeof shutdownDate !== 'string') return false;
  const parsed = Date.parse(shutdownDate);
  return Number.isNaN(parsed) || parsed > Date.now();
}

/** Parse the bounded first page returned by the OpenAI-compatible /models endpoint. */
export function parseOpenAiModelCatalog(
  value: unknown,
  profile: OpenAiProfile,
): readonly ProviderModel[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.data)) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI models response is invalid.');
  }
  if (record.data.length > MAX_DYNAMIC_MODEL_COUNT) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI models response exceeds the model limit.');
  }
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of record.data) {
    const id = modelEntryId(entry);
    if (
      id === undefined ||
      seen.has(id) ||
      !modelIsAvailable(entry) ||
      !isCompatibleImageModel(profile, id)
    ) {
      continue;
    }
    seen.add(id);
    const known = profile === 'openai-images-v1'
      ? imageModelId(id) !== undefined
      : isKnownResponsesModel(id);
    const fallbackName = displayName(profile, id);
    const entryRecord = asRecord(entry);
    const remoteName = stringValue(entryRecord?.display_name) ?? stringValue(entryRecord?.displayName);
    models.push({
      id,
      displayName: boundedModelText(remoteName, fallbackName),
      capabilities: imageCapabilities(profile, id, !known),
    });
  }
  return models;
}

function latestPartials(partials: readonly OpenAiImagePartial[]): readonly OpenAiImagePartial[] {
  const byIndex = new Map<number, OpenAiImagePartial>();
  for (const partial of partials) byIndex.set(partial.index, partial);
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

export class OpenAiProviderAdapter implements ProviderAdapter {
  public readonly type: OpenAiProfile;
  private readonly configuredHttp: HttpClient | undefined;
  private readonly options: OpenAiProviderOptions;
  private readonly resolver: OpenAiAssetResolver | undefined;

  public constructor(options: OpenAiProviderOptions);
  public constructor(profile: OpenAiProfile, options?: Omit<OpenAiProviderOptions, 'profile'>);
  public constructor(
    optionsOrProfile: OpenAiProviderOptions | OpenAiProfile,
    profileOptions?: Omit<OpenAiProviderOptions, 'profile'>,
  ) {
    const options: OpenAiProviderOptions = typeof optionsOrProfile === 'string'
      ? { ...profileOptions, profile: optionsOrProfile }
      : optionsOrProfile;
    this.options = options;
    this.type = options.profile;
    this.configuredHttp = options.http ?? options.transport;
    this.resolver = options.resolveAsset;
  }

  public async getCapabilities(context: OpenAiRuntimeContext): Promise<ProviderCapabilities>;
  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = asRuntimeContext(context);
    const models: ProviderModel[] = modelIds(this.options, runtime).map((model) => ({
      id: model,
      displayName: displayName(this.options.profile, model),
      capabilities: imageCapabilities(
        this.options.profile,
        model,
        this.options.profile === 'openai-images-v1'
          ? imageModelId(model) === undefined
          : !isKnownResponsesModel(model),
      ),
    }));
    return { providerType: this.type, models };
  }

  public async getLiveCapabilities(context: OpenAiRuntimeContext): Promise<ProviderCapabilities>;
  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = asRuntimeContext(context);
    const http = this.configuredHttp ?? runtime.http ?? runtime.transport;
    if (http === undefined) return this.getCapabilities(runtime);
    const payload = await this.requestModelCatalog(runtime, http);
    return {
      providerType: this.type,
      models: parseOpenAiModelCatalog(payload, this.options.profile),
    };
  }

  public async testConnection(context: OpenAiRuntimeContext): Promise<void>;
  public async testConnection(context: ProviderContext): Promise<void>;
  public async testConnection(context: ProviderContext): Promise<void> {
    const runtime = asRuntimeContext(context);
    const http = this.configuredHttp ?? runtime.http ?? runtime.transport;
    if (http === undefined) {
      throw new OpenAiTransportError('OpenAI provider requires an injected HTTP transport.');
    }
    await this.requestModelCatalog(runtime, http);
  }

  private async requestModelCatalog(
    context: OpenAiRuntimeContext,
    http: HttpClient,
  ): Promise<unknown> {
    const headers = this.requestHeaders(context);
    const request: OpenAiHttpRequest = {
      method: 'GET',
      url: endpoint(baseUrlFor(this.options, context), '/models'),
      headers: { ...headers, Accept: 'application/json' },
      headersTimeoutMs: 15_000,
      bodyTimeoutMs: 30_000,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    context.signal?.throwIfAborted();
    let response: OpenAiHttpResponse;
    try {
      response = typeof http === 'function' ? await http(request) : await http.request(request);
    } catch (error) {
      if (error instanceof OpenAiValidationError || error instanceof OpenAiTransportError) throw error;
      throw new OpenAiTransportError('OpenAI connection request failed.', { cause: error });
    }
    try {
      const statusCode = response.statusCode ?? response.status;
      if (statusCode === undefined) {
        throw new OpenAiTransportError('OpenAI HTTP transport returned no status code.');
      }
      const payload = await responsePayload(response);
      if (statusCode < 200 || statusCode >= 300) {
        throw new OpenAiHttpError(
          statusCode,
          sanitizedMessage(errorMessage(payload)),
          payload,
          response.headers,
          context.secrets,
        );
      }
      return payload;
    } finally {
      await response.dispose?.();
    }
  }

  public async validate(request: GenerationRequest, context: OpenAiRuntimeContext): Promise<void>;
  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void>;
  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const runtime = asRuntimeContext(context);
    validateRequest(request, runtime, this.options.profile, modelIds(this.options, runtime));
    await resolveInputs(request, runtime, this.resolver);
  }

  public async submit(request: GenerationRequest, context: OpenAiRuntimeContext): Promise<SubmitResult>;
  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult>;
  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtime = asRuntimeContext(context);
    await this.validate(request, runtime);
    const inputs = await resolveInputs(request, runtime, this.resolver);
    const options = imageRequestOptions(
      request,
      this.options.profile === 'openai-images-v1' ? undefined : RESPONSES_EXTRA_KEYS,
      requestPolicy(this.options.profile, request.modelId),
    );
    const headers = this.requestHeaders(runtime);
    let body: string | Uint8Array;
    let contentType: string;
    let path: string;
    const isImagesEdit = this.options.profile === 'openai-images-v1' &&
      (request.operation === 'image.edit' || inputs.length > 0);
    if (this.options.profile === 'openai-images-v1' && isImagesEdit) {
      const multipart = buildImageEditMultipart(options, inputs);
      body = multipart.body;
      contentType = multipart.contentType;
      path = '/images/edits';
    } else if (this.options.profile === 'openai-images-v1') {
      const payload = buildImageGenerationPayload(options);
      assertImageGenerationPayload(payload);
      body = JSON.stringify(payload);
      contentType = 'application/json';
      path = '/images/generations';
    } else {
      const payload = buildResponsesPayload(request, options, inputs);
      assertResponsesImagePayload(payload);
      body = JSON.stringify(payload);
      contentType = 'application/json';
      path = '/responses';
    }
    const requestHeaders: Record<string, string> = Object.fromEntries(
      Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
    );
    requestHeaders.Accept = 'application/json';
    requestHeaders['Content-Type'] = contentType;
    if (runtime.idempotencyKey !== undefined) {
      const idempotencyKey = assertHeaderValue(runtime.idempotencyKey, 'Idempotency-Key').trim();
      if (idempotencyKey === '') throw new OpenAiValidationError('invalid_header', 'Idempotency-Key cannot be empty.');
      requestHeaders['Idempotency-Key'] = idempotencyKey;
    }
    const http = this.configuredHttp ?? runtime.http ?? runtime.transport;
    if (http === undefined) {
      throw new OpenAiTransportError('OpenAI provider requires an injected HTTP transport.');
    }
    const httpRequest = {
      url: endpoint(baseUrlFor(this.options, runtime), path),
      method: 'POST',
      headers: requestHeaders,
      body: typeof body === 'string' ? body : new TextDecoder('latin1').decode(body),
      ...(typeof body === 'string' ? {} : { bodyBytes: body }),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    } satisfies OpenAiHttpRequest;
    const response = typeof http === 'function'
      ? await http(httpRequest)
      : await http.request(httpRequest);
    try {
      const statusCode = response.statusCode ?? response.status;
      if (statusCode === undefined) {
        throw new OpenAiTransportError('OpenAI HTTP transport returned no status code.');
      }
      const streamRequested = options.stream === true;
      const maxAssets = outputCountLimit(this.options.profile, request);
      if (statusCode < 200 || statusCode >= 300) {
        const payload = await responsePayload(response);
        throw new OpenAiHttpError(
          statusCode,
          sanitizedMessage(errorMessage(payload)),
          payload,
          response.headers,
          runtime.secrets,
        );
      }
      if (streamRequested || headerValue(response.headers, 'content-type')?.toLowerCase().includes('text/event-stream')) {
        const raw = await streamPayload(response);
        const outputFormat = options.outputFormat === 'jpeg' || options.outputFormat === 'webp' || options.outputFormat === 'png'
          ? options.outputFormat
          : undefined;
        const parsed = parseOpenAiImageStream(raw, outputFormat === undefined ? {} : { outputFormat });
        if (parsed.assets.length > 0) {
          assertOutputCount(parsed.assets, maxAssets);
          return { state: 'completed', assets: parsed.assets };
        }
        const finalPartials = latestPartials(parsed.partials);
        if (finalPartials.length > 0) {
          assertOutputCount(finalPartials, maxAssets);
          return {
            state: 'completed',
            assets: finalPartials.map((partial, index) => ({
              type: 'image',
              mimeType: partial.mimeType,
              source: 'base64',
              base64: partial.base64,
              resultId: `partial-${index}`,
            })),
          };
        }
        throw new OpenAiValidationError('invalid_response', 'OpenAI stream completed without an image.');
      }
      const payload = await responsePayload(response);
      const outputFormat = options.outputFormat === 'jpeg' || options.outputFormat === 'webp' || options.outputFormat === 'png'
        ? options.outputFormat
        : undefined;
      return {
        state: 'completed',
        assets: normalizeImageResponse(payload, {
          ...(outputFormat === undefined ? {} : { outputFormat }),
          maxAssets,
        }),
      };
    } finally {
      await response.dispose?.();
    }
  }

  public normalizeError(error: unknown): ProviderError {
    if (error instanceof OpenAiValidationError) {
      return {
        code: error.code.startsWith('openai_') ? error.code : `openai_${error.code}`,
        kind: 'rejected',
        message: sanitizedMessage(error.message),
        retryable: false,
      };
    }
    if (error instanceof OpenAiHttpError) {
      return statusError(
        error.statusCode,
        error.responseBody === undefined ? error.message : errorMessage(error.responseBody),
        error.responseHeaders,
        error.responseBody,
      );
    }
    if (error instanceof OpenAiResponseError) {
      return {
        code: error.code.startsWith('openai_') ? error.code : `openai_${error.code}`,
        kind: 'rejected',
        message: sanitizedMessage(error.message),
        retryable: false,
      };
    }
    if (error instanceof OpenAiTransportError) {
      return {
        code: 'openai_network_error',
        kind: 'transient',
        message: sanitizedMessage(error.message),
        retryable: true,
      };
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return { code: 'request_aborted', kind: 'expired', message: 'OpenAI request was aborted.', retryable: false };
    }
    const record = asRecord(error);
    const statusCode = typeof record?.statusCode === 'number' ? record.statusCode : typeof record?.status === 'number' ? record.status : undefined;
    if (statusCode !== undefined) {
      return statusError(statusCode, errorMessage(error), undefined, error);
    }
    return {
      code: 'openai_network_error',
      kind: 'transient',
      message: sanitizedMessage(error instanceof Error ? error.message : 'OpenAI request failed.'),
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
    if (apiKey !== undefined) assertHeaderValue(apiKey, 'API key');
    if (apiKey !== undefined && apiKey.trim() === '') {
      throw new OpenAiValidationError('missing_api_key', 'OpenAI API key is not configured.');
    }
    if (headerValue(headers, 'Authorization') === null && apiKey !== undefined) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
    if (headerValue(headers, 'Accept') === null) headers.Accept = 'application/json';
    const authorization = headerValue(headers, 'Authorization');
    if (authorization === null || authorization.trim() === '') {
      throw new OpenAiValidationError('missing_api_key', 'OpenAI API key is not configured.');
    }
    return headers;
  }
}

export class OpenAiImagesProvider extends OpenAiProviderAdapter {
  public constructor(options: Omit<OpenAiProviderOptions, 'profile'> & { profile?: 'openai-images-v1' } = {}) {
    super({ ...options, profile: 'openai-images-v1' });
  }
}

export class OpenAiResponsesImageProvider extends OpenAiProviderAdapter {
  public constructor(options: Omit<OpenAiProviderOptions, 'profile'> & { profile?: 'openai-responses-image-v1' } = {}) {
    super({ ...options, profile: 'openai-responses-image-v1' });
  }
}

export { OpenAiImagesProvider as OpenAiImagesAdapter, OpenAiResponsesImageProvider as OpenAiResponsesImageAdapter };

export function createOpenAiImagesProvider(
  options: Omit<OpenAiProviderOptions, 'profile'> = {},
): OpenAiImagesProvider {
  return new OpenAiImagesProvider(options);
}

export function createOpenAiResponsesImageProvider(
  options: Omit<OpenAiProviderOptions, 'profile'> = {},
): OpenAiResponsesImageProvider {
  return new OpenAiResponsesImageProvider(options);
}
