import type { SubmittedAsset } from '@imagine/provider-contract';

import {
  GEMINI_IMAGE_MIME_TYPES,
  GEMINI_MAX_INLINE_OUTPUT_BYTES,
  GEMINI_MAX_OUTPUT_ASSETS,
  GEMINI_MAX_RESPONSE_STRING_LENGTH,
} from './catalog.js';
import { GeminiResponseError, redactSensitiveText } from './errors.js';

const SENSITIVE_QUERY_KEYS = new Set(['access_token', 'api_key', 'apikey', 'key', 'secret', 'token', 'x-goog-api-key']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: Record<string, unknown>, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}

function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'image/png';
  if (value.length > 256) return 'application/octet-stream';
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? 'image/png';
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function boundedText(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > GEMINI_MAX_RESPONSE_STRING_LENGTH) return fallback;
  return value;
}

function safeResourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GeminiResponseError('Gemini returned a file resource without a URI.');
  }
  if (raw.length > GEMINI_MAX_RESPONSE_STRING_LENGTH) {
    throw new GeminiResponseError('Gemini returned a file resource URI that is too long.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeminiResponseError('Gemini returned an invalid file resource URI.');
  }
  if (url.protocol !== 'https:') {
    throw new GeminiResponseError('Gemini file resource URI must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new GeminiResponseError('Gemini file resource URI cannot contain credentials.');
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  const normalized = url.toString();
  if (normalized.length > GEMINI_MAX_RESPONSE_STRING_LENGTH) {
    throw new GeminiResponseError('Gemini file resource URI is too long.');
  }
  return redactSensitiveText(normalized);
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value;
}

function inlineAsset(value: Record<string, unknown>): SubmittedAsset {
  const dataValue = objectValue(value, 'data', 'data');
  const mimeType = normalizeMimeType(objectValue(value, 'mimeType', 'mime_type'));
  if (typeof dataValue !== 'string' || !validBase64(dataValue)) {
    throw new GeminiResponseError('Gemini returned invalid inline image data.');
  }
  if (Buffer.byteLength(dataValue, 'base64') > GEMINI_MAX_INLINE_OUTPUT_BYTES) {
    throw new GeminiResponseError('Gemini returned an image larger than the output size limit.');
  }
  if (!(GEMINI_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new GeminiResponseError(`Gemini returned a non-image MIME type '${boundedText(mimeType, 'unknown')}'.`);
  }
  return {
    type: 'image',
    mimeType,
    source: 'base64',
    base64: dataValue,
  };
}

function fileAsset(value: Record<string, unknown>): SubmittedAsset {
  const rawUri = objectValue(value, 'fileUri', 'file_uri') ?? value.uri;
  const mimeType = normalizeMimeType(objectValue(value, 'mimeType', 'mime_type'));
  if (!(GEMINI_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new GeminiResponseError(`Gemini returned a non-image MIME type '${boundedText(mimeType, 'unknown')}'.`);
  }
  return {
    type: 'image',
    mimeType,
    source: 'url',
    url: safeResourceUrl(rawUri),
  };
}

function imageFromPart(part: unknown): SubmittedAsset | null {
  if (!isRecord(part)) throw new GeminiResponseError('Gemini returned a malformed content part.');
  const inline = objectValue(part, 'inlineData', 'inline_data');
  if (inline !== undefined) {
    if (!isRecord(inline)) throw new GeminiResponseError('Gemini inlineData response is malformed.');
    return inlineAsset(inline);
  }
  const file = objectValue(part, 'fileData', 'file_data');
  if (file !== undefined) {
    if (!isRecord(file)) throw new GeminiResponseError('Gemini fileData response is malformed.');
    return fileAsset(file);
  }
  return null;
}

export interface GeminiImageResponseOptions {
  readonly maxAssets?: number;
}

/** Normalize both the documented camelCase REST response and legacy snake_case fixtures. */
export function normalizeGeminiImageResponse(
  value: unknown,
  options: GeminiImageResponseOptions = {},
): readonly SubmittedAsset[] {
  const maxAssets = options.maxAssets ?? GEMINI_MAX_OUTPUT_ASSETS;
  if (!Number.isSafeInteger(maxAssets) || maxAssets < 1) {
    throw new GeminiResponseError('Gemini output asset limit is invalid.');
  }
  if (!isRecord(value)) throw new GeminiResponseError('Gemini response must be a JSON object.');
  const promptFeedback = objectValue(value, 'promptFeedback', 'prompt_feedback');
  if (isRecord(promptFeedback) && promptFeedback.blockReason !== undefined) {
    throw new GeminiResponseError(
      `Gemini blocked the prompt (${boundedText(promptFeedback.blockReason, 'unknown')}).`,
      'gemini_content_blocked',
    );
  }
  const candidates = value.candidates;
  if (!Array.isArray(candidates)) throw new GeminiResponseError('Gemini response has no candidates.');

  const assets: SubmittedAsset[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) throw new GeminiResponseError('Gemini candidate is malformed.');
    const finishReason = objectValue(candidate, 'finishReason', 'finish_reason');
    const content = candidate.content;
    if (content !== undefined && !isRecord(content)) throw new GeminiResponseError('Gemini candidate content is malformed.');
    const parts = isRecord(content) ? content.parts : undefined;
    if (parts !== undefined && !Array.isArray(parts)) throw new GeminiResponseError('Gemini candidate parts are malformed.');
    for (const part of parts ?? []) {
      const image = imageFromPart(part);
      if (image) {
        if (assets.length >= maxAssets) {
          throw new GeminiResponseError('Gemini response contained more images than requested.', 'gemini_output_limit_exceeded');
        }
        assets.push(image);
      }
    }
    if (assets.length === 0 && typeof finishReason === 'string' && finishReason !== 'STOP') {
      const normalizedReason = finishReason.toLowerCase();
      if (normalizedReason.includes('safety') || normalizedReason.includes('prohibited') || normalizedReason.includes('image_')) {
        throw new GeminiResponseError(
          `Gemini did not return an image (${boundedText(finishReason, 'unknown')}).`,
          'gemini_content_blocked',
        );
      }
    }
  }
  if (assets.length === 0) throw new GeminiResponseError('Gemini response did not contain an image.');
  return assets;
}
