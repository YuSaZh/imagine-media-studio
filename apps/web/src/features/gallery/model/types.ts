import type { ImageInputPolicy } from '@imagine/shared';

import type { ImageAssetInputDescriptor } from '../../media-input/model/types.js';

export const PR1_JOB_STATUSES = [
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
] as const;

export type FixtureJobStatus = (typeof PR1_JOB_STATUSES)[number];

export type FixtureMediaOperation =
  | 'image.generate'
  | 'image.edit'
  | 'video.generate'
  | 'video.image_to_video'
  | 'video.reference_to_video';

export type FixtureAspectRatio = string;

export interface FixtureDurationRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface FixtureCapabilities {
  readonly operations: readonly FixtureMediaOperation[];
  readonly aspectRatios: readonly FixtureAspectRatio[];
  readonly resolutions: readonly string[];
  readonly durations: readonly number[];
  readonly durationRange?: FixtureDurationRange;
  readonly maxReferenceImages: number;
  readonly supportsMask: boolean;
  readonly supportsProgress: boolean;
  readonly supportsCancel: boolean;
  readonly supportsBatchCount: boolean;
  readonly maxBatchCount: number;
  readonly inputImagePolicy?: ImageInputPolicy;
}

export interface FixtureModel {
  readonly id: string;
  readonly displayName: string;
  readonly mediaKind: 'image' | 'video';
  readonly capabilities: FixtureCapabilities;
}

export interface FixtureProvider {
  readonly id: string;
  readonly type: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly models: readonly FixtureModel[];
}

export interface FixtureError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface FixtureGalleryItemBase {
  readonly id: string;
  readonly jobId: string;
  readonly prompt: string;
  readonly alt: string;
  readonly createdAt: string;
  readonly status: FixtureJobStatus;
  readonly stage: string;
  readonly progress: number | null;
  readonly error: FixtureError | null;
  readonly saved: boolean;
  readonly folderIds: readonly string[];
  readonly providerId: string;
  readonly modelId: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: FixtureAspectRatio;
  readonly referenceCount: number;
  readonly batchCount: number;
  readonly previewPath: string;
  readonly inputDescriptor: ImageAssetInputDescriptor | null;
  readonly persistedAsset: boolean;
}

export interface FixtureImageItem extends FixtureGalleryItemBase {
  readonly kind: 'image';
  readonly sourcePath: string;
  readonly posterPath: null;
  readonly durationSeconds: null;
}

export interface FixtureVideoItem extends FixtureGalleryItemBase {
  readonly kind: 'video';
  readonly sourcePath: string | null;
  readonly posterPath: string;
  readonly durationSeconds: number;
}

export type FixtureGalleryItem = FixtureImageItem | FixtureVideoItem;

export interface FixtureFolder {
  readonly id: string;
  readonly name: string;
  readonly itemIds: readonly string[];
}

export interface GalleryFixture {
  readonly version: 'pr1-v1';
  readonly provider: FixtureProvider;
  readonly imageAssets: readonly FixtureImageItem[];
  readonly videoItems: readonly FixtureVideoItem[];
  readonly items: readonly FixtureGalleryItem[];
  readonly folders: readonly FixtureFolder[];
}
