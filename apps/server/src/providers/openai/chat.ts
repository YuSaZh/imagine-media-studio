import type { GenerationRequest } from '@imagine/shared';
import type { SubmittedAsset } from '@imagine/provider-contract';
import { dataUrlForAsset, normalizeImageResponse } from './protocol.js';
import { parseSseEvents } from './stream.js';
import { OpenAiResponseError, OpenAiValidationError, type OpenAiInputAsset } from './types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function validateChatImageOptions(request: GenerationRequest): void {
  if (request.count !== undefined && request.count !== 1) throw new OpenAiValidationError('unsupported_option', 'Chat image generation creates one image per call.');
  for (const key of ['negativePrompt', 'width', 'height', 'durationSeconds', 'fps', 'quality', 'format', 'seed', 'audio'] as const) {
    if (request[key] !== undefined) throw new OpenAiValidationError('unsupported_option', `Chat image generation does not support ${key}.`);
  }
  for (const [key, value] of Object.entries(request.extra ?? {})) {
    if (key !== 'stream' || typeof value !== 'boolean') throw new OpenAiValidationError('unsupported_option', `Chat image generation does not support extra.${key}.`);
  }
  if (request.aspectRatio !== undefined && !/^(auto|[1-9]\d*:[1-9]\d*)$/.test(request.aspectRatio)) throw new OpenAiValidationError('unsupported_option', 'Chat image aspect ratio is invalid.');
  if (request.resolution !== undefined && !['auto', '512', '1K', '2K', '4K'].includes(request.resolution)) throw new OpenAiValidationError('unsupported_option', 'Chat image resolution must be 512, 1K, 2K or 4K.');
}

export function buildChatImagePayload(request: GenerationRequest, inputs: readonly OpenAiInputAsset[]): Record<string, unknown> {
  validateChatImageOptions(request);
  const imageConfig = {
    ...(request.aspectRatio && request.aspectRatio !== 'auto' ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.resolution && request.resolution !== 'auto' ? { image_size: request.resolution } : {}),
  };
  return {
    model: request.modelId.replace(/^models\//, ''),
    messages: [{ role: 'user', content: [
      { type: 'text', text: request.prompt },
      ...inputs.map(input => ({ type: 'image_url', image_url: { url: dataUrlForAsset(input) } })),
    ] }],
    modalities: ['image', 'text'],
    stream: request.extra?.stream === true,
    ...(Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
  };
}

function messageImages(message: Record<string, unknown>): unknown[] {
  const images = Array.isArray(message.images) ? [...message.images] : [];
  if (Array.isArray(message.content)) {
    for (const item of message.content) if (record(item)?.type === 'image_url') images.push(item);
  }
  return images;
}

export function normalizeChatImageResponse(payload: unknown, maxAssets = 1): readonly SubmittedAsset[] {
  const streaming = typeof payload === 'string';
  const events: unknown[] = streaming ? parseSseEvents(payload).filter(event => event.data !== '[DONE]').map(event => {
    try { return JSON.parse(event.data) as unknown; } catch { throw new OpenAiResponseError('invalid_response', 'Chat image stream contains invalid JSON.'); }
  }) : [payload];
  const images = new Map<string, unknown>();
  let finished = !streaming;
  for (const event of events) {
    const value = record(event);
    if (value?.error) throw new OpenAiResponseError('invalid_response', 'Chat image response contains an upstream error.');
    if (!Array.isArray(value?.choices)) continue;
    for (const [index, item] of value.choices.entries()) {
      const choice = record(item);
      if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'length') throw new OpenAiResponseError('invalid_response', 'Chat image generation was filtered or incomplete.');
      if (choice?.finish_reason === 'stop') finished = true;
      const message = record(choice?.message) ?? record(choice?.delta);
      if (!message) continue;
      for (const [imageIndex, image] of messageImages(message).entries()) {
        const imageRecord = record(image);
        const key = `${choice?.index ?? index}:${imageRecord?.index ?? imageIndex}`;
        images.set(key, image);
      }
    }
  }
  if (!finished) throw new OpenAiResponseError('invalid_response', 'Chat image stream ended before completion.');
  return normalizeImageResponse({ data: [...images.values()] }, { maxAssets });
}
