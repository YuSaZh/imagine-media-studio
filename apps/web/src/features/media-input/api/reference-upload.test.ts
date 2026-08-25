import { describe, expect, it, vi } from 'vitest';

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
});
