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
import type { AssetMediaService } from '../media/asset-media-service.js';
import type { ProviderOutputMediaRecord } from '../media/types.js';
import type {
  JobRunnerOptions,
  JobTransitionCommit,
  JobTransitionInput,
  MaterializedAsset,
  MediaMaterializerPort,
  ProviderRegistryPort,
  RunnerAssetPort,
  RunnerEvent,
  RunnerEventPort,
  RunnerJob,
  RunnerJobPort,
} from './ports.js';
import type { StageRetryCounts } from './retry-budget.js';

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

function isSubmittedAsset(value: unknown): value is SubmittedAsset {
  if (
    !isRecord(value) ||
    !isMediaType(value.type) ||
    typeof value.mimeType !== 'string'
  ) {
    return false;
  }
  return (
    (value.source === 'base64' && typeof value.base64 === 'string') ||
    (value.source === 'url' && typeof value.url === 'string')
  );
}

function isMaterializedAsset(value: unknown): value is MaterializedAsset {
  return (
    isRecord(value) &&
    isMediaType(value.type) &&
    typeof value.mimeType === 'string' &&
    typeof value.filePath === 'string' &&
    typeof value.fileSize === 'number' &&
    Number.isFinite(value.fileSize) &&
    typeof value.sha256 === 'string' &&
    (value.thumbnailPath === undefined || value.thumbnailPath === null || typeof value.thumbnailPath === 'string') &&
    (value.posterPath === undefined || value.posterPath === null || typeof value.posterPath === 'string') &&
    (value.width === undefined || value.width === null || typeof value.width === 'number') &&
    (value.height === undefined || value.height === null || typeof value.height === 'number') &&
    (value.durationMs === undefined || value.durationMs === null || typeof value.durationMs === 'number') &&
    (value.materializationKey === undefined || typeof value.materializationKey === 'string') &&
    (value.sourceFingerprint === undefined || typeof value.sourceFingerprint === 'string') &&
    (value.resultId === undefined || typeof value.resultId === 'string') &&
    (value.filename === undefined || typeof value.filename === 'string') &&
    (value.metadata === undefined || isRecord(value.metadata))
  );
}

function readManifest(value: readonly unknown[]): DurableRunnerManifest {
  const envelope = value[0];
  if (isRecord(envelope) && envelope.version === 1) {
    const resultAssets = Array.isArray(envelope.resultAssets)
      ? envelope.resultAssets.filter(isSubmittedAsset)
      : undefined;
    const materializedAssets = Array.isArray(envelope.materializedAssets)
      ? envelope.materializedAssets.filter(isMaterializedAsset)
      : undefined;
    return {
      version: 1,
      ...(resultAssets === undefined ? {} : { resultAssets }),
      ...(materializedAssets === undefined ? {} : { materializedAssets }),
    };
  }

  const resultAssets = value.filter(isSubmittedAsset);
  const materializedAssets = value.filter(isMaterializedAsset);
  return {
    version: 1,
    ...(resultAssets.length === 0 ? {} : { resultAssets }),
    ...(materializedAssets.length === 0 ? {} : { materializedAssets }),
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
  const manifest = readManifest(record.resultManifest);
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
    pollAfterAt: record.pollAfterAt,
    cancelRequestedAt: record.cancelRequestedAt,
    resultAssets: manifest.resultAssets ?? [],
    materializedAssets: manifest.materializedAssets ?? [],
    error: errorFor(record),
    stageRetryCounts: record.stageRetryCounts,
  };
}

function manifestFor(input: JobTransitionInput): readonly unknown[] | undefined {
  if (input.resultAssets === undefined && input.materializedAssets === undefined) return undefined;
  const manifest: DurableRunnerManifest = {
    version: 1,
    ...(input.resultAssets === undefined ? {} : { resultAssets: input.resultAssets }),
    ...(input.materializedAssets === undefined
      ? {}
      : { materializedAssets: input.materializedAssets }),
  };
  return [manifest];
}

function fieldsFor(input: JobTransitionInput): UpdateJobStatusFields {
  const fields: {
    progress?: number | null;
    remoteJobId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    pollAfterAt?: Date | null;
    completedAt?: Date | null;
    resultManifest?: readonly unknown[];
    stageRetryCounts?: StageRetryCounts;
  } = {};
  if ('progress' in input) fields.progress = input.progress ?? null;
  if ('remoteJobId' in input) fields.remoteJobId = input.remoteJobId ?? null;
  if ('pollAfterAt' in input) fields.pollAfterAt = input.pollAfterAt ?? null;
  if ('error' in input) {
    fields.errorCode = input.error?.code ?? null;
    fields.errorMessage = input.error?.message ?? null;
  }
  const manifest = manifestFor(input);
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
    return (await this.jobs.listRecoverable()).map(toRunnerJob);
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
    const record = await this.jobs.compareAndSetStatus(
      jobId,
      input.expectedRevision,
      input.expectedStatuses,
      input.status,
      input.stage,
      fieldsFor(input),
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
        const record =
          asset.source === 'base64'
            ? await this.media.materializeProviderBase64({ ...common, base64: asset.base64 })
            : await this.media.materializeProviderUrl({ ...common, url: asset.url });
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
  ): Promise<readonly MaterializedAsset[]> {
    try {
      if (await this.media.validateProviderOutputs(job.id, assets.map(toProviderOutputRecord))) {
        return assets;
      }
      await this.media.cleanupProviderOutputs(job.id, this.outputCount(job, assets));
      if (job.resultAssets.length === 0) {
        throw new Error(`Job ${job.id} has no durable Provider results to rematerialize.`);
      }
      return await this.materialize(job, job.resultAssets, signal);
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
