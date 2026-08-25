import { applyMaskStroke, createMaskDocument } from '@imagine/shared';
import type { AssetDto } from '@imagine/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  loadEditorAsset,
  uploadEditorMask,
} from './editor-assets.js';
import type {
  EditorAssetClientPort,
  EditorFetchPort,
} from './editor-assets.js';
import type { DecodedImageBitmapPort } from '../browser/source-content.js';

function asset(overrides: Partial<AssetDto> = {}): AssetDto {
  const id = overrides.id ?? 'asset-1';
  return {
    collectionIds: [],
    contentUrl: `/internal/assets/${encodeURIComponent(id)}/content`,
    createdAt: '2026-08-25T00:00:00.000Z',
    durationMs: null,
    favorite: false,
    fileSize: 5,
    height: 2,
    id,
    jobId: null,
    metadata: {},
    mimeType: 'image/png',
    originalFilename: 'source.png',
    parentAssetId: null,
    posterUrl: null,
    role: 'upload',
    sha256: 'a'.repeat(64),
    thumbnailUrl: null,
    type: 'image',
    width: 3,
    ...overrides,
  };
}

function bitmap(width = 3, height = 2): DecodedImageBitmapPort {
  return { close: vi.fn(), height, width };
}

function imageResponse(
  body: Blob = new Blob(['image'], { type: 'image/png' }),
  options: { readonly contentLength?: string; readonly mimeType?: string; readonly status?: number } = {},
): Response {
  const headers = new Headers({ 'Content-Type': options.mimeType ?? 'image/png' });
  if (options.contentLength !== undefined) headers.set('Content-Length', options.contentLength);
  return new Response(body, { headers, status: options.status ?? 200 });
}

describe('loadEditorAsset', () => {
  it('loads a persisted same-origin image and returns disposable oriented source content', async () => {
    const sourceAsset = asset({ id: 'asset/with space' });
    const decoded = bitmap();
    const getAsset = vi.fn(async () => ({ asset: sourceAsset }));
    const fetchPort = vi.fn<EditorFetchPort>(async () => imageResponse());
    const signal = new AbortController().signal;

    const loaded = await loadEditorAsset(sourceAsset.id, signal, {
      client: { getAsset },
      decoder: { decode: vi.fn(async () => decoded) },
      fetch: fetchPort,
    });

    expect(getAsset).toHaveBeenCalledWith(sourceAsset.id);
    expect(fetchPort).toHaveBeenCalledWith(
      '/internal/assets/asset%2Fwith%20space/content',
      {
        credentials: 'same-origin',
        headers: { Accept: 'image/png' },
        signal,
      },
    );
    expect(loaded.asset).toBe(sourceAsset);
    expect(loaded.source.naturalSize).toEqual({ height: 2, width: 3 });
    loaded.source.dispose();
    loaded.source.dispose();
    expect(decoded.close).toHaveBeenCalledTimes(1);
  });

  it('rejects non-internal, mismatched, and externally controlled content URLs before fetch', async () => {
    for (const contentUrl of [
      'https://example.com/internal/assets/asset-1/content',
      '//example.com/internal/assets/asset-1/content',
      '/internal/assets/other/content',
      '/internal/assets/asset-1/content?download=1',
    ]) {
      const fetchPort = vi.fn<EditorFetchPort>();
      await expect(loadEditorAsset('asset-1', new AbortController().signal, {
        client: { getAsset: async () => ({ asset: asset({ contentUrl }) }) },
        decoder: { decode: async () => bitmap() },
        fetch: fetchPort,
      })).rejects.toMatchObject({ code: 'asset_content_url_forbidden' });
      expect(fetchPort).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['asset_not_image', { type: 'video' as const }],
    ['asset_dimensions_missing', { width: null }],
    ['asset_pixels_exceeded', { height: 2_049, width: 2_049 }],
    ['asset_not_persisted', { fileSize: 0 }],
    ['asset_mime_invalid', { mimeType: 'image/svg+xml' }],
  ])('rejects invalid persisted metadata with %s', async (code, overrides) => {
    const fetchPort = vi.fn<EditorFetchPort>();
    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset(overrides) }) },
      decoder: { decode: async () => bitmap() },
      fetch: fetchPort,
    })).rejects.toMatchObject({ code });
    expect(fetchPort).not.toHaveBeenCalled();
  });

  it('rejects metadata identity mismatches', async () => {
    await expect(loadEditorAsset('requested', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset({ id: 'returned' }) }) },
      decoder: { decode: async () => bitmap() },
      fetch: vi.fn<EditorFetchPort>(),
    })).rejects.toMatchObject({ code: 'asset_identity_mismatch' });
  });

  it('preserves fetch cancellation and wraps transport failures', async () => {
    const controller = new AbortController();
    const fetchPort = vi.fn<EditorFetchPort>(async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }));
    const loading = loadEditorAsset('asset-1', controller.signal, {
      client: { getAsset: async () => ({ asset: asset() }) },
      decoder: { decode: async () => bitmap() },
      fetch: fetchPort,
    });
    await vi.waitFor(() => expect(fetchPort).toHaveBeenCalled());
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });

    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset() }) },
      decoder: { decode: async () => bitmap() },
      fetch: async () => { throw new TypeError('offline'); },
    })).rejects.toMatchObject({ code: 'content_fetch_failed' });
  });

  it.each([
    ['content_response_not_ok', () => imageResponse(undefined, { status: 503 })],
    ['content_mime_mismatch', () => imageResponse(undefined, { mimeType: 'image/jpeg' })],
    ['content_empty', () => imageResponse(new Blob([], { type: 'image/png' }), { contentLength: '0' })],
    ['content_bytes_exceeded', () => imageResponse(undefined, { contentLength: '6' })],
    ['content_length_invalid', () => imageResponse(undefined, { contentLength: '5x' })],
  ])('rejects invalid content responses with %s', async (code, response) => {
    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset() }) },
      decoder: { decode: async () => bitmap() },
      fetch: async () => response(),
    })).rejects.toMatchObject({ code });
  });

  it('rejects body bytes above the declared size without decoding', async () => {
    const decode = vi.fn(async () => bitmap());
    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset({ fileSize: 4 }) }) },
      decoder: { decode },
      fetch: async () => imageResponse(),
    })).rejects.toMatchObject({ code: 'content_bytes_exceeded' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('rejects declared response bytes above the default editor file limit', async () => {
    const oversizedBytes = 32 * 1024 * 1024 + 1;
    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset({ fileSize: oversizedBytes }) }) },
      decoder: { decode: async () => bitmap() },
      fetch: async () => imageResponse(undefined, { contentLength: String(oversizedBytes) }),
    })).rejects.toMatchObject({ code: 'content_bytes_exceeded' });
  });

  it('disposes decoded content when natural dimensions differ from metadata', async () => {
    const decoded = bitmap(4, 2);
    await expect(loadEditorAsset('asset-1', new AbortController().signal, {
      client: { getAsset: async () => ({ asset: asset() }) },
      decoder: { decode: async () => decoded },
      fetch: async () => imageResponse(),
    })).rejects.toMatchObject({ code: 'content_dimensions_mismatch' });
    expect(decoded.close).toHaveBeenCalledTimes(1);
  });
});

function paintedMask() {
  return applyMaskStroke(createMaskDocument({ height: 2, width: 3 }), {
    diameter: 1,
    points: [{ x: 0, y: 0 }],
    tool: 'brush',
  });
}

function uploadedMask(overrides: Partial<AssetDto> = {}): AssetDto {
  return asset({
    contentUrl: '/internal/assets/mask-1/content',
    fileSize: 3,
    id: 'mask-1',
    originalFilename: 'mask.png',
    parentAssetId: 'asset-1',
    role: 'mask',
    ...overrides,
  });
}

describe('uploadEditorMask', () => {
  it('exports a File and uploads a persisted Mask relationship', async () => {
    const encoder = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    const uploadAsset = vi.fn<EditorAssetClientPort['uploadAsset']>(
      async () => ({ asset: uploadedMask() }),
    );
    const signal = new AbortController().signal;
    const result = await uploadEditorMask({
      document: paintedMask(),
      signal,
      sourceAsset: asset(),
    }, { client: { uploadAsset }, encoder: { encode: encoder } });

    expect(encoder).toHaveBeenCalledWith(expect.objectContaining({
      height: 2,
      rgba: expect.any(Uint8ClampedArray),
      signal,
      width: 3,
    }));
    const [file, fields, options] = uploadAsset.mock.calls[0]!;
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: 'mask.png', type: 'image/png' });
    expect(fields).toEqual({ parentAssetId: 'asset-1', role: 'mask' });
    expect(options.signal).toBe(signal);
    expect(result).toEqual(uploadedMask());
  });

  it('rejects an empty Mask before encoding or upload', async () => {
    const encoder = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
    const uploadAsset = vi.fn<EditorAssetClientPort['uploadAsset']>();
    await expect(uploadEditorMask({
      document: createMaskDocument({ height: 2, width: 3 }),
      signal: new AbortController().signal,
      sourceAsset: asset(),
    }, { client: { uploadAsset }, encoder: { encode: encoder } })).rejects
      .toMatchObject({ code: 'mask_empty' });
    expect(encoder).not.toHaveBeenCalled();
    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['role', { role: 'output' as const }],
    ['parent', { parentAssetId: 'other' }],
    ['type', { type: 'video' as const }],
    ['MIME', { mimeType: 'image/jpeg' }],
    ['width', { width: 2 }],
    ['height', { height: 3 }],
    ['persistence', { fileSize: 0 }],
  ])('rejects uploaded Mask %s contract mismatch', async (_field, overrides) => {
    await expect(uploadEditorMask({
      document: paintedMask(),
      signal: new AbortController().signal,
      sourceAsset: asset(),
    }, {
      client: { uploadAsset: async () => ({ asset: uploadedMask(overrides) }) },
      encoder: { encode: async () => new Blob(['png'], { type: 'image/png' }) },
    })).rejects.toMatchObject({ code: 'mask_upload_contract_mismatch' });
  });
});
