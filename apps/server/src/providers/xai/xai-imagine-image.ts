import type { GenerationRequest } from '@imagine/shared';
import { publicInputUrl } from '../public-input-url.js';
import { parseOpenAiImageStream } from '../openai/stream.js';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderErrorKind,
  ProviderInput,
  ProviderModel,
  SubmitResult,
  SubmittedAsset,
} from '@imagine/provider-contract';

export const XAI_IMAGINE_IMAGE_PROFILE = 'xai-imagine-image-v1' as const;
export const XAI_PROVIDER_TYPE = 'xai' as const;
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1' as const;

const XAI_IMAGE_MODEL = 'grok-imagine-image';
const XAI_IMAGE_MODEL_ALIAS = 'xai-imagine-image-v1';
const XAI_IMAGE_2_MODEL = 'grok-imagine-image-2.0';
const XAI_IMAGE_QUALITY_MODEL = 'grok-imagine-image-quality';
const XAI_IMAGE_MODEL_IDS = new Set([
  XAI_IMAGE_MODEL,
  XAI_IMAGE_MODEL_ALIAS,
  XAI_IMAGE_2_MODEL,
  XAI_IMAGE_QUALITY_MODEL,
]);
const XAI_IMAGE_MODEL_PATTERN = /^grok-[a-z0-9.-]*image[a-z0-9.-]*$/iu;

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ASPECT_RATIOS = [
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '1:2',
  '2:1',
  '21:9',
  '5:2',
  'auto',
] as const;
const RESOLUTIONS = ['1k', '2k'] as const;
const QUALITIES = ['low', 'medium'] as const;
const RESPONSE_FORMATS = ['url', 'b64_json'] as const;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 96 * 1024 * 1024;
const MAX_OUTPUT_IMAGES = 10;
const MAX_OUTPUT_URL_CHARS = 4_096;
const MAX_RESULT_ID_CHARS = 256;
const MAX_REVISED_PROMPT_CHARS = 32_000;
const MAX_MIME_TYPE_CHARS = 128;
const RESERVED_HEADER_NAMES = new Set([
  'accept',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'host',
  'idempotency-key',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
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

/**
 * The server's ProviderContext is intentionally small in the PR 0 contract.
 * This local extension is the hand-off shape for the PR 4 integration: input
 * bytes are resolved by the server, while this adapter only serializes them.
 */
export interface XaiImagineImageInput extends ProviderInput {
  readonly dataUri?: string;
}

export interface XaiImagineProviderContext extends ProviderContext {
  readonly baseUrl?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly inputs?: readonly XaiImagineImageInput[];
  readonly transport?: XaiImagineHttpClient | XaiImagineHttpRequestExecutor;
}

export interface XaiImagineHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface XaiImagineHttpHeaders {
  get(name: string): string | null;
}

export interface XaiImagineHttpResponse {
  readonly status?: number;
  readonly statusCode?: number;
  readonly headers?:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | XaiImagineHttpHeaders;
  /** A JSON object or bounded encoded body. Readable streams are not supported. */
  readonly body?: JsonRecord | string | Uint8Array;
  readonly json?: unknown | Promise<unknown> | (() => Promise<unknown>);
  readonly text?: string | Promise<string> | (() => Promise<string>);
  readonly dispose?: () => Promise<void> | void;
}

export interface XaiImagineHttpClient {
  request(request: XaiImagineHttpRequest): Promise<XaiImagineHttpResponse>;
}

export type XaiImagineHttpTransport = XaiImagineHttpClient;

export type XaiImagineHttpRequestExecutor = (
  request: XaiImagineHttpRequest,
) => Promise<XaiImagineHttpResponse>;

export interface XaiImagineImageProviderOptions {
  readonly http?: XaiImagineHttpClient | XaiImagineHttpRequestExecutor;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly transport?: XaiImagineHttpClient | XaiImagineHttpRequestExecutor;
}

export type XaiHttpRequest = XaiImagineHttpRequest;
export type XaiHttpResponse = XaiImagineHttpResponse;
export type XaiHttpTransport = XaiImagineHttpTransport;
export type XaiProviderContext = XaiImagineProviderContext;
export type XaiProviderOptions = XaiImagineImageProviderOptions;

export class XaiImagineValidationError extends Error {
  public override readonly name = 'XaiImagineValidationError';
  public readonly providerError: ProviderError;

  public constructor(code: string, message: string) {
    super(message);
    this.providerError = {
      code,
      kind: 'rejected',
      message,
      retryable: false,
    };
  }
}

export class XaiImagineHttpError extends Error {
  public override readonly name = 'XaiImagineHttpError';
  public readonly responseBody: string | undefined;

  public constructor(
    public readonly statusCode: number,
    responseBody?: unknown,
    public readonly responseHeaders?:
      | Readonly<Record<string, string | readonly string[] | undefined>>
      | XaiImagineHttpHeaders,
    secrets?: Readonly<Record<string, string>>,
  ) {
    super(`xAI Imagine returned HTTP ${statusCode}.`);
    this.responseBody = errorMessageFromBody(responseBody, secrets);
  }
}

export class XaiImagineTransportError extends Error {
  public override readonly name = 'XaiImagineTransportError';

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class XaiImagineResponseError extends Error {
  public override readonly name = 'XaiImagineResponseError';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedOptionalString(
  record: JsonRecord,
  key: string,
  maxChars: number,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new XaiImagineResponseError(`xAI Imagine returned a non-string ${key}.`);
  }
  if (value.length > maxChars) {
    throw new XaiImagineResponseError(`xAI Imagine returned an oversized ${key}.`);
  }
  return value.length === 0 ? undefined : value;
}

function canonicalModelId(modelId: string): string {
  return modelId === XAI_IMAGE_MODEL_ALIAS ? XAI_IMAGE_MODEL : modelId;
}

function isSupportedModel(modelId: string): boolean {
  return XAI_IMAGE_MODEL_IDS.has(modelId) || XAI_IMAGE_MODEL_PATTERN.test(modelId);
}

function isKnownImageModel(modelId: string): boolean {
  return XAI_IMAGE_MODEL_IDS.has(modelId) || XAI_IMAGE_MODEL_IDS.has(canonicalModelId(modelId));
}

function isImageMimeType(value: string): boolean {
  return IMAGE_MIME_TYPES.has(value.toLowerCase() === 'image/jpg' ? 'image/jpeg' : value.toLowerCase());
}

function normalizeImageMimeType(value: string): string {
  const normalized = value.toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function safeHeaderValue(value: string, label: string): string {
  if (/[\r\n]/.test(value)) {
    throw new XaiImagineValidationError('xai_invalid_header', `${label} contains an invalid newline.`);
  }
  return value;
}

function safeHeaderName(name: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
    throw new XaiImagineValidationError('xai_invalid_header', `Header ${name || '(empty)'} is invalid.`);
  }
  return name;
}

function safeUrl(rawUrl: string, label: string): string {
  if (rawUrl.length > MAX_OUTPUT_URL_CHARS) {
    throw new XaiImagineValidationError('xai_invalid_image_url', `${label} exceeds the URL length limit.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new XaiImagineValidationError('xai_invalid_image_url', `${label} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new XaiImagineValidationError('xai_invalid_image_url', `${label} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new XaiImagineValidationError('xai_invalid_image_url', `${label} cannot contain credentials.`);
  }
  for (const [name] of parsed.searchParams) {
    const normalized = name.trim().toLowerCase();
    if (
      CREDENTIAL_QUERY_NAMES.has(normalized) ||
      normalized.startsWith('x-amz-') ||
      normalized.startsWith('x-goog-') ||
      normalized.startsWith('x-ms-') ||
      normalized.startsWith('oauth_')
    ) {
      throw new XaiImagineValidationError('xai_invalid_image_url', `${label} contains credential-like query data.`);
    }
  }
  return parsed.toString();
}

function imageDataUri(mimeType: string, bytes: Uint8Array): string {
  if (!isImageMimeType(mimeType)) {
    throw new XaiImagineValidationError(
      'xai_unsupported_input_type',
      `xAI Imagine does not accept ${mimeType || '(empty)'} image inputs.`,
    );
  }
  if (bytes.byteLength === 0) {
    throw new XaiImagineValidationError('xai_empty_input', 'xAI Imagine image inputs cannot be empty.');
  }
  return `data:${mimeType.toLowerCase()};base64,${Buffer.from(bytes).toString('base64')}`;
}

function dataUriParts(raw: string): { base64: string; mimeType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(raw);
  if (match === null || !match[1] || !match[2] || !isImageMimeType(match[1])) return null;
  const base64 = match[2].replace(/\s/g, '');
  if (!validBase64(base64)) return null;
  return { base64, mimeType: normalizeImageMimeType(match[1]) };
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength > 0 && bytes.toString('base64') === value;
}

function resolveInputSource(input: XaiImagineImageInput): { mimeType: string; url: string } {
  if (Object.prototype.hasOwnProperty.call(input, 'url')) {
    throw new XaiImagineValidationError(
      'xai_input_url_unsupported',
      `Image input ${input.assetId} must be supplied as loader bytes or a data URI, not a URL.`,
    );
  }
  if (input.dataUri !== undefined) {
    const parts = dataUriParts(input.dataUri);
    if (parts === null) {
      throw new XaiImagineValidationError(
        'xai_invalid_image_data',
        `Image input ${input.assetId} is not a valid image data URI.`,
      );
    }
    return { mimeType: parts.mimeType, url: input.dataUri };
  }
  if (input.bytes !== undefined) {
    const mimeType = normalizeImageMimeType(input.mimeType?.toLowerCase() ?? 'image/png');
    const publicUrl = publicInputUrl(input);
    if (publicUrl) return { mimeType, url: publicUrl };
    return { mimeType, url: imageDataUri(mimeType, input.bytes) };
  }
  throw new XaiImagineValidationError(
    'xai_input_missing',
    `Image input ${input.assetId} has no resolved bytes, data URI, or URL.`,
  );
}

function requestInput(
  requestInput: GenerationRequest['inputs'][number],
  contextInputs: readonly XaiImagineImageInput[] | undefined,
): XaiImagineImageInput {
  const found = contextInputs?.find((candidate) => candidate.assetId === requestInput.assetId);
  if (found !== undefined) {
    if (found.role !== requestInput.role) {
      throw new XaiImagineValidationError(
        'xai_input_role_mismatch',
        `Image input ${requestInput.assetId} has a mismatched role.`,
      );
    }
    return found;
  }
  throw new XaiImagineValidationError(
    'xai_input_missing',
    `Image input ${requestInput.assetId} was not resolved by the server.`,
  );
}

function ratioIsValid(value: string): boolean {
  return (ASPECT_RATIOS as readonly string[]).includes(value);
}

function responseFormat(value: string | undefined): (typeof RESPONSE_FORMATS)[number] | undefined {
  if (value === undefined) return undefined;
  if (value === 'base64' || value === 'base64_json') return 'b64_json';
  if ((RESPONSE_FORMATS as readonly string[]).includes(value)) {
    return value as (typeof RESPONSE_FORMATS)[number];
  }
  throw new XaiImagineValidationError(
    'xai_invalid_format',
    'xAI Imagine format must be url or b64_json.',
  );
}

function validateCommonRequest(request: GenerationRequest, context: ProviderContext): void {
  if (request.providerId !== context.providerId) {
    throw new XaiImagineValidationError(
      'xai_provider_mismatch',
      'The generation request provider does not match the active xAI provider.',
    );
  }
  if (!isSupportedModel(request.modelId)) {
    throw new XaiImagineValidationError(
      'xai_model_unsupported',
      `xAI Imagine model ${request.modelId} is not supported by this profile.`,
    );
  }
  if (request.prompt.trim().length === 0) {
    throw new XaiImagineValidationError('xai_prompt_empty', 'xAI Imagine prompts cannot be empty.');
  }
  const canonicalModel = canonicalModelId(request.modelId);
  const conservativeModel = !isKnownImageModel(canonicalModel);
  if (
    request.aspectRatio !== undefined &&
    (!ratioIsValid(request.aspectRatio) || (conservativeModel && request.aspectRatio !== '1:1'))
  ) {
    throw new XaiImagineValidationError(
      'xai_aspect_ratio_unsupported',
      `xAI Imagine does not support aspect ratio ${request.aspectRatio}.`,
    );
  }
  if (
    request.resolution !== undefined &&
    (!(RESOLUTIONS as readonly string[]).includes(request.resolution) ||
      (conservativeModel && request.resolution !== '1k'))
  ) {
    throw new XaiImagineValidationError(
      'xai_resolution_unsupported',
      'xAI Imagine resolution must be 1k or 2k.',
    );
  }
  if (request.quality !== undefined) {
    if (!(QUALITIES as readonly string[]).includes(request.quality)) {
      throw new XaiImagineValidationError(
        'xai_quality_unsupported',
        'xAI Imagine quality must be low or medium.',
      );
    }
    if (canonicalModelId(request.modelId) !== XAI_IMAGE_2_MODEL) {
      throw new XaiImagineValidationError(
        'xai_quality_model_unsupported',
        'xAI Imagine quality is only supported by grok-imagine-image-2.0.',
      );
    }
  }
  const maxCount = conservativeModel || canonicalModel === XAI_IMAGE_QUALITY_MODEL ? 1 : 10;
  if (request.count !== undefined && (!Number.isInteger(request.count) || request.count < 1 || request.count > maxCount)) {
    throw new XaiImagineValidationError(
      'xai_count_unsupported',
      maxCount === 1
        ? 'This xAI Imagine model supports one generated image per request.'
        : 'xAI Imagine supports between one and ten generated images.',
    );
  }
  if (
    request.count !== undefined &&
    request.count > 1 &&
    canonicalModel === XAI_IMAGE_QUALITY_MODEL
  ) {
    throw new XaiImagineValidationError(
      'xai_batch_unsupported',
      'The xAI Imagine quality model supports one generated image per request.',
    );
  }
  const unsupported: Array<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt],
    ['width', request.width],
    ['height', request.height],
    ['durationSeconds', request.durationSeconds],
    ['fps', request.fps],
    ['seed', request.seed],
    ['audio', request.audio],
    ['extra', request.extra],
  ];
  const unsupportedOption = unsupported.find(([, value]) => value !== undefined);
  if (unsupportedOption !== undefined) {
    throw new XaiImagineValidationError(
      'xai_option_unsupported',
      `xAI Imagine does not support ${unsupportedOption[0]}.`,
    );
  }
  responseFormat(request.format);
}

function validateImageInputs(request: GenerationRequest): void {
  if (request.operation === 'image.generate') {
    if (request.inputs.length > 0) {
      throw new XaiImagineValidationError(
        'xai_generation_inputs_unsupported',
        'xAI image generation does not accept reference images; use image.edit.',
      );
    }
    return;
  }

  if (request.operation !== 'image.edit') {
    throw new XaiImagineValidationError(
      'xai_operation_unsupported',
      'The xAI Imagine image profile only supports image.generate and image.edit.',
    );
  }
  const maxReferences = isKnownImageModel(canonicalModelId(request.modelId)) ? 3 : 1;
  const referenceLimitMessage = maxReferences === 3
    ? 'xAI Imagine image edits require one source and at most three references.'
    : 'xAI Imagine image edits require one source and at most one reference.';
  if (request.inputs.length < 1 || request.inputs.length > maxReferences + 1) {
    throw new XaiImagineValidationError(
      'xai_reference_limit',
      referenceLimitMessage,
    );
  }
  const assetIds = new Set<string>();
  for (const input of request.inputs) {
    if (assetIds.has(input.assetId)) {
      throw new XaiImagineValidationError(
        'xai_input_duplicate',
        `xAI Imagine input asset ${input.assetId} is duplicated.`,
      );
    }
    assetIds.add(input.assetId);
  }
  if (request.inputs.some((input) => input.role !== 'source' && input.role !== 'reference')) {
    throw new XaiImagineValidationError(
      'xai_input_role_unsupported',
      'xAI Imagine edits accept source and reference images only; masks are unsupported.',
    );
  }
  const sourceCount = request.inputs.filter((input) => input.role === 'source').length;
  if (sourceCount !== 1) {
    throw new XaiImagineValidationError(
      'xai_source_required',
      'xAI Imagine image edits require exactly one source image.',
    );
  }
  const referenceCount = request.inputs.filter((input) => input.role === 'reference').length;
  if (referenceCount > maxReferences) {
    throw new XaiImagineValidationError(
      'xai_reference_limit',
      maxReferences === 3
        ? 'xAI Imagine image edits accept at most three references.'
        : 'xAI Imagine image edits accept at most one reference.',
    );
  }
  if (request.inputs.length === 1 && request.aspectRatio !== undefined) {
    throw new XaiImagineValidationError(
      'xai_single_edit_aspect_ratio_unsupported',
      'xAI Imagine single-image edits infer the aspect ratio from the source image.',
    );
  }
}

function contextApiKey(context: ProviderContext): string {
  const apiKey = context.secrets.apiKey?.trim();
  if (!apiKey) {
    throw new XaiImagineValidationError('xai_api_key_missing', 'The xAI API key is not configured.');
  }
  return apiKey;
}

export interface XaiImagineImagePayload {
  readonly endpoint: 'generations' | 'edits';
  readonly body: JsonRecord;
}

export function buildXaiImagineImagePayload(
  request: GenerationRequest,
  context: XaiImagineProviderContext,
): XaiImagineImagePayload {
  validateCommonRequest(request, context);
  validateImageInputs(request);
  const body: JsonRecord = {
    model: canonicalModelId(request.modelId),
    prompt: request.prompt,
  };
  if (request.aspectRatio !== undefined) body.aspect_ratio = request.aspectRatio;
  if (request.resolution !== undefined) body.resolution = request.resolution;
  if (request.quality !== undefined) body.quality = request.quality;
  const format = responseFormat(request.format);
  if (format !== undefined) body.response_format = format;

  if (request.operation === 'image.generate') {
    if (request.count !== undefined) body.n = request.count;
    return { endpoint: 'generations', body };
  }

  const resolvedInputs = context.inputs ?? [];
  const resolvedIds = new Set<string>();
  for (const input of resolvedInputs) {
    if (!input.assetId.trim() || resolvedIds.has(input.assetId)) {
      throw new XaiImagineValidationError(
        'xai_input_duplicate',
        `xAI Imagine input asset ${input.assetId || '(empty)'} is duplicated or invalid.`,
      );
    }
    resolvedIds.add(input.assetId);
    if (!request.inputs.some((requested) => requested.assetId === input.assetId)) {
      throw new XaiImagineValidationError(
        'xai_input_unexpected',
        `xAI Imagine input asset ${input.assetId} is not part of the request.`,
      );
    }
  }
  const inputs = request.inputs.map((input) => {
    const resolved = requestInput(input, context.inputs);
    return {
      type: 'image_url',
      url: resolveInputSource(resolved).url,
    };
  });
  if (inputs.length === 1) body.image = inputs[0];
  else body.images = inputs;
  if (request.count !== undefined) body.n = request.count;
  return { endpoint: 'edits', body };
}

function inferMimeTypeFromUrl(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.avif')) return 'image/avif';
  } catch {
    // The URL is validated by the caller before this helper is reached.
  }
  return 'application/octet-stream';
}

function submittedBase64Asset(item: JsonRecord, rawBase64: string, resultIndex: number): SubmittedAsset {
  let base64 = rawBase64;
  let mimeType = 'application/octet-stream';
  const uri = dataUriParts(rawBase64);
  if (uri !== null) {
    base64 = uri.base64;
    mimeType = uri.mimeType;
  }
  if (base64.length === 0 || base64.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(base64)) {
    throw new XaiImagineResponseError('xAI Imagine returned invalid base64 image data.');
  }
  if (!validBase64(base64) || Buffer.byteLength(base64, 'base64') > MAX_INLINE_OUTPUT_BYTES) {
    throw new XaiImagineResponseError('xAI Imagine returned invalid or oversized base64 image data.');
  }
  const resultId = boundedOptionalString(item, 'id', MAX_RESULT_ID_CHARS) ?? `image-${resultIndex}`;
  const revisedPrompt = boundedOptionalString(item, 'revised_prompt', MAX_REVISED_PROMPT_CHARS);
  const claimedMimeType = boundedOptionalString(item, 'mime_type', MAX_MIME_TYPE_CHARS) ??
    boundedOptionalString(item, 'mimeType', MAX_MIME_TYPE_CHARS);
  if (claimedMimeType !== undefined) {
    if (!isImageMimeType(claimedMimeType)) {
      throw new XaiImagineResponseError('xAI Imagine returned a non-image MIME type.');
    }
    mimeType = normalizeImageMimeType(claimedMimeType);
  }
  return {
    type: 'image',
    mimeType,
    source: 'base64',
    base64,
    ...(resultId === undefined ? {} : { resultId }),
    ...(revisedPrompt === undefined ? {} : { metadata: { revisedPrompt } }),
  };
}

function submittedUrlAsset(item: JsonRecord, rawUrl: string, resultIndex: number): SubmittedAsset {
  const url = safeUrl(rawUrl, 'xAI Imagine output URL');
  const resultId = boundedOptionalString(item, 'id', MAX_RESULT_ID_CHARS) ?? `image-${resultIndex}`;
  const revisedPrompt = boundedOptionalString(item, 'revised_prompt', MAX_REVISED_PROMPT_CHARS);
  const claimedMimeType = boundedOptionalString(item, 'mime_type', MAX_MIME_TYPE_CHARS) ??
    boundedOptionalString(item, 'mimeType', MAX_MIME_TYPE_CHARS);
  let mimeType = inferMimeTypeFromUrl(url);
  if (claimedMimeType !== undefined) {
    if (!isImageMimeType(claimedMimeType)) {
      throw new XaiImagineResponseError('xAI Imagine returned a non-image MIME type.');
    }
    mimeType = normalizeImageMimeType(claimedMimeType);
  }
  return {
    type: 'image',
    mimeType,
    source: 'url',
    url,
    ...(resultId === undefined ? {} : { resultId }),
    ...(revisedPrompt === undefined ? {} : { metadata: { revisedPrompt } }),
  };
}

export function parseXaiImagineImageResponse(value: unknown): readonly SubmittedAsset[] {
  if (typeof value === 'string' && /(?:^|\n)(?:data|event):/.test(value)) {
    const result = parseOpenAiImageStream(value);
    if (result.assets.length > 0 && result.assets.length <= MAX_OUTPUT_IMAGES) return result.assets;
    throw new XaiImagineResponseError('xAI Imagine stream returned no final image data.');
  }
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length === 0) {
    throw new XaiImagineResponseError('xAI Imagine returned no image data.');
  }
  if (value.data.length > MAX_OUTPUT_IMAGES) {
    throw new XaiImagineResponseError('xAI Imagine returned too many image results.');
  }
  return value.data.map((rawItem, resultIndex) => {
    if (!isRecord(rawItem)) {
      throw new XaiImagineResponseError('xAI Imagine returned an invalid image result.');
    }
    const base64 = optionalString(rawItem, 'b64_json') ?? optionalString(rawItem, 'base64');
    if (base64 !== undefined) return submittedBase64Asset(rawItem, base64, resultIndex);
    if (typeof rawItem.url === 'string' && rawItem.url.startsWith('data:')) return submittedBase64Asset(rawItem, rawItem.url, resultIndex);
    const rawUrl = boundedOptionalString(rawItem, 'url', MAX_OUTPUT_URL_CHARS);
    if (rawUrl !== undefined) return submittedUrlAsset(rawItem, rawUrl, resultIndex);
    const image = rawItem.image;
    if (isRecord(image)) {
      const nestedBase64 = optionalString(image, 'b64_json') ?? optionalString(image, 'base64');
      if (nestedBase64 !== undefined) return submittedBase64Asset(rawItem, nestedBase64, resultIndex);
      if (typeof image.url === 'string' && image.url.startsWith('data:')) return submittedBase64Asset(rawItem, image.url, resultIndex);
      const nestedUrl = boundedOptionalString(image, 'url', MAX_OUTPUT_URL_CHARS);
      if (nestedUrl !== undefined) return submittedUrlAsset(rawItem, nestedUrl, resultIndex);
    }
    throw new XaiImagineResponseError('xAI Imagine returned an image result without URL or base64 data.');
  });
}

function sanitizeMessage(value: string, secrets?: Readonly<Record<string, string>>): string {
  let sanitized = value;
  for (const secret of Object.values(secrets ?? {})) {
    if (secret.length > 0) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|xai)-[a-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/api[_-]?key\s*[:=]\s*[^\s,;]+/gi, 'api_key=[REDACTED]')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, 'data:image/[REDACTED]')
    .replace(/[a-z0-9+/]{80,}={0,2}/gi, '[REDACTED]')
    .slice(0, 500);
}

function errorMessageFromBody(body: unknown, secrets?: Readonly<Record<string, string>>): string | undefined {
  if (typeof body === 'string') return sanitizeMessage(body, secrets);
  if (!isRecord(body)) return undefined;
  const nested = body.error;
  if (typeof nested === 'string') return sanitizeMessage(nested, secrets);
  if (isRecord(nested)) {
    const message = optionalString(nested, 'message') ?? optionalString(nested, 'detail');
    if (message !== undefined) return sanitizeMessage(message, secrets);
  }
  return sanitizeMessage(optionalString(body, 'message') ?? optionalString(body, 'detail') ?? '', secrets);
}

function headerValue(
  headers:
    | Readonly<Record<string, string | readonly string[] | undefined>>
    | XaiImagineHttpHeaders
    | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if ('get' in headers && typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const expected = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1];
  return typeof found === 'string' ? found : found?.[0];
}

function httpProviderError(error: XaiImagineHttpError): ProviderError {
  const status = error.statusCode;
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  const kind: ProviderErrorKind =
    retryable ? 'transient' : status > 0 && status < 500 ? 'rejected' : 'unknown';
  const retryAfter = headerValue(error.responseHeaders, 'retry-after');
  const retryAfterSeconds = retryAfter === undefined ? undefined : Number(retryAfter);
  const retryAfterMs =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.min(Math.round(retryAfterSeconds * 1000), 86_400_000)
      : retryAfter === undefined || Number.isNaN(Date.parse(retryAfter))
        ? undefined
        : Math.max(0, Math.min(Date.parse(retryAfter) - Date.now(), 86_400_000));
  const bodyMessage = errorMessageFromBody(error.responseBody);
  const message =
    bodyMessage === undefined || bodyMessage.length === 0
      ? `xAI Imagine request failed with HTTP ${status}.`
      : bodyMessage;
  const code = status === 401 || status === 403 ? 'xai_authentication_error' : status === 429 ? 'xai_rate_limited' : `xai_http_${status}`;
  return {
    code,
    kind,
    message,
    retryable,
    statusCode: status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export function normalizeXaiImagineError(error: unknown): ProviderError {
  if (error instanceof XaiImagineValidationError) return error.providerError;
  if (error instanceof XaiImagineHttpError) return httpProviderError(error);
  if (error instanceof XaiImagineTransportError) {
    const cause = error.cause;
    if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'CanceledError')) {
      return {
        code: 'xai_request_aborted',
        kind: 'transient',
        message: 'The xAI Imagine request was aborted.',
        retryable: false,
      };
    }
    return {
      code: 'xai_transport_error',
      kind: 'transient',
      message: 'The xAI Imagine request failed before a response was received.',
      retryable: true,
    };
  }
  if (error instanceof XaiImagineResponseError) {
    return {
      code: 'xai_invalid_response',
      kind: 'unknown',
      message: sanitizeMessage(error.message),
      retryable: false,
    };
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')) {
    return {
      code: 'xai_request_aborted',
      kind: 'transient',
      message: 'The xAI Imagine request was aborted.',
      retryable: false,
    };
  }
  return {
    code: 'xai_network_error',
    kind: 'transient',
    message: 'The xAI Imagine request failed before a response was received.',
    retryable: true,
  };
}

function modelCapabilities(modelId: string): ModelCapabilities {
  const quality = modelId === XAI_IMAGE_2_MODEL;
  const batch = modelId !== XAI_IMAGE_QUALITY_MODEL;
  return {
    operations: ['image.generate', 'image.edit'],
    aspectRatios: ASPECT_RATIOS,
    resolutions: RESOLUTIONS,
    maxReferenceImages: 3,
    supportsMask: false,
    supportsNegativePrompt: false,
    supportsSeed: false,
    supportsProgress: false,
    supportsCancel: false,
    supportsBatchCount: batch,
    maxBatchCount: batch ? 10 : 1,
    ...(quality
      ? {
          customFields: {
            type: 'object',
            properties: {
              quality: { type: 'string', enum: [...QUALITIES] },
            },
          },
        }
      : {}),
    inputImageConstraints: {
      mimeTypes: [...IMAGE_MIME_TYPES],
    },
  };
}

const MAX_DYNAMIC_MODEL_COUNT = 200;
const MAX_MODEL_ID_CHARS = 255;
const MAX_MODEL_DISPLAY_NAME_CHARS = 255;

function conservativeModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...modelCapabilities(modelId),
    aspectRatios: ['1:1'],
    resolutions: ['1k'],
    maxReferenceImages: 1,
    supportsBatchCount: false,
    maxBatchCount: 1,
    customFields: { type: 'object', additionalProperties: false },
  };
}

function modelDisplayName(modelId: string): string {
  switch (canonicalModelId(modelId)) {
    case XAI_IMAGE_2_MODEL:
      return 'Grok Imagine Image 2.0';
    case XAI_IMAGE_MODEL:
      return 'Grok Imagine Image';
    case XAI_IMAGE_QUALITY_MODEL:
      return 'Grok Imagine Image Quality';
    default:
      return `xAI Imagine (${modelId})`;
  }
}

function boundedModelText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_MODEL_DISPLAY_NAME_CHARS) {
    return fallback.slice(0, MAX_MODEL_DISPLAY_NAME_CHARS);
  }
  return value.trim();
}

function modelEntryId(entry: JsonRecord): string | undefined {
  const raw = optionalString(entry, 'id') ?? optionalString(entry, 'name') ?? optionalString(entry, 'model');
  if (raw === undefined) return undefined;
  const normalized = raw.trim().replace(/^models\//u, '');
  return normalized.length > 0 ? canonicalModelId(normalized) : undefined;
}

function advertisedImageSupport(entry: JsonRecord): boolean {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const methods = [
    entry.supportedGenerationMethods,
    entry.supported_methods,
    capabilities?.supportedGenerationMethods,
    capabilities?.supported_methods,
  ].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  const capabilityFlags = [
    capabilities?.image_generation,
    capabilities?.imageGeneration,
    capabilities?.image_generation_supported,
    capabilities?.supports_image_generation,
  ].filter((value): value is boolean => typeof value === 'boolean');
  if (capabilityFlags.some((value) => value === false)) return false;
  if (capabilityFlags.some((value) => value === true)) return true;
  if (methods.length > 0) return methods.some((method) => /image|imagine|generation/iu.test(method));
  return true;
}

function parseXaiModelCatalog(value: unknown): readonly ProviderModel[] {
  if (!isRecord(value)) throw new XaiImagineResponseError('xAI Imagine models response is invalid.');
  const entries = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : undefined;
  if (entries === undefined) throw new XaiImagineResponseError('xAI Imagine models response is invalid.');
  if (entries.length > MAX_DYNAMIC_MODEL_COUNT) {
    throw new XaiImagineResponseError('xAI Imagine models response exceeds the model limit.');
  }
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const rawEntry of entries) {
    if (!isRecord(rawEntry)) continue;
    const id = modelEntryId(rawEntry);
    if (
      id === undefined ||
      id.length > MAX_MODEL_ID_CHARS ||
      !isSupportedModel(id) ||
      seen.has(id) ||
      !advertisedImageSupport(rawEntry)
    ) continue;
    seen.add(id);
    const known = isKnownImageModel(id);
    const fallbackName = modelDisplayName(id);
    const remoteName = optionalString(rawEntry, 'display_name') ?? optionalString(rawEntry, 'displayName');
    models.push({
      id,
      displayName: boundedModelText(remoteName, fallbackName),
      capabilities: known ? modelCapabilities(id) : conservativeModelCapabilities(id),
    });
  }
  return models;
}

function isGenerationResultResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Array.isArray(value.data) ? value.data : [];
  return entries.some((entry) => {
    if (!isRecord(entry)) return false;
    return entry.b64_json !== undefined || entry.base64 !== undefined || entry.url !== undefined || isRecord(entry.image);
  });
}

export function getXaiImagineImageCapabilities(): ProviderCapabilities {
  const models: readonly ProviderModel[] = [
    {
      id: XAI_IMAGE_2_MODEL,
      displayName: 'Grok Imagine Image 2.0',
      capabilities: modelCapabilities(XAI_IMAGE_2_MODEL),
    },
    {
      id: XAI_IMAGE_MODEL,
      displayName: 'Grok Imagine Image',
      capabilities: modelCapabilities(XAI_IMAGE_MODEL),
    },
    {
      id: XAI_IMAGE_QUALITY_MODEL,
      displayName: 'Grok Imagine Image Quality',
      capabilities: modelCapabilities(XAI_IMAGE_QUALITY_MODEL),
    },
  ];
  return { providerType: XAI_IMAGINE_IMAGE_PROFILE, models };
}

function endpointFor(baseUrl: string, endpoint: XaiImagineImagePayload['endpoint']): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new XaiImagineValidationError('xai_base_url_invalid', 'The xAI Imagine base URL is invalid.');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.protocol !== 'https:' && parsed.protocol !== 'http:'
  ) {
    throw new XaiImagineValidationError(
      'xai_base_url_invalid',
      'The xAI Imagine base URL must be an HTTP(S) URL without credentials.',
    );
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${path || '/v1'}/images/${endpoint}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function modelsEndpointFor(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new XaiImagineValidationError('xai_base_url_invalid', 'The xAI Imagine base URL is invalid.');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.protocol !== 'https:' && parsed.protocol !== 'http:'
  ) {
    throw new XaiImagineValidationError(
      'xai_base_url_invalid',
      'The xAI Imagine base URL must be an HTTP(S) URL without credentials.',
    );
  }
  const path = parsed.pathname.replace(/\/+$/u, '');
  parsed.pathname = path.endsWith('/models') ? path : `${path || '/v1'}/models`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function contextHttp(context: XaiImagineProviderContext): XaiImagineHttpClient | XaiImagineHttpRequestExecutor | undefined {
  return context.http ?? context.transport;
}

function contextBaseUrl(context: XaiImagineProviderContext, fallback: string | undefined): string {
  const configured =
    context.baseUrl?.trim() ||
    (typeof context.config?.baseUrl === 'string' ? context.config.baseUrl.trim() : '') ||
    fallback?.trim() ||
    XAI_DEFAULT_BASE_URL;
  return configured;
}

async function readResponseBody(response: XaiImagineHttpResponse): Promise<unknown> {
  if (typeof response.json === 'function') return assertParsedResponseBody(await response.json());
  if (response.json !== undefined) return assertParsedResponseBody(await response.json);
  if (response.body !== undefined) {
    if (response.body instanceof Uint8Array) {
      return parseResponseText(Buffer.from(response.body).toString('utf8'));
    }
    if (typeof response.body === 'string') {
      return parseResponseText(response.body);
    }
    return assertParsedResponseBody(response.body);
  }
  if (typeof response.text === 'function') {
    return parseResponseText(await response.text());
  }
  if (response.text !== undefined) {
    return parseResponseText(await response.text);
  }
  return undefined;
}

function parseResponseText(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BODY_BYTES) {
    throw new XaiImagineResponseError('xAI Imagine response body exceeds the configured size limit.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isReadableLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    typeof candidate.pipe === 'function' ||
    typeof candidate.getReader === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

function assertParsedResponseBody(value: unknown): unknown {
  if (isReadableLike(value)) {
    throw new XaiImagineResponseError(
      'xAI Imagine transport responses must be pre-parsed or supplied as bounded text/bytes.',
    );
  }
  if (
    (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BODY_BYTES) ||
    (value instanceof Uint8Array && value.byteLength > MAX_RESPONSE_BODY_BYTES)
  ) {
    throw new XaiImagineResponseError('xAI Imagine response body exceeds the configured size limit.');
  }
  return value;
}

function customHeaders(
  context: XaiImagineProviderContext,
  configuredHeaders: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const setHeader = (name: string, value: string): void => {
    const normalized = safeHeaderName(name).toLowerCase();
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === normalized) delete headers[existingName];
    }
    headers[name] = safeHeaderValue(value, name);
  };
  for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
    setHeader(name, value);
  }
  for (const [name, value] of Object.entries(context.headers ?? {})) {
    setHeader(name, value);
  }
  const configHeaders = context.config?.headers;
  if (isRecord(configHeaders)) {
    for (const [name, rawValue] of Object.entries(configHeaders)) {
      if (typeof rawValue === 'string') setHeader(name, rawValue);
    }
  }
  for (const [key, value] of Object.entries(context.secrets)) {
    if (key.startsWith('header:') && key.length > 'header:'.length) {
      const name = key.slice('header:'.length);
      setHeader(name, value);
    }
  }
  return headers;
}

export class XaiImagineImageProvider implements ProviderAdapter {
  public readonly type = XAI_IMAGINE_IMAGE_PROFILE;
  private readonly injectedHttp: XaiImagineHttpClient | XaiImagineHttpRequestExecutor | undefined;
  private readonly configuredBaseUrl: string | undefined;
  private readonly configuredHeaders: Readonly<Record<string, string>> | undefined;

  public constructor(options: XaiImagineImageProviderOptions = {}) {
    this.injectedHttp = options.http ?? options.transport;
    this.configuredBaseUrl = options.baseUrl;
    this.configuredHeaders = options.headers;
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return getXaiImagineImageCapabilities();
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const xaiContext = context as XaiImagineProviderContext;
    const apiKey = contextApiKey(xaiContext);
    const http = contextHttp(xaiContext) ?? xaiContext.transport ?? this.injectedHttp;
    if (http === undefined) {
      throw new XaiImagineValidationError(
        'xai_http_not_configured',
        'The xAI Imagine secure HTTP client is not configured.',
      );
    }
    const body = await this.requestModels(xaiContext, apiKey, http);
    const models = parseXaiModelCatalog(body);
    // Some OpenAI-compatible relays return the generation envelope for every
    // path. Preserve the built-in profile only for that unmistakable shape;
    // a real models list containing no supported image model remains empty.
    return isGenerationResultResponse(body)
      ? getXaiImagineImageCapabilities()
      : { providerType: this.type, models };
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const xaiContext = context as XaiImagineProviderContext;
    const apiKey = contextApiKey(xaiContext);
    const http = contextHttp(xaiContext) ?? xaiContext.transport ?? this.injectedHttp;
    if (http === undefined) {
      throw new XaiImagineValidationError(
        'xai_http_not_configured',
        'The xAI Imagine secure HTTP client is not configured.',
      );
    }
    await this.requestModels(xaiContext, apiKey, http);
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    contextApiKey(context);
    const xaiContext = context as XaiImagineProviderContext;
    const payload = buildXaiImagineImagePayload(request, xaiContext);
    endpointFor(contextBaseUrl(xaiContext, this.configuredBaseUrl), payload.endpoint);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const xaiContext = context as XaiImagineProviderContext;
    const payload = buildXaiImagineImagePayload(request, xaiContext);
    const apiKey = contextApiKey(xaiContext);
    const http = contextHttp(xaiContext) ?? xaiContext.transport ?? this.injectedHttp;
    if (http === undefined) {
      throw new XaiImagineValidationError(
        'xai_http_not_configured',
        'The xAI Imagine secure HTTP client is not configured.',
      );
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...customHeaders(xaiContext, this.configuredHeaders),
      Authorization: `Bearer ${safeHeaderValue(apiKey, 'API key')}`,
    };
    if (xaiContext.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = safeHeaderValue(xaiContext.idempotencyKey, 'Idempotency key');
    }
    const httpRequest: XaiImagineHttpRequest = {
      method: 'POST',
      url: endpointFor(contextBaseUrl(xaiContext, this.configuredBaseUrl), payload.endpoint),
      headers,
      body: JSON.stringify(payload.body),
      ...(xaiContext.signal === undefined ? {} : { signal: xaiContext.signal }),
    };
    xaiContext.signal?.throwIfAborted();
    let response: XaiImagineHttpResponse;
    try {
      response =
        typeof http === 'function' ? await http(httpRequest) : await http.request(httpRequest);
    } catch (error) {
      throw error instanceof XaiImagineValidationError || error instanceof XaiImagineTransportError
        ? error
        : new XaiImagineTransportError('xAI Imagine HTTP request failed.', { cause: error });
    }
    try {
      const body = await readResponseBody(response);
      const statusCode = response.statusCode ?? response.status;
      if (statusCode === undefined) {
        throw new XaiImagineResponseError('xAI Imagine HTTP response did not include a status code.');
      }
      if (statusCode < 200 || statusCode >= 300) {
        throw new XaiImagineHttpError(statusCode, body, response.headers, xaiContext.secrets);
      }
      return { state: 'completed', assets: parseXaiImagineImageResponse(body) };
    } finally {
      await response.dispose?.();
    }
  }

  public normalizeError(error: unknown): ProviderError {
    return normalizeXaiImagineError(error);
  }

  private async requestModels(
    context: XaiImagineProviderContext,
    apiKey: string,
    http: XaiImagineHttpClient | XaiImagineHttpRequestExecutor,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...customHeaders(context, this.configuredHeaders),
      Authorization: `Bearer ${safeHeaderValue(apiKey, 'API key')}`,
    };
    const request: XaiImagineHttpRequest = {
      method: 'GET',
      url: modelsEndpointFor(contextBaseUrl(context, this.configuredBaseUrl)),
      headers,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    context.signal?.throwIfAborted();
    let response: XaiImagineHttpResponse;
    try {
      response = typeof http === 'function' ? await http(request) : await http.request(request);
    } catch (error) {
      throw error instanceof XaiImagineValidationError || error instanceof XaiImagineTransportError
        ? error
        : new XaiImagineTransportError('xAI Imagine connection request failed.');
    }
    try {
      const statusCode = response.statusCode ?? response.status;
      if (statusCode === undefined) {
        throw new XaiImagineResponseError('xAI Imagine HTTP response did not include a status code.');
      }
      const body = await readResponseBody(response);
      if (statusCode < 200 || statusCode >= 300) {
        throw new XaiImagineHttpError(statusCode, body, response.headers, context.secrets);
      }
      return body;
    } finally {
      await response.dispose?.();
    }
  }

}

export function createXaiImagineImageProvider(
  options: XaiImagineImageProviderOptions = {},
): XaiImagineImageProvider {
  return new XaiImagineImageProvider(options);
}

export { XaiImagineImageProvider as XaiImagineImageAdapter };
export default XaiImagineImageProvider;
