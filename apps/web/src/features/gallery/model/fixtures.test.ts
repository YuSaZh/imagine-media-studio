import { describe, expect, it } from 'vitest';

import {
  PR1_GALLERY_FIXTURE,
  PR1_MOCK_FOLDERS,
  PR1_MOCK_GALLERY_ITEMS,
  PR1_MOCK_IMAGE_ASSETS,
  PR1_MOCK_PROVIDER,
  PR1_MOCK_VIDEO_ITEMS,
} from './fixtures.js';
import { PR1_JOB_STATUSES } from './types.js';

describe('PR 1 gallery fixture', () => {
  it('contains the required deterministic image and video inventory', () => {
    expect(PR1_MOCK_IMAGE_ASSETS).toHaveLength(30);
    expect(PR1_MOCK_VIDEO_ITEMS).toHaveLength(8);
    expect(PR1_MOCK_GALLERY_ITEMS).toHaveLength(38);
    expect(PR1_GALLERY_FIXTURE.version).toBe('pr1-v1');

    expect(PR1_MOCK_IMAGE_ASSETS[0]).toMatchObject({
      id: 'image-01',
      jobId: 'job-image-01',
      createdAt: '2026-08-24T18:30:00.000Z',
      status: 'queued',
      progress: null,
    });
    expect(PR1_MOCK_VIDEO_ITEMS[7]).toMatchObject({
      id: 'video-08',
      jobId: 'job-video-08',
      createdAt: '2026-08-23T19:41:00.000Z',
      status: 'failed',
    });
  });

  it('uses unique stable IDs and covers every required job state', () => {
    const itemIds = PR1_MOCK_GALLERY_ITEMS.map((item) => item.id);
    const jobIds = PR1_MOCK_GALLERY_ITEMS.map((item) => item.jobId);
    const observedStatuses = new Set(PR1_MOCK_GALLERY_ITEMS.map((item) => item.status));

    expect(new Set(itemIds).size).toBe(itemIds.length);
    expect(new Set(jobIds).size).toBe(jobIds.length);
    expect(observedStatuses).toEqual(new Set(PR1_JOB_STATUSES));
    expect(PR1_MOCK_GALLERY_ITEMS).toEqual(
      [...PR1_MOCK_GALLERY_ITEMS].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      ),
    );
  });

  it('uses local study media with valid image and poster relationships', () => {
    const paths = PR1_MOCK_GALLERY_ITEMS.map((item) => item.previewPath);
    const aspectRatios = new Set(PR1_MOCK_GALLERY_ITEMS.map((item) => item.aspectRatio));

    expect(paths.every((path) => /^\/mock-media\/study-\d{2}-.+\.png$/.test(path))).toBe(true);
    expect(aspectRatios).toEqual(new Set(['2:3', '3:2', '1:1', '9:16', '16:9']));
    expect(paths).toContain('/mock-media/study-13-vertical.png');

    for (const image of PR1_MOCK_IMAGE_ASSETS) {
      expect(image.sourcePath).toBe(image.previewPath);
      expect(image.posterPath).toBeNull();
      expect(image.durationSeconds).toBeNull();
    }

    for (const video of PR1_MOCK_VIDEO_ITEMS) {
      expect(video.sourcePath).toBe('/mock-media/study-motion.mp4');
      expect(video.posterPath).toBe(video.previewPath);
      expect([5, 10, 15]).toContain(video.durationSeconds);
    }
  });

  it('keeps saved, folder, provider, model, and capability relations consistent', () => {
    const itemsById = new Map(PR1_MOCK_GALLERY_ITEMS.map((item) => [item.id, item]));

    expect(PR1_MOCK_GALLERY_ITEMS.some((item) => item.saved)).toBe(true);
    expect(PR1_MOCK_FOLDERS).toHaveLength(3);
    expect(PR1_MOCK_FOLDERS.every((folder) => folder.itemIds.length > 0)).toBe(true);

    for (const item of PR1_MOCK_GALLERY_ITEMS) {
      const model = PR1_MOCK_PROVIDER.models.find((candidate) => candidate.id === item.modelId);
      expect(item.providerId).toBe(PR1_MOCK_PROVIDER.id);
      expect(model?.mediaKind).toBe(item.kind);
      expect(item.progress === null || (item.progress >= 0 && item.progress <= 100)).toBe(true);
      expect(item.referenceCount).toBeGreaterThanOrEqual(0);
      expect(item.batchCount).toBeGreaterThanOrEqual(1);

      for (const folderId of item.folderIds) {
        const folder = PR1_MOCK_FOLDERS.find((candidate) => candidate.id === folderId);
        expect(folder?.itemIds).toContain(item.id);
      }
    }

    for (const folder of PR1_MOCK_FOLDERS) {
      for (const itemId of folder.itemIds) {
        expect(itemsById.get(itemId)?.folderIds).toContain(folder.id);
      }
    }

    const imageModel = PR1_MOCK_PROVIDER.models.find((model) => model.id === 'studio-image-v1');
    const videoModel = PR1_MOCK_PROVIDER.models.find((model) => model.id === 'studio-video-v1');

    expect(imageModel?.capabilities).toMatchObject({
      maxReferenceImages: 4,
      supportsMask: true,
      supportsProgress: true,
      supportsCancel: true,
      maxBatchCount: 4,
    });
    expect(imageModel?.capabilities.aspectRatios).toContain('9:16');
    expect(videoModel?.capabilities.aspectRatios).toContain('9:16');
    expect(videoModel?.capabilities.durations).toEqual([5, 10, 15]);
  });
});
