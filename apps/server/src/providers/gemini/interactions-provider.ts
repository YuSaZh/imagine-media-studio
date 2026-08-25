import type { GenerationRequest } from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderInput,
  SubmitResult,
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
import {
  GEMINI_MAX_OUTPUT_ASSETS,
  GEMINI_MAX_RESULT_ID_LENGTH,
  GEMINI_MAX_RESPONSE_STRING_LENGTH,
  liveGeminiCapabilities,
  staticGeminiCapabilities,
} from './catalog.js';
import { buildGeminiHeaders as mergeGeminiHeaders } from './headers.js';
import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  getGeminiModelProfile,
  type GeminiModelProfile,
} from './payload.js';
import type {
  GeminiHttpRequest,
  GeminiHttpRequestExecutor,
  GeminiHttpResponse,
  GeminiHttpTransport,
  GeminiProviderContext,
  GeminiProviderOptions,
} from './types.js';

export const GEMINI_INTERACTIONS_IMAGE_PROFILE = 'gemini-interactions-image-v1' as const;
export const GEMINI_INTERACTIONS_PROFILE = GEMINI_INTERACTIONS_IMAGE_PROFILE;
// Google's stable Interactions API examples use /v1/interactions. The
// GenerateContent profile intentionally keeps its separate /v1beta default.
export const GEMINI_INTERACTIONS_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1' as const;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_INLINE_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RETRY_AFTER_MS = 86_400_000;

interface InteractionTextInput {
  type: 'text';
  text: string;
}

interface InteractionImageInput {
  type: 'image';
  mime_type: string;
  data: string;
}

type InteractionInput = InteractionTextInput | InteractionImageInput;

export interface GeminiInteractionsResponseFormat {
  type: 'image';
  mime_type?: string;
  aspect_ratio?: string;
  image_size?: string;
}

export interface GeminiInteractionsPayload {
  model: string;
  input: string | readonly InteractionInput[];
  response_format: GeminiInteractionsResponseFormat;
  previous_interaction_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextWithInteractionsFields(context: ProviderContext): GeminiProviderContext {
  return context as GeminiProviderContext;
}

function canonicalMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function contextApiKey(context: GeminiProviderContext): string {
  const key = context.secrets.apiKey?.trim();
  if (!key) throw new GeminiValidationError('Gemini API key is required.', 'gemini_api_key_missing');
  if (/[\r\n]/u.test(key)) throw new GeminiValidationError('Gemini API key is invalid.', 'gemini_header_invalid');
  return key;
}

function configuredBaseUrl(context: GeminiProviderContext, fallback: string | undefined): string {
  return (
    context.baseUrl?.trim() ||
    (typeof context.config?.baseUrl === 'string' ? context.config.baseUrl.trim() : '') ||
    fallback?.trim() ||
    GEMINI_INTERACTIONS_DEFAULT_BASE_URL
  );
}

function interactionsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GeminiValidationError('Gemini base URL is invalid.', 'gemini_base_url_invalid');
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new GeminiValidationError('Gemini base URL must use HTTP or HTTPS without credentials, query, or fragment.', 'gemini_base_url_invalid');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  url.pathname = path.endsWith('/interactions') ? path : `${path}/interactions`;
  return url.toString();
}

function modelsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GeminiValidationError('Gemini base URL is invalid.', 'gemini_base_url_invalid');
  }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new GeminiValidationError(
      'Gemini base URL must use HTTP or HTTPS without credentials, query, or fragment.',
      'gemini_base_url_invalid',
    );
  }
  let path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith('/interactions')) path = path.slice(0, -'/interactions'.length).replace(/\/+$/u, '');
  url.pathname = path.endsWith('/models') ? path : `${path}/models`;
  return url.toString();
}

function resolveTransport(
  context: GeminiProviderContext,
  configured: GeminiHttpTransport | GeminiHttpRequestExecutor | undefined,
): GeminiHttpTransport | GeminiHttpRequestExecutor {
  const transport = configured ?? context.http ?? context.transport;
  if (!transport) throw new GeminiTransportError('Gemini requires an injected safe HTTP transport.');
  return transport;
}

function secretHeaders(context: GeminiProviderContext): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(context.secrets)
      .filter(([name]) => name.startsWith('header:'))
      .map(([name, value]) => [name.slice('header:'.length), value]),
  );
}

function buildRequestHeaders(
  context: GeminiProviderContext,
  apiKey: string,
  configured: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return mergeGeminiHeaders(
    apiKey,
    [configured, context.headers, context.config?.headers as Readonly<Record<string, unknown>> | undefined],
    secretHeaders(context),
  );
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new GeminiValidationError(`Gemini ${label} field '${key}' is unsupported.`, 'gemini_payload_invalid');
  }
}

function modelProfile(modelId: string): GeminiModelProfile {
  return getGeminiModelProfile(modelId);
}

function previousInteractionId(request: GenerationRequest): string | undefined {
  const extra = request.extra ?? {};
  if (!isRecord(extra)) throw new GeminiValidationError('Gemini extra must be an object.', 'gemini_extra_fields_unsupported');
  for (const key of Object.keys(extra)) {
    if (key !== 'previous_interaction_id') {
      throw new GeminiValidationError(`Gemini does not support extra.${key}.`, 'gemini_extra_fields_unsupported');
    }
  }
  const value = extra.previous_interaction_id;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GeminiValidationError('previous_interaction_id must be a non-empty string.', 'gemini_extra_fields_unsupported');
  }
  return value.trim();
}

function validateRequest(request: GenerationRequest, context: GeminiProviderContext): {
  profile: GeminiModelProfile;
  previousId?: string;
  outputMimeType?: string;
} {
  if (request.providerId !== context.providerId) {
    throw new GeminiValidationError('Gemini request provider does not match the active provider.', 'gemini_provider_mismatch');
  }
  if (request.prompt.trim() === '') throw new GeminiValidationError('Gemini prompts cannot be empty.', 'gemini_prompt_empty');
  if (!['image.generate', 'image.edit'].includes(request.operation)) {
    throw new GeminiValidationError(`Gemini Interactions does not support ${request.operation}.`, 'gemini_operation_unsupported');
  }
  const profile = modelProfile(request.modelId);
  const previousId = previousInteractionId(request);
  const count = (role: GenerationRequest['inputs'][number]['role']) => request.inputs.filter((input) => input.role === role).length;
  if (count('reference') > profile.maxReferenceImages) {
    throw new GeminiValidationError(`Gemini model '${profile.id}' accepts at most ${profile.maxReferenceImages} reference images.`, 'gemini_reference_limit_exceeded');
  }
  if (request.operation === 'image.generate') {
    if (request.inputs.some((input) => input.role !== 'reference')) {
      throw new GeminiValidationError('Gemini image.generate accepts reference images only.', 'gemini_input_role_unsupported');
    }
  } else if (previousId !== undefined) {
    if (request.inputs.length > 0) {
      throw new GeminiValidationError('A previous interaction cannot be combined with new image inputs.', 'gemini_edit_inputs_invalid');
    }
  } else if (count('source') !== 1 || count('mask') > 0 || count('first_frame') > 0 || count('last_frame') > 0) {
    throw new GeminiValidationError('Gemini image.edit requires one source image and no mask/video frame roles.', 'gemini_edit_inputs_invalid');
  }
  if (request.aspectRatio !== undefined && !profile.aspectRatios.includes(request.aspectRatio)) {
    throw new GeminiValidationError(`Gemini aspect ratio '${request.aspectRatio}' is unsupported.`, 'gemini_aspect_ratio_unsupported');
  }
  if (request.resolution !== undefined && !profile.resolutions.includes(request.resolution)) {
    throw new GeminiValidationError(`Gemini resolution '${request.resolution}' is unsupported.`, 'gemini_resolution_unsupported');
  }
  if (request.count !== undefined && request.count !== 1) {
    throw new GeminiValidationError('Gemini Interactions returns one image per request.', 'gemini_batch_unsupported');
  }
  const unsupported: ReadonlyArray<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt],
    ['width', request.width],
    ['height', request.height],
    ['quality', request.quality],
    ['seed', request.seed],
    ['durationSeconds', request.durationSeconds],
    ['fps', request.fps],
    ['audio', request.audio],
  ];
  const unsupportedOption = unsupported.find(([, value]) => value !== undefined);
  if (unsupportedOption) throw new GeminiValidationError(`Gemini Interactions does not support ${unsupportedOption[0]}.`, 'gemini_option_unsupported');
  let outputMimeType: string | undefined;
  if (request.format !== undefined) {
    const format = request.format.toLowerCase();
    outputMimeType = format.startsWith('image/') ? canonicalMimeType(format) : `image/${format}`;
    if (!IMAGE_MIME_TYPES.has(outputMimeType)) {
      throw new GeminiValidationError('Gemini Interactions format must be png, jpeg, or webp.', 'gemini_format_unsupported');
    }
  }
  return { profile, ...(previousId === undefined ? {} : { previousId }), ...(outputMimeType === undefined ? {} : { outputMimeType }) };
}

function resolvedInputs(request: GenerationRequest, context: GeminiProviderContext): readonly ProviderInput[] {
  const available = context.inputs ?? [];
  const result: ProviderInput[] = [];
  const seen = new Set<string>();
  for (const requested of request.inputs) {
    if (seen.has(requested.assetId)) throw new GeminiValidationError(`Gemini input '${requested.assetId}' is duplicated.`, 'gemini_input_duplicate');
    seen.add(requested.assetId);
    const input = available.find((candidate) => candidate.assetId === requested.assetId);
    if (!input) throw new GeminiValidationError(`Gemini input '${requested.assetId}' is unresolved.`, 'gemini_input_unresolved');
    if (input.role !== requested.role) throw new GeminiValidationError(`Gemini input '${requested.assetId}' has a mismatched role.`, 'gemini_input_role_mismatch');
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new GeminiValidationError(`Gemini input '${requested.assetId}' has no bytes.`, 'gemini_input_bytes_invalid');
    const mimeType = canonicalMimeType(input.mimeType);
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new GeminiValidationError(`Gemini input '${requested.assetId}' has an unsupported MIME type.`, 'gemini_input_mime_unsupported');
    if (input.bytes.byteLength > MAX_INLINE_INPUT_BYTES) throw new GeminiValidationError(`Gemini input '${requested.assetId}' is too large.`, 'gemini_input_too_large');
    result.push({ ...input, mimeType });
  }
  return result;
}

function buildPayload(request: GenerationRequest, context: GeminiProviderContext): GeminiInteractionsPayload {
  const validation = validateRequest(request, context);
  const inputs = resolvedInputs(request, context);
  const content: InteractionInput[] = [
    { type: 'text', text: request.prompt.trim() },
    ...inputs.map((input) => ({
      type: 'image' as const,
      mime_type: input.mimeType,
      data: Buffer.from(input.bytes).toString('base64'),
    })),
  ];
  const responseFormat: GeminiInteractionsResponseFormat = {
    type: 'image',
    ...(validation.outputMimeType === undefined ? {} : { mime_type: validation.outputMimeType }),
    ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }),
    ...(request.resolution === undefined ? {} : { image_size: request.resolution }),
  };
  const payload: GeminiInteractionsPayload = {
    model: validation.profile.id,
    input: inputs.length === 0 ? request.prompt.trim() : content,
    response_format: responseFormat,
    ...(validation.previousId === undefined ? {} : { previous_interaction_id: validation.previousId }),
  };
  assertInteractionsPayload(payload);
  return payload;
}

export function assertInteractionsPayload(value: unknown): asserts value is GeminiInteractionsPayload {
  if (!isRecord(value)) throw new GeminiValidationError('Gemini Interactions payload must be an object.', 'gemini_payload_invalid');
  assertExactKeys(value, ['model', 'input', 'response_format', 'previous_interaction_id'], 'Interactions payload');
  if (typeof value.model !== 'string' || value.model.trim() === '') throw new GeminiValidationError('Gemini Interactions model is required.', 'gemini_payload_invalid');
  if (typeof value.input !== 'string' && !Array.isArray(value.input)) throw new GeminiValidationError('Gemini Interactions input is invalid.', 'gemini_payload_invalid');
  if (Array.isArray(value.input)) {
    if (value.input.length === 0) throw new GeminiValidationError('Gemini Interactions input cannot be empty.', 'gemini_payload_invalid');
    for (const part of value.input) {
      if (!isRecord(part)) throw new GeminiValidationError('Gemini Interactions input part is invalid.', 'gemini_payload_invalid');
      assertExactKeys(part, ['type', 'text', 'mime_type', 'data'], 'Interactions input part');
      if (part.type === 'text') {
        if (Object.keys(part).some((key) => key !== 'type' && key !== 'text') || typeof part.text !== 'string' || part.text.length === 0) {
          throw new GeminiValidationError('Gemini Interactions text input is invalid.', 'gemini_payload_invalid');
        }
      }
      if (part.type === 'image') {
        if (Object.keys(part).some((key) => key !== 'type' && key !== 'mime_type' && key !== 'data') || typeof part.mime_type !== 'string' || !IMAGE_MIME_TYPES.has(canonicalMimeType(part.mime_type)) || typeof part.data !== 'string' || !validBase64(part.data) || Buffer.byteLength(part.data, 'base64') > MAX_INLINE_INPUT_BYTES) {
          throw new GeminiValidationError('Gemini Interactions image input is invalid.', 'gemini_payload_invalid');
        }
      }
      if (part.type !== 'text' && part.type !== 'image') throw new GeminiValidationError('Gemini Interactions input type is unsupported.', 'gemini_payload_invalid');
    }
  }
  if (!isRecord(value.response_format)) throw new GeminiValidationError('Gemini Interactions response_format is invalid.', 'gemini_payload_invalid');
  assertExactKeys(value.response_format, ['type', 'mime_type', 'aspect_ratio', 'image_size'], 'Interactions response_format');
  if (value.response_format.type !== 'image') throw new GeminiValidationError('Gemini Interactions response_format.type must be image.', 'gemini_payload_invalid');
  if (value.response_format.mime_type !== undefined && (typeof value.response_format.mime_type !== 'string' || !IMAGE_MIME_TYPES.has(canonicalMimeType(value.response_format.mime_type)))) throw new GeminiValidationError('Gemini Interactions response MIME type is invalid.', 'gemini_payload_invalid');
  if (value.response_format.aspect_ratio !== undefined && (typeof value.response_format.aspect_ratio !== 'string' || !GEMINI_IMAGE_ASPECT_RATIOS.includes(value.response_format.aspect_ratio as (typeof GEMINI_IMAGE_ASPECT_RATIOS)[number]))) throw new GeminiValidationError('Gemini Interactions aspect ratio is invalid.', 'gemini_payload_invalid');
  if (value.response_format.image_size !== undefined && (typeof value.response_format.image_size !== 'string' || !GEMINI_IMAGE_SIZES.includes(value.response_format.image_size as (typeof GEMINI_IMAGE_SIZES)[number]))) throw new GeminiValidationError('Gemini Interactions image size is invalid.', 'gemini_payload_invalid');
  if (value.previous_interaction_id !== undefined && (typeof value.previous_interaction_id !== 'string' || value.previous_interaction_id.length === 0)) throw new GeminiValidationError('Gemini previous_interaction_id is invalid.', 'gemini_payload_invalid');
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '');
}

function resourceUrl(value: string): string {
  if (value.length > GEMINI_MAX_RESPONSE_STRING_LENGTH) {
    throw new GeminiResponseError('Gemini Interactions image URI is too long.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GeminiResponseError('Gemini Interactions returned an invalid image URI.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new GeminiResponseError('Gemini Interactions image URI is unsafe.');
  for (const key of [...url.searchParams.keys()]) {
    if (['key', 'api_key', 'access_token', 'token', 'secret', 'x-goog-api-key'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  const normalized = url.toString();
  if (normalized.length > GEMINI_MAX_RESPONSE_STRING_LENGTH) {
    throw new GeminiResponseError('Gemini Interactions image URI is too long.');
  }
  return normalized;
}

function outputMime(value: Record<string, unknown>): string {
  const raw = value.mime_type ?? value.mimeType;
  if (typeof raw === 'string' && IMAGE_MIME_TYPES.has(canonicalMimeType(raw))) return canonicalMimeType(raw);
  const format = value.output_format;
  if (typeof format === 'string' && IMAGE_MIME_TYPES.has(`image/${format.toLowerCase()}`)) return `image/${format.toLowerCase()}`;
  return 'image/png';
}

function imageAsset(value: unknown, resultId?: string): SubmittedAsset | null {
  if (!isRecord(value)) return null;
  const rawData = value.data ?? value.base64 ?? value.result;
  const file = isRecord(value.fileData) ? value.fileData : isRecord(value.file_data) ? value.file_data : undefined;
  const rawUri = value.uri ?? value.url ?? value.file_uri ?? value.fileUri ?? file?.uri ?? file?.file_uri ?? file?.fileUri;
  if (typeof rawUri === 'string' && /^https?:\/\//iu.test(rawUri)) {
    return { type: 'image', mimeType: outputMime(value), source: 'url', url: resourceUrl(rawUri), ...(resultId === undefined ? {} : { resultId }) };
  }
  if (typeof rawData !== 'string') return null;
  if (/^https?:\/\//iu.test(rawData)) return { type: 'image', mimeType: outputMime(value), source: 'url', url: resourceUrl(rawData), ...(resultId === undefined ? {} : { resultId }) };
  const dataUrl = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/iu.exec(rawData);
  const base64 = dataUrl?.[2] ?? rawData;
  const mimeType = dataUrl?.[1] === undefined ? outputMime(value) : canonicalMimeType(dataUrl[1]);
  if (!IMAGE_MIME_TYPES.has(mimeType) || !validBase64(base64) || Buffer.byteLength(base64, 'base64') > MAX_INLINE_OUTPUT_BYTES) return null;
  return { type: 'image', mimeType, source: 'base64', base64, ...(resultId === undefined ? {} : { resultId }) };
}

export interface GeminiInteractionsResponseOptions {
  readonly maxAssets?: number;
}

function boundedResultId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length > GEMINI_MAX_RESULT_ID_LENGTH) {
    throw new GeminiResponseError('Gemini Interactions result id is too long.', 'gemini_output_metadata_invalid');
  }
  return value;
}

export function normalizeGeminiInteractionsImageResponse(
  value: unknown,
  options: GeminiInteractionsResponseOptions = {},
): readonly SubmittedAsset[] {
  const maxAssets = options.maxAssets ?? GEMINI_MAX_OUTPUT_ASSETS;
  if (!Number.isSafeInteger(maxAssets) || maxAssets < 1) {
    throw new GeminiResponseError('Gemini Interactions output asset limit is invalid.');
  }
  if (!isRecord(value)) throw new GeminiResponseError('Gemini Interactions response must be an object.');
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (status === 'failed' || status === 'error') {
    const error = isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error.message
      : 'Gemini Interactions image generation failed.';
    throw new GeminiResponseError(
      redactSensitiveText(error).slice(0, GEMINI_MAX_RESPONSE_STRING_LENGTH),
      'gemini_interaction_failed',
    );
  }
  const candidates: unknown[] = [];
  if (value.output_image !== undefined) candidates.push(value.output_image);
  if (Array.isArray(value.output)) candidates.push(...value.output);
  if (Array.isArray(value.steps)) {
    for (const step of value.steps) {
      if (!isRecord(step)) continue;
      if (Array.isArray(step.content)) candidates.push(...step.content);
      if (step.output_image !== undefined) candidates.push(step.output_image);
    }
  }
  const resultId = boundedResultId(value.id);
  const assets: SubmittedAsset[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const asset = imageAsset(candidate, resultId);
    if (!asset) continue;
    const key = asset.source === 'base64' ? `b64:${asset.base64}` : `url:${asset.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (assets.length >= maxAssets) {
      throw new GeminiResponseError(
        'Gemini Interactions response contained more images than requested.',
        'gemini_output_limit_exceeded',
      );
    }
    assets.push(asset);
  }
  if (assets.length === 0) throw new GeminiResponseError('Gemini Interactions response did not contain an image.');
  return assets;
}

function headerValue(response: GeminiHttpResponse, name: string): string | undefined {
  const headers = response.headers;
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return typeof found === 'string' ? found : found?.[0];
}

function retryAfterMs(response: GeminiHttpResponse): number | undefined {
  const value = headerValue(response, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

async function responseBody(response: GeminiHttpResponse): Promise<unknown> {
  try {
    if (typeof response.json === 'function') {
      try {
        return await response.json();
      } catch {
        // Empty and plain-text error responses are still classified by HTTP status.
      }
    }
    if (response.json !== undefined && typeof response.json !== 'function') return response.json;
    let text: string | undefined;
    if (typeof response.text === 'function') {
      try {
        text = await response.text();
      } catch {
        text = undefined;
      }
    } else {
      text = response.text;
    }
    if (typeof text === 'string') {
      if (text.trim() === '') return undefined;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (typeof response.body === 'string') {
      if (response.body.trim() === '') return undefined;
      try {
        return JSON.parse(response.body);
      } catch {
        return response.body;
      }
    }
    if (response.body instanceof Uint8Array) {
      const value = Buffer.from(response.body).toString('utf8');
      if (value.trim() === '') return undefined;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return response.body;
  } finally {
    await response.dispose?.();
  }
}

function errorMessage(value: unknown, statusCode: number): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message.slice(0, GEMINI_MAX_RESPONSE_STRING_LENGTH);
  }
  if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, GEMINI_MAX_RESPONSE_STRING_LENGTH);
  return `Gemini Interactions request failed with HTTP ${statusCode}.`;
}

export class GeminiInteractionsImageProvider implements ProviderAdapter {
  public readonly type = GEMINI_INTERACTIONS_IMAGE_PROFILE;
  private readonly http: GeminiHttpTransport | GeminiHttpRequestExecutor | undefined;
  private readonly baseUrl: string | undefined;
  private readonly headers: Readonly<Record<string, string>> | undefined;

  public constructor(options: GeminiProviderOptions = {}) {
    this.http = options.http ?? options.transport;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return staticGeminiCapabilities(this.type, true);
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtime = contextWithInteractionsFields(context);
    const apiKey = contextApiKey(runtime);
    const transport = resolveTransport(runtime, this.http);
    const body = await this.requestModels(runtime, apiKey, transport);
    return liveGeminiCapabilities(this.type, body, true);
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const runtime = contextWithInteractionsFields(context);
    const apiKey = contextApiKey(runtime);
    const transport = resolveTransport(runtime, this.http);
    const request: GeminiHttpRequest = {
      method: 'GET',
      url: modelsUrl(configuredBaseUrl(runtime, this.baseUrl)),
      headers: buildRequestHeaders(runtime, apiKey, this.headers),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    };
    runtime.signal?.throwIfAborted();
    let response: GeminiHttpResponse;
    try {
      response = typeof transport === 'function' ? await transport(request) : await transport.request(request);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini Interactions connection request failed.');
    }
    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini Interactions response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await responseBody(response);
      throw new GeminiHttpError(
        redactSensitiveText(errorMessage(body, statusCode), runtime.secrets),
        statusCode,
        undefined,
        retryAfterMs(response),
      );
    }
    await response.dispose?.();
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const runtime = contextWithInteractionsFields(context);
    contextApiKey(runtime);
    buildPayload(request, runtime);
    interactionsUrl(configuredBaseUrl(runtime, this.baseUrl));
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtime = contextWithInteractionsFields(context);
    const payload = buildPayload(request, runtime);
    const apiKey = contextApiKey(runtime);
    const transport = resolveTransport(runtime, this.http);
    const requestData: GeminiHttpRequest = {
      method: 'POST',
      url: interactionsUrl(configuredBaseUrl(runtime, this.baseUrl)),
      headers: buildRequestHeaders(runtime, apiKey, this.headers),
      body: JSON.stringify(payload),
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    };
    runtime.signal?.throwIfAborted();
    let response: GeminiHttpResponse;
    try {
      response = typeof transport === 'function' ? await transport(requestData) : await transport.request(requestData);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini Interactions HTTP request failed.', { cause: error });
    }
    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini Interactions response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await responseBody(response);
      throw new GeminiHttpError(redactSensitiveText(errorMessage(body, statusCode), runtime.secrets), statusCode, undefined, retryAfterMs(response));
    }
    const body = await responseBody(response);
    if (body === undefined) throw new GeminiResponseError('Gemini Interactions response body is empty.');
    return {
      state: 'completed',
      assets: normalizeGeminiInteractionsImageResponse(body, { maxAssets: GEMINI_MAX_OUTPUT_ASSETS }),
    };
  }

  private async requestModels(
    context: GeminiProviderContext,
    apiKey: string,
    transport: GeminiHttpTransport | GeminiHttpRequestExecutor,
  ): Promise<unknown> {
    const request: GeminiHttpRequest = {
      method: 'GET',
      url: modelsUrl(configuredBaseUrl(context, this.baseUrl)),
      headers: buildRequestHeaders(context, apiKey, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    context.signal?.throwIfAborted();
    let response: GeminiHttpResponse;
    try {
      response = typeof transport === 'function' ? await transport(request) : await transport.request(request);
    } catch (error) {
      if (error instanceof GeminiValidationError || error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError('Gemini Interactions model catalog request failed.');
    }
    const statusCode = response.statusCode ?? response.status;
    if (statusCode === undefined) {
      await response.dispose?.();
      throw new GeminiResponseError('Gemini Interactions response did not include a status code.');
    }
    if (statusCode < 200 || statusCode >= 300) {
      const body = await responseBody(response);
      throw new GeminiHttpError(
        redactSensitiveText(errorMessage(body, statusCode), context.secrets),
        statusCode,
        undefined,
        retryAfterMs(response),
      );
    }
    const body = await responseBody(response);
    if (body === undefined) throw new GeminiResponseError('Gemini Interactions models response body is empty.');
    return body;
  }

  public async poll(_remoteJobId: string, _context: ProviderContext): Promise<never> {
    throw new GeminiValidationError('Gemini Interactions image generation is synchronous and does not support polling.', 'gemini_poll_unsupported');
  }

  public normalizeError(error: unknown): ProviderError {
    if (error instanceof GeminiValidationError) return { code: error.code, kind: 'rejected', message: redactSensitiveText(error.message), retryable: false };
    if (error instanceof GeminiHttpError) {
      const retryable = error.statusCode === 408 || error.statusCode === 425 || error.statusCode === 429 || error.statusCode >= 500;
      const code = error.statusCode === 429
        ? 'gemini_rate_limited'
        : error.statusCode === 401 || error.statusCode === 403
          ? 'gemini_authentication_error'
          : normalizeProviderCode(error.providerCode)
            ? `gemini_${normalizeProviderCode(error.providerCode)}`
            : `gemini_http_${error.statusCode}`;
      return { code, kind: retryable ? 'transient' : 'rejected', message: redactSensitiveText(error.message), retryable, statusCode: error.statusCode, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) };
    }
    if (error instanceof GeminiResponseError) return { code: error.code, kind: error.code === 'gemini_content_blocked' || error.code === 'gemini_interaction_failed' ? 'rejected' : 'unknown', message: redactSensitiveText(error.message), retryable: false };
    if (error instanceof GeminiTransportError) {
      if (error.cause instanceof Error && (error.cause.name === 'AbortError' || error.cause.name === 'CanceledError')) return { code: 'gemini_request_aborted', kind: 'transient', message: 'The Gemini request was aborted.', retryable: false };
      return { code: 'gemini_transport_error', kind: 'transient', message: redactSensitiveText(error.message), retryable: true };
    }
    return { code: 'gemini_network_error', kind: 'transient', message: redactSensitiveText(error instanceof Error ? error.message : 'Gemini Interactions request failed.'), retryable: true };
  }
}

export {
  GeminiInteractionsImageProvider as GeminiInteractionsImageAdapter,
  GeminiInteractionsImageProvider as GeminiInteractionsProvider,
};
export default GeminiInteractionsImageProvider;
