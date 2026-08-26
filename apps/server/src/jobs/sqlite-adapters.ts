import type { SubmittedAsset } from '@imagine/provider-contract';
import { InternalEventSchema, type JobStatus } from '@imagine/shared';

import type { ChangeEventRecord } from '../database/events.js';
import type {
  FinalizeOutputInput,
  FinalizeOutputsResult,
  JobOutputRecord,
  JobRecord,
  UpdateJobStatusFields,
} from '../database/jobs.js';
import { JobRepositoryError } from '../database/jobs.js';
import type { AssetMediaService } from '../media/asset-media-service.js';
import type { ProviderOutputMediaRecord } from '../media/types.js';
import type {
  JobRunnerOptions,
  JobTransitionCommit,
  JobTransitionInput,
  MaterializedAsset,
  MediaMaterializerPort,
  ProviderRegistryPort,
  ProviderResultResolver,
  RunnerAssetPort,
  RunnerEvent,
  RunnerEventPort,
  RunnerJob,
  RunnerJobPort,
} from './ports.js';
import type { StageRetryCounts } from './retry-budget.js';
import {
  MAX_SUBMITTED_ASSETS,
  SubmittedAssetValidationError,
  assertDurableResultManifest,
  assertSubmittedManifestSize,
  assertSubmittedMetadata,
  validateSubmittedAssets,
} from './submitted-asset-validator.js';

interface DurableRunnerManifest {
  version: 1;
  resultAssets?: readonly SubmittedAsset[];
  materializedAssets?: readonly MaterializedAsset[];
}

export interface SqliteJobRepositoryPort {
  get(jobId: string): JobRecord | null | Promise<JobRecord | null>;
  listRecoverable(): readonly JobRecord[] | Promise<readonly JobRecord[]>;
  claimQueued(
    jobId: string,
    expectedRevision: number,
  ): JobRecord | null | Promise<JobRecord | null>;
  compareAndSetStatus(
    jobId: string,
    expectedRevision: number,
    expectedStatuses: readonly JobStatus[],
    status: JobStatus,
    stage: string,
    fields?: UpdateJobStatusFields,
  ): JobRecord | null | Promise<JobRecord | null>;
  requestCancel(
    jobId: string,
    expectedRevision: number,
  ): JobRecord | null | Promise<JobRecord | null>;
  recoverCancellation(
    jobId: string,
    expectedRevision: number,
  ): JobRecord | null | Promise<JobRecord | null>;
  quarantineInvalidManifest?(
    jobId: string,
    expectedRevision: number,
  ): JobRecord | null | Promise<JobRecord | null>;
  quarantineInvalidAdapterRef?(
    jobId: string,
    expectedRevision: number,
  ): JobRecord | null | Promise<JobRecord | null>;
  listOutputs(jobId: string): readonly JobOutputRecord[] | Promise<readonly JobOutputRecord[]>;
  finalizeOutputs(
    jobId: string,
    expectedRevision: number,
    assets: readonly FinalizeOutputInput[],
  ): FinalizeOutputsResult | null | Promise<FinalizeOutputsResult | null>;
}

export interface SqliteChangeEventRepositoryPort {
  latestForAggregate(
    aggregateType: string,
    aggregateId: string,
  ): ChangeEventRecord | null | Promise<ChangeEventRecord | null>;
}

export interface LiveEventBrokerPort {
  publish(event: ReturnType<typeof InternalEventSchema.parse>): void;
}

export type AssetMediaServicePort = Pick<
  AssetMediaService,
  | 'cleanupProviderOutputs'
  | 'materializeProviderBase64'
  | 'materializeProviderUrl'
  | 'releaseProviderOutputs'
  | 'validateProviderOutputs'
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function isMediaType(value: unknown): value is 'image' | 'video' {
  return value === 'image' || value === 'video';
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isOutputLink(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'slot' && key !== 'assetId')) {
    return false;
  }
  return (
    Object.keys(value).length === 2 &&
    typeof value.slot === 'number' &&
    Number.isSafeInteger(value.slot) &&
    value.slot >= 0 &&
    (value.assetId === null || (
      typeof value.assetId === 'string' &&
      value.assetId.length > 0 &&
      value.assetId.length <= 4_096 &&
      !hasControlCharacters(value.assetId)
    ))
  );
}

function isMaterializedAsset(value: unknown): value is MaterializedAsset {
  if (!(
    isRecord(value) &&
    isMediaType(value.type) &&
    typeof value.mimeType === 'string' && value.mimeType.length > 0 && value.mimeType.length <= 128 &&
    typeof value.filePath === 'string' && value.filePath.length > 0 && value.filePath.length <= 4_096 &&
    typeof value.fileSize === 'number' &&
    Number.isSafeInteger(value.fileSize) && value.fileSize >= 0 &&
    typeof value.sha256 === 'string' && value.sha256.length > 0 && value.sha256.length <= 4_096 &&
    (value.thumbnailPath === undefined || value.thumbnailPath === null || typeof value.thumbnailPath === 'string') &&
    (value.posterPath === undefined || value.posterPath === null || typeof value.posterPath === 'string') &&
    (value.width === undefined || value.width === null || (typeof value.width === 'number' && Number.isFinite(value.width))) &&
    (value.height === undefined || value.height === null || (typeof value.height === 'number' && Number.isFinite(value.height))) &&
    (value.durationMs === undefined || value.durationMs === null || (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs))) &&
    (value.materializationKey === undefined || typeof value.materializationKey === 'string') &&
    (value.sourceFingerprint === undefined || typeof value.sourceFingerprint === 'string') &&
    (value.resultId === undefined || typeof value.resultId === 'string') &&
    (value.filename === undefined || typeof value.filename === 'string') &&
    (value.metadata === undefined || isRecord(value.metadata))
  )) return false;
  const allowedKeys = new Set([
    'type', 'mimeType', 'filePath', 'thumbnailPath', 'posterPath', 'width', 'height',
    'durationMs', 'materializationKey', 'sourceFingerprint', 'fileSize', 'sha256', 'resultId',
    'filename', 'metadata',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const strings = [
    value.mimeType,
    value.filePath,
    value.sha256,
    value.thumbnailPath,
    value.posterPath,
    value.materializationKey,
    value.sourceFingerprint,
    value.resultId,
    value.filename,
  ];
  if (strings.some((candidate) =>
    candidate !== undefined && candidate !== null &&
    (candidate.length > 4_096 || hasControlCharacters(candidate)))) return false;
  if (value.metadata !== undefined) {
    try {
      assertSubmittedMetadata(value.metadata);
    } catch {
      return false;
    }
  }
  return true;
}

function readMaterializedAssets(value: unknown, maxAssets: number): readonly MaterializedAsset[] {
  if (!Array.isArray(value) || value.some((asset) => !isMaterializedAsset(asset))) {
    throw new SubmittedAssetValidationError('Persisted materialized asset manifest is invalid.');
  }
  if (value.length > maxAssets || value.length > MAX_SUBMITTED_ASSETS) {
    throw new SubmittedAssetValidationError('Persisted materialized asset manifest is too large.');
  }
  return value;
}

function readManifest(
  value: readonly unknown[],
  maxAssets: number,
): DurableRunnerManifest {
  assertDurableResultManifest(value, maxAssets);
  assertSubmittedManifestSize(value);
  const envelope = value[0];
  if (isRecord(envelope) && envelope.version === 1) {
    if (Object.keys(envelope).some((key) => !['version', 'resultAssets', 'materializedAssets'].includes(key))) {
      throw new SubmittedAssetValidationError('Persisted result manifest contains unsupported fields.');
    }
    const resultAssets = envelope.resultAssets === undefined
      ? undefined
      : validateSubmittedAssets(envelope.resultAssets, { allowEmpty: true, maxAssets });
    const materializedAssets = envelope.materializedAssets === undefined
      ? undefined
      : readMaterializedAssets(envelope.materializedAssets, maxAssets);
    return {
      version: 1,
      ...(resultAssets === undefined ? {} : { resultAssets }),
      ...(materializedAssets === undefined ? {} : { materializedAssets }),
    };
  }

  // Completed jobs use the database's explicit output-link manifest. It is a
  // separate durable shape from provider results and must be fully validated.
  if (value.length > 0 && value.length <= MAX_SUBMITTED_ASSETS && value.every(isOutputLink)) {
    return { version: 1 };
  }

  const resultAssetValues = value.filter((asset) => isRecord(asset) && 'source' in asset);
  const materializedAssetValues = value.filter((asset) => isRecord(asset) && !('source' in asset));
  if (resultAssetValues.length > 0 && materializedAssetValues.length > 0) {
    return {
      version: 1,
      resultAssets: validateSubmittedAssets(resultAssetValues, { maxAssets }),
      materializedAssets: readMaterializedAssets(materializedAssetValues, maxAssets),
    };
  }
  const resultAssets = resultAssetValues.length > 0
    ? validateSubmittedAssets(resultAssetValues, { maxAssets })
    : undefined;
  const materializedAssets = materializedAssetValues.length > 0
    ? readMaterializedAssets(materializedAssetValues, maxAssets)
    : undefined;
  if (value.length > 0 && resultAssets === undefined && materializedAssets === undefined) {
    throw new SubmittedAssetValidationError('Persisted result manifest contains unsupported values.');
  }
  return {
    version: 1,
    ...(resultAssets === undefined || resultAssets.length === 0 ? {} : { resultAssets }),
    ...(materializedAssets === undefined || materializedAssets.length === 0 ? {} : { materializedAssets }),
  };
}

function errorFor(record: JobRecord): RunnerJob['error'] {
  if (record.errorCode === null || record.errorMessage === null) return null;
  return {
    code: record.errorCode,
    kind:
      record.status === 'rejected'
        ? 'rejected'
        : record.status === 'expired'
          ? 'expired'
          : 'unknown',
    message: record.errorMessage,
    retryable: false,
  };
}

export function toRunnerJob(record: JobRecord): RunnerJob {
  const manifest = readManifest(record.resultManifest, record.request.count ?? 1);
  return {
    id: record.id,
    request: record.request,
    status: record.status,
    stage: record.stage,
    progress: record.progress,
    revision: record.revision,
    idempotencyKey: record.idempotencyKey,
    attempt: record.submitAttempt,
    remoteJobId: record.remoteJobId,
    remoteDeadlineAt: record.remoteDeadlineAt,
    resultExpiresAt: record.resultExpiresAt,
    pollAfterAt: record.pollAfterAt,
    cancelRequestedAt: record.cancelRequestedAt,
    resultAssets: manifest.resultAssets ?? [],
    materializedAssets: manifest.materializedAssets ?? [],
    error: errorFor(record),
    stageRetryCounts: record.stageRetryCounts,
    adapterRef: record.adapterRef,
  };
}

function manifestFor(input: JobTransitionInput, maxAssets: number): readonly unknown[] | undefined {
  if (input.resultAssets === undefined && input.materializedAssets === undefined) return undefined;
  if (
    ['failed', 'cancelled', 'rejected', 'expired'].includes(input.status) &&
    input.resultAssets?.length === 0 &&
    input.materializedAssets?.length === 0
  ) {
    return [];
  }
  if (input.resultAssets !== undefined) {
    validateSubmittedAssets(input.resultAssets, { allowEmpty: true, maxAssets });
  }
  if (
    input.materializedAssets !== undefined &&
    (input.materializedAssets.length > maxAssets ||
      input.materializedAssets.length > MAX_SUBMITTED_ASSETS ||
      input.materializedAssets.some((asset) => !isMaterializedAsset(asset)))
  ) {
    throw new SubmittedAssetValidationError('Materialized asset manifest is invalid.');
  }
  const manifest: DurableRunnerManifest = {
    version: 1,
    ...(input.resultAssets === undefined ? {} : { resultAssets: input.resultAssets }),
    ...(input.materializedAssets === undefined
      ? {}
      : { materializedAssets: input.materializedAssets }),
  };
  assertDurableResultManifest([manifest], maxAssets);
  assertSubmittedManifestSize(manifest);
  return [manifest];
}

function fieldsFor(input: JobTransitionInput, maxAssets: number): UpdateJobStatusFields {
  const fields: {
    progress?: number | null;
    remoteJobId?: string | null;
    remoteDeadlineAt?: Date | null;
    resultExpiresAt?: Date | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    pollAfterAt?: Date | null;
    completedAt?: Date | null;
    resultManifest?: readonly unknown[];
    stageRetryCounts?: StageRetryCounts;
  } = {};
  if ('progress' in input) fields.progress = input.progress ?? null;
  if ('remoteJobId' in input) fields.remoteJobId = input.remoteJobId ?? null;
  if ('remoteDeadlineAt' in input) fields.remoteDeadlineAt = input.remoteDeadlineAt ?? null;
  if ('resultExpiresAt' in input) fields.resultExpiresAt = input.resultExpiresAt ?? null;
  if ('pollAfterAt' in input) fields.pollAfterAt = input.pollAfterAt ?? null;
  if ('error' in input) {
    fields.errorCode = input.error?.code ?? null;
    fields.errorMessage = input.error?.message ?? null;
  }
  const manifest = manifestFor(input, maxAssets);
  if (manifest !== undefined) fields.resultManifest = manifest;
  if (input.stageRetryCounts !== undefined) fields.stageRetryCounts = input.stageRetryCounts;
  return fields;
}

function toRunnerEvent(record: ChangeEventRecord, revision: number): RunnerEvent {
  return {
    id: record.id,
    aggregateType: 'job',
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    revision,
    payload: {
      ...record.payload,
      occurredAt: record.createdAt.toISOString(),
    },
  };
}

export class SqliteRunnerJobPort implements RunnerJobPort {
  public constructor(
    private readonly jobs: SqliteJobRepositoryPort,
    private readonly events: SqliteChangeEventRepositoryPort,
  ) {}

  public async get(jobId: string): Promise<RunnerJob | null> {
    const record = await this.jobs.get(jobId);
    return record === null ? null : toRunnerJob(record);
  }

  public async listRecoverable(): Promise<readonly RunnerJob[]> {
    const recovered: RunnerJob[] = [];
    for (const record of await this.jobs.listRecoverable()) {
      try {
        recovered.push(toRunnerJob(record));
      } catch (error) {
        if (error instanceof SubmittedAssetValidationError) {
          await this.jobs.quarantineInvalidManifest?.(record.id, record.revision);
          continue;
        }
        if (
          error instanceof JobRepositoryError &&
          (error.code === 'adapter_ref_corrupt' || error.code === 'persisted_data_corrupt')
        ) {
          await this.jobs.quarantineInvalidAdapterRef?.(record.id, record.revision);
          continue;
        }
        throw error;
      }
    }
    return recovered;
  }

  public async recoverCancellation(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null> {
    const record = await this.jobs.recoverCancellation(jobId, expectedRevision);
    return record === null ? null : this.committed(record);
  }

  public async claimQueued(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null> {
    const record = await this.jobs.claimQueued(jobId, expectedRevision);
    return record === null ? null : this.committed(record);
  }

  public async transition(
    jobId: string,
    input: JobTransitionInput,
  ): Promise<JobTransitionCommit | null> {
    if (input.status === 'cancelled') {
      return this.cancel(jobId, input.expectedRevision);
    }
    const current = input.resultAssets === undefined && input.materializedAssets === undefined
      ? null
      : await this.jobs.get(jobId);
    const maxAssets = Math.min(
      current?.request.count ?? 1,
      MAX_SUBMITTED_ASSETS,
    );
    if (input.resultAssets !== undefined) {
      validateSubmittedAssets(input.resultAssets, { allowEmpty: true, maxAssets });
    }
    const record = await this.jobs.compareAndSetStatus(
      jobId,
      input.expectedRevision,
      input.expectedStatuses,
      input.status,
      input.stage,
      fieldsFor(input, maxAssets),
    );
    return record === null ? null : this.committed(record);
  }

  private async cancel(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null> {
    const requested = await this.jobs.requestCancel(jobId, expectedRevision);
    if (requested === null) return null;
    if (requested.status === 'cancelled') return this.committed(requested);

    const cancelled = await this.jobs.compareAndSetStatus(
      jobId,
      requested.revision,
      [requested.status],
      'cancelled',
      'cancelled',
      {
        pollAfterAt: null,
        resultManifest: [],
        remoteDeadlineAt: null,
        resultExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        stageRetryCounts: { poll: 0, download: 0, process: 0 },
      },
    );
    return cancelled === null ? null : this.committed(cancelled);
  }

  private async committed(record: JobRecord): Promise<JobTransitionCommit> {
    const event = await this.events.latestForAggregate('job', record.id);
    if (event === null) {
      throw new Error(`Job ${record.id} committed without a durable change event.`);
    }
    const payloadRevision = event.payload.revision;
    if (typeof payloadRevision === 'number' && payloadRevision !== record.revision) {
      throw new Error(`Job ${record.id} event revision does not match its committed revision.`);
    }
    return { job: toRunnerJob(record), event: toRunnerEvent(event, record.revision) };
  }
}

export class SqliteRunnerAssetPort implements RunnerAssetPort {
  public constructor(
    private readonly jobs: SqliteJobRepositoryPort,
    private readonly events: SqliteChangeEventRepositoryPort,
  ) {}

  public async outputsConsistent(jobId: string): Promise<boolean> {
    const outputs = await this.jobs.listOutputs(jobId);
    return outputs.length > 0 && outputs.every((output) => output.assetId !== null);
  }

  public async finalize(
    jobId: string,
    expectedRevision: number,
    assets: readonly MaterializedAsset[],
  ): Promise<JobTransitionCommit | null> {
    const result = await this.jobs.finalizeOutputs(jobId, expectedRevision, assets);
    if (result === null) return null;
    return {
      job: toRunnerJob(result.job),
      event: toRunnerEvent(result.event, result.job.revision),
    };
  }
}

export class SqliteRunnerEventPort implements RunnerEventPort {
  public constructor(private readonly broker: LiveEventBrokerPort) {}

  public publish(event: RunnerEvent): void {
    if (typeof event.id !== 'number') {
      throw new TypeError('SQLite runner events require a numeric durable event id.');
    }
    this.broker.publish(
      InternalEventSchema.parse({
        version: 1,
        id: event.id,
        type:
          event.eventType === 'job.created'
            ? 'job.created'
            : event.eventType === 'job.deleted'
              ? 'job.deleted'
              : 'job.updated',
        entityId: event.aggregateId,
        revision: event.revision,
        occurredAt: event.payload.occurredAt,
      }),
    );
  }
}

function toMaterializedAsset(
  record: ProviderOutputMediaRecord,
  submitted: SubmittedAsset,
): MaterializedAsset {
  return {
    type: record.type,
    mimeType: record.mimeType,
    filePath: record.filePath,
    thumbnailPath: record.thumbnailPath,
    posterPath: record.posterPath,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    materializationKey: record.materializationKey,
    sourceFingerprint: record.sourceFingerprint,
    fileSize: record.fileSize,
    sha256: record.sha256,
    ...(submitted.resultId === undefined ? {} : { resultId: submitted.resultId }),
    ...(record.originalFilename === null ? {} : { filename: record.originalFilename }),
    metadata: {
      ...record.metadata,
      ...(submitted.metadata === undefined ? {} : { provider: submitted.metadata }),
    },
  };
}

export class AssetMediaMaterializer implements MediaMaterializerPort {
  public constructor(private readonly media: AssetMediaServicePort) {}

  public async materialize(
    job: RunnerJob,
    assets: readonly SubmittedAsset[],
    signal: AbortSignal,
    resolveProviderAsset?: ProviderResultResolver,
  ): Promise<readonly MaterializedAsset[]> {
    const materialized: MaterializedAsset[] = [];
    try {
      for (const [outputSlot, asset] of assets.entries()) {
        const common = {
          claimedMimeType: asset.mimeType,
          expectedKind: asset.type,
          jobId: job.id,
          originalFilename: asset.filename ?? null,
          outputSlot,
          ...(asset.resultId === undefined ? {} : { resultId: asset.resultId }),
          signal,
        };
        let record;
        if (asset.source === 'base64') {
          record = await this.media.materializeProviderBase64({ ...common, base64: asset.base64 });
        } else if (asset.source === 'url') {
          record = await this.media.materializeProviderUrl({ ...common, url: asset.url });
        } else {
          if (resolveProviderAsset === undefined) {
            throw new Error('Provider-owned result cannot be materialized without a resolver.');
          }
          const target = await resolveProviderAsset(asset, signal);
          record = await this.media.materializeProviderUrl({
            ...common,
            ...(target.claimedMimeType === undefined ? {} : { claimedMimeType: target.claimedMimeType }),
            ...(target.headers === undefined ? {} : { headers: target.headers }),
            providerOwned: true,
            url: target.url,
          });
        }
        materialized.push(toMaterializedAsset(record, asset));
      }
      return materialized;
    } catch (error) {
      await this.media.cleanupProviderOutputs(job.id, assets.length).catch(() => undefined);
      throw error;
    }
  }

  public async process(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
    signal: AbortSignal,
    resolveProviderAsset?: ProviderResultResolver,
  ): Promise<readonly MaterializedAsset[]> {
    try {
      if (await this.media.validateProviderOutputs(job.id, assets.map(toProviderOutputRecord))) {
        return assets;
      }
      await this.media.cleanupProviderOutputs(job.id, this.outputCount(job, assets));
      if (job.resultAssets.length === 0) {
        throw new Error(`Job ${job.id} has no durable Provider results to rematerialize.`);
      }
      return await this.materialize(job, job.resultAssets, signal, resolveProviderAsset);
    } catch (error) {
      await this.media.cleanupProviderOutputs(job.id, this.outputCount(job, assets)).catch(
        () => undefined,
      );
      throw error;
    }
  }

  public async discard(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void> {
    await this.media.cleanupProviderOutputs(job.id, this.outputCount(job, assets));
  }

  public async finalized(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void> {
    await this.media.releaseProviderOutputs(job.id, this.outputCount(job, assets));
  }

  private outputCount(job: RunnerJob, assets: readonly MaterializedAsset[]): number {
    return Math.max(job.resultAssets.length, assets.length, job.request.count ?? 1);
  }
}

function toProviderOutputRecord(asset: MaterializedAsset): ProviderOutputMediaRecord {
  return {
    durationMs: asset.durationMs ?? null,
    filePath: asset.filePath,
    fileSize: asset.fileSize,
    height: asset.height ?? null,
    materializationKey: asset.materializationKey ?? '',
    metadata: asset.metadata ?? {},
    mimeType: asset.mimeType,
    originalFilename: asset.filename ?? null,
    posterPath: asset.posterPath ?? null,
    sha256: asset.sha256,
    sourceFingerprint: asset.sourceFingerprint ?? '',
    thumbnailPath: asset.thumbnailPath ?? null,
    type: asset.type,
    width: asset.width ?? null,
  };
}

export interface CreateSqliteRunnerOptions {
  jobs: SqliteJobRepositoryPort;
  changeEvents: SqliteChangeEventRepositoryPort;
  broker: LiveEventBrokerPort;
  providers: ProviderRegistryPort;
  media: AssetMediaServicePort;
}

export function createSqliteRunnerOptions(
  options: CreateSqliteRunnerOptions,
): JobRunnerOptions {
  return {
    jobs: new SqliteRunnerJobPort(options.jobs, options.changeEvents),
    assets: new SqliteRunnerAssetPort(options.jobs, options.changeEvents),
    events: new SqliteRunnerEventPort(options.broker),
    providers: options.providers,
    media: new AssetMediaMaterializer(options.media),
  };
}
