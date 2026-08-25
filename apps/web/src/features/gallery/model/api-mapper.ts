import type { AssetDto, JobDto } from '@imagine/shared';

import type {
  FixtureAspectRatio,
  FixtureGalleryItem,
  FixtureJobStatus,
} from './types.js';

const KNOWN_ASPECT_RATIOS: readonly FixtureAspectRatio[] = ['2:3', '3:2', '1:1', '9:16', '16:9'];
const PLACEHOLDER_PATH = '/icons/app-icon-512.png';

function aspectRatioFor(
  declared: string | undefined,
  width: number,
  height: number,
): FixtureAspectRatio {
  if (KNOWN_ASPECT_RATIOS.includes(declared as FixtureAspectRatio)) {
    return declared as FixtureAspectRatio;
  }
  const ratio = width / height;
  return [...KNOWN_ASPECT_RATIOS]
    .map((candidate) => {
      const [left, right] = candidate.split(':').map(Number);
      return { candidate, difference: Math.abs(ratio - (left ?? 1) / (right ?? 1)) };
    })
    .sort((left, right) => left.difference - right.difference)[0]?.candidate ?? '1:1';
}

function dimensionsForJob(job: JobDto): { width: number; height: number } {
  if (job.request.width && job.request.height) {
    return { width: job.request.width, height: job.request.height };
  }
  const aspectRatio = aspectRatioFor(job.request.aspectRatio, 1, 1);
  const [left, right] = aspectRatio.split(':').map(Number);
  return { width: (left ?? 1) * 512, height: (right ?? 1) * 512 };
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
    previewPath: asset.thumbnailUrl ?? asset.posterUrl ?? asset.contentUrl,
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
        sourcePath: null,
        posterPath: asset.posterUrl ?? asset.contentUrl,
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

export function mapInternalGallery(
  assets: readonly AssetDto[],
  jobs: readonly JobDto[],
): readonly FixtureGalleryItem[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const assetsByJob = new Map<string, AssetDto[]>();
  for (const asset of assets) {
    if (!asset.jobId) continue;
    const existing = assetsByJob.get(asset.jobId) ?? [];
    existing.push(asset);
    assetsByJob.set(asset.jobId, existing);
  }

  const mappedAssets = assets.map((asset) => mapAsset(
    asset,
    asset.jobId ? jobsById.get(asset.jobId) : undefined,
  ));
  const jobSlots = jobs.flatMap((job) => {
    const existingCount = assetsByJob.get(job.id)?.length ?? 0;
    if (job.status === 'completed' && existingCount > 0) return [];
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
