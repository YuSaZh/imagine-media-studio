import { imageDimensionsPreset, type GenerationRequest } from '@imagine/shared';
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
  const dimensions = request.resolution ? imageDimensionsPreset(request.resolution) : undefined;
  if (request.resolution !== undefined && !dimensions && !['auto', '512', '1K', '2K', '4K'].includes(request.resolution)) throw new OpenAiValidationError('unsupported_option', 'Chat image pixel dimensions must map to a supported aspect ratio and 1K, 2K or 4K preset.');
  if (dimensions && request.aspectRatio && request.aspectRatio !== 'auto' && request.aspectRatio !== dimensions.ratio) throw new OpenAiValidationError('unsupported_option', 'Chat image pixel dimensions conflict with the selected aspect ratio.');
}

export function buildChatImagePayload(request: GenerationRequest, inputs: readonly OpenAiInputAsset[]): Record<string, unknown> {
  validateChatImageOptions(request);
  const dimensions = request.resolution ? imageDimensionsPreset(request.resolution) : undefined;
  const imageConfig = {
    ...(request.aspectRatio && request.aspectRatio !== 'auto' ? { aspect_ratio: request.aspectRatio } : {}),
    ...(request.resolution && request.resolution !== 'auto' ? { image_size: request.resolution } : {}),
    ...(dimensions ? { aspect_ratio: dimensions.ratio, image_size: dimensions.preset } : {}),
  };
  return {
    model: request.modelId.replace(/^models\//, ''),
    messages: [{ role: 'user', content: [
      { type: 'text', text: request.prompt },
      ...inputs.map(input => ({ type: 'image_url', image_url: { url: dataUrlForAsset(input) } })),
    ] }],
    modalities: ['image', 'text'],
    stream: request.extra?.stream === true,
    ...(Object.keys(imageConfig).length ? { image_config: imageConfig, extra_body: { google: { image_config: imageConfig } } } : {}),
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
  const textByChoice = new Map<string, string[]>();
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
      const choiceKey = String(choice?.index ?? index);
      const texts = typeof message.content === 'string' ? [message.content] : Array.isArray(message.content)
        ? message.content.flatMap(item => { const part = record(item); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []; }) : [];
      if (texts.length) {
        const chunks = textByChoice.get(choiceKey) ?? [];
        chunks.push(...texts);
        textByChoice.set(choiceKey, chunks);
      }
      for (const [imageIndex, image] of messageImages(message).entries()) {
        const imageRecord = record(image);
        const key = `${choice?.index ?? index}:${imageRecord?.index ?? imageIndex}`;
        images.set(key, image);
      }
    }
  }
  if (!finished) throw new OpenAiResponseError('invalid_response', 'Chat image stream ended before completion.');
  // New API encodes inline images as Markdown; join SSE fragments once so a
  // data URL split across chunks is validated by the existing image normalizer.
  for (const [choiceKey, chunks] of textByChoice) {
    const text = chunks.join('');
    const pattern = /!\[[^\]\r\n]{0,256}\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)]*)\)/g;
    for (const [index, match] of [...text.matchAll(pattern)].entries()) {
      images.set(`${choiceKey}:markdown:${index}`, { image_url: { url: match[1] } });
    }
  }
  return normalizeImageResponse({ data: [...images.values()] }, { maxAssets });
}
