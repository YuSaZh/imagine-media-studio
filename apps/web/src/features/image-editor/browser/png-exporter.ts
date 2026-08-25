import { classifyMaskRgba } from '@imagine/shared';
import type { ImageSize, MaskDocument } from '@imagine/shared';

import { MAX_IMAGE_EDITOR_NATURAL_PIXELS } from '../model/limits.js';

/** Alpha is authoritative; RGB under alpha 0 is not portable after browser encoding. */
export interface EncodePngInput {
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
  readonly signal?: AbortSignal;
  readonly width: number;
}

/**
 * Mask alpha is authoritative: 0 means edit and 255 means preserve. RGB is normalized to white
 * before encoding, but consumers must ignore RGB where alpha is 0 because browser canvas encoders
 * may discard fully transparent color channels.
 */
export const MASK_PNG_ALPHA_CONTRACT = 'alpha-0-edit-alpha-255-preserve' as const;

export interface PngEncoderPort {
  encode(input: EncodePngInput): Promise<Blob>;
}

export interface ExportMaskPngOptions {
  readonly encoder: PngEncoderPort;
  readonly mask: MaskDocument;
  readonly signal?: AbortSignal;
  readonly sourceSize: ImageSize;
}

export type MaskPngExportErrorCode =
  | 'empty_mask'
  | 'invalid_encoded_png'
  | 'invalid_mask_rgba'
  | 'invalid_source_size'
  | 'source_mask_size_mismatch'
  | 'unsupported_canvas';

export class MaskPngExportError extends Error {
  public override readonly name = 'MaskPngExportError';

  public constructor(
    public readonly code: MaskPngExportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertSourceSize(size: ImageSize): void {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > Math.floor(MAX_IMAGE_EDITOR_NATURAL_PIXELS / size.height)
  ) {
    throw new MaskPngExportError(
      'invalid_source_size',
      `Source dimensions must contain at most ${MAX_IMAGE_EDITOR_NATURAL_PIXELS} pixels.`,
    );
  }
}

function canonicalExportRgba(mask: MaskDocument): Uint8ClampedArray {
  if (mask.rgba.length !== mask.width * mask.height * 4) {
    throw new MaskPngExportError('invalid_mask_rgba', 'Mask RGBA length is invalid.');
  }
  const rgba = new Uint8ClampedArray(mask.rgba.length);
  for (let offset = 0; offset < mask.rgba.length; offset += 4) {
    const alpha = mask.rgba[offset + 3];
    if (alpha !== 0 && alpha !== 255) {
      throw new MaskPngExportError(
        'invalid_mask_rgba',
        'Mask alpha must use canonical 0 or 255 values.',
      );
    }
    rgba[offset] = 255;
    rgba[offset + 1] = 255;
    rgba[offset + 2] = 255;
    rgba[offset + 3] = alpha;
  }
  return rgba;
}

export async function exportMaskPng(options: ExportMaskPngOptions): Promise<Blob> {
  options.signal?.throwIfAborted();
  assertSourceSize(options.sourceSize);
  if (
    options.mask.width !== options.sourceSize.width ||
    options.mask.height !== options.sourceSize.height
  ) {
    throw new MaskPngExportError(
      'source_mask_size_mismatch',
      'Exported mask dimensions must match the source image.',
    );
  }
  const rgba = canonicalExportRgba(options.mask);
  if (classifyMaskRgba(rgba) === 'empty') {
    throw new MaskPngExportError('empty_mask', 'A mask must contain an edited area before export.');
  }
  const input: EncodePngInput = options.signal
    ? { height: options.mask.height, rgba, signal: options.signal, width: options.mask.width }
    : { height: options.mask.height, rgba, width: options.mask.width };
  const png = await options.encoder.encode(input);
  options.signal?.throwIfAborted();
  if (png.size === 0 || png.type.toLowerCase() !== 'image/png') {
    throw new MaskPngExportError(
      'invalid_encoded_png',
      'Mask encoder must return a non-empty image/png Blob.',
    );
  }
  return png;
}

export function createBrowserCanvasPngEncoder(
  documentPort: Pick<Document, 'createElement'>,
): PngEncoderPort {
  return {
    async encode(input) {
      input.signal?.throwIfAborted();
      const canvas = documentPort.createElement('canvas');
      canvas.width = input.width;
      canvas.height = input.height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new MaskPngExportError('unsupported_canvas', 'A 2D canvas context is required.');
      }
      const imageData = context.createImageData(input.width, input.height);
      imageData.data.set(input.rgba);
      context.putImageData(imageData, 0, 0);

      return new Promise<Blob>((resolve, reject) => {
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          reject(input.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        input.signal?.addEventListener('abort', abort, { once: true });
        canvas.toBlob((blob) => {
          input.signal?.removeEventListener('abort', abort);
          if (settled) return;
          settled = true;
          if (!blob) {
            reject(new MaskPngExportError('invalid_encoded_png', 'Canvas PNG encoding failed.'));
            return;
          }
          resolve(blob);
        }, 'image/png');
      });
    },
  };
}
