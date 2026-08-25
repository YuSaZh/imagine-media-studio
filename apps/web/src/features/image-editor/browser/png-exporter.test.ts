import { applyMaskStroke, createMaskDocument } from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import { MASK_PNG_ALPHA_CONTRACT, exportMaskPng } from './png-exporter.js';
import type { EncodePngInput, PngEncoderPort } from './png-exporter.js';

function paintedMask() {
  return applyMaskStroke(createMaskDocument({ height: 2, width: 3 }), {
    diameter: 1,
    points: [{ x: 0, y: 0 }],
    tool: 'brush',
  });
}

describe('mask PNG exporter', () => {
  it('passes canonical alpha-authoritative RGBA to the encoder at source dimensions', async () => {
    let captured: EncodePngInput | undefined;
    const encoder: PngEncoderPort = {
      encode: vi.fn(async (input) => {
        captured = { ...input, rgba: input.rgba.slice() };
        return new Blob(['png'], { type: 'image/png' });
      }),
    };
    const mask = paintedMask();
    const png = await exportMaskPng({
      encoder,
      mask,
      sourceSize: { height: 2, width: 3 },
    });

    expect(png.type).toBe('image/png');
    expect(MASK_PNG_ALPHA_CONTRACT).toBe('alpha-0-edit-alpha-255-preserve');
    expect(captured).toMatchObject({ height: 2, width: 3 });
    expect(captured?.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 255, 255, 0]));
    expect(captured?.rgba.slice(4, 8)).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
    expect(mask.rgba.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 255, 255, 0]));
  });

  it('strictly rejects empty, malformed, and dimension-mismatched masks', async () => {
    const encoder: PngEncoderPort = {
      encode: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    };
    await expect(exportMaskPng({
      encoder,
      mask: createMaskDocument({ height: 2, width: 3 }),
      sourceSize: { height: 2, width: 3 },
    })).rejects.toMatchObject({ code: 'empty_mask' });
    expect(encoder.encode).not.toHaveBeenCalled();

    const malformed = { ...paintedMask(), rgba: paintedMask().rgba.slice() };
    malformed.rgba[3] = 64;
    await expect(exportMaskPng({
      encoder,
      mask: malformed,
      sourceSize: { height: 2, width: 3 },
    })).rejects.toMatchObject({ code: 'invalid_mask_rgba' });

    await expect(exportMaskPng({
      encoder,
      mask: paintedMask(),
      sourceSize: { height: 3, width: 2 },
    })).rejects.toMatchObject({ code: 'source_mask_size_mismatch' });
    await expect(exportMaskPng({
      encoder,
      mask: paintedMask(),
      sourceSize: { height: 1, width: 4_194_305 },
    })).rejects.toMatchObject({ code: 'invalid_source_size' });
  });

  it('supports cancellation before and during asynchronous encoding', async () => {
    const before = new AbortController();
    before.abort();
    await expect(exportMaskPng({
      encoder: { encode: vi.fn() },
      mask: paintedMask(),
      signal: before.signal,
      sourceSize: { height: 2, width: 3 },
    })).rejects.toMatchObject({ name: 'AbortError' });

    let release: ((value: Blob) => void) | undefined;
    const controller = new AbortController();
    const exporting = exportMaskPng({
      encoder: {
        encode: async () => new Promise((resolve) => {
          release = resolve;
        }),
      },
      mask: paintedMask(),
      signal: controller.signal,
      sourceSize: { height: 2, width: 3 },
    });
    controller.abort();
    release?.(new Blob(['png'], { type: 'image/png' }));
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects empty or incorrectly typed encoder output', async () => {
    await expect(exportMaskPng({
      encoder: { encode: async () => new Blob([], { type: 'image/png' }) },
      mask: paintedMask(),
      sourceSize: { height: 2, width: 3 },
    })).rejects.toMatchObject({ code: 'invalid_encoded_png' });
    await expect(exportMaskPng({
      encoder: { encode: async () => new Blob(['x'], { type: 'image/jpeg' }) },
      mask: paintedMask(),
      sourceSize: { height: 2, width: 3 },
    })).rejects.toMatchObject({ code: 'invalid_encoded_png' });
  });
});
