import { describe, expect, it } from 'vitest';
import { groupPendingStudies, type PendingStudy } from './pending-studies';
import { mapMedia } from './data';
import { AssetDtoSchema } from '@imagine/shared';

const task = (id: string, seriesId?: string): PendingStudy => ({ id, jobId: id, ...(seriesId ? { seriesId } : {}), prompt: 'fixture', kind: 'image', width: 1, height: 1, status: 'running', progress: null });
describe('pending series', () => {
  it('groups before any outputs exist, separates batches and respects disabled grouping', () => {
    const grouped = groupPendingStudies([task('a', 'b:one'), task('b', 'b:one'), task('c', 'b:two'), task('d')], []);
    expect(grouped.pending.map(item => item.seriesCount)).toEqual([2, 1, undefined]);
    expect(groupPendingStudies([task('a'), task('b')], []).pending).toHaveLength(2);
  });
  it('keeps the completed cover and remaining failures in one entry until all jobs finish', () => {
    const cover = mapMedia(AssetDtoSchema.parse({ id: 'cover', parentAssetId: null, contentUrl: '/cover', thumbnailUrl: null, posterUrl: null, originalFilename: null, sha256: 'a'.repeat(64), metadata: {}, collectionIds: [], jobId: 'completed', type: 'image', role: 'output', mimeType: 'image/png', width: 512, height: 512, durationMs: null, fileSize: 128, favorite: false, createdAt: '2026-09-19T00:00:00.000Z', series: { id: 'b:one', count: 1 } }), null);
    const result = groupPendingStudies([{ ...task('a', 'b:one'), status: 'failed' }, task('b', 'b:one')], [cover]);
    expect(result.items).toHaveLength(0);
    expect(result.pending[0]).toMatchObject({ status: 'running', seriesCount: 3, cover });
    expect(result.pending[0]?.members).toHaveLength(2);
    expect(groupPendingStudies([], [cover]).items).toEqual([cover]);
  });
});
