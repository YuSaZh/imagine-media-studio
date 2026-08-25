import {
  DEFAULT_IMAGE_INPUT_POLICY,
  type ImageInputPolicy,
} from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ANIMATED_IMAGE_FRAME_POLICY,
  compatibleSourceMimeTypes,
  preprocessBrowserImage,
  type DecodedCanvasImage,
  type ImageCanvasPort,
} from './browser-image-preprocessor.js';

function policy(overrides: Partial<ImageInputPolicy> = {}): ImageInputPolicy {
  return { ...DEFAULT_IMAGE_INPUT_POLICY, ...overrides };
}

function fakePort(
  dimensions: { readonly width: number; readonly height: number },
  blobType: 'image/jpeg' | 'image/png' = 'image/png',
): ImageCanvasPort & { close: ReturnType<typeof vi.fn>; encode: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const decoded: DecodedCanvasImage = {
    ...dimensions,
    close,
    source: {} as CanvasImageSource,
  };
  return {
    close,
    decode: vi.fn(async () => decoded),
    encode: vi.fn(async () => new Blob(['normalized'], { type: blobType })),
  };
}

describe('browser image preprocessor', () => {
  it('uses orientation-normalized decoded dimensions and always re-encodes', async () => {
    const port = fakePort({ width: 400, height: 600 }, 'image/jpeg');
    const source = new File(['jpeg'], 'rotated.jpeg', { lastModified: 42, type: 'image/jpeg' });
    const result = await preprocessBrowserImage(source, new AbortController().signal, { port });

    expect(port.encode).toHaveBeenCalledWith(
      expect.objectContaining({ width: 400, height: 600 }),
      { height: 600, mimeType: 'image/jpeg', quality: 0.92, width: 400 },
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ name: 'rotated.jpg', type: 'image/jpeg', lastModified: 42 });
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('resizes for dimension and pixel limits without upscaling smaller images', async () => {
    const largePort = fakePort({ width: 4_000, height: 2_000 });
    await preprocessBrowserImage(
      new File(['png'], 'large.png', { type: 'image/png' }),
      new AbortController().signal,
      { policy: policy({ maxHeight: 1_000, maxPixels: 1_000_000, maxWidth: 2_000 }), port: largePort },
    );
    expect(largePort.encode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ height: 707, width: 1_414 }),
      expect.any(AbortSignal),
    );

    const smallPort = fakePort({ width: 320, height: 240 });
    await preprocessBrowserImage(
      new File(['png'], 'small.png', { type: 'image/png' }),
      new AbortController().signal,
      { policy: policy({ maxHeight: 2_000, maxPixels: 4_000_000, maxWidth: 2_000 }), port: smallPort },
    );
    expect(smallPort.encode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ height: 240, width: 320 }),
      expect.any(AbortSignal),
    );
  });

  it('normalizes alpha-capable and animated formats to a first-frame PNG', async () => {
    for (const mimeType of ['image/png', 'image/gif', 'image/webp', 'image/avif']) {
      const port = fakePort({ width: 64, height: 64 });
      const result = await preprocessBrowserImage(
        new File(['image'], `input.${mimeType.slice(6)}`, { type: mimeType }),
        new AbortController().signal,
        { port },
      );
      expect(result.type).toBe('image/png');
      expect(result.name.endsWith('.png')).toBe(true);
      expect(port.encode).toHaveBeenCalledWith(
        expect.anything(),
        { height: 64, mimeType: 'image/png', width: 64 },
        expect.any(AbortSignal),
      );
    }
    expect(ANIMATED_IMAGE_FRAME_POLICY).toBe('first-frame-only');
    expect(compatibleSourceMimeTypes(policy({ allowedMimeTypes: ['image/png'] }))).toEqual([
      'image/avif',
      'image/gif',
      'image/png',
      'image/webp',
    ]);
    expect(compatibleSourceMimeTypes(policy({ allowedMimeTypes: ['image/webp'] }))).toEqual([]);
  });

  it('honors aborts before decode and after an orientation-aware decode', async () => {
    const before = new AbortController();
    before.abort();
    const untouchedPort = fakePort({ width: 1, height: 1 });
    await expect(preprocessBrowserImage(
      new File(['png'], 'input.png', { type: 'image/png' }),
      before.signal,
      { port: untouchedPort },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(untouchedPort.decode).not.toHaveBeenCalled();

    const during = new AbortController();
    const close = vi.fn();
    const port: ImageCanvasPort = {
      decode: async () => {
        during.abort();
        return { close, height: 10, source: {} as CanvasImageSource, width: 10 };
      },
      encode: vi.fn(),
    };
    await expect(preprocessBrowserImage(
      new File(['png'], 'input.png', { type: 'image/png' }),
      during.signal,
      { port },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a pending decode promptly and closes a bitmap that arrives late', async () => {
    const controller = new AbortController();
    const close = vi.fn();
    let finishDecode: ((image: DecodedCanvasImage) => void) | undefined;
    const port: ImageCanvasPort = {
      decode: async () => new Promise((resolve) => {
        finishDecode = resolve;
      }),
      encode: vi.fn(),
    };
    const pending = preprocessBrowserImage(
      new File(['png'], 'input.png', { type: 'image/png' }),
      controller.signal,
      { port },
    );

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finishDecode?.({ close, height: 10, source: {} as CanvasImageSource, width: 10 });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(port.encode).not.toHaveBeenCalled();
  });

  it('rejects null encoder output and files above the byte policy', async () => {
    const nullPort = fakePort({ width: 20, height: 20 });
    nullPort.encode.mockResolvedValue(null);
    await expect(preprocessBrowserImage(
      new File(['png'], 'input.png', { type: 'image/png' }),
      new AbortController().signal,
      { port: nullPort },
    )).rejects.toMatchObject({ code: 'encode_failed' });
    expect(nullPort.close).toHaveBeenCalledOnce();

    const encodedOversizePort = fakePort({ width: 20, height: 20 });
    await expect(preprocessBrowserImage(
      new File(['x'], 'input.png', { type: 'image/png' }),
      new AbortController().signal,
      { policy: policy({ maxFileBytes: 4 }), port: encodedOversizePort },
    )).rejects.toMatchObject({ code: 'image_file_too_large' });
    expect(encodedOversizePort.decode).toHaveBeenCalledOnce();

    const oversizePort = fakePort({ width: 20, height: 20 });
    await expect(preprocessBrowserImage(
      new File(['oversize'], 'large.png', { type: 'image/png' }),
      new AbortController().signal,
      { policy: policy({ maxFileBytes: 4 }), port: oversizePort },
    )).rejects.toMatchObject({ code: 'image_file_too_large' });
    expect(oversizePort.decode).not.toHaveBeenCalled();
  });
});
