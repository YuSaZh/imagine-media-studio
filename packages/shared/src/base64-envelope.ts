export type Base64EnvelopeErrorCode =
  | 'base64_too_large'
  | 'decode_failed'
  | 'decoder_unavailable'
  | 'decoded_length_mismatch'
  | 'invalid_base64'
  | 'invalid_decoded_output'
  | 'invalid_data_url'
  | 'invalid_size_limit'
  | 'unsupported_mime_type';

export class Base64EnvelopeError extends Error {
  public override readonly name = 'Base64EnvelopeError';

  public constructor(
    public readonly code: Base64EnvelopeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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

export interface Base64DecoderPort {
  decode(payload: string, signal?: AbortSignal): Promise<Uint8Array> | Uint8Array;
}

export interface DecodeBase64EnvelopeOptions extends ParseBase64EnvelopeOptions {
  readonly decoder?: Base64DecoderPort;
  readonly signal?: AbortSignal;
}

export interface DecodedBase64Envelope {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
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

export const browserAtobBase64Decoder: Base64DecoderPort = {
  decode(payload, signal) {
    signal?.throwIfAborted();
    if (typeof globalThis.atob !== 'function') {
      throw new Base64EnvelopeError(
        'decoder_unavailable',
        'This environment does not provide a Base64 decoder.',
      );
    }
    const binary = globalThis.atob(payload);
    signal?.throwIfAborted();
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    signal?.throwIfAborted();
    return bytes;
  },
};

export async function decodeBase64Envelope(
  dataUrl: string,
  options: DecodeBase64EnvelopeOptions,
): Promise<DecodedBase64Envelope> {
  options.signal?.throwIfAborted();
  const envelope = parseBase64Envelope(dataUrl, options);
  options.signal?.throwIfAborted();

  let bytes: Uint8Array;
  try {
    bytes = await (options.decoder ?? browserAtobBase64Decoder).decode(
      envelope.payload,
      options.signal,
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Base64EnvelopeError && error.code === 'decoder_unavailable') {
      throw error;
    }
    throw new Base64EnvelopeError(
      'decode_failed',
      'The Base64 payload could not be decoded.',
      { cause: error },
    );
  }
  options.signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array)) {
    throw new Base64EnvelopeError(
      'invalid_decoded_output',
      'The Base64 decoder must return a Uint8Array.',
    );
  }
  if (bytes.byteLength !== envelope.decodedBytes) {
    throw new Base64EnvelopeError(
      'decoded_length_mismatch',
      `Decoded Base64 length ${bytes.byteLength} does not match the expected ${envelope.decodedBytes} bytes.`,
    );
  }
  return { bytes, mimeType: envelope.mimeType };
}

export async function base64DataUrlToBlob(
  dataUrl: string,
  options: DecodeBase64EnvelopeOptions,
): Promise<Blob> {
  const decoded = await decodeBase64Envelope(dataUrl, options);
  options.signal?.throwIfAborted();
  const blobBytes = new Uint8Array(decoded.bytes.byteLength);
  blobBytes.set(decoded.bytes);
  const blob = new Blob([blobBytes.buffer], { type: decoded.mimeType });
  options.signal?.throwIfAborted();
  return blob;
}
