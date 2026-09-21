import { expect, it, vi } from 'vitest';
import { AssetDtoSchema } from '@imagine/shared';
import { mapMedia } from './data';
import { resolveGallerySelection, selectionKey } from './gallery-selection';

const asset = (id: string) => AssetDtoSchema.parse({ id, parentAssetId: null, contentUrl: `/${id}`, thumbnailUrl: null, posterUrl: null, originalFilename: null, sha256: 'a'.repeat(64), metadata: {}, collectionIds: [], jobId: null, type: 'image', role: 'output', mimeType: 'image/png', width: 512, height: 512, durationMs: null, fileSize: 128, favorite: false, createdAt: '2026-09-21T00:00:00.000Z' });
const member = (id: string) => mapMedia({ ...asset(id), series: { id: 'family', count: 2 } });

it('resolves hidden members once and keeps selection stable when the cover changes', async () => {
  const fetch = vi.fn().mockResolvedValue({ assets: [asset('a'), asset('b')], jobs: [], truncated: false });
  const result = await resolveGallerySelection([member('a'), member('b'), mapMedia(asset('single'))], fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(result.map(item => item.id)).toEqual(['a', 'b', 'single']);
  expect(result.slice(0, 2).map(selectionKey)).toEqual([selectionKey(member('b')), selectionKey(member('b'))]);
});

it('does not turn a partial or failed series lookup into a selectable subset', async () => {
  await expect(resolveGallerySelection([member('a')], async () => ({ assets: [asset('a')], jobs: [], truncated: true }))).rejects.toThrow('无法完整读取');
  await expect(resolveGallerySelection([member('a')], async () => ({ assets: [], jobs: [], truncated: false }))).rejects.toThrow('已变化');
  await expect(resolveGallerySelection([member('a')], async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
});

it('leaves ungrouped selections as individual assets', async () => {
  const fetch = vi.fn();
  expect((await resolveGallerySelection([mapMedia(asset('a')), mapMedia(asset('b'))], fetch)).map(item => item.id)).toEqual(['a', 'b']);
  expect(fetch).not.toHaveBeenCalled();
});
