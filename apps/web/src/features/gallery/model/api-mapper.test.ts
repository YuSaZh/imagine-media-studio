import type { AssetDto, JobDto } from '@imagine/shared';
import { describe, expect, it } from 'vitest';

import { mapInternalGallery, VIDEO_PLACEHOLDER_PATH } from './api-mapper.js';
import { storedInputAvailability } from '../../media-input/model/input-compatibility.js';
import { DEFAULT_IMAGE_INPUT_POLICY } from '@imagine/shared';

const job: JobDto = {
  id: 'job-1',
  operation: 'image.generate',
  providerId: 'mock',
  modelId: 'mock-image-v1',
  prompt: 'Persistent prompt',
  request: {
    operation: 'image.generate',
    providerId: 'mock',
    modelId: 'mock-image-v1',
    prompt: 'Persistent prompt',
    inputs: [],
    aspectRatio: '16:9',
    count: 2,
  },
  status: 'remote_running',
  stage: 'Generating media',
  progress: 42,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
  retryOfJobId: null,
  rootJobId: null,
  revision: 3,
  outputCount: 2,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:01:00.000Z',
  completedAt: null,
};

const asset: AssetDto = {
  id: 'asset-1',
  jobId: 'job-1',
  parentAssetId: null,
  type: 'image',
  role: 'output',
  contentUrl: '/internal/assets/asset-1/content',
  thumbnailUrl: '/internal/assets/asset-1/thumbnail',
  posterUrl: null,
  originalFilename: null,
  mimeType: 'image/png',
  width: 1600,
  height: 900,
  durationMs: null,
  fileSize: 2048,
  sha256: 'a'.repeat(64),
  metadata: {},
  favorite: true,
  collectionIds: ['collection-1'],
  createdAt: '2026-08-25T00:02:00.000Z',
};

describe('mapInternalGallery', () => {
  it('de-duplicates records before creating output slots', () => {
    const items = mapInternalGallery([asset, asset], [job, job]);

    expect(items.map((item) => item.id)).toEqual(['asset-1', 'job-slot-job-1-1']);
  });

  it('keeps the latest repeated job and does not invent a completed result slot', () => {
    const latest = {
      ...job,
      stage: 'Latest stage',
      updatedAt: '2026-08-25T00:03:00.000Z',
      progress: 73,
    };

    expect(mapInternalGallery([], [job, latest])[0]).toMatchObject({
      status: 'remote_running',
      stage: 'Latest stage',
      progress: 73,
    });
    expect(mapInternalGallery([], [latest, job])[0]).toMatchObject({
      status: 'remote_running',
      stage: 'Latest stage',
      progress: 73,
    });
    expect(mapInternalGallery([], [{ ...latest, status: 'completed' }])).toEqual([]);
  });

  it('maps persisted assets and fills missing stable output slots', () => {
    const items = mapInternalGallery([asset], [job]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'asset-1',
      saved: true,
      folderIds: ['collection-1'],
      previewPath: '/internal/assets/asset-1/thumbnail',
      aspectRatio: '16:9',
      persistedAsset: true,
      inputDescriptor: {
        fileSize: 2048,
        height: 900,
        mimeType: 'image/png',
        width: 1600,
      },
    });
    expect(items[1]).toMatchObject({
      id: 'job-slot-job-1-1',
      status: 'remote_running',
      progress: 42,
      batchCount: 2,
      persistedAsset: false,
      inputDescriptor: null,
    });
  });

  it('represents expired jobs without assets as retryable terminal cards', () => {
    const [item] = mapInternalGallery([], [{
      ...job,
      id: 'job-expired',
      status: 'expired',
      stage: 'Provider result expired',
      errorCode: 'result_expired',
      errorMessage: 'The remote result expired before download.',
      outputCount: 1,
    }]);

    expect(item).toMatchObject({
      id: 'job-slot-job-expired-0',
      status: 'expired',
      error: { code: 'result_expired', retryable: true },
    });
  });

  it('keeps valid dynamic ratios for persisted dimensions and rejects invalid declarations', () => {
    const [dynamic] = mapInternalGallery([], [{
      ...job,
      id: 'job-dynamic-ratio',
      request: { ...job.request, aspectRatio: '4:3' },
      status: 'queued',
      outputCount: 1,
    }]);
    expect(dynamic).toMatchObject({ aspectRatio: '4:3', width: 2048, height: 1536 });

    const [inferred] = mapInternalGallery([], [{
      ...job,
      id: 'job-invalid-ratio',
      request: { ...job.request, aspectRatio: 'NaN:1', height: 900, width: 1600 },
      status: 'queued',
      outputCount: 1,
    }]);
    expect(inferred).toMatchObject({ aspectRatio: '16:9', width: 1600, height: 900 });
  });

  it('maps standalone uploads without inventing a Provider job', () => {
    const [item] = mapInternalGallery([], []).concat(
      mapInternalGallery([{ ...asset, id: 'upload-1', jobId: null, role: 'upload' }], []),
    );

    expect(item).toMatchObject({
      id: 'upload-1',
      jobId: 'upload-upload-1',
      providerId: 'local',
      status: 'completed',
    });
  });

  it('keeps video content separate from poster fallback', () => {
    const [item] = mapInternalGallery([{
      ...asset,
      contentUrl: '/internal/assets/video-1/content',
      durationMs: 12_500,
      id: 'video-1',
      mimeType: 'video/mp4',
      posterUrl: null,
      thumbnailUrl: null,
      type: 'video',
    }], []);

    expect(item).toMatchObject({
      kind: 'video',
      previewPath: VIDEO_PLACEHOLDER_PATH,
      posterPath: VIDEO_PLACEHOLDER_PATH,
      sourcePath: '/internal/assets/video-1/content',
      durationSeconds: 13,
    });
  });

  it('lets the Composer revalidate a persisted descriptor when model policy changes', () => {
    const [item] = mapInternalGallery([asset], [job]);
    expect(item).toBeDefined();
    expect(storedInputAvailability(item, DEFAULT_IMAGE_INPUT_POLICY, true)).toBe('ready');
    expect(storedInputAvailability(item, {
      ...DEFAULT_IMAGE_INPUT_POLICY,
      maxWidth: 512,
    }, true)).toBe('incompatible');
  });
});
