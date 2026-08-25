import {
  DEFAULT_IMAGE_INPUT_POLICY,
  validateImageInputs,
} from '@imagine/shared';
import type { ImageInputPolicy, ImageSize } from '@imagine/shared';

import { MAX_IMAGE_EDITOR_NATURAL_PIXELS } from '../model/limits.js';

export interface DecodedImageBitmapPort {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface ImageBitmapDecoderPort {
  decode(
    content: Blob,
    options: { readonly imageOrientation: 'from-image' },
  ): Promise<DecodedImageBitmapPort>;
}

export interface LoadedSourceContent {
  readonly bitmap: DecodedImageBitmapPort;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly naturalSize: ImageSize;
  dispose(): void;
}

export type SourceContentErrorCode =
  | 'decode_failed'
  | 'decoded_dimensions_exceeded'
  | 'invalid_decoded_dimensions'
  | 'unsupported_decoder';

export class SourceContentError extends Error {
  public override readonly name = 'SourceContentError';

  public constructor(
    public readonly code: SourceContentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const MAX_EDITOR_SOURCE_PIXELS = MAX_IMAGE_EDITOR_NATURAL_PIXELS;

export function createBrowserImageBitmapDecoder(): ImageBitmapDecoderPort {
  return {
    async decode(content, options) {
      if (typeof globalThis.createImageBitmap !== 'function') {
        throw new SourceContentError(
          'unsupported_decoder',
          'This browser does not support createImageBitmap.',
        );
      }
      return globalThis.createImageBitmap(content, options);
    },
  };
}

function validateDecodedSize(size: ImageSize): void {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    throw new SourceContentError(
      'invalid_decoded_dimensions',
      'Decoded image dimensions must be positive safe integers.',
    );
  }
  if (size.width > Math.floor(MAX_EDITOR_SOURCE_PIXELS / size.height)) {
    throw new SourceContentError(
      'decoded_dimensions_exceeded',
      `Decoded image exceeds ${MAX_EDITOR_SOURCE_PIXELS} pixels.`,
    );
  }
}

function decodeWithAbort(
  decoder: ImageBitmapDecoderPort,
  content: Blob,
  signal: AbortSignal | undefined,
): Promise<DecodedImageBitmapPort> {
  const decoding = decoder.decode(content, { imageOrientation: 'from-image' });
  if (!signal) return decoding;
  if (signal.aborted) {
    void decoding.then((bitmap) => bitmap.close(), () => undefined);
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void decoding.then(
      (bitmap) => {
        signal.removeEventListener('abort', abort);
        if (settled) {
          bitmap.close();
          return;
        }
        settled = true;
        resolve(bitmap);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

export async function loadSourceContent(
  content: Blob,
  options: {
    readonly decoder: ImageBitmapDecoderPort;
    readonly policy?: ImageInputPolicy;
    readonly signal?: AbortSignal;
  },
): Promise<LoadedSourceContent> {
  const policy = options.policy ?? DEFAULT_IMAGE_INPUT_POLICY;
  options.signal?.throwIfAborted();

  // Reject unsupported or oversized content before invoking a potentially expensive decoder.
  validateImageInputs([
    { bytes: content.size, height: 1, mimeType: content.type, width: 1 },
  ], policy);

  let bitmap: DecodedImageBitmapPort;
  try {
    bitmap = await decodeWithAbort(options.decoder, content, options.signal);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof SourceContentError) throw error;
    throw new SourceContentError('decode_failed', 'The source image could not be decoded.', {
      cause: error,
    });
  }

  try {
    options.signal?.throwIfAborted();
    const naturalSize = { height: bitmap.height, width: bitmap.width };
    validateDecodedSize(naturalSize);
    validateImageInputs([
      {
        bytes: content.size,
        height: naturalSize.height,
        mimeType: content.type,
        width: naturalSize.width,
      },
    ], policy);

    let disposed = false;
    return Object.freeze({
      bitmap,
      byteLength: content.size,
      mimeType: content.type.toLowerCase(),
      naturalSize: Object.freeze(naturalSize),
      dispose() {
        if (disposed) return;
        disposed = true;
        bitmap.close();
      },
    });
  } catch (error) {
    bitmap.close();
    throw error;
  }
}
