import type { AssetDto, JobDto } from '@imagine/shared';

import type {
  FixtureAspectRatio,
  FixtureGalleryItem,
  FixtureJobStatus,
} from './types.js';
import { dimensionsForAspectRatio, nearestAspectRatio, parseAspectRatio } from './aspect-ratio.js';
const PLACEHOLDER_PATH = '/icons/app-icon-512.png';
export const VIDEO_PLACEHOLDER_PATH = PLACEHOLDER_PATH;

function aspectRatioFor(
  declared: string | undefined,
  width: number,
  height: number,
): FixtureAspectRatio {
  return parseAspectRatio(declared) ?? nearestAspectRatio(width, height);
}

function dimensionsForJob(job: JobDto): { width: number; height: number } {
  if (job.request.width && job.request.height) {
    return { width: job.request.width, height: job.request.height };
  }
  return dimensionsForAspectRatio(aspectRatioFor(job.request.aspectRatio, 1, 1), 2_048);
}

function errorForJob(job: JobDto) {
  if (!job.errorCode && !job.errorMessage) return null;
  return {
    code: job.errorCode ?? 'generation_error',
    message: job.errorMessage ?? 'The generation did not complete.',
    retryable: ['expired', 'failed'].includes(job.status),
  };
}

function mapAsset(asset: AssetDto, job: JobDto | undefined): FixtureGalleryItem {
  const width = asset.width ?? 1;
  const height = asset.height ?? 1;
  const status: FixtureJobStatus = job?.status ?? 'completed';
  const common = {
    id: asset.id,
    jobId: asset.jobId ?? `upload-${asset.id}`,
    prompt: job?.prompt ?? asset.originalFilename ?? 'Uploaded media',
    alt: asset.originalFilename ?? `Generated ${asset.type}`,
    createdAt: asset.createdAt,
    status,
    stage: job?.stage ?? 'Ready',
    progress: job?.progress ?? (status === 'completed' ? 100 : null),
    error: job ? errorForJob(job) : null,
    saved: asset.favorite,
    folderIds: asset.collectionIds,
    providerId: job?.providerId ?? 'local',
    modelId: job?.modelId ?? 'upload',
    width,
    height,
    aspectRatio: aspectRatioFor(job?.request.aspectRatio, width, height),
    referenceCount: job?.request.inputs.length ?? 0,
    batchCount: Math.max(1, job?.outputCount ?? 1),
    previewPath: asset.type === 'video'
      ? asset.thumbnailUrl ?? asset.posterUrl ?? PLACEHOLDER_PATH
      : asset.thumbnailUrl ?? asset.posterUrl ?? asset.contentUrl,
    inputDescriptor: asset.type === 'image' && asset.width !== null && asset.height !== null
      ? {
          fileSize: asset.fileSize,
          height: asset.height,
          mimeType: asset.mimeType,
          width: asset.width,
        }
      : null,
    persistedAsset: true,
  };
  return asset.type === 'image'
    ? {
        ...common,
        kind: 'image',
        sourcePath: asset.contentUrl,
        posterPath: null,
        durationSeconds: null,
      }
    : {
        ...common,
        kind: 'video',
        sourcePath: asset.contentUrl,
        posterPath: asset.posterUrl ?? asset.thumbnailUrl ?? PLACEHOLDER_PATH,
        durationSeconds: Math.max(0, Math.round((asset.durationMs ?? 0) / 1000)),
      };
}

function mapJobSlot(job: JobDto, outputIndex: number): FixtureGalleryItem {
  const kind = job.operation.startsWith('video.') ? 'video' : 'image';
  const { width, height } = dimensionsForJob(job);
  const common = {
    id: `job-slot-${job.id}-${outputIndex}`,
    jobId: job.id,
    prompt: job.prompt,
    alt: `${kind === 'video' ? 'Video' : 'Image'} result ${outputIndex + 1}`,
    createdAt: job.createdAt,
    status: job.status as FixtureJobStatus,
    stage: job.stage,
    progress: job.progress,
    error: errorForJob(job),
    saved: false,
    folderIds: [],
    providerId: job.providerId,
    modelId: job.modelId,
    width,
    height,
    aspectRatio: aspectRatioFor(job.request.aspectRatio, width, height),
    referenceCount: job.request.inputs.length,
    batchCount: Math.max(1, job.outputCount),
    previewPath: PLACEHOLDER_PATH,
    inputDescriptor: null,
    persistedAsset: false,
  };
  return kind === 'image'
    ? {
        ...common,
        kind: 'image',
        sourcePath: PLACEHOLDER_PATH,
        posterPath: null,
        durationSeconds: null,
      }
    : {
        ...common,
        kind: 'video',
        sourcePath: null,
        posterPath: PLACEHOLDER_PATH,
        durationSeconds: Math.round(job.request.durationSeconds ?? 0),
      };
}

function uniqueById<T extends { readonly id: string }>(
  records: readonly T[],
  timestampFor?: (record: T) => string,
): readonly T[] {
  const recordsById = new Map<string, T>();
  for (const record of records) {
    const current = recordsById.get(record.id);
    if (current === undefined || timestampFor === undefined || timestampFor(record) >= timestampFor(current)) {
      recordsById.set(record.id, record);
    }
  }
  return [...recordsById.values()];
}

export function mapInternalGallery(
  assets: readonly AssetDto[],
  jobs: readonly JobDto[],
): readonly FixtureGalleryItem[] {
  const uniqueAssets = uniqueById(assets, (asset) => asset.createdAt);
  const uniqueJobs = uniqueById(jobs, (job) => job.updatedAt);
  const jobsById = new Map(uniqueJobs.map((job) => [job.id, job]));
  const assetsByJob = new Map<string, AssetDto[]>();
  for (const asset of uniqueAssets) {
    if (!asset.jobId) continue;
    const existing = assetsByJob.get(asset.jobId) ?? [];
    existing.push(asset);
    assetsByJob.set(asset.jobId, existing);
  }

  const mappedAssets = uniqueAssets.map((asset) => mapAsset(
    asset,
    asset.jobId ? jobsById.get(asset.jobId) : undefined,
  ));
  const jobSlots = uniqueJobs.flatMap((job) => {
    const existingCount = assetsByJob.get(job.id)?.length ?? 0;
    if (job.status === 'completed') return [];
    const slotCount = Math.max(1, job.outputCount || job.request.count || 1);
    return Array.from(
      { length: Math.max(0, slotCount - existingCount) },
      (_, index) => mapJobSlot(job, existingCount + index),
    );
  });

  return [...mappedAssets, ...jobSlots].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}
