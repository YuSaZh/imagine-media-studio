import type { GenerationRequest } from '@imagine/shared';

import { GeminiValidationError } from './errors.js';
import type { GeminiInputAsset, GeminiProviderContext } from './types.js';

export const GEMINI_PROFILE = 'gemini-generate-content-image-v1' as const;
export const GEMINI_GENERATE_CONTENT_IMAGE_PROFILE = GEMINI_PROFILE;
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export const GEMINI_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;

export const GEMINI_IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;

const GEMINI_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const MAX_INLINE_INPUT_BYTES = 32 * 1024 * 1024;

export interface GeminiInlineData {
  mimeType: string;
  data: string;
}

export type GeminiContentPart =
  | { text: string }
  | { inlineData: GeminiInlineData };

export interface GeminiGenerateContentPayload {
  contents: readonly [{ role: 'user'; parts: readonly GeminiContentPart[] }];
  generationConfig: {
    responseModalities: readonly ['IMAGE'];
    imageConfig?: {
      aspectRatio?: string;
      imageSize?: string;
    };
    seed?: number;
  };
}

export interface GeminiModelProfile {
  id: string;
  displayName: string;
  maxReferenceImages: number;
  resolutions: readonly string[];
  aspectRatios: readonly string[];
}

const MODEL_PROFILES: readonly GeminiModelProfile[] = [
  {
    id: 'gemini-3.1-flash-lite-image',
    displayName: 'Gemini 3.1 Flash Lite Image',
    maxReferenceImages: 14,
    resolutions: ['1K'],
    aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  },
  {
    id: 'gemini-3.1-flash-image',
    displayName: 'Gemini 3.1 Flash Image',
    maxReferenceImages: 14,
    resolutions: ['512', '1K', '2K', '4K'],
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  },
  {
    id: 'gemini-3-pro-image',
    displayName: 'Gemini 3 Pro Image',
    maxReferenceImages: 14,
    resolutions: ['1K', '2K', '4K'],
    aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
  },
  {
    id: 'gemini-2.5-flash-image',
    displayName: 'Gemini 2.5 Flash Image',
    maxReferenceImages: 3,
    resolutions: ['1K'],
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'],
  },
];

const MODEL_PROFILE_BY_ID = new Map(MODEL_PROFILES.map((profile) => [profile.id, profile]));

export function supportedGeminiModels(): readonly GeminiModelProfile[] {
  return MODEL_PROFILES;
}

function canonicalModelId(modelId: string): string {
  const trimmed = modelId.trim();
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
}

export function getGeminiModelProfile(modelId: string): GeminiModelProfile {
  const canonical = canonicalModelId(modelId);
  const exact = MODEL_PROFILE_BY_ID.get(canonical);
  if (exact) return exact;
  if (/^gemini-[a-z0-9.-]+-image(?:-preview)?$/i.test(canonical)) {
    return {
      id: canonical,
      displayName: canonical,
      maxReferenceImages: 3,
      resolutions: GEMINI_IMAGE_SIZES,
      aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
    };
  }
  throw new GeminiValidationError(
    `Gemini image model '${modelId}' is not supported by ${GEMINI_PROFILE}.`,
    'gemini_model_unsupported',
  );
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function assertSupportedMimeType(input: GeminiInputAsset): string {
  const mimeType = normalizeMimeType(input.mimeType);
  if (!(GEMINI_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new GeminiValidationError(
      `Gemini does not accept image MIME type '${input.mimeType}'.`,
      'gemini_input_mime_unsupported',
    );
  }
  return mimeType;
}

function inputMap(context: GeminiProviderContext, request: GenerationRequest): Map<string, GeminiInputAsset> {
  const inputs = context.inputs ?? [];
  const map = new Map<string, GeminiInputAsset>();
  for (const input of inputs) {
    if (map.has(input.assetId)) {
      throw new GeminiValidationError(
        `Gemini input asset '${input.assetId}' is duplicated.`,
        'gemini_input_duplicate',
      );
    }
    if (!input.assetId.trim()) {
      throw new GeminiValidationError('Gemini input asset ids must not be empty.', 'gemini_input_invalid');
    }
    map.set(input.assetId, input);
  }

  for (const input of request.inputs) {
    const resolved = map.get(input.assetId);
    if (!resolved) {
      throw new GeminiValidationError(
        `Gemini input asset '${input.assetId}' has no resolved bytes or file URI.`,
        'gemini_input_unresolved',
      );
    }
    if (resolved.role !== input.role) {
      throw new GeminiValidationError(
        `Gemini input asset '${input.assetId}' has a mismatched role.`,
        'gemini_input_role_mismatch',
      );
    }
  }
  for (const input of inputs) {
    if (!request.inputs.some((requested) => requested.assetId === input.assetId)) {
      throw new GeminiValidationError(
        `Gemini input asset '${input.assetId}' is not part of the request.`,
        'gemini_input_unexpected',
      );
    }
  }
  return map;
}

function assertRequestShape(request: GenerationRequest, profile: GeminiModelProfile): void {
  if (!['image.generate', 'image.edit'].includes(request.operation)) {
    throw new GeminiValidationError(
      `Gemini image profile does not support ${request.operation}.`,
      'gemini_operation_unsupported',
    );
  }
  if (canonicalModelId(request.modelId) !== profile.id) {
    throw new GeminiValidationError(
      `Gemini request model '${request.modelId}' does not match the selected image model.`,
      'gemini_model_unsupported',
    );
  }

  const count = (role: GeminiInputAsset['role']) => request.inputs.filter((input) => input.role === role).length;
  const references = count('reference');
  if (references > profile.maxReferenceImages) {
    throw new GeminiValidationError(
      `Gemini image model '${profile.id}' accepts at most ${profile.maxReferenceImages} reference images.`,
      'gemini_reference_limit_exceeded',
    );
  }
  if (request.operation === 'image.generate') {
    if (request.inputs.some((input) => input.role !== 'reference')) {
      throw new GeminiValidationError(
        'Gemini image.generate accepts reference images only.',
        'gemini_input_role_unsupported',
      );
    }
  } else {
    if (count('source') !== 1 || count('mask') > 0 || count('first_frame') > 0 || count('last_frame') > 0) {
      throw new GeminiValidationError(
        'Gemini image.edit requires one source image and does not support masks or video frame roles.',
        'gemini_edit_inputs_invalid',
      );
    }
  }

  if (request.aspectRatio !== undefined && !profile.aspectRatios.includes(request.aspectRatio)) {
    throw new GeminiValidationError(
      `Gemini image model '${profile.id}' does not support aspect ratio '${request.aspectRatio}'.`,
      'gemini_aspect_ratio_unsupported',
    );
  }
  if (request.resolution !== undefined && !profile.resolutions.includes(request.resolution)) {
    throw new GeminiValidationError(
      `Gemini image model '${profile.id}' does not support resolution '${request.resolution}'.`,
      'gemini_resolution_unsupported',
    );
  }
  if (request.count !== undefined && request.count !== 1) {
    throw new GeminiValidationError(
      'Gemini generateContent image requests support exactly one candidate.',
      'gemini_batch_unsupported',
    );
  }

  const unsupported: ReadonlyArray<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt],
    ['width', request.width],
    ['height', request.height],
    ['durationSeconds', request.durationSeconds],
    ['fps', request.fps],
    ['quality', request.quality],
    ['format', request.format],
    ['audio', request.audio],
  ];
  const found = unsupported.find(([, value]) => value !== undefined);
  if (found) {
    throw new GeminiValidationError(
      `Gemini ${GEMINI_PROFILE} does not support ${found[0]}.`,
      'gemini_option_unsupported',
    );
  }
  if (request.extra !== undefined && Object.keys(request.extra).length > 0) {
    throw new GeminiValidationError(
      'Gemini generateContent image requests do not accept unrecognized extra fields.',
      'gemini_extra_fields_unsupported',
    );
  }
}

function inputPart(input: GeminiInputAsset): GeminiContentPart {
  const mimeType = assertSupportedMimeType(input);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new GeminiValidationError(
      `Gemini input asset '${input.assetId}' has empty or invalid bytes.`,
      'gemini_input_bytes_invalid',
    );
  }
  if (input.bytes.byteLength > MAX_INLINE_INPUT_BYTES) {
    throw new GeminiValidationError(
      `Gemini input asset '${input.assetId}' exceeds the inline input size limit.`,
      'gemini_input_too_large',
    );
  }
  return {
    inlineData: {
      mimeType,
      data: Buffer.from(input.bytes).toString('base64'),
    },
  };
}

export function buildGeminiGenerateContentPayload(
  request: GenerationRequest,
  context: GeminiProviderContext,
): GeminiGenerateContentPayload {
  if (request.providerId !== context.providerId) {
    throw new GeminiValidationError(
      'The Gemini generation request provider does not match the active provider.',
      'gemini_provider_mismatch',
    );
  }
  if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
    throw new GeminiValidationError('Gemini prompts cannot be empty.', 'gemini_prompt_empty');
  }
  const requestIds = new Set<string>();
  for (const input of request.inputs) {
    if (requestIds.has(input.assetId)) {
      throw new GeminiValidationError(
        `Gemini input asset '${input.assetId}' is duplicated in the request.`,
        'gemini_input_duplicate',
      );
    }
    requestIds.add(input.assetId);
  }
  const profile = getGeminiModelProfile(request.modelId);
  assertRequestShape(request, profile);
  const resolved = inputMap(context, request);
  const parts: GeminiContentPart[] = [{ text: request.prompt.trim() }];
  for (const input of request.inputs) {
    const resolvedInput = resolved.get(input.assetId);
    if (!resolvedInput) throw new GeminiValidationError('Gemini input resolution failed.');
    parts.push(inputPart(resolvedInput));
  }

  const imageConfig = {
    ...(request.aspectRatio === undefined ? {} : { aspectRatio: request.aspectRatio }),
    ...(request.resolution === undefined ? {} : { imageSize: request.resolution }),
  };
  const generationConfig = {
    responseModalities: ['IMAGE'] as const,
    ...(Object.keys(imageConfig).length === 0 ? {} : { imageConfig }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  };
  const payload: GeminiGenerateContentPayload = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };
  assertGeminiGenerateContentPayload(payload);
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '');
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new GeminiValidationError(`Gemini payload has an unsupported ${label} field '${key}'.`, 'gemini_payload_invalid');
    }
  }
}

function assertGeminiPart(value: unknown): void {
  if (!isRecord(value)) throw new GeminiValidationError('Gemini payload part must be an object.', 'gemini_payload_invalid');
  assertExactKeys(value, ['text', 'inlineData'], 'part');
  if (Object.keys(value).length !== 1) {
    throw new GeminiValidationError('Gemini payload part must contain exactly one data field.', 'gemini_payload_invalid');
  }
  if ('text' in value && (typeof value.text !== 'string' || value.text.length === 0)) {
    throw new GeminiValidationError('Gemini text payload parts must be non-empty strings.', 'gemini_payload_invalid');
  }
  if ('inlineData' in value) {
    if (!isRecord(value.inlineData)) throw new GeminiValidationError('Gemini inlineData must be an object.', 'gemini_payload_invalid');
    assertExactKeys(value.inlineData, ['mimeType', 'data'], 'inlineData');
    if (
      typeof value.inlineData.mimeType !== 'string' ||
      !GEMINI_IMAGE_MIME_TYPES.includes(normalizeMimeType(value.inlineData.mimeType) as (typeof GEMINI_IMAGE_MIME_TYPES)[number]) ||
      typeof value.inlineData.data !== 'string' ||
      !validBase64(value.inlineData.data) ||
      Buffer.byteLength(value.inlineData.data, 'base64') > MAX_INLINE_INPUT_BYTES
    ) {
      throw new GeminiValidationError('Gemini inlineData requires mimeType and data.', 'gemini_payload_invalid');
    }
  }
}

/** Rejects payload fields outside the documented generateContent image subset. */
export function assertGeminiGenerateContentPayload(value: unknown): asserts value is GeminiGenerateContentPayload {
  if (!isRecord(value)) throw new GeminiValidationError('Gemini payload must be an object.', 'gemini_payload_invalid');
  assertExactKeys(value, ['contents', 'generationConfig'], 'request');
  if (!Array.isArray(value.contents) || value.contents.length !== 1) {
    throw new GeminiValidationError('Gemini payload must contain one user content.', 'gemini_payload_invalid');
  }
  const content = value.contents[0];
  if (!isRecord(content)) throw new GeminiValidationError('Gemini content must be an object.', 'gemini_payload_invalid');
  assertExactKeys(content, ['role', 'parts'], 'content');
  if (content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length < 1) {
    throw new GeminiValidationError('Gemini content must be a user message with parts.', 'gemini_payload_invalid');
  }
  for (const part of content.parts) assertGeminiPart(part);

  if (!isRecord(value.generationConfig)) {
    throw new GeminiValidationError('Gemini generationConfig must be an object.', 'gemini_payload_invalid');
  }
  assertExactKeys(value.generationConfig, ['responseModalities', 'imageConfig', 'seed'], 'generationConfig');
  if (!Array.isArray(value.generationConfig.responseModalities) || value.generationConfig.responseModalities.length !== 1 || value.generationConfig.responseModalities[0] !== 'IMAGE') {
    throw new GeminiValidationError('Gemini image payload must request the IMAGE modality only.', 'gemini_payload_invalid');
  }
  if ('seed' in value.generationConfig && (typeof value.generationConfig.seed !== 'number' || !Number.isSafeInteger(value.generationConfig.seed))) {
    throw new GeminiValidationError('Gemini seed must be a safe integer.', 'gemini_payload_invalid');
  }
  if ('imageConfig' in value.generationConfig) {
    const imageConfig = value.generationConfig.imageConfig;
    if (!isRecord(imageConfig)) throw new GeminiValidationError('Gemini imageConfig must be an object.', 'gemini_payload_invalid');
    assertExactKeys(imageConfig, ['aspectRatio', 'imageSize'], 'imageConfig');
    if ('aspectRatio' in imageConfig && typeof imageConfig.aspectRatio !== 'string') {
      throw new GeminiValidationError('Gemini aspectRatio must be a string.', 'gemini_payload_invalid');
    }
    if ('aspectRatio' in imageConfig && !GEMINI_IMAGE_ASPECT_RATIOS.includes(imageConfig.aspectRatio as (typeof GEMINI_IMAGE_ASPECT_RATIOS)[number])) {
      throw new GeminiValidationError('Gemini aspectRatio is unsupported.', 'gemini_payload_invalid');
    }
    if ('imageSize' in imageConfig && typeof imageConfig.imageSize !== 'string') {
      throw new GeminiValidationError('Gemini imageSize must be a string.', 'gemini_payload_invalid');
    }
    if ('imageSize' in imageConfig && !GEMINI_IMAGE_SIZES.includes(imageConfig.imageSize as (typeof GEMINI_IMAGE_SIZES)[number])) {
      throw new GeminiValidationError('Gemini imageSize is unsupported.', 'gemini_payload_invalid');
    }
  }
}

export function buildGeminiGenerateContentUrl(baseUrl: string, modelId: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GeminiValidationError('Gemini base URL is invalid.', 'gemini_base_url_invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new GeminiValidationError('Gemini base URL cannot contain credentials, query, or fragment.', 'gemini_base_url_invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GeminiValidationError('Gemini base URL must use HTTP or HTTPS.', 'gemini_base_url_invalid');
  }
  const model = canonicalModelId(modelId);
  if (!/^gemini-[a-z0-9.-]+-image(?:-preview)?$/i.test(model)) {
    throw new GeminiValidationError(`Gemini model '${modelId}' is not an image model.`, 'gemini_model_unsupported');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith(':generateContent')) {
    const match = /^(.*\/models\/)[^/:]+:generateContent$/u.exec(path);
    if (!match || match[1] === undefined) {
      throw new GeminiValidationError(
        'Gemini generateContent URL must include a models/{model} path.',
        'gemini_base_url_invalid',
      );
    }
    url.pathname = `${match[1]}${encodeURIComponent(model)}:generateContent`;
    return url.toString();
  }
  const modelPath = path.endsWith(`/models/${encodeURIComponent(model)}`)
    ? path
    : `${path}/models/${encodeURIComponent(model)}`;
  url.pathname = `${modelPath}:generateContent`;
  return url.toString();
}
