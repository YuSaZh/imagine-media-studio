import {
  AssetDtoSchema,
  CollectionDtoSchema,
  JobDtoSchema,
  ModelDtoSchema,
  ProviderDtoSchema,
  type AssetDto,
  type CollectionDto,
  type JobDto,
  type ModelDto,
  type ProviderDto,
} from '@imagine/shared';

import type { AssetRecord } from '../database/assets.js';
import type { CollectionRecord } from '../database/collections.js';
import type { JobRecord } from '../database/jobs.js';
import type { ModelRecord } from '../database/models.js';
import type { ProviderStorageRecord } from '../database/providers.js';

function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function toProviderDto(record: ProviderStorageRecord): ProviderDto {
  return ProviderDtoSchema.parse({
    id: record.id,
    name: record.name,
    type: record.type,
    baseUrl: record.baseUrl,
    config: record.config,
    enabled: record.enabled,
    isDefault: record.isDefault,
    hasApiKey: record.apiKeyCiphertext !== null,
    hasCustomHeaders: record.headersCiphertext !== null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toModelDto(record: ModelRecord): ModelDto {
  return ModelDtoSchema.parse({
    id: record.id,
    providerId: record.providerId,
    modelId: record.modelId,
    displayName: record.displayName,
    capabilities: record.capabilities,
    capabilitySource: record.capabilitySource,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toJobDto(record: JobRecord, outputCount: number): JobDto {
  return JobDtoSchema.parse({
    id: record.id,
    operation: record.request.operation,
    providerId: record.request.providerId,
    modelId: record.request.modelId,
    prompt: record.request.prompt,
    request: record.request,
    status: record.status,
    stage: record.stage,
    progress: record.progress,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    retryCount: record.retryCount,
    retryOfJobId: record.retryOfJobId,
    rootJobId: record.rootJobId,
    revision: record.revision,
    outputCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    completedAt: timestamp(record.completedAt),
  });
}

export function toAssetDto(
  record: AssetRecord,
  collectionIds: readonly string[],
): AssetDto {
  return AssetDtoSchema.parse({
    id: record.id,
    jobId: record.jobId,
    parentAssetId: record.parentAssetId,
    type: record.type,
    role: record.role,
    contentUrl: `/internal/assets/${encodeURIComponent(record.id)}/content`,
    thumbnailUrl: record.thumbnailPath
      ? `/internal/assets/${encodeURIComponent(record.id)}/thumbnail`
      : null,
    posterUrl: record.posterPath
      ? `/internal/assets/${encodeURIComponent(record.id)}/poster`
      : null,
    originalFilename: record.originalFilename,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    fileSize: record.fileSize,
    sha256: record.sha256,
    metadata: record.metadata,
    favorite: record.favorite,
    collectionIds,
    createdAt: record.createdAt.toISOString(),
  });
}

export function toCollectionDto(record: CollectionRecord): CollectionDto {
  return CollectionDtoSchema.parse({
    id: record.id,
    name: record.name,
    itemCount: record.itemCount,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}
