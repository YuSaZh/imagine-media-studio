import type {
  ModelCapabilities,
  ProviderCapabilities,
  ProviderModel,
} from '@imagine/provider-contract';

import { GeminiResponseError } from './errors.js';
import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  getGeminiModelProfile,
  supportedGeminiModels,
  type GeminiModelProfile,
} from './payload.js';

export const GEMINI_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const GEMINI_MAX_INLINE_INPUT_BYTES = 32 * 1024 * 1024;
export const GEMINI_MAX_INLINE_OUTPUT_BYTES = 64 * 1024 * 1024;
export const GEMINI_MAX_OUTPUT_ASSETS = 1;
export const GEMINI_MAX_RESULT_ID_LENGTH = 256;
export const GEMINI_MAX_RESPONSE_STRING_LENGTH = 4_096;
export const GEMINI_MAX_MODEL_ID_LENGTH = 255;
export const GEMINI_MAX_MODEL_DISPLAY_NAME_LENGTH = 255;
export const GEMINI_MAX_MODEL_COUNT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, fallback: string, max = GEMINI_MAX_RESPONSE_STRING_LENGTH): string {
  const safeFallback = fallback.slice(0, max);
  if (typeof value !== 'string' || value.trim() === '') return safeFallback;
  const text = value.trim();
  return text.length <= max ? text : safeFallback;
}

export function geminiModelCapabilities(
  profile: GeminiModelProfile,
  interactions: boolean,
): ModelCapabilities {
  const inputImageConstraints = {
    mimeTypes: GEMINI_IMAGE_MIME_TYPES,
    maxBytes: GEMINI_MAX_INLINE_INPUT_BYTES,
    ...(interactions ? {} : { maxPixels: 100_000_000, maxWidth: 16_384, maxHeight: 16_384 }),
  };
  return {
    operations: ['image.generate', 'image.edit'],
    aspectRatios: profile.aspectRatios,
    resolutions: profile.resolutions,
    maxReferenceImages: profile.maxReferenceImages,
    inputImageConstraints,
    supportsMask: false,
    supportsNegativePrompt: false,
    supportsSeed: !interactions,
    supportsAudio: false,
    supportsProgress: false,
    supportsCancel: false,
    supportsBatchCount: false,
    customFields: interactions
      ? { type: 'object', properties: { previous_interaction_id: { type: 'string' } }, additionalProperties: false }
      : { type: 'object', additionalProperties: false },
  };
}

export function staticGeminiCapabilities(
  providerType: string,
  interactions: boolean,
): ProviderCapabilities {
  return {
    providerType,
    models: supportedGeminiModels().map((profile) => ({
      id: profile.id,
      displayName: interactions ? `${profile.displayName} (Interactions)` : profile.displayName,
      capabilities: geminiModelCapabilities(profile, interactions),
    })),
  };
}

function canonicalModelId(value: string): string {
  return value.trim().replace(/^models\//u, '');
}

/** Parse the bounded, first-page shape returned by Google's ListModels endpoint. */
export function parseGeminiModelCatalog(value: unknown, interactions: boolean): readonly ProviderModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new GeminiResponseError('Gemini models response is invalid.');
  }
  if (value.models.length > GEMINI_MAX_MODEL_COUNT) {
    throw new GeminiResponseError('Gemini models response exceeds the model limit.');
  }
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of value.models) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    const id = canonicalModelId(entry.name);
    if (id.length === 0 || id.length > GEMINI_MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    const methods = Array.isArray(entry.supportedGenerationMethods)
      ? entry.supportedGenerationMethods.filter((method): method is string => typeof method === 'string')
      : [];
    if (!methods.some((method) => method.toLowerCase() === 'generatecontent')) continue;
    let profile: GeminiModelProfile;
    try {
      profile = getGeminiModelProfile(id);
    } catch {
      // The provider may advertise text, embedding, or future non-image models.
      // Only the conservative image-model grammar is eligible here.
      continue;
    }
    seen.add(id);
    const suffix = interactions ? ' (Interactions)' : '';
    models.push({
      id,
      displayName: `${boundedText(
        entry.displayName,
        profile.displayName,
        GEMINI_MAX_MODEL_DISPLAY_NAME_LENGTH - suffix.length,
      )}${suffix}`,
      capabilities: geminiModelCapabilities(profile, interactions),
    });
  }
  return models;
}

export function liveGeminiCapabilities(
  providerType: string,
  value: unknown,
  interactions: boolean,
): ProviderCapabilities {
  return { providerType, models: parseGeminiModelCatalog(value, interactions) };
}

export {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
};
