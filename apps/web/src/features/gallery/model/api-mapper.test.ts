import type { AssetDto, JobDto } from '@imagine/shared';
import { describe, expect, it } from 'vitest';

import { mapInternalGallery } from './api-mapper.js';

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
  it('maps persisted assets and fills missing stable output slots', () => {
    const items = mapInternalGallery([asset], [job]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'asset-1',
      saved: true,
      folderIds: ['collection-1'],
      previewPath: '/internal/assets/asset-1/thumbnail',
      aspectRatio: '16:9',
    });
    expect(items[1]).toMatchObject({
      id: 'job-slot-job-1-1',
      status: 'remote_running',
      progress: 42,
      batchCount: 2,
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
});
