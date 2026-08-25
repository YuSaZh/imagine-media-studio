import { applyMaskStroke, createMaskDocument } from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MASK_OVERLAY_COLOR,
  renderMaskEditorLayers,
} from './canvas-renderer.js';
import type { CanvasLayerPort } from './canvas-renderer.js';
import type { LoadedSourceContent } from './source-content.js';

class FakeLayer implements CanvasLayerPort {
  public readonly drawable = this;
  public readonly draws: Array<{
    height: number;
    source: unknown;
    width: number;
    x: number;
    y: number;
  }> = [];
  public rgba: Uint8ClampedArray | null = null;
  public size = { height: 0, width: 0 };
  public readonly clear = vi.fn();

  public drawImage(source: unknown, x: number, y: number, width: number, height: number): void {
    this.draws.push({ height, source, width, x, y });
  }

  public resize(width: number, height: number): void {
    this.size = { height, width };
  }

  public writeRgba(rgba: Uint8ClampedArray, width: number, height: number): void {
    this.rgba = rgba.slice();
    this.size = { height, width };
  }
}

function source(width = 2, height = 2): LoadedSourceContent {
  return {
    bitmap: { close: vi.fn(), height, width },
    byteLength: 4,
    dispose: vi.fn(),
    mimeType: 'image/png',
    naturalSize: { height, width },
  };
}

describe('mask editor canvas renderer', () => {
  it('renders source and canonical mask overlay into separate DPR-limited layers', () => {
    const sourceLayer = new FakeLayer();
    const maskLayer = new FakeLayer();
    const scratch = new FakeLayer();
    const mask = applyMaskStroke(createMaskDocument({ height: 200, width: 400 }), {
      diameter: 1,
      points: [{ x: 0, y: 0 }],
      tool: 'brush',
    });
    const rendered = renderMaskEditorLayers({
      devicePixelRatio: 4,
      displaySize: { height: 100, width: 100 },
      factory: { create: () => scratch },
      mask,
      maskLayer,
      source: source(400, 200),
      sourceLayer,
    });

    expect(rendered).toEqual({
      contentRect: { height: 50, left: 0, top: 25, width: 100 },
      devicePixelRatio: 2,
      height: 200,
      width: 200,
    });
    expect(sourceLayer.size).toEqual({ height: 200, width: 200 });
    expect(maskLayer.size).toEqual({ height: 200, width: 200 });
    expect(sourceLayer.draws[0]).toMatchObject({ height: 100, width: 200, x: 0, y: 50 });
    expect(maskLayer.draws[0]).toMatchObject({
      height: 100,
      source: scratch,
      width: 200,
      x: 0,
      y: 50,
    });
    expect(scratch.size).toEqual({ height: 100, width: 200 });
    expect(scratch.rgba?.slice(0, 4)).toEqual(new Uint8ClampedArray([
      DEFAULT_MASK_OVERLAY_COLOR.red,
      DEFAULT_MASK_OVERLAY_COLOR.green,
      DEFAULT_MASK_OVERLAY_COLOR.blue,
      DEFAULT_MASK_OVERLAY_COLOR.alpha,
    ]));
    expect(scratch.rgba?.slice(4, 8)).toEqual(new Uint8ClampedArray([
      DEFAULT_MASK_OVERLAY_COLOR.red,
      DEFAULT_MASK_OVERLAY_COLOR.green,
      DEFAULT_MASK_OVERLAY_COLOR.blue,
      0,
    ]));
  });

  it('rejects mismatched dimensions, malformed alpha, and unsafe render bounds', () => {
    const layer = new FakeLayer();
    const factory = { create: () => new FakeLayer() };
    const mask = createMaskDocument({ height: 2, width: 2 });
    expect(() => renderMaskEditorLayers({
      devicePixelRatio: 1,
      displaySize: { height: 2, width: 2 },
      factory,
      mask,
      maskLayer: layer,
      source: source(3, 2),
      sourceLayer: layer,
    })).toThrowError(expect.objectContaining({ code: 'source_mask_size_mismatch' }));

    const malformed = { ...mask, rgba: mask.rgba.slice() };
    malformed.rgba[3] = 128;
    expect(() => renderMaskEditorLayers({
      devicePixelRatio: 1,
      displaySize: { height: 2, width: 2 },
      factory,
      mask: malformed,
      maskLayer: layer,
      source: source(),
      sourceLayer: layer,
    })).toThrowError(expect.objectContaining({ code: 'invalid_mask_rgba' }));

    expect(() => renderMaskEditorLayers({
      devicePixelRatio: Number.POSITIVE_INFINITY,
      displaySize: { height: 2, width: 2 },
      factory,
      mask,
      maskLayer: layer,
      source: source(),
      sourceLayer: layer,
    })).toThrowError(expect.objectContaining({ code: 'invalid_device_pixel_ratio' }));

    const tinyMask = createMaskDocument({ height: 1, width: 1 });
    expect(() => renderMaskEditorLayers({
      devicePixelRatio: 1,
      displaySize: { height: 1, width: 1 },
      factory,
      mask: { ...tinyMask, width: 4_194_305 },
      maskLayer: layer,
      source: source(4_194_305, 1),
      sourceLayer: layer,
    })).toThrowError(expect.objectContaining({ code: 'source_pixels_exceeded' }));
  });
});
