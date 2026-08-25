import {
  DEFAULT_IMAGE_INPUT_POLICY,
  ImageInputPolicyError,
  fitImageWithin,
  validateImageInputs,
  type FittedImageSize,
  type ImageInputPolicy,
} from '@imagine/shared';

import { SUPPORTED_REFERENCE_MIME_TYPES } from './acquisition.js';
import type { ImageAssetInputDescriptor } from './types.js';

export const ANIMATED_IMAGE_FRAME_POLICY = 'first-frame-only' as const;

export type NormalizedImageMimeType = 'image/jpeg' | 'image/png';

export interface DecodedCanvasImage {
  readonly height: number;
  readonly source: CanvasImageSource;
  readonly width: number;
  close: () => void;
}

export interface CanvasEncodeRequest {
  readonly height: number;
  readonly mimeType: NormalizedImageMimeType;
  readonly quality?: number;
  readonly width: number;
}

export interface ImageCanvasPort {
  decode: (file: File, signal: AbortSignal) => Promise<DecodedCanvasImage>;
  encode: (
    image: DecodedCanvasImage,
    request: CanvasEncodeRequest,
    signal: AbortSignal,
  ) => Promise<Blob | null>;
}

export interface BrowserImagePreprocessOptions {
  readonly jpegQuality?: number;
  readonly policy?: ImageInputPolicy;
  readonly port?: ImageCanvasPort;
}

export interface PreparedBrowserImage {
  readonly file: File;
  readonly inputDescriptor: ImageAssetInputDescriptor;
}

export class BrowserImagePreprocessError extends Error {
  public override readonly name = 'BrowserImagePreprocessError';

  public constructor(
    public readonly code: 'canvas_unavailable' | 'decode_unavailable' | 'encode_failed',
    message: string,
  ) {
    super(message);
  }
}

export function normalizedOutputMimeType(inputMimeType: string): NormalizedImageMimeType {
  return inputMimeType.trim().toLowerCase() === 'image/jpeg' ? 'image/jpeg' : 'image/png';
}

export function compatibleSourceMimeTypes(policy: ImageInputPolicy): readonly string[] {
  const outputMimeTypes = new Set(policy.allowedMimeTypes.map((mime) => mime.trim().toLowerCase()));
  return [...SUPPORTED_REFERENCE_MIME_TYPES].filter((sourceMimeType) =>
    outputMimeTypes.has(normalizedOutputMimeType(sourceMimeType)),
  );
}

function outputFilename(filename: string, mimeType: NormalizedImageMimeType): string {
  const trimmed = filename.trim();
  const basename = trimmed.replace(/\.[^.]*$/u, '') || 'pasted-image';
  return `${basename}.${mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;
}

function positivePolicyLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function abortable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void pending.then((value) => onLateValue?.(value), () => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled || signal.aborted) {
          onLateValue?.(value);
          if (!settled) reject(abortReason(signal));
          return;
        }
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

function targetImageSize(
  source: { readonly width: number; readonly height: number },
  policy: ImageInputPolicy,
): FittedImageSize {
  const dimensionFit = fitImageWithin(source, {
    width: policy.maxWidth,
    height: policy.maxHeight,
  });
  if (dimensionFit.width <= Math.floor(policy.maxPixels / dimensionFit.height)) {
    return dimensionFit;
  }

  const pixelScale = Math.sqrt(policy.maxPixels / source.width / source.height);
  const pixelBounds = {
    width: Math.max(1, Math.floor(source.width * Math.min(dimensionFit.scale, pixelScale))),
    height: Math.max(1, Math.floor(source.height * Math.min(dimensionFit.scale, pixelScale))),
  };
  const pixelFit = fitImageWithin(source, pixelBounds);
  if (pixelFit.width <= Math.floor(policy.maxPixels / pixelFit.height)) return pixelFit;

  return fitImageWithin(source, {
    width: Math.max(1, Math.floor(policy.maxPixels / pixelFit.height)),
    height: pixelFit.height,
  });
}

function validateSourceFile(file: File, policy: ImageInputPolicy): void {
  validateImageInputs([], policy);
  const mimeType = file.type.trim().toLowerCase();
  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) {
    throw new ImageInputPolicyError(
      'unsupported_image_mime',
      `Image MIME type ${mimeType || '(empty)'} is not allowed.`,
    );
  }
  const normalizedMimeType = normalizedOutputMimeType(mimeType);
  if (!policy.allowedMimeTypes.some(
    (allowed) => allowed.trim().toLowerCase() === normalizedMimeType,
  )) {
    throw new ImageInputPolicyError(
      'unsupported_image_mime',
      `The selected model does not accept normalized ${normalizedMimeType} inputs.`,
    );
  }
  if (!positivePolicyLimit(file.size)) {
    throw new ImageInputPolicyError(
      'invalid_image_metadata',
      'Image byte size must be a positive safe integer.',
    );
  }
  if (file.size > policy.maxFileBytes) {
    throw new ImageInputPolicyError(
      'image_file_too_large',
      `Image input exceeds ${policy.maxFileBytes} bytes.`,
    );
  }
}

async function htmlCanvasBlob(
  canvas: HTMLCanvasElement,
  request: CanvasEncodeRequest,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, request.mimeType, request.quality);
  });
}

export const browserImageCanvasPort: ImageCanvasPort = {
  async decode(file, signal) {
    signal.throwIfAborted();
    if (typeof createImageBitmap !== 'function') {
      throw new BrowserImagePreprocessError(
        'decode_unavailable',
        'This browser cannot decode image inputs for upload.',
      );
    }
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (signal.aborted) {
      bitmap.close();
      signal.throwIfAborted();
    }
    return {
      close: () => bitmap.close(),
      height: bitmap.height,
      source: bitmap,
      width: bitmap.width,
    };
  },
  async encode(image, request, signal) {
    signal.throwIfAborted();
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(request.width, request.height);
      const context = canvas.getContext('2d', { alpha: request.mimeType === 'image/png' });
      if (!context) {
        throw new BrowserImagePreprocessError(
          'canvas_unavailable',
          'This browser cannot prepare image inputs for upload.',
        );
      }
      context.drawImage(image.source, 0, 0, request.width, request.height);
      const blob = await canvas.convertToBlob({
        type: request.mimeType,
        ...(request.quality === undefined ? {} : { quality: request.quality }),
      });
      signal.throwIfAborted();
      return blob;
    }
    if (typeof document === 'undefined') {
      throw new BrowserImagePreprocessError(
        'canvas_unavailable',
        'This browser cannot prepare image inputs for upload.',
      );
    }
    const canvas = document.createElement('canvas');
    canvas.width = request.width;
    canvas.height = request.height;
    const context = canvas.getContext('2d', { alpha: request.mimeType === 'image/png' });
    if (!context) {
      throw new BrowserImagePreprocessError(
        'canvas_unavailable',
        'This browser cannot prepare image inputs for upload.',
      );
    }
    context.drawImage(image.source, 0, 0, request.width, request.height);
    const blob = await htmlCanvasBlob(canvas, request);
    canvas.width = 1;
    canvas.height = 1;
    signal.throwIfAborted();
    return blob;
  },
};

export async function prepareBrowserImage(
  file: File,
  signal: AbortSignal,
  options: BrowserImagePreprocessOptions = {},
): Promise<PreparedBrowserImage> {
  const policy = options.policy ?? DEFAULT_IMAGE_INPUT_POLICY;
  const jpegQuality = options.jpegQuality ?? 0.92;
  if (!(jpegQuality > 0 && jpegQuality <= 1)) {
    throw new RangeError('JPEG quality must be greater than zero and at most one.');
  }
  signal.throwIfAborted();
  validateSourceFile(file, policy);

  const port = options.port ?? browserImageCanvasPort;
  const decoded = await abortable(
    port.decode(file, signal),
    signal,
    (lateImage) => lateImage.close(),
  );
  try {
    signal.throwIfAborted();
    const target = targetImageSize(decoded, policy);
    const mimeType = normalizedOutputMimeType(file.type);
    const blob = await abortable(port.encode(decoded, {
      height: target.height,
      mimeType,
      ...(mimeType === 'image/jpeg' ? { quality: jpegQuality } : {}),
      width: target.width,
    }, signal), signal);
    signal.throwIfAborted();
    if (!blob || blob.size === 0 || blob.type !== mimeType) {
      throw new BrowserImagePreprocessError(
        'encode_failed',
        'The browser could not encode this image for upload.',
      );
    }
    validateImageInputs([{
      bytes: blob.size,
      height: target.height,
      mimeType,
      width: target.width,
    }], policy);
    const normalizedFile = new File([blob], outputFilename(file.name, mimeType), {
      lastModified: file.lastModified,
      type: mimeType,
    });
    return {
      file: normalizedFile,
      inputDescriptor: {
        fileSize: normalizedFile.size,
        height: target.height,
        mimeType,
        width: target.width,
      },
    };
  } finally {
    decoded.close();
  }
}

export async function preprocessBrowserImage(
  file: File,
  signal: AbortSignal,
  options: BrowserImagePreprocessOptions = {},
): Promise<File> {
  return (await prepareBrowserImage(file, signal, options)).file;
}
