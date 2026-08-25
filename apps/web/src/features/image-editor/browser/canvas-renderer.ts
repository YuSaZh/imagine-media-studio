import type { MaskDocument } from '@imagine/shared';

import { MAX_IMAGE_EDITOR_NATURAL_PIXELS } from '../model/limits.js';
import type { LoadedSourceContent } from './source-content.js';

export const MAX_EDITOR_DEVICE_PIXEL_RATIO = 2;
export const MAX_EDITOR_RENDER_PIXELS = MAX_IMAGE_EDITOR_NATURAL_PIXELS;
export const DEFAULT_MASK_OVERLAY_COLOR = Object.freeze({
  alpha: 104,
  blue: 82,
  green: 64,
  red: 235,
});

export interface MaskOverlayColor {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
}

export interface CanvasLayerPort {
  readonly drawable: unknown;
  clear(): void;
  drawImage(source: unknown, x: number, y: number, width: number, height: number): void;
  resize(width: number, height: number): void;
  writeRgba(rgba: Uint8ClampedArray, width: number, height: number): void;
}

export interface CanvasLayerFactoryPort {
  create(): CanvasLayerPort;
}

export interface RenderMaskEditorLayersOptions {
  readonly devicePixelRatio: number;
  readonly displaySize: { readonly height: number; readonly width: number };
  readonly factory: CanvasLayerFactoryPort;
  readonly mask: MaskDocument;
  readonly maskLayer: CanvasLayerPort;
  readonly overlayColor?: MaskOverlayColor;
  readonly source: LoadedSourceContent;
  readonly sourceLayer: CanvasLayerPort;
}

export interface RenderedLayerSize {
  readonly contentRect: DisplayContentRect;
  readonly devicePixelRatio: number;
  readonly height: number;
  readonly width: number;
}

export interface DisplayContentRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

interface BackingContentRect {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export type CanvasRendererErrorCode =
  | 'invalid_device_pixel_ratio'
  | 'invalid_display_size'
  | 'invalid_mask_rgba'
  | 'invalid_overlay_color'
  | 'layer_pixels_exceeded'
  | 'source_pixels_exceeded'
  | 'source_mask_size_mismatch'
  | 'unsupported_canvas';

export class CanvasRendererError extends Error {
  public override readonly name = 'CanvasRendererError';

  public constructor(
    public readonly code: CanvasRendererErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertByte(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new CanvasRendererError(
      'invalid_overlay_color',
      'Mask overlay color channels must be bytes.',
    );
  }
}

export function normalizeEditorDevicePixelRatio(devicePixelRatio: number): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) {
    throw new CanvasRendererError(
      'invalid_device_pixel_ratio',
      'Device pixel ratio must be finite and positive.',
    );
  }
  return Math.min(MAX_EDITOR_DEVICE_PIXEL_RATIO, Math.max(1, devicePixelRatio));
}

function layerGeometry(
  displaySize: { readonly height: number; readonly width: number },
  naturalSize: { readonly height: number; readonly width: number },
  devicePixelRatio: number,
): { readonly backingContentRect: BackingContentRect; readonly size: RenderedLayerSize } {
  if (
    !Number.isFinite(displaySize.width) ||
    !Number.isFinite(displaySize.height) ||
    displaySize.width <= 0 ||
    displaySize.height <= 0
  ) {
    throw new CanvasRendererError(
      'invalid_display_size',
      'Canvas display dimensions must be finite and positive.',
    );
  }
  const dpr = normalizeEditorDevicePixelRatio(devicePixelRatio);
  const width = Math.max(1, Math.round(displaySize.width * dpr));
  const height = Math.max(1, Math.round(displaySize.height * dpr));
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > Math.floor(MAX_EDITOR_RENDER_PIXELS / height)
  ) {
    throw new CanvasRendererError(
      'layer_pixels_exceeded',
      `Canvas backing layer exceeds ${MAX_EDITOR_RENDER_PIXELS} pixels.`,
    );
  }
  const scale = Math.min(
    displaySize.width / naturalSize.width,
    displaySize.height / naturalSize.height,
  );
  const contentRect = {
    height: naturalSize.height * scale,
    left: (displaySize.width - naturalSize.width * scale) / 2,
    top: (displaySize.height - naturalSize.height * scale) / 2,
    width: naturalSize.width * scale,
  };
  const left = Math.max(0, Math.round(contentRect.left * dpr));
  const top = Math.max(0, Math.round(contentRect.top * dpr));
  const right = Math.min(width, Math.round((contentRect.left + contentRect.width) * dpr));
  const bottom = Math.min(height, Math.round((contentRect.top + contentRect.height) * dpr));
  return {
    backingContentRect: {
      height: Math.max(1, bottom - top),
      left,
      top,
      width: Math.max(1, right - left),
    },
    size: { contentRect, devicePixelRatio: dpr, height, width },
  };
}

function assertCanonicalMask(mask: MaskDocument): void {
  if (mask.rgba.length !== mask.width * mask.height * 4) {
    throw new CanvasRendererError('invalid_mask_rgba', 'Mask RGBA length is invalid.');
  }
  for (let offset = 3; offset < mask.rgba.length; offset += 4) {
    const alpha = mask.rgba[offset];
    if (alpha !== 0 && alpha !== 255) {
      throw new CanvasRendererError(
        'invalid_mask_rgba',
        'Mask alpha must use canonical 0 or 255 values.',
      );
    }
  }
}

function createOverlayRgba(
  mask: MaskDocument,
  color: MaskOverlayColor,
  outputSize: { readonly height: number; readonly width: number },
): Uint8ClampedArray {
  assertByte(color.red);
  assertByte(color.green);
  assertByte(color.blue);
  assertByte(color.alpha);
  assertCanonicalMask(mask);
  const overlay = new Uint8ClampedArray(outputSize.width * outputSize.height * 4);
  for (let y = 0; y < outputSize.height; y += 1) {
    const sourceY = Math.min(mask.height - 1, Math.floor((y * mask.height) / outputSize.height));
    for (let x = 0; x < outputSize.width; x += 1) {
      const sourceX = Math.min(mask.width - 1, Math.floor((x * mask.width) / outputSize.width));
      const sourceAlpha = mask.rgba[(sourceY * mask.width + sourceX) * 4 + 3]!;
      const offset = (y * outputSize.width + x) * 4;
      overlay[offset] = color.red;
      overlay[offset + 1] = color.green;
      overlay[offset + 2] = color.blue;
      overlay[offset + 3] = sourceAlpha === 0 ? color.alpha : 0;
    }
  }
  return overlay;
}

export function renderMaskEditorLayers(
  options: RenderMaskEditorLayersOptions,
): RenderedLayerSize {
  const naturalSize = options.source.naturalSize;
  if (
    !Number.isSafeInteger(naturalSize.width) ||
    !Number.isSafeInteger(naturalSize.height) ||
    naturalSize.width <= 0 ||
    naturalSize.height <= 0 ||
    naturalSize.width > Math.floor(MAX_IMAGE_EDITOR_NATURAL_PIXELS / naturalSize.height)
  ) {
    throw new CanvasRendererError(
      'source_pixels_exceeded',
      `Source dimensions must contain at most ${MAX_IMAGE_EDITOR_NATURAL_PIXELS} pixels.`,
    );
  }
  if (
    options.mask.width !== naturalSize.width ||
    options.mask.height !== naturalSize.height
  ) {
    throw new CanvasRendererError(
      'source_mask_size_mismatch',
      'Source and mask dimensions must match.',
    );
  }
  const { backingContentRect, size } = layerGeometry(
    options.displaySize,
    naturalSize,
    options.devicePixelRatio,
  );
  const overlayRgba = createOverlayRgba(
    options.mask,
    options.overlayColor ?? DEFAULT_MASK_OVERLAY_COLOR,
    backingContentRect,
  );
  options.sourceLayer.resize(size.width, size.height);
  options.maskLayer.resize(size.width, size.height);
  options.sourceLayer.clear();
  options.maskLayer.clear();
  options.sourceLayer.drawImage(
    options.source.bitmap,
    backingContentRect.left,
    backingContentRect.top,
    backingContentRect.width,
    backingContentRect.height,
  );

  // The scratch surface is ephemeral and is never stored in editor history.
  const scratch = options.factory.create();
  scratch.resize(backingContentRect.width, backingContentRect.height);
  scratch.writeRgba(overlayRgba, backingContentRect.width, backingContentRect.height);
  options.maskLayer.drawImage(
    scratch.drawable,
    backingContentRect.left,
    backingContentRect.top,
    backingContentRect.width,
    backingContentRect.height,
  );
  return size;
}

export function createHtmlCanvasLayer(canvas: HTMLCanvasElement): CanvasLayerPort {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new CanvasRendererError('unsupported_canvas', 'A 2D canvas context is required.');
  }
  return {
    drawable: canvas,
    clear() {
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
    drawImage(source, x, y, width, height) {
      context.drawImage(source as CanvasImageSource, x, y, width, height);
    },
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    writeRgba(rgba, width, height) {
      const imageData = context.createImageData(width, height);
      imageData.data.set(rgba);
      context.putImageData(imageData, 0, 0);
    },
  };
}

export function createHtmlCanvasLayerFactory(
  documentPort: Pick<Document, 'createElement'>,
): CanvasLayerFactoryPort {
  return {
    create() {
      return createHtmlCanvasLayer(documentPort.createElement('canvas'));
    },
  };
}
