import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { PR1_MOCK_GALLERY_ITEMS } from '../model/fixtures.js';
import type { FixtureGalleryItem } from '../model/types.js';
import {
  applyGalleryCacheAction,
  applyOptimisticSubmission,
  createMockSubmissionItems,
  galleryQueryKey,
  reduceGalleryItems,
  rollbackOptimisticSubmission,
  type MockSubmission,
} from './gallery-query.js';

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
});
