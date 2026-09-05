import type { GenerationRequest } from '@imagine/shared';
import type { SubmittedAsset } from '@imagine/provider-contract';

import type {
  OpenAiHttpBody,
  OpenAiInputAsset,
  OpenAiMultipartPart,
} from './types.js';
import { OpenAiResponseError, OpenAiValidationError } from './types.js';

const DEFAULT_SIZE_BY_ASPECT_RATIO: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  auto: 'auto',
};

const FIXED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);
const VALID_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const VALID_FORMATS = new Set(['png', 'jpeg', 'webp']);
const VALID_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const VALID_INPUT_FIDELITIES = new Set(['low', 'high']);
const VALID_MODERATION = new Set(['low', 'auto']);
export const OPENAI_MAX_INLINE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((OPENAI_MAX_INLINE_OUTPUT_BYTES * 4) / 3) + 4;
const MAX_OUTPUT_URL_CHARS = 4_096;
const MAX_RESULT_ID_CHARS = 256;
const MAX_METADATA_BYTES = 16 * 1024;
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

export const IMAGE_EXTRA_KEYS = Object.freeze([
  'background',
  'input_fidelity',
  'moderation',
  'output_compression',
  'output_format',
  'partial_images',
  'quality',
  'size',
  'stream',
] as const);

export const RESPONSES_EXTRA_KEYS = Object.freeze([
  'background',
  'moderation',
  'partial_images',
  'quality',
  'size',
  'stream',
] as const);

export type ImageExtraKey = (typeof IMAGE_EXTRA_KEYS)[number];

export type OpenAiOutputFormat = 'png' | 'jpeg' | 'webp';

export interface OpenAiImageResultOptions {
  readonly outputFormat?: OpenAiOutputFormat;
  readonly maxAssets?: number;
}

export interface OpenAiImageRequestPolicy {
  readonly compatibleSize?: boolean;
  readonly flexibleSize?: boolean;
  readonly supportsInputFidelity?: boolean;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpenAiValidationError('invalid_option', `${name} must be a positive safe integer.`);
  }
  return value;
}

function readExtra(
  request: GenerationRequest,
  allowed: readonly string[],
): Record<string, unknown> {
  const extra = request.extra ?? {};
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new OpenAiValidationError('invalid_option', 'extra must be a JSON object.');
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(extra)) {
    if (!allowedSet.has(key)) {
      throw new OpenAiValidationError('unsupported_option', `OpenAI does not support extra.${key}.`);
    }
  }
  return extra;
}

function assertStringOption(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpenAiValidationError('invalid_option', `${name} must be a non-empty string.`);
  }
  return value.trim();
}

function assertEnumOption(
  value: unknown,
  name: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const normalized = assertStringOption(value, name);
  if (normalized === undefined) return undefined;
  if (!allowed.has(normalized)) {
    throw new OpenAiValidationError('invalid_option', `${name} is not supported by OpenAI.`);
  }
  return normalized;
}

function flexibleSize(value: string): boolean {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return false;
  if (width > 3_840 || height > 3_840 || width % 16 !== 0 || height % 16 !== 0) return false;
  const pixels = width * height;
  const ratio = Math.max(width / height, height / width);
  return pixels >= 655_360 && pixels <= 8_294_400 && ratio <= 3;
}

function compatibleImageSize(value: string): boolean {
  if (!/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(value)) return false;
  const [width, height] = value.split('x').map(Number) as [number, number];
  return width <= 16384 && height <= 16384 && width * height <= 100_000_000;
}

function deriveSize(
  request: GenerationRequest,
  extra: Record<string, unknown>,
  policy: OpenAiImageRequestPolicy,
): string | undefined {
  const compatibleSize = (value: string) => policy.compatibleSize === true && compatibleImageSize(value);
  const explicit = extra.size ?? request.resolution;
  if (explicit !== undefined) {
    const size = assertStringOption(explicit, 'size');
    if (size === undefined || (size !== 'auto' && !FIXED_SIZES.has(size) && !compatibleSize(size) && !(policy.flexibleSize === true && flexibleSize(size)))) {
      throw new OpenAiValidationError(
        'invalid_option',
        policy.flexibleSize === true
          ? 'size must satisfy GPT Image 2 dimensions, or be auto.'
          : 'size must be one of 1024x1024, 1536x1024, 1024x1536, or auto.',
      );
    }
    return size;
  }
  if (request.width !== undefined || request.height !== undefined) {
    if (request.width === undefined || request.height === undefined) {
      throw new OpenAiValidationError('invalid_option', 'width and height must be provided together.');
    }
    positiveInteger(request.width, 'width');
    positiveInteger(request.height, 'height');
    const size = `${request.width}x${request.height}`;
    if (!((policy.flexibleSize === true && flexibleSize(size)) || compatibleSize(size) || FIXED_SIZES.has(size))) {
      throw new OpenAiValidationError(
        'invalid_option',
        policy.flexibleSize === true
          ? 'width and height must satisfy GPT Image 2 dimensions.'
          : 'OpenAI image sizes are 1024x1024, 1536x1024, or 1024x1536.',
      );
    }
    return size;
  }
  if (request.aspectRatio !== undefined) {
    if (policy.compatibleSize && request.aspectRatio !== 'auto') {
      const match = /^([1-9]\d{0,2}):([1-9]\d{0,2})$/.exec(request.aspectRatio);
      if (!match) throw new OpenAiValidationError('invalid_option', 'aspectRatio must be a positive width:height ratio.');
      const ratio = Number(match[1]) / Number(match[2]);
      const width = Math.round((ratio >= 1 ? 1024 : 1024 * ratio) / 16) * 16;
      const height = Math.round((ratio >= 1 ? 1024 / ratio : 1024) / 16) * 16;
      if (!compatibleSize(`${width}x${height}`)) throw new OpenAiValidationError('invalid_option', 'aspectRatio produces unsupported dimensions.');
      return `${width}x${height}`;
    }
    const size = policy.flexibleSize === true
      ? ({ '1:1': '1024x1024', '16:9': '2048x1152', '9:16': '1152x2048', auto: 'auto' } as Readonly<Record<string, string>>)[request.aspectRatio]
      : DEFAULT_SIZE_BY_ASPECT_RATIO[request.aspectRatio];
    if (size === undefined) {
      throw new OpenAiValidationError(
        'invalid_option',
        `OpenAI does not support aspect ratio ${request.aspectRatio}.`,
      );
    }
    return size;
  }
  return undefined;
}

export interface OpenAiImageRequestOptions {
  readonly model: string;
  readonly prompt: string;
  readonly count?: number;
  readonly size?: string;
  readonly quality?: string;
  /** File encoding only; transport remains the provider response source. */
  readonly outputFormat?: string;
  readonly background?: string;
  readonly inputFidelity?: string;
  readonly moderation?: string;
  readonly outputCompression?: number;
  readonly stream?: boolean;
  readonly partialImages?: number;
}

export function imageRequestOptions(
  request: GenerationRequest,
  allowedExtra: readonly string[] = IMAGE_EXTRA_KEYS,
  policy: OpenAiImageRequestPolicy = {},
): OpenAiImageRequestOptions {
  if (request.negativePrompt !== undefined) {
    throw new OpenAiValidationError('unsupported_option', 'OpenAI Images does not support negativePrompt.');
  }
  if (request.seed !== undefined || request.audio !== undefined || request.fps !== undefined) {
    throw new OpenAiValidationError('unsupported_option', 'OpenAI Images does not support seed, audio, or fps.');
  }
  if (request.durationSeconds !== undefined) {
    throw new OpenAiValidationError('unsupported_option', 'OpenAI Images does not support durationSeconds.');
  }
  const extra = readExtra(request, allowedExtra);
  const count = positiveInteger(request.count, 'count');
  if (count !== undefined && count > 10) {
    throw new OpenAiValidationError('invalid_option', 'count must be at most 10.');
  }
  const quality = request.quality ?? assertEnumOption(extra.quality, 'quality', VALID_QUALITIES);
  if (quality !== undefined && !VALID_QUALITIES.has(quality)) {
    throw new OpenAiValidationError('invalid_option', 'quality must be low, medium, high, or auto.');
  }
  const requestedFormat = assertStringOption(request.format, 'format');
  const extraOutputFormat = assertEnumOption(extra.output_format, 'output_format', VALID_FORMATS);
  const outputFormat = requestedFormat ?? extraOutputFormat;
  if (outputFormat !== undefined && !VALID_FORMATS.has(outputFormat)) {
    throw new OpenAiValidationError('invalid_option', 'format must be png, jpeg, or webp.');
  }
  const compression = extra.output_compression;
  if (
    compression !== undefined &&
    (typeof compression !== 'number' || !Number.isInteger(compression) || compression < 0 || compression > 100)
  ) {
    throw new OpenAiValidationError('invalid_option', 'output_compression must be an integer from 0 through 100.');
  }
  if (compression !== undefined && outputFormat !== 'jpeg' && outputFormat !== 'webp') {
    throw new OpenAiValidationError('unsupported_option', 'output_compression is supported only for jpeg or webp output.');
  }
  const partialImages = extra.partial_images;
  if (
    partialImages !== undefined &&
    (typeof partialImages !== 'number' || !Number.isInteger(partialImages) || partialImages < 0 || partialImages > 3)
  ) {
    throw new OpenAiValidationError('invalid_option', 'partial_images must be an integer from 0 through 3.');
  }
  const stream = extra.stream;
  if (stream !== undefined && typeof stream !== 'boolean') {
    throw new OpenAiValidationError('invalid_option', 'stream must be a boolean.');
  }
  if (partialImages !== undefined && stream !== true) {
    throw new OpenAiValidationError('unsupported_option', 'partial_images requires stream=true.');
  }
  const size = deriveSize(request, extra, policy);
  const background = assertEnumOption(extra.background, 'background', VALID_BACKGROUNDS);
  const inputFidelity = extra.input_fidelity === undefined
    ? undefined
    : policy.supportsInputFidelity === true
      ? assertEnumOption(extra.input_fidelity, 'input_fidelity', VALID_INPUT_FIDELITIES)
      : (() => {
          throw new OpenAiValidationError('unsupported_option', 'This OpenAI image model does not support input_fidelity.');
        })();
  const moderation = assertEnumOption(extra.moderation, 'moderation', VALID_MODERATION);
  return {
    model: request.modelId,
    prompt: request.prompt,
    ...(count === undefined ? {} : { count }),
    ...(size === undefined ? {} : { size }),
    ...(quality === undefined ? {} : { quality }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...(background === undefined ? {} : { background }),
    ...(inputFidelity === undefined ? {} : { inputFidelity }),
    ...(moderation === undefined ? {} : { moderation }),
    ...(compression === undefined ? {} : { outputCompression: compression as number }),
    ...(stream === undefined ? {} : { stream: stream as boolean }),
    ...(partialImages === undefined ? {} : { partialImages: partialImages as number }),
  };
}

function addField(parts: OpenAiMultipartPart[], name: string, value: string | number | boolean): void {
  parts.push({ name, bytes: new TextEncoder().encode(String(value)) });
}

export function buildImageGenerationPayload(options: OpenAiImageRequestOptions): Record<string, unknown> {
  return {
    model: options.model,
    prompt: options.prompt,
    ...(options.count === undefined ? {} : { n: options.count }),
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.outputFormat === undefined ? {} : { output_format: options.outputFormat }),
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.inputFidelity === undefined ? {} : { input_fidelity: options.inputFidelity }),
    ...(options.moderation === undefined ? {} : { moderation: options.moderation }),
    ...(options.outputCompression === undefined ? {} : { output_compression: options.outputCompression }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(options.partialImages === undefined ? {} : { partial_images: options.partialImages }),
  };
}

export const buildImagesGenerationPayload = buildImageGenerationPayload;

function assertPayloadObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAiValidationError('invalid_payload', `${label} payload must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new OpenAiValidationError('invalid_payload', `${label} payload field ${key} is not supported.`);
  }
}

export function assertImageGenerationPayload(value: unknown, policy: OpenAiImageRequestPolicy = {}): asserts value is Record<string, unknown> {
  const payload = assertPayloadObject(value, 'Images generation');
  assertKnownKeys(payload, new Set([
    'model',
    'prompt',
    'n',
    'size',
    'quality',
    'output_format',
    'background',
    'input_fidelity',
    'moderation',
    'output_compression',
    'stream',
    'partial_images',
  ]), 'Images generation');
  if (typeof payload.model !== 'string' || typeof payload.prompt !== 'string' || payload.prompt.trim() === '') {
    throw new OpenAiValidationError('invalid_payload', 'Images generation requires model and prompt.');
  }
  if (
    payload.n !== undefined &&
    (typeof payload.n !== 'number' || !Number.isSafeInteger(payload.n) || payload.n < 1 || payload.n > 10)
  ) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation n must be an integer from 1 through 10.');
  }
  const isGptImage2 = payload.model === 'gpt-image-2';
  if (payload.size !== undefined && (
    typeof payload.size !== 'string' ||
    (isGptImage2 ? payload.size !== 'auto' && !flexibleSize(payload.size) : !FIXED_SIZES.has(payload.size) && !(policy.compatibleSize && compatibleImageSize(payload.size)))
  )) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation size is invalid.');
  }
  if (payload.quality !== undefined && (typeof payload.quality !== 'string' || !VALID_QUALITIES.has(payload.quality))) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation quality is invalid.');
  }
  if (payload.background !== undefined && (typeof payload.background !== 'string' || !VALID_BACKGROUNDS.has(payload.background))) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation background is invalid.');
  }
  if (payload.input_fidelity !== undefined && (
    isGptImage2 ||
    typeof payload.input_fidelity !== 'string' ||
    !VALID_INPUT_FIDELITIES.has(payload.input_fidelity)
  )) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation input_fidelity is invalid.');
  }
  if (payload.output_format !== undefined && (typeof payload.output_format !== 'string' || !VALID_FORMATS.has(payload.output_format))) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation output_format is invalid.');
  }
  if (
    payload.output_compression !== undefined &&
    (typeof payload.output_compression !== 'number' ||
      !Number.isSafeInteger(payload.output_compression) ||
      payload.output_compression < 0 ||
      payload.output_compression > 100 ||
      (payload.output_format !== 'jpeg' && payload.output_format !== 'webp'))
  ) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation output_compression is invalid.');
  }
  if (payload.moderation !== undefined && (typeof payload.moderation !== 'string' || !VALID_MODERATION.has(payload.moderation))) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation moderation is invalid.');
  }
  if (payload.stream !== undefined && typeof payload.stream !== 'boolean') {
    throw new OpenAiValidationError('invalid_payload', 'Images generation stream must be a boolean.');
  }
  if (
    payload.partial_images !== undefined &&
    (typeof payload.partial_images !== 'number' || !Number.isSafeInteger(payload.partial_images) || payload.partial_images < 0 || payload.partial_images > 3)
  ) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation partial_images is invalid.');
  }
  if (payload.partial_images !== undefined && payload.stream !== true) {
    throw new OpenAiValidationError('invalid_payload', 'Images generation partial_images requires stream=true.');
  }
}

export const assertOpenAiImageGenerationPayload = assertImageGenerationPayload;

export function assertImageEditInputs(inputs: readonly OpenAiInputAsset[]): void {
  if (inputs.length === 0 || inputs[0]?.role !== 'source' || inputs.filter((input) => input.role === 'source').length !== 1) {
    throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edits require one source image first.');
  }
  if (inputs.some((input) => input.role !== 'source' && input.role !== 'reference' && input.role !== 'mask')) {
    throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edits accept source, reference, and mask images only.');
  }
  const masks = inputs.filter((input) => input.role === 'mask');
  if (masks.length > 1) throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edits accept at most one mask.');
  const mask = masks[0];
  if (mask && mask.mimeType.toLowerCase() !== 'image/png') {
    throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edit masks must be PNG images.');
  }
  const source = inputs[0]!;
  if (mask?.parentAssetId != null && mask.parentAssetId !== source.assetId) {
    throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edit mask parent must match the source.');
  }
  if (
    mask?.width !== undefined &&
    mask.height !== undefined &&
    source.width !== undefined &&
    source.height !== undefined &&
    (mask.width !== source.width || mask.height !== source.height)
  ) {
    throw new OpenAiValidationError('invalid_inputs', 'OpenAI image edit mask dimensions must match the source.');
  }
}

export function buildImageEditMultipart(
  options: OpenAiImageRequestOptions,
  inputs: readonly OpenAiInputAsset[],
  boundary = '----imagine-openai-images-v1',
): { readonly body: Uint8Array; readonly contentType: string } {
  assertImageEditInputs(inputs);
  const parts: OpenAiMultipartPart[] = [];
  addField(parts, 'model', options.model);
  addField(parts, 'prompt', options.prompt);
  if (options.count !== undefined) addField(parts, 'n', options.count);
  if (options.size !== undefined) addField(parts, 'size', options.size);
  if (options.quality !== undefined) addField(parts, 'quality', options.quality);
  if (options.outputFormat !== undefined) addField(parts, 'output_format', options.outputFormat);
  if (options.background !== undefined) addField(parts, 'background', options.background);
  if (options.inputFidelity !== undefined) addField(parts, 'input_fidelity', options.inputFidelity);
  if (options.moderation !== undefined) addField(parts, 'moderation', options.moderation);
  if (options.outputCompression !== undefined) addField(parts, 'output_compression', options.outputCompression);
  if (options.stream !== undefined) addField(parts, 'stream', options.stream);
  if (options.partialImages !== undefined) addField(parts, 'partial_images', options.partialImages);
  for (const input of inputs) {
    parts.push({
      name: input.role === 'mask' ? 'mask' : 'image[]',
      filename: input.filename ?? `${input.assetId}.${input.mimeType.split('/')[1] ?? 'bin'}`,
      contentType: input.mimeType,
      bytes: input.bytes,
    });
  }
  return { body: encodeMultipart(parts, boundary), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const buildImagesEditMultipart = buildImageEditMultipart;

export function encodeMultipart(
  parts: readonly OpenAiMultipartPart[],
  boundary = '----imagine-openai-images-v1',
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const appendText = (value: string) => chunks.push(encoder.encode(value));
  for (const part of parts) {
    appendText(`--${boundary}\r\n`);
    appendText(`Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"`);
    if (part.filename !== undefined) appendText(`; filename="${escapeHeaderValue(part.filename)}"`);
    appendText('\r\n');
    if (part.contentType !== undefined) appendText(`Content-Type: ${escapeHeaderValue(part.contentType)}\r\n`);
    appendText('\r\n');
    chunks.push(part.bytes);
    appendText('\r\n');
  }
  appendText(`--${boundary}--\r\n`);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

export function mimeTypeForOutputFormat(format: OpenAiOutputFormat | undefined): string {
  // Unlabelled results are typed from their bytes by the media ingestion pipeline.
  return format === undefined ? 'application/octet-stream' : format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
}

function inferMimeType(value: string): string | undefined {
  if (/\.png(?:$|[?#])/i.test(value)) return 'image/png';
  if (/^data:image\/(jpeg|jpg);base64,/i.test(value)) return 'image/jpeg';
  if (/^data:image\/webp;base64,/i.test(value)) return 'image/webp';
  if (/^data:image\/gif;base64,/i.test(value)) return 'image/gif';
  if (/\.(?:jpe?g)(?:$|[?#])/i.test(value)) return 'image/jpeg';
  if (/\.webp(?:$|[?#])/i.test(value)) return 'image/webp';
  if (/\.gif(?:$|[?#])/i.test(value)) return 'image/gif';
  if (/\.[a-z0-9]+(?:$|[?#])/i.test(value)) return undefined;
  return undefined;
}

function normalizeMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? 'image/png';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function supportedMimeType(value: string): boolean {
  return normalizeMimeType(value).startsWith('image/');
}

export function normalizeBase64Image(
  rawValue: string,
  options: OpenAiImageResultOptions = {},
): { readonly base64: string; readonly mimeType: string } {
  if (rawValue.length > MAX_BASE64_CHARS) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned oversized Base64 image data.');
  }
  let base64 = rawValue;
  let mimeType = mimeTypeForOutputFormat(options.outputFormat);
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(rawValue);
  if (match) {
    mimeType = normalizeMimeType(match[1]!);
    base64 = match[2]!;
    if (!supportedMimeType(mimeType)) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI returned a non-image Base64 MIME type.');
    }
  }
  if (!validBase64(base64) || Buffer.byteLength(base64, 'base64') > OPENAI_MAX_INLINE_OUTPUT_BYTES) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned invalid or oversized Base64 image data.');
  }
  return { base64, mimeType };
}

function dataUrlAsset(
  value: string,
  resultId: string,
  options: OpenAiImageResultOptions,
  metadata?: Readonly<Record<string, unknown>>,
): SubmittedAsset {
  const normalized = normalizeBase64Image(value, options);
  return {
    type: 'image',
    mimeType: normalized.mimeType,
    source: 'base64',
    base64: normalized.base64,
    resultId,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
}

function boundedResultId(value: string, fallback: string): string {
  const resultId = value || fallback;
  if (resultId.length > MAX_RESULT_ID_CHARS) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an oversized image result id.');
  }
  return resultId;
}

function boundedMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const record = recordValue(value);
  if (record === null) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned invalid image metadata.');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(record);
  } catch {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned invalid image metadata.');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned oversized image metadata.');
  }
  return record;
}

function outputUrlAsset(
  rawUrl: string,
  resultId: string,
  claimedMimeType: string | undefined,
  options: OpenAiImageResultOptions,
  metadata?: Readonly<Record<string, unknown>>,
): SubmittedAsset {
  if (rawUrl.length > MAX_OUTPUT_URL_CHARS) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an oversized image URL.');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an invalid image URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an image URL with an unsupported protocol.');
  }
  if (url.username || url.password) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned an image URL with embedded credentials.');
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
      throw new OpenAiResponseError('invalid_response', 'OpenAI returned an image URL with credential-like query data.');
    }
  }
  const inferred = inferMimeType(rawUrl);
  if (claimedMimeType === undefined && inferred === undefined && /\.[a-z0-9]+(?:$|[?#])/i.test(url.pathname)) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a URL with an unknown media extension.');
  }
  const mimeType = claimedMimeType === undefined
    ? inferred ?? mimeTypeForOutputFormat(options.outputFormat)
    : normalizeMimeType(claimedMimeType);
  if (!supportedMimeType(mimeType) && !(claimedMimeType === undefined && mimeType === 'application/octet-stream')) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned a URL with a non-image MIME type.');
  }
  return {
    type: 'image',
    mimeType,
    source: 'url',
    url: rawUrl,
    resultId,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function assetFromValue(
  value: unknown,
  resultIndex: number,
  options: OpenAiImageResultOptions,
): SubmittedAsset | null {
  const record = recordValue(value);
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return dataUrlAsset(value, `image-${resultIndex}`, options);
    if (/^https?:\/\//i.test(value)) {
      return outputUrlAsset(value, `image-${resultIndex}`, undefined, options);
    }
    return normalizeBase64Image(value, options).base64 === value
      ? { type: 'image', mimeType: mimeTypeForOutputFormat(options.outputFormat), source: 'base64', base64: value, resultId: `image-${resultIndex}` }
      : null;
  }
  if (!record) return null;
  const id = boundedResultId(stringValue(record.id) ?? '', `image-${resultIndex}`);
  const metadata = boundedMetadata(record.metadata);
  const claimedMimeType = stringValue(record.mime_type) ?? stringValue(record.content_type) ?? undefined;
  const b64 = stringValue(record.b64_json) ?? stringValue(record.base64) ?? stringValue(record.result);
  if (b64 !== null) {
    if (/^https?:\/\//i.test(b64)) {
      return outputUrlAsset(b64, id, claimedMimeType, options, metadata);
    }
    if (b64.startsWith('data:')) {
      return dataUrlAsset(b64, id, options, metadata);
    }
    const normalized = normalizeBase64Image(b64, options);
    if (claimedMimeType !== undefined && !supportedMimeType(claimedMimeType)) {
      throw new OpenAiResponseError('invalid_response', 'OpenAI returned a non-image Base64 MIME type.');
    }
    return {
      type: 'image',
      mimeType: claimedMimeType === undefined ? normalized.mimeType : normalizeMimeType(claimedMimeType),
      source: 'base64',
      base64: normalized.base64,
      resultId: id,
      ...(metadata === undefined ? {} : { metadata }),
    };
  }
  const imageUrl = recordValue(record.image_url);
  const url = stringValue(record.url) ?? stringValue(record.image_url) ?? stringValue(imageUrl?.url);
  if (url !== null && /^https?:\/\//i.test(url)) {
    return outputUrlAsset(url, id, claimedMimeType, options, metadata);
  }
  return null;
}

function nestedOutput(value: unknown): readonly unknown[] {
  const record = recordValue(value);
  if (!record) return [];
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.output)) return record.output;
  if (Array.isArray(record.images)) return record.images;
  if (record.image !== undefined) return [record.image];
  return [];
}

export function normalizeImageResponse(
  value: unknown,
  options: OpenAiImageResultOptions = {},
): readonly SubmittedAsset[] {
  const candidates: unknown[] = [...nestedOutput(value)];
  const record = recordValue(value);
  const response = recordValue(record?.response);
  if (response) candidates.push(...nestedOutput(response));
  const output = recordValue(record?.output);
  if (output && output.type === 'image_generation_call') candidates.push(output);
  if (record && (record.type === 'image_generation_call' || record.type === 'response.output_item.done')) {
    candidates.push(record);
  }
  const assets: SubmittedAsset[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const asset = assetFromValue(candidate, index, options);
    if (asset) assets.push(asset);
  }
  if (assets.length === 0) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned no image result.');
  }
  if (options.maxAssets !== undefined && assets.length > options.maxAssets) {
    throw new OpenAiResponseError('invalid_response', 'OpenAI returned more images than requested.');
  }
  return assets;
}

export const normalizeOpenAiImageResponse = normalizeImageResponse;

export function dataUrlForAsset(asset: OpenAiInputAsset): string {
  return `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`;
}

export function buildResponsesPayload(
  request: GenerationRequest,
  options: OpenAiImageRequestOptions,
  inputs: readonly OpenAiInputAsset[],
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    { type: 'input_text', text: request.prompt },
    ...inputs
      .filter((input) => input.role !== 'mask')
      .map((input) => ({
        type: 'input_image',
        image_url: dataUrlForAsset(input),
      })),
  ];
  const input: unknown = inputs.length === 0
    ? request.prompt
    : [{ role: 'user', content }];
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    ...(options.background === undefined ? {} : { background: options.background }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.moderation === undefined ? {} : { moderation: options.moderation }),
    ...(options.partialImages === undefined ? {} : { partial_images: options.partialImages }),
  };
  return {
    model: options.model,
    input,
    tools: [tool],
    ...(options.stream === true ? { stream: true } : {}),
  };
}

export function assertResponsesImagePayload(value: unknown): asserts value is Record<string, unknown> {
  const payload = assertPayloadObject(value, 'Responses image');
  assertKnownKeys(payload, new Set(['model', 'input', 'tools', 'stream']), 'Responses image');
  if (typeof payload.model !== 'string' || payload.input === undefined || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    throw new OpenAiValidationError('invalid_payload', 'Responses image requires model, input, and tools.');
  }
  if (payload.stream !== undefined && typeof payload.stream !== 'boolean') {
    throw new OpenAiValidationError('invalid_payload', 'Responses image stream must be a boolean.');
  }
  for (const tool of payload.tools) {
    const record = assertPayloadObject(tool, 'Responses image tool');
    assertKnownKeys(record, new Set(['type', 'background', 'quality', 'size', 'moderation', 'partial_images']), 'Responses image tool');
    if (record.type !== 'image_generation') {
      throw new OpenAiValidationError('invalid_payload', 'Responses image tool type must be image_generation.');
    }
    if (record.quality !== undefined && (typeof record.quality !== 'string' || !VALID_QUALITIES.has(record.quality))) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image quality is invalid.');
    }
    if (record.background !== undefined && (typeof record.background !== 'string' || !VALID_BACKGROUNDS.has(record.background))) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image background is invalid.');
    }
    if (record.size !== undefined && (typeof record.size !== 'string' || !FIXED_SIZES.has(record.size))) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image size is invalid.');
    }
    if (record.moderation !== undefined && (typeof record.moderation !== 'string' || !VALID_MODERATION.has(record.moderation))) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image moderation is invalid.');
    }
    if (
      record.partial_images !== undefined &&
      (typeof record.partial_images !== 'number' || !Number.isSafeInteger(record.partial_images) || record.partial_images < 0 || record.partial_images > 3)
    ) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image partial_images is invalid.');
    }
    if (record.partial_images !== undefined && payload.stream !== true) {
      throw new OpenAiValidationError('invalid_payload', 'Responses image partial_images requires stream=true.');
    }
  }
}

export function bodyToString(body: OpenAiHttpBody): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}
