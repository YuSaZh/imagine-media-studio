import type {
  ProviderAdapter,
  ProviderContext,
  ProviderError,
  ProviderErrorKind,
  ProviderInput,
} from '@imagine/provider-contract';
import type { JobStatus } from '@imagine/shared';
import PQueue from 'p-queue';

import {
  createLegacyRunnerOptions,
  type LegacyAssetRepository,
  type LegacyJobRepository,
  type LegacyStoragePaths,
} from './legacy-adapters.js';
import { InvalidBase64MediaError, InvalidMaskMediaError } from '../media/asset-media-service.js';
import { InvalidImageError } from '../media/image-processor.js';
import { UnsupportedMediaTypeError } from '../media/mime.js';
import { UnsafeRemoteUrlError } from '../security/network-policy.js';
import { AtomicFileTooLargeError } from '../storage/atomic-file.js';
import { UnsafeStoragePathError } from '../storage/path-safety.js';
import type {
  JobRunnerOptions,
  JobTransitionCommit,
  MaterializedAsset,
  ProviderRegistration,
  RunnerClock,
  RunnerJob,
} from './ports.js';
import { ProviderInputLoaderError } from '../providers/provider-input-loader.js';
import {
  clearStageRetryCount,
  EMPTY_STAGE_RETRY_COUNTS,
  nextStageRetryCounts,
  type StageRetryCounts,
} from './retry-budget.js';

type WorkKind = 'submit' | 'poll' | 'download' | 'process';
type RetriableWorkKind = Exclude<WorkKind, 'submit'>;

const TERMINAL_STATUSES = new Set<JobStatus>([
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

const systemClock: RunnerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function runnerError(
  code: string,
  message: string,
  kind: ProviderErrorKind = 'unknown',
): ProviderError {
  return { code, kind, message, retryable: false };
}

function deterministicOutputError(error: unknown): ProviderError | null {
  if (
    error instanceof UnsafeRemoteUrlError ||
    error instanceof UnsafeStoragePathError ||
    error instanceof UnsupportedMediaTypeError ||
    error instanceof AtomicFileTooLargeError ||
    error instanceof InvalidBase64MediaError ||
    error instanceof InvalidImageError ||
    error instanceof InvalidMaskMediaError
  ) {
    return runnerError(
      'provider_output_rejected',
      error.message.slice(0, 500),
      'rejected',
    );
  }
  return null;
}

function inputLoaderError(error: ProviderInputLoaderError): ProviderError {
  const kind: ProviderErrorKind = error.code === 'provider_input_too_large' ||
    error.code === 'provider_input_invalid' ||
    error.code === 'provider_input_missing' ||
    error.code === 'provider_input_changed'
    ? 'rejected'
    : 'unknown';
  return {
    code: error.code,
    kind,
    message: error.message,
    retryable: false,
  };
}

function isOptions(value: JobRunnerOptions | LegacyJobRepository): value is JobRunnerOptions {
  return 'jobs' in value && 'providers' in value && 'media' in value;
}

export class JobRunner {
  private readonly options: JobRunnerOptions;
  private readonly clock: RunnerClock;
  private readonly maxAttempts: number;
  private readonly defaultPollAfterMs: number;
  private readonly defaultRetryAfterMs: number;
  private readonly imageSubmitQueue: PQueue;
  private readonly videoSubmitQueue: PQueue;
  private readonly pollQueue: PQueue;
  private readonly downloadQueue: PQueue;
  private readonly processQueue: PQueue;
  private readonly workKeys = new Set<string>();
  private readonly scheduled = new Map<string, unknown>();
  private readonly rescheduleAfterActive = new Map<string, number>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly operationKinds = new Map<string, 'image' | 'video'>();
  private running = false;

  public constructor(options: JobRunnerOptions);
  public constructor(
    jobs: LegacyJobRepository,
    assets: LegacyAssetRepository,
    provider: ProviderAdapter,
    storage: LegacyStoragePaths,
    maxConcurrency?: number,
  );
  public constructor(
    optionsOrJobs: JobRunnerOptions | LegacyJobRepository,
    assets?: LegacyAssetRepository,
    provider?: ProviderAdapter,
    storage?: LegacyStoragePaths,
    maxConcurrency = 2,
  ) {
    if (isOptions(optionsOrJobs)) {
      this.options = optionsOrJobs;
    } else {
      if (!assets || !provider || !storage) {
        throw new Error('The legacy JobRunner constructor requires all repository arguments.');
      }
      this.options = createLegacyRunnerOptions(
        optionsOrJobs,
        assets,
        provider,
        storage,
        maxConcurrency,
      );
    }

    this.clock = this.options.clock ?? systemClock;
    const maxAttempts = this.options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive safe integer.');
    }
    this.maxAttempts = maxAttempts;
    this.defaultPollAfterMs = this.options.defaultPollAfterMs ?? 1_000;
    this.defaultRetryAfterMs = this.options.defaultRetryAfterMs ?? 1_000;
    const concurrency = this.options.concurrency ?? {};
    this.imageSubmitQueue = new PQueue({ concurrency: concurrency.imageSubmit ?? 2 });
    this.videoSubmitQueue = new PQueue({ concurrency: concurrency.videoSubmit ?? 2 });
    this.pollQueue = new PQueue({ concurrency: concurrency.poll ?? 4 });
    this.downloadQueue = new PQueue({ concurrency: concurrency.download ?? 3 });
    this.processQueue = new PQueue({ concurrency: concurrency.process ?? 2 });
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.resumePendingJobs();
  }

  public async stop(): Promise<void> {
    this.running = false;
    for (const handle of this.scheduled.values()) {
      this.clock.clearTimeout(handle);
    }
    this.scheduled.clear();
    this.rescheduleAfterActive.clear();
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    for (const queue of this.queues()) {
      queue.clear();
    }
    this.notifyIfIdle();
    await Promise.all(this.queues().map((queue) => queue.onIdle()));
    this.workKeys.clear();
    this.notifyIfIdle();
  }

  public async enqueue(jobId: string): Promise<void> {
    if (!this.running) {
      return;
    }
    const job = await this.options.jobs.get(jobId);
    if (!job || job.status !== 'queued') {
      return;
    }
    this.rememberOperation(job);
    this.schedule('submit', job.id, job.pollAfterAt?.getTime() ?? this.clock.now());
  }

  public async resumePendingJobs(): Promise<void> {
    const jobs = await this.options.jobs.listRecoverable();
    for (const job of jobs) {
      if (job.cancelRequestedAt !== null && !TERMINAL_STATUSES.has(job.status)) {
        await this.recoverCancellation(job);
        continue;
      }
      this.rememberOperation(job);
      await this.recover(job);
    }
  }

  private async recoverCancellation(job: RunnerJob): Promise<void> {
    const committed = await this.options.jobs.recoverCancellation(job.id, job.revision);
    if (!committed) return;

    if (committed.job.remoteJobId) {
      await this.cancelRemote(committed.job).catch(() => undefined);
    }
    if (committed.job.status === 'downloading' || committed.job.status === 'processing') {
      await this.discardProvisional(committed.job, committed.job.materializedAssets);
    }
  }

  public async cancel(jobId: string): Promise<void> {
    this.clearScheduledForJob(jobId);
    this.abortControllers.get(jobId)?.abort();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.options.jobs.get(jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) {
        return;
      }
      const committed = await this.commitTransition(job, {
        expectedStatuses: [job.status],
        expectedRevision: job.revision,
        status: 'cancelled',
        stage: 'cancelled',
        pollAfterAt: null,
        error: null,
        stageRetryCounts: EMPTY_STAGE_RETRY_COUNTS,
      });
      if (!committed) {
        continue;
      }

      if (job.remoteJobId) {
        await this.cancelRemote(job).catch(() => undefined);
      }
      if (job.status === 'downloading' || job.status === 'processing') {
        await this.discardProvisional(job, job.materializedAssets);
      }
      return;
    }
  }

  public async waitForIdle(): Promise<void> {
    while (!this.isIdle()) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
        this.notifyIfIdle();
      });
    }
  }

  private async recover(job: RunnerJob): Promise<void> {
    switch (job.status) {
      case 'queued':
        this.schedule('submit', job.id, job.pollAfterAt?.getTime() ?? this.clock.now());
        return;
      case 'submitting':
        await this.recoverSubmitting(job);
        return;
      case 'remote_pending':
      case 'remote_running':
        this.schedule('poll', job.id, job.pollAfterAt?.getTime() ?? this.clock.now());
        return;
      case 'downloading':
        this.schedule('download', job.id, this.clock.now());
        return;
      case 'processing':
        this.schedule('process', job.id, this.clock.now());
        return;
      case 'completed': {
        const consistent = await this.options.assets.outputsConsistent(job.id);
        if (consistent) return;
        if (job.materializedAssets.length > 0) {
          const committed = await this.commitTransition(job, {
            expectedStatuses: ['completed'],
            expectedRevision: job.revision,
            status: 'processing',
            stage: 'repairing_outputs',
          });
          if (committed) {
            this.schedule('process', job.id, this.clock.now());
          }
        } else {
          await this.commitTransition(job, {
            expectedStatuses: ['completed'],
            expectedRevision: job.revision,
            status: 'failed',
            stage: 'output_consistency_error',
            progress: null,
            error: runnerError(
              'output_consistency_error',
              'The completed Job has no recoverable output manifest.',
            ),
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async recoverSubmitting(job: RunnerJob): Promise<void> {
    if (job.remoteJobId) {
      const committed = await this.commitTransition(job, {
        expectedStatuses: ['submitting'],
        expectedRevision: job.revision,
        status: 'remote_pending',
        stage: 'recovered_remote_submission',
        pollAfterAt: new Date(this.clock.now()),
      });
      if (committed) {
        this.schedule('poll', job.id, this.clock.now());
      }
      return;
    }

    try {
      const registration = await this.options.providers.resolve(job.request.providerId);
      if (registration.submitReplaySafe) {
        const committed = await this.commitTransition(job, {
          expectedStatuses: ['submitting'],
          expectedRevision: job.revision,
          status: 'queued',
          stage: 'recovered_submit_replay',
          pollAfterAt: new Date(this.clock.now()),
        });
        if (committed) {
          this.schedule('submit', job.id, this.clock.now());
        }
        return;
      }
    } catch {
      // The durable failure below is more actionable than a startup exception.
    }

    await this.fail(
      job,
      runnerError(
        'submission_outcome_unknown',
        'The process stopped during submit and this provider cannot replay it safely.',
      ),
    );
  }

  private schedule(kind: WorkKind, jobId: string, dueAt: number): void {
    if (!this.running) {
      return;
    }
    const key = this.workKey(kind, jobId);
    if (this.workKeys.has(key)) {
      this.rescheduleAfterActive.set(key, dueAt);
      return;
    }
    const existing = this.scheduled.get(key);
    if (existing) {
      this.clock.clearTimeout(existing);
      this.scheduled.delete(key);
    }

    const delay = Math.max(0, dueAt - this.clock.now());
    if (delay === 0) {
      this.enqueueWork(kind, jobId);
      return;
    }

    const handle = this.clock.setTimeout(() => {
      this.scheduled.delete(key);
      this.enqueueWork(kind, jobId);
      this.notifyIfIdle();
    }, delay);
    this.scheduled.set(key, handle);
  }

  private enqueueWork(kind: WorkKind, jobId: string): void {
    if (!this.running) {
      return;
    }
    const key = this.workKey(kind, jobId);
    if (this.workKeys.has(key)) {
      return;
    }
    this.workKeys.add(key);
    const queue = this.queueFor(kind, jobId);
    void queue
      .add(async () => {
        try {
          await this.run(kind, jobId);
        } catch (error) {
          await this.handleUnexpected(jobId, error);
        } finally {
          this.workKeys.delete(key);
          const nextDueAt = this.rescheduleAfterActive.get(key);
          if (nextDueAt !== undefined) {
            this.rescheduleAfterActive.delete(key);
            this.schedule(kind, jobId, nextDueAt);
          }
          this.notifyIfIdle();
        }
      })
      .catch(() => undefined)
      .finally(() => this.notifyIfIdle());
  }

  private async run(kind: WorkKind, jobId: string): Promise<void> {
    switch (kind) {
      case 'submit':
        await this.submit(jobId);
        return;
      case 'poll':
        await this.poll(jobId);
        return;
      case 'download':
        await this.download(jobId);
        return;
      case 'process':
        await this.process(jobId);
    }
  }

  private async submit(jobId: string): Promise<void> {
    const queued = await this.options.jobs.get(jobId);
    if (!queued || queued.status !== 'queued') {
      return;
    }
    const claimed = await this.options.jobs.claimQueued(jobId, queued.revision);
    if (!claimed) {
      return;
    }
    const controller = this.beginOperation(jobId);
    let registration: ProviderRegistration | undefined;
    try {
      await this.publish(claimed);
      if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
        return;
      }

      try {
        registration = await this.options.providers.resolve(claimed.job.request.providerId);
      } catch (error) {
        if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
          return;
        }
        await this.fail(
          claimed.job,
          runnerError(
            'provider_unavailable',
            error instanceof Error ? error.message : 'Provider unavailable',
          ),
        );
        return;
      }
      if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
        return;
      }

      const inputs = this.options.inputLoader
        ? await this.options.inputLoader.load(claimed.job.request, controller.signal)
        : undefined;
      if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
        return;
      }
      const context = this.contextFor(claimed.job, registration, controller.signal, inputs);
      await registration.adapter.validate(claimed.job.request, context);
      if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
        return;
      }
      const result = await registration.adapter.submit(claimed.job.request, context);
      if (!await this.isOperationActive(jobId, ['submitting'], controller)) {
        return;
      }
      if (result.state === 'pending') {
        const dueAt = this.clock.now() + (result.pollAfterMs ?? this.defaultPollAfterMs);
        const committed = await this.commitTransition(claimed.job, {
          expectedStatuses: ['submitting'],
          expectedRevision: claimed.job.revision,
          status: 'remote_pending',
          stage: 'remote_pending',
          remoteJobId: result.remoteJobId,
          pollAfterAt: new Date(dueAt),
          error: null,
        });
        if (committed) {
          this.schedule('poll', jobId, dueAt);
        }
        return;
      }

      const committed = await this.commitTransition(claimed.job, {
        expectedStatuses: ['submitting'],
        expectedRevision: claimed.job.revision,
        status: 'downloading',
        stage: 'materializing_results',
        resultAssets: result.assets,
        pollAfterAt: null,
        error: null,
      });
      if (committed) {
        this.schedule('download', jobId, this.clock.now());
      }
    } catch (error) {
      if (registration && await this.isOperationActive(jobId, ['submitting'], controller)) {
        const normalized = error instanceof ProviderInputLoaderError
          ? inputLoaderError(error)
          : registration.adapter.normalizeError(error);
        await this.handleSubmitError(claimed.job, registration, normalized);
      }
    } finally {
      this.endOperation(jobId, controller);
    }
  }

  private async poll(jobId: string): Promise<void> {
    const job = await this.options.jobs.get(jobId);
    if (!job || !['remote_pending', 'remote_running'].includes(job.status)) {
      return;
    }
    if (!job.remoteJobId) {
      await this.fail(job, runnerError('remote_job_id_missing', 'Remote polling requires a job id.'));
      return;
    }

    const controller = this.beginOperation(jobId);
    let registration: ProviderRegistration | undefined;
    try {
      registration = await this.options.providers.resolve(job.request.providerId);
      if (!await this.isOperationActive(jobId, ['remote_pending', 'remote_running'], controller)) {
        return;
      }
      if (!registration.adapter.poll) {
        await this.fail(
          job,
          runnerError(
            'provider_poll_unsupported',
            'The provider returned pending without poll support.',
            'rejected',
          ),
        );
        return;
      }

      const result = await registration.adapter.poll(
        job.remoteJobId,
        this.contextFor(job, registration, controller.signal),
      );
      if (!await this.isOperationActive(jobId, ['remote_pending', 'remote_running'], controller)) {
        return;
      }
      if (result.state === 'completed') {
        const committed = await this.commitTransition(job, {
          expectedStatuses: ['remote_pending', 'remote_running'],
          expectedRevision: job.revision,
          status: 'downloading',
          stage: 'materializing_results',
          resultAssets: result.assets,
          pollAfterAt: null,
          error: null,
          stageRetryCounts: clearStageRetryCount(job.stageRetryCounts, 'poll'),
        });
        if (committed) {
          this.schedule('download', jobId, this.clock.now());
        }
        return;
      }
      if (result.state === 'failed') {
        await this.handlePollError(job, result.error);
        return;
      }

      const dueAt = this.clock.now() + (result.pollAfterMs ?? this.defaultPollAfterMs);
      const committed = await this.commitTransition(job, {
        expectedStatuses: ['remote_pending', 'remote_running'],
        expectedRevision: job.revision,
        status: result.state,
        stage: result.state,
        ...(result.progress === undefined ? {} : { progress: result.progress }),
        pollAfterAt: new Date(dueAt),
        error: null,
        stageRetryCounts: clearStageRetryCount(job.stageRetryCounts, 'poll'),
      });
      if (committed) {
        this.schedule('poll', jobId, dueAt);
      }
    } catch (error) {
      if (!this.running || controller.signal.aborted) {
        return;
      }
      if (!registration) {
        throw error;
      }
      if (await this.isOperationActive(jobId, ['remote_pending', 'remote_running'], controller)) {
        await this.handlePollError(job, registration.adapter.normalizeError(error));
      }
    } finally {
      this.endOperation(jobId, controller);
    }
  }

  private async download(jobId: string): Promise<void> {
    const job = await this.options.jobs.get(jobId);
    if (!job || job.status !== 'downloading') {
      return;
    }
    const controller = this.beginOperation(jobId);
    let registration: ProviderRegistration | undefined;
    let materialized: readonly MaterializedAsset[] | undefined;
    try {
      registration = await this.options.providers.resolve(job.request.providerId);
      if (!await this.isOperationActive(jobId, ['downloading'], controller)) {
        return;
      }
      materialized = await this.options.media.materialize(
        job,
        job.resultAssets,
        controller.signal,
      );
      if (!await this.isOperationActive(jobId, ['downloading'], controller)) {
        if (materialized !== undefined) {
          await this.settleProvisionalAfterCasLoss(job, materialized);
        }
        return;
      }
      const committed = await this.commitTransition(job, {
        expectedStatuses: ['downloading'],
        expectedRevision: job.revision,
        status: 'processing',
        stage: 'processing',
        resultAssets: [],
        materializedAssets: materialized,
        pollAfterAt: null,
        error: null,
        stageRetryCounts: clearStageRetryCount(job.stageRetryCounts, 'download'),
      });
      if (committed) {
        this.schedule('process', jobId, this.clock.now());
      } else {
        await this.settleProvisionalAfterCasLoss(job, materialized);
      }
    } catch (error) {
      if (!this.running || controller.signal.aborted) {
        return;
      }
      if (!registration) {
        throw error;
      }
      if (materialized !== undefined) {
        await this.settleProvisionalAfterCasLoss(job, materialized);
      }
      if (await this.isOperationActive(jobId, ['downloading'], controller)) {
        await this.retryStage(
          job,
          'download',
          deterministicOutputError(error) ?? registration.adapter.normalizeError(error),
        );
      }
    } finally {
      this.endOperation(jobId, controller);
    }
  }

  private async process(jobId: string): Promise<void> {
    const job = await this.options.jobs.get(jobId);
    if (!job || job.status !== 'processing') {
      return;
    }
    const controller = this.beginOperation(jobId);
    let registration: ProviderRegistration | undefined;
    let processed: readonly MaterializedAsset[] | undefined;
    try {
      registration = await this.options.providers.resolve(job.request.providerId);
      if (!await this.isOperationActive(jobId, ['processing'], controller)) {
        return;
      }
      processed = await this.options.media.process(
        job,
        job.materializedAssets,
        controller.signal,
      );
      if (!await this.isOperationActive(jobId, ['processing'], controller)) {
        if (processed !== undefined) {
          await this.settleProvisionalAfterCasLoss(job, processed);
        }
        return;
      }
      const committed = await this.options.assets.finalize(jobId, job.revision, processed);
      if (committed) {
        await this.releaseProvisional(job, processed);
        await this.publish(committed);
      } else {
        await this.settleProvisionalAfterCasLoss(job, processed);
      }
    } catch (error) {
      if (!this.running || controller.signal.aborted) {
        return;
      }
      if (!registration) {
        throw error;
      }
      if (processed !== undefined) {
        await this.settleProvisionalAfterCasLoss(job, processed);
      }
      if (await this.isOperationActive(jobId, ['processing'], controller)) {
        await this.retryStage(
          job,
          'process',
          deterministicOutputError(error) ?? registration.adapter.normalizeError(error),
        );
      }
    } finally {
      this.endOperation(jobId, controller);
    }
  }

  private async handleSubmitError(
    job: RunnerJob,
    registration: ProviderRegistration,
    normalized: ProviderError,
  ): Promise<void> {
    if (normalized.retryable && registration.submitReplaySafe && job.attempt < this.maxAttempts) {
      const dueAt = this.clock.now() + (normalized.retryAfterMs ?? this.defaultRetryAfterMs);
      const committed = await this.commitTransition(job, {
        expectedStatuses: ['submitting'],
        expectedRevision: job.revision,
        status: 'queued',
        stage: 'submit_retry_scheduled',
        pollAfterAt: new Date(dueAt),
        error: normalized,
      });
      if (committed) {
        this.schedule('submit', job.id, dueAt);
      }
      return;
    }
    await this.fail(job, normalized);
  }

  private async handlePollError(job: RunnerJob, error: ProviderError): Promise<void> {
    const counts = this.consumeStageRetry(job, 'poll');
    if (error.retryable && counts !== null) {
      const dueAt = this.clock.now() + (error.retryAfterMs ?? this.defaultRetryAfterMs);
      const committed = await this.commitTransition(job, {
        expectedStatuses: ['remote_pending', 'remote_running'],
        expectedRevision: job.revision,
        status: 'remote_pending',
        stage: 'poll_retry_scheduled',
        pollAfterAt: new Date(dueAt),
        error,
        stageRetryCounts: counts,
      });
      if (committed) {
        this.schedule('poll', job.id, dueAt);
      }
      return;
    }
    await this.fail(job, error);
  }

  private async retryStage(
    job: RunnerJob,
    kind: Exclude<RetriableWorkKind, 'poll'>,
    error: ProviderError,
  ): Promise<void> {
    const counts = this.consumeStageRetry(job, kind);
    if (!error.retryable || counts === null) {
      await this.fail(job, error);
      return;
    }
    const dueAt = this.clock.now() + (error.retryAfterMs ?? this.defaultRetryAfterMs);
    const committed = await this.commitTransition(job, {
      expectedStatuses: [job.status],
      expectedRevision: job.revision,
      status: job.status,
      stage: `${kind}_retry_scheduled`,
      pollAfterAt: new Date(dueAt),
      error,
      stageRetryCounts: counts,
    });
    if (committed) {
      this.schedule(kind, job.id, dueAt);
    }
  }

  private async fail(job: RunnerJob, error: ProviderError): Promise<void> {
    const status = this.failureStatus(error.kind);
    const committed = await this.commitTransition(job, {
      expectedStatuses: [job.status],
      expectedRevision: job.revision,
      status,
      stage: status,
      pollAfterAt: null,
      error,
      stageRetryCounts: EMPTY_STAGE_RETRY_COUNTS,
    });
    if (committed && (job.status === 'downloading' || job.status === 'processing')) {
      await this.discardProvisional(job, job.materializedAssets);
    }
  }

  private async settleProvisionalAfterCasLoss(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
  ): Promise<void> {
    const current = await this.options.jobs.get(job.id).catch(() => null);
    if (current?.status === 'processing') return;
    if (current?.status === 'completed') {
      const consistent = await this.options.assets.outputsConsistent(job.id).catch(() => false);
      if (consistent) {
        await this.releaseProvisional(job, assets);
        return;
      }
    }
    await this.discardProvisional(job, assets);
  }

  private async discardProvisional(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
  ): Promise<void> {
    await this.options.media.discard?.(job, assets).catch(() => undefined);
  }

  private async releaseProvisional(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
  ): Promise<void> {
    await this.options.media.finalized?.(job, assets).catch(() => undefined);
  }

  private failureStatus(kind: ProviderErrorKind): 'failed' | 'rejected' | 'expired' {
    if (kind === 'rejected') {
      return 'rejected';
    }
    if (kind === 'expired') {
      return 'expired';
    }
    return 'failed';
  }

  private async handleUnexpected(jobId: string, error: unknown): Promise<void> {
    if (!this.running) {
      return;
    }
    const job = await this.options.jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      return;
    }
    await this.fail(
      job,
      runnerError('runner_error', error instanceof Error ? error.message : 'Unknown runner error'),
    );
  }

  private async cancelRemote(job: RunnerJob): Promise<void> {
    const registration = await this.options.providers.resolve(job.request.providerId);
    if (!registration.adapter.cancel || !job.remoteJobId) {
      return;
    }
    await registration.adapter.cancel(job.remoteJobId, this.contextFor(job, registration));
  }

  private contextFor(
    job: RunnerJob,
    registration: ProviderRegistration,
    signal?: AbortSignal,
    inputs?: readonly ProviderInput[],
  ): ProviderContext {
    const context = {
      providerId: job.request.providerId,
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      attempt: job.attempt,
      ...(signal ? { signal } : {}),
      ...(registration.baseUrl ? { baseUrl: registration.baseUrl } : {}),
      config: registration.config ?? {},
      ...(registration.http ? { http: registration.http } : {}),
      ...(inputs === undefined ? {} : { inputs }),
      secrets: registration.secrets,
    };
    return context as ProviderContext;
  }

  private async isOperationActive(
    jobId: string,
    expectedStatuses: readonly JobStatus[],
    controller: AbortController,
  ): Promise<boolean> {
    if (!this.running || controller.signal.aborted) {
      return false;
    }
    const current = await this.options.jobs.get(jobId);
    return Boolean(
      this.running &&
      !controller.signal.aborted &&
      current &&
      expectedStatuses.includes(current.status),
    );
  }

  private consumeStageRetry(job: RunnerJob, kind: RetriableWorkKind): StageRetryCounts | null {
    const counts = job.stageRetryCounts ?? EMPTY_STAGE_RETRY_COUNTS;
    // maxAttempts includes the initial stage attempt, matching submit retries.
    if (counts[kind] >= this.maxAttempts - 1) return null;
    return nextStageRetryCounts(counts, kind);
  }

  private beginOperation(jobId: string): AbortController {
    this.abortControllers.get(jobId)?.abort();
    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);
    return controller;
  }

  private endOperation(jobId: string, controller: AbortController): void {
    if (this.abortControllers.get(jobId) === controller) {
      this.abortControllers.delete(jobId);
    }
  }

  private async commitTransition(
    job: RunnerJob,
    input: Parameters<JobRunnerOptions['jobs']['transition']>[1],
  ): Promise<JobTransitionCommit | null> {
    const committed = await this.options.jobs.transition(job.id, input);
    if (committed) {
      await this.publish(committed);
    }
    return committed;
  }

  private async publish(commit: JobTransitionCommit): Promise<void> {
    try {
      await this.options.events.publish(commit.event);
    } catch {
      // The event is durable already; a live subscriber may reconnect using its cursor.
    }
  }

  private queueFor(kind: WorkKind, jobId: string): PQueue {
    if (kind === 'submit') {
      return this.operationKinds.get(jobId) === 'video'
        ? this.videoSubmitQueue
        : this.imageSubmitQueue;
    }
    if (kind === 'poll') {
      return this.pollQueue;
    }
    if (kind === 'download') {
      return this.downloadQueue;
    }
    return this.processQueue;
  }

  private rememberOperation(job: RunnerJob): void {
    this.operationKinds.set(job.id, job.request.operation.startsWith('video.') ? 'video' : 'image');
  }

  private queues(): readonly PQueue[] {
    return [
      this.imageSubmitQueue,
      this.videoSubmitQueue,
      this.pollQueue,
      this.downloadQueue,
      this.processQueue,
    ];
  }

  private clearScheduledForJob(jobId: string): void {
    for (const kind of ['submit', 'poll', 'download', 'process'] as const) {
      const key = this.workKey(kind, jobId);
      const handle = this.scheduled.get(key);
      if (handle) {
        this.clock.clearTimeout(handle);
        this.scheduled.delete(key);
      }
      this.rescheduleAfterActive.delete(key);
    }
    this.notifyIfIdle();
  }

  private workKey(kind: WorkKind, jobId: string): string {
    return `${kind}:${jobId}`;
  }

  private isIdle(): boolean {
    return (
      this.workKeys.size === 0 &&
      this.scheduled.size === 0 &&
      this.rescheduleAfterActive.size === 0 &&
      this.queues().every((queue) => queue.size === 0 && queue.pending === 0)
    );
  }

  private notifyIfIdle(): void {
    if (!this.isIdle()) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}
