import { GeminiValidationError } from './errors.js';

const FORBIDDEN_HEADER_NAMES = new Set([
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
  'x-goog-api-key',
]);

export function assertGeminiHeader(name: string, value: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\r\n]/u.test(value)) {
    throw new GeminiValidationError(`Gemini custom header '${name}' is invalid.`, 'gemini_header_invalid');
  }
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    throw new GeminiValidationError(`Gemini custom header '${name}' is not allowed.`, 'gemini_header_invalid');
  }
}

function mergeCustomHeader(headers: Record<string, string>, name: string, value: string): void {
  assertGeminiHeader(name, value);
  const normalized = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === normalized) delete headers[existing];
  }
  headers[name] = value;
}

export function buildGeminiHeaders(
  apiKey: string,
  sources: readonly (Readonly<Record<string, unknown>> | undefined)[],
  secretHeaders: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
  };
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value === 'string') mergeCustomHeader(headers, name, value);
    }
  }
  for (const [name, value] of Object.entries(secretHeaders)) mergeCustomHeader(headers, name, value);
  return headers;
}
