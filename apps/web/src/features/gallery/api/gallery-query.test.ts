import { QueryClient } from '@tanstack/react-query';
import type { AssetDto, JobDto } from '@imagine/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { internalClient } from '../../../api/internal-client.js';
import { PR1_MOCK_GALLERY_ITEMS } from '../model/fixtures.js';
import type { FixtureGalleryItem } from '../model/types.js';
import {
  applyGalleryCacheAction,
  applyOptimisticSubmission,
  createGenerationRequest,
  createMockSubmissionItems,
  executeGalleryAction,
  folderQueryKey,
  foldersQueryKey,
  galleryQueryKey,
  isVisualFixtureMode,
  loadGalleryData,
  loadProviderData,
  reduceGalleryItems,
  rollbackOptimisticSubmission,
  type GalleryModel,
  type MockSubmission,
} from './gallery-query.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const imageSubmission: MockSubmission = {
  mode: 'image',
  prompt: 'A deterministic vertical batch',
  modelId: 'studio-image-v1',
  count: 4,
  aspectRatio: '9:16',
  durationSeconds: null,
  referenceCount: 3,
};

function requiredItem(items: readonly FixtureGalleryItem[], id: string): FixtureGalleryItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing gallery test item ${id}.`);
  return item;
}

describe('PR 1 gallery query model', () => {
  it('creates deterministic image batches with normalized request metadata', () => {
    const items = createMockSubmissionItems(imageSubmission, 61);

    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.id)).size).toBe(4);
    expect(new Set(items.map((item) => item.jobId)).size).toBe(1);
    expect(items.every((item) => item.kind === 'image')).toBe(true);
    expect(items.every((item) => item.aspectRatio === '9:16')).toBe(true);
    expect(items.every((item) => item.previewPath === '/mock-media/study-13-vertical.png')).toBe(true);
    expect(items.every((item) => item.width === 900 && item.height === 1600)).toBe(true);
    expect(items.every((item) => item.referenceCount === 3 && item.batchCount === 4)).toBe(true);
    expect(items[0]?.createdAt).toBe('2026-08-25T01:01:00.000Z');
  });

  it('forces video batches to one output while preserving duration and references', () => {
    const items = createMockSubmissionItems(
      {
        mode: 'video',
        prompt: 'A single motion study',
        modelId: 'studio-video-v1',
        count: 4,
        aspectRatio: '16:9',
        durationSeconds: 15,
        referenceCount: 4,
      },
      62,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'video',
      durationSeconds: 15,
      referenceCount: 1,
      batchCount: 1,
      aspectRatio: '16:9',
    });
  });

  it('keeps timestamps legal and IDs unique well beyond sixty submissions', () => {
    const first = createMockSubmissionItems({ ...imageSubmission, count: 1 }, 1);
    const sixtyFirst = createMockSubmissionItems({ ...imageSubmission, count: 1 }, 61);
    const distant = createMockSubmissionItems({ ...imageSubmission, count: 1 }, 10_000);
    const items = [...first, ...sixtyFirst, ...distant];

    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.every((item) => !Number.isNaN(Date.parse(item.createdAt)))).toBe(true);
    expect(distant[0]?.createdAt).toBe('2026-08-31T22:40:00.000Z');
  });

  it('inserts submissions during onMutate, derives the next sequence, and rolls back', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(galleryQueryKey, PR1_MOCK_GALLERY_ITEMS);

    const firstContext = await applyOptimisticSubmission(queryClient, imageSubmission);
    const secondContext = await applyOptimisticSubmission(queryClient, {
      ...imageSubmission,
      count: 1,
    });
    const current = queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ?? [];

    expect(firstContext.optimisticItems[0]?.id).toBe('optimistic-image-0001-01');
    expect(secondContext.optimisticItems[0]?.id).toBe('optimistic-image-0002-01');
    expect(current.slice(0, 1).map((item) => item.id)).toEqual(['optimistic-image-0002-01']);

    rollbackOptimisticSubmission(queryClient, secondContext);
    expect(queryClient.getQueryData(galleryQueryKey)).toEqual(secondContext.previousItems);

    const thirdContext = await applyOptimisticSubmission(queryClient, {
      ...imageSubmission,
      count: 1,
    });
    expect(thirdContext.optimisticItems[0]?.id).toBe('optimistic-image-0003-01');
    applyGalleryCacheAction(queryClient, { type: 'toggleSaved', itemId: 'image-02' });
    rollbackOptimisticSubmission(queryClient, thirdContext);
    const afterRollback =
      queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ?? [];
    expect(afterRollback.some((item) => item.id === thirdContext.optimisticItems[0]?.id)).toBe(false);
    expect(requiredItem(afterRollback, 'image-02').saved).toBe(
      !requiredItem(thirdContext.previousItems, 'image-02').saved,
    );

    applyGalleryCacheAction(queryClient, {
      type: 'removeMany',
      itemIds: firstContext.optimisticItems.map((item) => item.id),
    });
    const fourthContext = await applyOptimisticSubmission(queryClient, {
      ...imageSubmission,
      count: 1,
    });
    expect(fourthContext.optimisticItems[0]?.id).toBe('optimistic-image-0004-01');
  });

  it('updates saved, folder, retry, cancel, and removal state immutably', () => {
    const initial = PR1_MOCK_GALLERY_ITEMS;
    const savedBefore = requiredItem(initial, 'image-02').saved;
    const saved = reduceGalleryItems(initial, { type: 'toggleSaved', itemId: 'image-02' });
    expect(saved).not.toBe(initial);
    expect(requiredItem(saved, 'image-02').saved).toBe(!savedBefore);

    const folderAdded = reduceGalleryItems(saved, {
      type: 'toggleFolder',
      itemId: 'image-02',
      folderId: 'folder-portraits',
    });
    expect(requiredItem(folderAdded, 'image-02').folderIds).toContain('folder-portraits');
    const folderRemoved = reduceGalleryItems(folderAdded, {
      type: 'toggleFolder',
      itemId: 'image-02',
      folderId: 'folder-portraits',
    });
    expect(requiredItem(folderRemoved, 'image-02').folderIds).not.toContain('folder-portraits');

    const retried = reduceGalleryItems(initial, { type: 'retry', itemId: 'image-19' });
    expect(requiredItem(retried, 'image-19')).toMatchObject({
      status: 'queued',
      stage: 'Waiting in queue',
      error: null,
    });
    const cancelled = reduceGalleryItems(initial, { type: 'cancel', itemId: 'image-01' });
    expect(requiredItem(cancelled, 'image-01')).toMatchObject({
      status: 'cancelled',
      stage: 'Cancelled',
    });

    const removed = reduceGalleryItems(initial, { type: 'remove', itemId: 'image-01' });
    expect(removed.some((item) => item.id === 'image-01')).toBe(false);
    const removedMany = reduceGalleryItems(initial, {
      type: 'removeMany',
      itemIds: ['image-01', 'image-02', 'video-01'],
    });
    expect(removedMany).toHaveLength(initial.length - 3);
  });

  it('applies cache actions through the shared query key', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(galleryQueryKey, PR1_MOCK_GALLERY_ITEMS);
    applyGalleryCacheAction(queryClient, { type: 'toggleSaved', itemId: 'image-02' });

    const current = queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ?? [];
    expect(requiredItem(current, 'image-02').saved).toBe(
      !requiredItem(PR1_MOCK_GALLERY_ITEMS, 'image-02').saved,
    );
  });

  it('keeps fixture folder queries synchronized with the current Gallery cache', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(galleryQueryKey, PR1_MOCK_GALLERY_ITEMS);
    queryClient.setQueryData(folderQueryKey('folder-editorial'), {
      folder: null,
      items: [],
    });

    applyGalleryCacheAction(queryClient, {
      type: 'toggleFolder',
      itemId: 'image-02',
      folderId: 'folder-editorial',
    });

    const folder = queryClient.getQueryData<{
      items: readonly FixtureGalleryItem[];
    }>(folderQueryKey('folder-editorial'));
    const folders = queryClient.getQueryData<readonly { id: string; itemIds: readonly string[] }[]>(
      foldersQueryKey,
    );
    expect(folder?.items.map((item) => item.id)).toContain('image-02');
    expect(folders?.find((candidate) => candidate.id === 'folder-editorial')?.itemIds).toContain(
      'image-02',
    );
  });
});

const API_JOB: JobDto = {
  id: 'job-api-1',
  operation: 'image.generate',
  providerId: 'mock',
  modelId: 'mock-image-v1',
  prompt: 'Persisted API result',
  request: {
    operation: 'image.generate',
    providerId: 'mock',
    modelId: 'mock-image-v1',
    prompt: 'Persisted API result',
    inputs: [],
    aspectRatio: '1:1',
  },
  status: 'completed',
  stage: 'Ready',
  progress: 100,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
  retryOfJobId: null,
  rootJobId: 'job-api-1',
  revision: 2,
  outputCount: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:01:00.000Z',
  completedAt: '2026-08-25T00:01:00.000Z',
};

const API_ASSET: AssetDto = {
  id: 'asset-api-1',
  jobId: API_JOB.id,
  parentAssetId: null,
  type: 'image',
  role: 'output',
  contentUrl: '/internal/assets/asset-api-1/content',
  thumbnailUrl: '/internal/assets/asset-api-1/thumbnail',
  posterUrl: null,
  originalFilename: 'result.png',
  mimeType: 'image/png',
  width: 1024,
  height: 1024,
  durationMs: null,
  fileSize: 128,
  sha256: 'a'.repeat(64),
  metadata: {},
  favorite: false,
  collectionIds: [],
  createdAt: '2026-08-25T00:01:00.000Z',
};

describe('PR 2 gallery API integration', () => {
  it('enables visual fixtures only for the exact session marker', () => {
    const getItem = vi.fn(() => 'pr1-v1');
    vi.stubGlobal('sessionStorage', { getItem });
    expect(isVisualFixtureMode()).toBe(true);
    expect(getItem).toHaveBeenCalledWith('imagine.visual-fixtures');

    getItem.mockReturnValue('PR1-V1');
    expect(isVisualFixtureMode()).toBe(false);
  });

  it('loads every API page and never falls back to fixtures on failure', async () => {
    const listAssets = vi.spyOn(internalClient, 'listAssets')
      .mockResolvedValueOnce({ items: [], nextCursor: 'asset-page-2' })
      .mockResolvedValueOnce({ items: [API_ASSET], nextCursor: null });
    vi.spyOn(internalClient, 'listJobs').mockResolvedValue({
      items: [API_JOB],
      nextCursor: null,
    });

    await expect(loadGalleryData()).resolves.toEqual([
      expect.objectContaining({ id: API_ASSET.id, jobId: API_JOB.id }),
    ]);
    expect(listAssets).toHaveBeenNthCalledWith(2, { cursor: 'asset-page-2', limit: 100 });

    listAssets.mockReset().mockRejectedValue(new Error('API unavailable'));
    await expect(loadGalleryData()).rejects.toThrow('API unavailable');
  });

  it('uses fixtures only when explicitly requested and does not call the API', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'pr1-v1' });
    const listAssets = vi.spyOn(internalClient, 'listAssets');
    const listJobs = vi.spyOn(internalClient, 'listJobs');

    await expect(loadGalleryData()).resolves.toBe(PR1_MOCK_GALLERY_ITEMS);
    expect(listAssets).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('loads providers and maps model capability data for the Composer', async () => {
    vi.spyOn(internalClient, 'listProviders').mockResolvedValue({
      items: [{
        id: 'provider-api',
        name: 'API Provider',
        type: 'mock',
        baseUrl: null,
        config: {},
        enabled: true,
        isDefault: true,
        hasApiKey: false,
        hasCustomHeaders: false,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }],
      nextCursor: null,
    });
    vi.spyOn(internalClient, 'listModels').mockResolvedValue({
      items: [{
        id: 'model-row-api',
        providerId: 'provider-api',
        modelId: 'image-api-v1',
        displayName: 'Image API',
        capabilities: {
          operations: ['image.generate', 'image.edit'],
          aspectRatios: ['1:1', '9:16'],
          maxReferenceImages: 2,
          supportsBatchCount: true,
          maxBatchCount: 3,
        },
        capabilitySource: 'mock',
        enabled: true,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }],
      nextCursor: null,
    });

    await expect(loadProviderData()).resolves.toEqual(
      expect.objectContaining({
        id: 'provider-api',
        models: [expect.objectContaining({
          id: 'image-api-v1',
          providerId: 'provider-api',
          mediaKind: 'image',
        })],
      }),
    );
  });

  it('creates requests with only durable reference asset IDs', () => {
    const model: GalleryModel = {
      id: 'image-api-v1',
      providerId: 'provider-api',
      displayName: 'Image API',
      mediaKind: 'image',
      capabilities: {
        operations: ['image.generate', 'image.edit'],
        aspectRatios: ['1:1'],
        resolutions: [],
        durations: [],
        maxReferenceImages: 2,
        supportsMask: false,
        supportsProgress: true,
        supportsCancel: true,
        supportsBatchCount: true,
        maxBatchCount: 2,
      },
    };

    expect(createGenerationRequest({
      mode: 'image',
      prompt: 'Use one persisted reference',
      modelId: model.id,
      providerId: model.providerId,
      count: 2,
      aspectRatio: '1:1',
      durationSeconds: null,
      referenceCount: 2,
      referenceAssetIds: ['asset-reference-1'],
    }, [model])).toEqual({
      operation: 'image.edit',
      providerId: 'provider-api',
      modelId: 'image-api-v1',
      prompt: 'Use one persisted reference',
      inputs: [{ assetId: 'asset-reference-1', role: 'reference' }],
      aspectRatio: '1:1',
      count: 2,
    });
  });

  it('executes persisted favorite, collection, job, and delete actions', async () => {
    const item: FixtureGalleryItem = {
      ...PR1_MOCK_GALLERY_ITEMS.find((candidate) => candidate.kind === 'image')!,
      id: API_ASSET.id,
      jobId: API_JOB.id,
      saved: false,
      folderIds: [],
    };
    const patchAsset = vi.spyOn(internalClient, 'patchAsset').mockResolvedValue({ asset: API_ASSET });
    const add = vi.spyOn(internalClient, 'addCollectionAssets').mockResolvedValue(undefined as never);
    const removeFolder = vi.spyOn(internalClient, 'removeCollectionAsset').mockResolvedValue();
    const retry = vi.spyOn(internalClient, 'retryJob').mockResolvedValue(undefined as never);
    const cancel = vi.spyOn(internalClient, 'cancelJob').mockResolvedValue(undefined as never);
    const deleteAsset = vi.spyOn(internalClient, 'deleteAsset').mockResolvedValue();
    const deleteJob = vi.spyOn(internalClient, 'deleteJob').mockResolvedValue();

    await executeGalleryAction({ type: 'toggleSaved', itemId: item.id }, [item]);
    await executeGalleryAction(
      { type: 'toggleFolder', itemId: item.id, folderId: 'folder-api' },
      [item],
    );
    await executeGalleryAction(
      { type: 'toggleFolder', itemId: item.id, folderId: 'folder-api' },
      [{ ...item, folderIds: ['folder-api'] }],
    );
    await executeGalleryAction({ type: 'retry', itemId: item.id }, [item]);
    await executeGalleryAction({ type: 'cancel', itemId: item.id }, [item]);
    await executeGalleryAction({ type: 'remove', itemId: item.id }, [item]);
    await executeGalleryAction(
      { type: 'remove', itemId: 'job-slot-job-api-2-0' },
      [{ ...item, id: 'job-slot-job-api-2-0', jobId: 'job-api-2' }],
    );

    expect(patchAsset).toHaveBeenCalledWith(item.id, true);
    expect(add).toHaveBeenCalledWith('folder-api', [item.id]);
    expect(removeFolder).toHaveBeenCalledWith('folder-api', item.id);
    expect(retry).toHaveBeenCalledWith(item.jobId);
    expect(cancel).toHaveBeenCalledWith(item.jobId);
    expect(deleteAsset).toHaveBeenCalledWith(item.id);
    expect(deleteJob).toHaveBeenCalledWith('job-api-2');
  });
});
