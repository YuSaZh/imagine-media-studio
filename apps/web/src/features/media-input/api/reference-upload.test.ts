import { describe, expect, it, vi } from 'vitest';

import { internalClient } from '../../../api/internal-client.js';
import { uploadReferenceImage } from './reference-upload.js';

describe('uploadReferenceImage', () => {
  it('uses a durable local fixture ID without calling the internal API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(
      uploadReferenceImage(
        new File(['image'], 'image.png', { type: 'image/png' }),
        new AbortController().signal,
        true,
        { fileSize: 5, height: 1, mimeType: 'image/png', width: 1 },
      ),
    ).resolves.toMatchObject({
      assetId: expect.stringMatching(/^fixture-reference-/),
      inputDescriptor: { fileSize: 5, height: 1, mimeType: 'image/png', width: 1 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('persists first-frame role through the upload API', async () => {
    const upload = vi.spyOn(internalClient, 'uploadAsset')
      .mockResolvedValue({
        asset: {
          id: 'asset-frame-1',
          jobId: null,
          parentAssetId: null,
          type: 'image',
          role: 'first_frame',
          contentUrl: '/internal/assets/asset-frame-1/content',
          thumbnailUrl: null,
          posterUrl: null,
          originalFilename: 'frame.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          durationMs: null,
          fileSize: 5,
          sha256: 'a'.repeat(64),
          metadata: {},
          favorite: false,
          collectionIds: [],
          createdAt: '2026-08-25T00:00:00.000Z',
        },
      });

    await expect(uploadReferenceImage(
      new File(['image'], 'frame.png', { type: 'image/png' }),
      new AbortController().signal,
      false,
      null,
      'first_frame',
    )).resolves.toMatchObject({ assetId: 'asset-frame-1' });
    expect(upload).toHaveBeenCalledWith(
      expect.any(File),
      { role: 'first_frame' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
