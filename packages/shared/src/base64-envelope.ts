export type Base64EnvelopeErrorCode =
  | 'base64_too_large'
  | 'invalid_base64'
  | 'invalid_data_url'
  | 'invalid_size_limit'
  | 'unsupported_mime_type';

export class Base64EnvelopeError extends Error {
  public override readonly name = 'Base64EnvelopeError';

  public constructor(
    public readonly code: Base64EnvelopeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Base64Envelope {
  readonly mimeType: string;
  readonly payload: string;
  readonly decodedBytes: number;
}

export interface ParseBase64EnvelopeOptions {
  readonly allowedMimeTypes?: readonly string[];
  readonly maxDecodedBytes: number;
}

const DATA_URL = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const MAX_BASE64_DATA_URL_HEADER_CHARS = 256;

function assertCanonicalPadding(payload: string): void {
  if (payload.endsWith('==')) {
    const value = BASE64_ALPHABET.indexOf(payload.at(-3) ?? '');
    if (value < 0 || (value & 0x0f) !== 0) {
      throw new Base64EnvelopeError('invalid_base64', 'Base64 padding bits are not canonical.');
    }
  } else if (payload.endsWith('=')) {
    const value = BASE64_ALPHABET.indexOf(payload.at(-2) ?? '');
    if (value < 0 || (value & 0x03) !== 0) {
      throw new Base64EnvelopeError('invalid_base64', 'Base64 padding bits are not canonical.');
    }
  }
}

export function estimateBase64DecodedBytes(payload: string): number {
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(payload)
  ) {
    throw new Base64EnvelopeError('invalid_base64', 'Base64 payload is not canonical.');
  }
  assertCanonicalPadding(payload);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

export function parseBase64Envelope(
  dataUrl: string,
  options: ParseBase64EnvelopeOptions,
): Base64Envelope {
  if (!Number.isSafeInteger(options.maxDecodedBytes) || options.maxDecodedBytes <= 0) {
    throw new Base64EnvelopeError(
      'invalid_size_limit',
      'Maximum decoded bytes must be a positive safe integer.',
    );
  }
  const commaIndex = dataUrl.indexOf(',');
  const maximumPayloadCharacters = Math.ceil(options.maxDecodedBytes / 3) * 4;
  const payloadTooLarge =
    commaIndex >= 0 && dataUrl.length - commaIndex - 1 > maximumPayloadCharacters;
  if (
    commaIndex < 0 ||
    commaIndex > MAX_BASE64_DATA_URL_HEADER_CHARS ||
    payloadTooLarge
  ) {
    throw new Base64EnvelopeError(
      payloadTooLarge ? 'base64_too_large' : 'invalid_data_url',
      'Data URL header or encoded payload exceeds its limit.',
    );
  }
  const match = DATA_URL.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Base64EnvelopeError(
      'invalid_data_url',
      'Only strict MIME-typed Base64 data URLs are supported.',
    );
  }
  const mimeType = match[1].toLowerCase();
  if (
    options.allowedMimeTypes !== undefined &&
    !options.allowedMimeTypes.some((allowed) => allowed.toLowerCase() === mimeType)
  ) {
    throw new Base64EnvelopeError(
      'unsupported_mime_type',
      `Data URL MIME type ${mimeType} is not allowed.`,
    );
  }
  const decodedBytes = estimateBase64DecodedBytes(match[2]);
  if (decodedBytes > options.maxDecodedBytes) {
    throw new Base64EnvelopeError(
      'base64_too_large',
      `Decoded payload exceeds ${options.maxDecodedBytes} bytes.`,
    );
  }
  return { mimeType, payload: match[2], decodedBytes };
}
