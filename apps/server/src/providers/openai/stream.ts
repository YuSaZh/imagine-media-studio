import type { SubmittedAsset } from '@imagine/provider-contract';

import {
  normalizeBase64Image,
  normalizeImageResponse,
  type OpenAiImageResultOptions,
} from './protocol.js';
import type { OpenAiImagePartial, OpenAiStreamResult } from './types.js';

export interface ServerSentEvent {
  readonly event: string | null;
  readonly data: string;
  readonly id: string | null;
}

export interface SseChunkResult {
  readonly events: readonly ServerSentEvent[];
  readonly remainder: string;
}

interface MutableEvent {
  event: string | null;
  data: string[];
  id: string | null;
}

function emptyEvent(): MutableEvent {
  return { event: null, data: [], id: null };
}

function emit(current: MutableEvent, events: ServerSentEvent[]): void {
  if (current.data.length === 0 && current.event === null && current.id === null) return;
  events.push({
    event: current.event,
    data: current.data.join('\n'),
    id: current.id,
  });
}

/**
 * Parse one SSE chunk while retaining an incomplete final line. This is pure
 * and deliberately does not assume that HTTP chunks align with SSE records.
 */
export function parseSseChunk(chunk: string, previousRemainder = ''): SseChunkResult {
  const input = `${previousRemainder}${chunk}`.replace(/\r\n?/g, '\n');
  const recordEnd = input.lastIndexOf('\n\n');
  if (recordEnd < 0) return { events: [], remainder: input };
  const completeInput = input.slice(0, recordEnd + 2);
  const remainder = input.slice(recordEnd + 2);
  const lines = completeInput.split(/\n/);
  const completeLines = lines;
  const events: ServerSentEvent[] = [];
  const current = emptyEvent();

  for (const rawLine of completeLines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      emit(current, events);
      current.event = null;
      current.data = [];
      current.id = null;
      continue;
    }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1
      ? ''
      : line.slice(separator + 1).startsWith(' ')
        ? line.slice(separator + 2)
        : line.slice(separator + 1);
    if (field === 'event') current.event = value;
    else if (field === 'data') current.data.push(value);
    else if (field === 'id') current.id = value;
  }

  return { events, remainder };
}

/** Parse a complete fixture or buffered SSE document. */
export function parseSseEvents(input: string): readonly ServerSentEvent[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  const complete = normalized.endsWith('\n\n') ? normalized : `${normalized}\n\n`;
  const result = parseSseChunk(complete);
  return result.events;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function extractAsset(value: unknown, options: OpenAiImageResultOptions): SubmittedAsset | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = stringValue(record.type);
  const result = stringValue(record.result) ?? stringValue(record.b64_json);
  const imageUrl = asRecord(record.image_url);
  const url = stringValue(record.url) ?? stringValue(record.image_url) ?? stringValue(imageUrl?.url);
  if (
    result !== null ||
    url !== null ||
    type === 'image_generation_call'
  ) {
    return normalizeImageResponse({ data: [record] }, options)[0] ?? null;
  }
  return null;
}

/**
 * Normalize image-related Responses/Image API stream events. The function is
 * intentionally tolerant of the small naming differences between the two
 * official streaming event families and OpenAI-compatible relays.
 */
export function parseOpenAiImageStream(
  input: string | readonly ServerSentEvent[],
  options: OpenAiImageResultOptions = {},
): OpenAiStreamResult {
  const events = typeof input === 'string' ? parseSseEvents(input) : input;
  const partials: OpenAiImagePartial[] = [];
  const assets: SubmittedAsset[] = [];
  let done = false;

  for (const event of events) {
    if (event.data === '[DONE]') {
      done = true;
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data) as unknown;
    } catch {
      continue;
    }
    const record = asRecord(payload);
    if (!record) continue;
    const eventType = stringValue(record.type) ?? event.event;
    const b64 = stringValue(record.b64_json) ?? stringValue(record.partial_image_b64);
    if (
      b64 !== null &&
      (eventType === 'image_generation.partial_image' ||
        eventType === 'response.image_generation_call.partial_image' ||
        eventType === 'image_generation_call.partial_image')
    ) {
      const normalized = normalizeBase64Image(b64, options);
      partials.push({
        index: integerValue(record.partial_image_index) ?? partials.length,
        base64: normalized.base64,
        mimeType: normalized.mimeType,
      });
      continue;
    }
    const outputItem = record.item ?? record.output_item;
    const outputAsset = extractAsset(outputItem, options);
    if (outputAsset) {
      assets.push(outputAsset);
      done = done || eventType === 'response.output_item.done';
      continue;
    }
    const directAsset = extractAsset(record, options);
    if (directAsset) {
      assets.push(directAsset);
      done = done || eventType === 'response.image_generation_call.completed' || eventType === 'image_generation.completed';
      continue;
    }
    if (eventType === 'response.completed' || eventType === 'image_generation.completed') {
      done = true;
      const response = asRecord(record.response);
      const outputCandidates = [
        ...(Array.isArray(response?.output) ? response.output : []),
        ...(Array.isArray(record.data) ? record.data : []),
      ];
      for (const item of outputCandidates) {
        const asset = extractAsset(item, options);
        if (asset) assets.push(asset);
      }
    }
  }

  return { partials, assets, done };
}

export const parseOpenAiImageStreamEvents = parseOpenAiImageStream;
export const parseImageGenerationStream = parseOpenAiImageStream;
export const parseOpenAiStream = parseOpenAiImageStream;
export const parseOpenAiSseEvents = parseSseEvents;
