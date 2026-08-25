import { describe, expect, it, vi } from 'vitest';

import { loadSourceContent } from './source-content.js';
import type { DecodedImageBitmapPort, ImageBitmapDecoderPort } from './source-content.js';

function bitmap(width = 8, height = 6): DecodedImageBitmapPort {
  return { close: vi.fn(), height, width };
}

function png(bytes = 4): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'image/png' });
}

describe('source content loader', () => {
  it('decodes with image orientation and reports oriented natural dimensions', async () => {
    const decoded = bitmap(12, 7);
    const decode = vi.fn(async () => decoded);
    const source = await loadSourceContent(png(), { decoder: { decode } });

    expect(decode).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' });
    expect(source.naturalSize).toEqual({ height: 7, width: 12 });
    expect(source.mimeType).toBe('image/png');
    source.dispose();
    source.dispose();
    expect(decoded.close).toHaveBeenCalledTimes(1);
  });

  it('rejects content policy violations before decode', async () => {
    const decoder: ImageBitmapDecoderPort = { decode: vi.fn(async () => bitmap()) };
    await expect(loadSourceContent(new Blob([], { type: 'image/png' }), { decoder })).rejects
      .toMatchObject({ code: 'invalid_image_metadata' });
    await expect(loadSourceContent(new Blob(['x'], { type: 'text/plain' }), { decoder })).rejects
      .toMatchObject({ code: 'unsupported_image_mime' });
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('closes a decoded bitmap when dimensions or cancellation reject it', async () => {
    const oversized = bitmap(4_194_305, 1);
    await expect(loadSourceContent(png(), {
      decoder: { decode: async () => oversized },
    })).rejects.toMatchObject({ code: 'decoded_dimensions_exceeded' });
    expect(oversized.close).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const decoded = bitmap();
    let release: ((value: DecodedImageBitmapPort) => void) | undefined;
    const loading = loadSourceContent(png(), {
      decoder: {
        decode: async () => new Promise((resolve) => {
          release = resolve;
        }),
      },
      signal: controller.signal,
    });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(decoded.close).not.toHaveBeenCalled();
    release?.(decoded);
    await vi.waitFor(() => expect(decoded.close).toHaveBeenCalledTimes(1));
  });

  it('wraps decoder failures without exposing browser-specific errors', async () => {
    await expect(loadSourceContent(png(), {
      decoder: { decode: async () => { throw new Error('codec internals'); } },
    })).rejects.toMatchObject({ code: 'decode_failed' });
  });

  it('does not miss cancellation triggered while the decoder is being created', async () => {
    const controller = new AbortController();
    const decoded = bitmap();
    const loading = loadSourceContent(png(), {
      decoder: {
        decode: async () => {
          controller.abort();
          return decoded;
        },
      },
      signal: controller.signal,
    });
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(decoded.close).toHaveBeenCalledTimes(1));
  });
});
