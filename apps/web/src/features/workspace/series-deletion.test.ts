import { expect, it, vi } from 'vitest';
import { AssetDtoSchema, type JobDto } from '@imagine/shared';
import { InternalApiError } from '../../api/internal-client';
import { createSeriesDeletionPlan, runSeriesDeletion } from './series-deletion';

const asset = (id: string) => AssetDtoSchema.parse({ id, parentAssetId: null, contentUrl: `/${id}`, thumbnailUrl: null, posterUrl: null, originalFilename: null, sha256: 'a'.repeat(64), metadata: {}, collectionIds: [], jobId: null, type: 'image', role: 'upload', mimeType: 'image/png', width: 512, height: 512, durationMs: null, fileSize: 128, favorite: false, createdAt: '2026-10-09T00:00:00.000Z' });
const job = (id: string, status: JobDto['status']) => ({ id, status }) as JobDto;
const missing = (code: string) => new InternalApiError(404, code, 'Not found');

it('retries only failed members after the cover was removed, then only failed tasks', async () => {
  const series = { assets: [asset('cover'), asset('other')], jobs: [job('failed', 'failed'), job('done', 'completed')], truncated: false };
  const plan = createSeriesDeletionPlan(series);
  const client = {
    deleteAsset: vi.fn(async (id: string) => { if (id === 'other') throw new Error('unavailable'); }),
    deleteJob: vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined),
  };
  expect((await runSeriesDeletion(plan, client)).complete).toBe(false);
  expect(plan.assets.map(item => item.id)).toEqual(['other']);
  expect(client.deleteJob).not.toHaveBeenCalled();
  client.deleteAsset.mockResolvedValue(undefined);
  expect((await runSeriesDeletion(plan, client)).complete).toBe(false);
  expect(plan.assets).toEqual([]);
  expect(plan.jobIds).toEqual(['failed']);
  expect((await runSeriesDeletion(plan, client)).complete).toBe(true);
  expect(client.deleteAsset.mock.calls).toEqual([['cover'], ['other'], ['other']]);
  expect(client.deleteJob.mock.calls).toEqual([['failed'], ['failed']]);
  // The loaded family remains unchanged; later retries never rediscover new members.
  expect(series.assets).toHaveLength(2);
});

it('finishes ambiguous deletes once retries confirm that the asset and task are absent', async () => {
  const plan = createSeriesDeletionPlan({ assets: [asset('cover')], jobs: [job('task', 'cancelled')], truncated: false });
  const client = { deleteAsset: vi.fn().mockRejectedValueOnce(new TypeError('Response lost')).mockRejectedValue(missing('asset_not_found')), deleteJob: vi.fn().mockRejectedValue(missing('job_not_found')) };
  expect((await runSeriesDeletion(plan, client)).complete).toBe(false);
  const retried = await runSeriesDeletion(plan, client);
  expect(retried.complete).toBe(true);
  expect(retried.deletedAssets.map(item => item.id)).toEqual(['cover']);
  expect(retried.deletedJobIds).toEqual(['task']);
});

it.each([new InternalApiError(401, 'authentication_required', 'Login'), new InternalApiError(404, 'route_not_found', 'Bad route'), new InternalApiError(500, 'asset_not_found', 'Failure')])('does not swallow unrelated failures: %s', async error => {
  const plan = createSeriesDeletionPlan({ assets: [asset('cover')], jobs: [], truncated: false });
  expect((await runSeriesDeletion(plan, { deleteAsset: vi.fn().mockRejectedValue(error), deleteJob: vi.fn() })).complete).toBe(false);
  expect(plan.assets).toHaveLength(1);
});

it('refuses partial families and running tasks before making a deletion plan', () => {
  expect(() => createSeriesDeletionPlan({ assets: [], jobs: [], truncated: true })).toThrow('无法完整删除');
  expect(() => createSeriesDeletionPlan({ assets: [asset('cover')], jobs: [job('running', 'remote_running')], truncated: false })).toThrow('请先取消');
});
