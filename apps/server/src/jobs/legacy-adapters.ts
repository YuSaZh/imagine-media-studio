import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ProviderAdapter, SubmittedAsset } from '@imagine/provider-contract';
import type { GenerationRequest, JobStatus } from '@imagine/shared';

import type {
  JobRunnerOptions,
  JobTransitionCommit,
  JobTransitionInput,
  MaterializedAsset,
  RunnerAssetPort,
  RunnerEvent,
  RunnerJob,
  RunnerJobPort,
} from './ports.js';

interface LegacyJobRecord {
  id: string;
  request: GenerationRequest;
  status: JobStatus;
  stage: string;
  progress: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  revision?: number;
  idempotencyKey?: string;
  retryCount?: number;
  submitAttempt?: number;
  remoteJobId?: string | null;
  pollAfterAt?: Date | null;
}

export interface LegacyJobRepository {
  get(jobId: string): LegacyJobRecord | null;
  listQueued(): LegacyJobRecord[];
  requeueRecoverableMockJobs(): number;
  claimQueued(jobId: string, expectedRevision?: number): LegacyJobRecord | null;
  updateStatus(
    jobId: string,
    status: JobStatus,
    stage: string,
    fields?: {
      progress?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      completedAt?: Date | null;
    },
  ): void;
  compareAndSetStatus?(
    jobId: string,
    expectedRevision: number,
    expectedStatuses: readonly JobStatus[],
    status: JobStatus,
    stage: string,
    fields?: {
      progress?: number | null;
      remoteJobId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      pollAfterAt?: Date | null;
      completedAt?: Date | null;
      resultManifest?: readonly unknown[];
    },
  ): LegacyJobRecord | null;
}

export interface LegacyAssetRepository {
  createIfMissing(input: {
    jobId: string;
    type: 'image' | 'video';
    role: string;
    filePath: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
  }): string;
  countForJob(jobId: string): number;
}

export interface LegacyStoragePaths {
  root: string;
  originals: string;
  temporary: string;
}

class LegacyJobPort implements RunnerJobPort {
  private readonly revisions = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private readonly remoteJobIds = new Map<string, string | null>();
  private readonly pollAfterDates = new Map<string, Date | null>();
  private readonly resultAssets = new Map<string, readonly SubmittedAsset[]>();
  private readonly materializedAssets = new Map<string, readonly MaterializedAsset[]>();

  public constructor(private readonly repository: LegacyJobRepository) {}

  public async get(jobId: string): Promise<RunnerJob | null> {
    const record = this.repository.get(jobId);
    return record ? this.toRunnerJob(record) : null;
  }

  public async listRecoverable(): Promise<readonly RunnerJob[]> {
    this.repository.requeueRecoverableMockJobs();
    return this.repository.listQueued().map((record) => this.toRunnerJob(record));
  }

  public async claimQueued(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null> {
    const current = this.repository.get(jobId);
    if (
      !current ||
      current.status !== 'queued' ||
      this.revisionFor(jobId, current) !== expectedRevision
    ) {
      return null;
    }

    const claimed = this.repository.claimQueued(jobId, expectedRevision);
    if (!claimed) {
      return null;
    }

    this.revisions.set(jobId, claimed.revision ?? expectedRevision + 1);
    this.attempts.set(
      jobId,
      claimed.submitAttempt ?? (this.attempts.get(jobId) ?? 0) + 1,
    );
    const job = this.toRunnerJob(claimed);
    return this.commit(job, 'job.submitting');
  }

  public async transition(
    jobId: string,
    input: JobTransitionInput,
  ): Promise<JobTransitionCommit | null> {
    const current = this.repository.get(jobId);
    if (
      !current ||
      !input.expectedStatuses.includes(current.status) ||
      this.revisionFor(jobId, current) !== input.expectedRevision
    ) {
      return null;
    }

    const fields: {
      progress?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      completedAt?: Date | null;
    } = {};
    if ('progress' in input) {
      fields.progress = input.progress;
    }
    if ('error' in input) {
      fields.errorCode = input.error?.code ?? null;
      fields.errorMessage = input.error?.message ?? null;
    }
    if (input.status === 'completed') {
      fields.completedAt = new Date();
    }
    const casFields = {
      ...fields,
      ...('remoteJobId' in input ? { remoteJobId: input.remoteJobId ?? null } : {}),
      ...('pollAfterAt' in input ? { pollAfterAt: input.pollAfterAt ?? null } : {}),
      ...(input.resultAssets ? { resultManifest: input.resultAssets } : {}),
    };
    const casResult = this.repository.compareAndSetStatus?.(
      jobId,
      input.expectedRevision,
      input.expectedStatuses,
      input.status,
      input.stage,
      casFields,
    );
    if (this.repository.compareAndSetStatus && !casResult) {
      return null;
    }
    if (!this.repository.compareAndSetStatus) {
      this.repository.updateStatus(jobId, input.status, input.stage, fields);
    }

    if ('remoteJobId' in input) {
      this.remoteJobIds.set(jobId, input.remoteJobId ?? null);
    }
    if ('pollAfterAt' in input) {
      this.pollAfterDates.set(jobId, input.pollAfterAt ?? null);
    }
    if (input.resultAssets) {
      this.resultAssets.set(jobId, input.resultAssets);
    }
    if (input.materializedAssets) {
      this.materializedAssets.set(jobId, input.materializedAssets);
    }
    if (input.incrementAttempt) {
      this.attempts.set(jobId, (this.attempts.get(jobId) ?? 0) + 1);
    }
    this.revisions.set(jobId, casResult?.revision ?? input.expectedRevision + 1);

    const updated = casResult ?? this.repository.get(jobId);
    if (!updated) {
      return null;
    }
    return this.commit(this.toRunnerJob(updated), `job.${input.status}`);
  }

  private revisionFor(jobId: string, record?: LegacyJobRecord): number {
    return record?.revision ?? this.revisions.get(jobId) ?? 0;
  }

  private toRunnerJob(record: LegacyJobRecord): RunnerJob {
    const error =
      record.errorCode && record.errorMessage
        ? {
            code: record.errorCode,
            kind: 'unknown' as const,
            message: record.errorMessage,
            retryable: false,
          }
        : null;
    return {
      id: record.id,
      request: record.request,
      status: record.status,
      stage: record.stage,
      progress: record.progress,
      revision: this.revisionFor(record.id, record),
      idempotencyKey: record.idempotencyKey ?? record.id,
      attempt: record.submitAttempt ?? this.attempts.get(record.id) ?? 0,
      remoteJobId: record.remoteJobId ?? this.remoteJobIds.get(record.id) ?? null,
      pollAfterAt: record.pollAfterAt ?? this.pollAfterDates.get(record.id) ?? null,
      resultAssets: this.resultAssets.get(record.id) ?? [],
      materializedAssets: this.materializedAssets.get(record.id) ?? [],
      error,
    };
  }

  private commit(job: RunnerJob, eventType: string): JobTransitionCommit {
    const event: RunnerEvent = {
      id: randomUUID(),
      aggregateType: 'job',
      aggregateId: job.id,
      eventType,
      revision: job.revision,
      payload: { status: job.status, stage: job.stage },
    };
    return { job, event };
  }
}

class LegacyAssetPort implements RunnerAssetPort {
  public constructor(
    private readonly repository: LegacyAssetRepository,
    private readonly jobs: LegacyJobPort,
  ) {}

  public async outputsConsistent(jobId: string): Promise<boolean> {
    return this.repository.countForJob(jobId) > 0;
  }

  public async finalize(
    jobId: string,
    expectedRevision: number,
    assets: readonly MaterializedAsset[],
  ): Promise<JobTransitionCommit | null> {
    const job = await this.jobs.get(jobId);
    if (
      !job ||
      job.status !== 'processing' ||
      job.revision !== expectedRevision
    ) {
      return null;
    }

    for (const asset of assets) {
      this.repository.createIfMissing({
        jobId,
        type: asset.type,
        role: 'output',
        filePath: asset.filePath,
        mimeType: asset.mimeType,
        fileSize: asset.fileSize,
        sha256: asset.sha256,
      });
    }

    return this.jobs.transition(jobId, {
      expectedStatuses: ['processing'],
      expectedRevision,
      status: 'completed',
      stage: 'completed',
      progress: 100,
      pollAfterAt: null,
      error: null,
    });
  }
}

function extensionFor(asset: SubmittedAsset): string {
  if (asset.filename?.includes('.')) {
    return asset.filename.slice(asset.filename.lastIndexOf('.') + 1).toLowerCase();
  }
  return asset.mimeType === 'image/png' ? 'png' : 'bin';
}

async function materializeLegacyAsset(
  storage: LegacyStoragePaths,
  jobId: string,
  index: number,
  asset: SubmittedAsset,
): Promise<MaterializedAsset> {
  if (asset.source !== 'base64') {
    throw new Error('The legacy PR 0 materializer does not download remote URL results.');
  }

  const filename = `${jobId}-${index}.${extensionFor(asset)}`;
  const absolutePath = join(storage.originals, filename);
  const relativePath = relative(storage.root, absolutePath);
  const bytes = Buffer.from(asset.base64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  let existingBytes: Buffer | null = null;
  try {
    existingBytes = await readFile(absolutePath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  if (existingBytes) {
    const existingHash = createHash('sha256').update(existingBytes).digest('hex');
    if (existingHash !== sha256) {
      throw new Error(`Existing Mock asset ${relativePath} failed its checksum.`);
    }
  } else {
    const temporaryPath = join(storage.temporary, `${jobId}-${index}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx' });
      await rename(temporaryPath, absolutePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  return {
    type: asset.type,
    mimeType: asset.mimeType,
    filePath: relativePath,
    fileSize: bytes.byteLength,
    sha256,
    ...(asset.resultId ? { resultId: asset.resultId } : {}),
    ...(asset.filename ? { filename: asset.filename } : {}),
    ...(asset.metadata ? { metadata: asset.metadata } : {}),
  };
}

export function createLegacyRunnerOptions(
  jobsRepository: LegacyJobRepository,
  assetsRepository: LegacyAssetRepository,
  provider: ProviderAdapter,
  storage: LegacyStoragePaths,
  maxConcurrency = 2,
): JobRunnerOptions {
  const jobs = new LegacyJobPort(jobsRepository);
  return {
    jobs,
    assets: new LegacyAssetPort(assetsRepository, jobs),
    events: { publish: () => undefined },
    providers: {
      resolve: () => ({ adapter: provider, secrets: {}, submitReplaySafe: true }),
    },
    media: {
      materialize: async (job, assets) =>
        Promise.all(
          assets.map((asset, index) => materializeLegacyAsset(storage, job.id, index, asset)),
        ),
      process: async (_job, assets) => assets,
    },
    concurrency: {
      imageSubmit: maxConcurrency,
      videoSubmit: maxConcurrency,
    },
  };
}
