import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  PollResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  SubmittedAsset,
  SubmitResult,
} from '@imagine/provider-contract';
import type { GenerationRequest } from '@imagine/shared';
import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../database/client.js';
import { AssetRepository, JobRepository } from '../database/jobs.js';
import { MockProviderAdapter } from '../providers/mock-provider.js';
import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { JobRunner } from './job-runner.js';
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

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitForPhase(promise: Promise<void>, phase: string): Promise<void> {
  await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`Timed out during ${phase}.`)), 2_000);
    }),
  ]);
}

class ControlledMockProvider extends MockProviderAdapter {
  public activeCount = 0;
  public maxActiveCount = 0;
  public enteredCount = 0;
  public readonly twoActive = createDeferred();
  public readonly thirdEntered = createDeferred();
  private readonly releases: Array<() => void> = [];

  public override async submit(
    request: GenerationRequest,
    context: ProviderContext,
  ): Promise<SubmitResult> {
    this.activeCount += 1;
    this.enteredCount += 1;
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount);
    if (this.activeCount === 2) {
      this.twoActive.resolve();
    }
    if (this.enteredCount === 3) {
      this.thirdEntered.resolve();
    }

    await new Promise<void>((resolve) => this.releases.push(resolve));
    this.activeCount -= 1;
    return super.submit(request, context);
  }

  public releaseActive(): void {
    for (const release of this.releases.splice(0)) {
      release();
    }
  }
}

const temporaryDirectories: string[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('JobRunner scheduling', () => {
  it('never exceeds the configured concurrency while draining queued jobs', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-runner-test-'));
    temporaryDirectories.push(dataDir);
    const storage = getStoragePaths(dataDir);
    await ensureStorage(storage);
    const database = createDatabase(storage.database, migrationsDirectory);
    const jobs = new JobRepository(database.orm);
    const assets = new AssetRepository(database.orm);
    const provider = new ControlledMockProvider();
    const runner = new JobRunner(jobs, assets, provider, storage, 2);
    await runner.start();

    const records = [0, 1, 2].map((index) =>
      jobs.create(createMockGenerationRequest({ prompt: `Concurrency fixture ${index}` })),
    );
    for (const record of records) {
      await runner.enqueue(record.id);
    }

    await waitForPhase(provider.twoActive.promise, 'first submit wave');
    expect(provider.activeCount).toBe(2);
    expect(provider.maxActiveCount).toBe(2);
    provider.releaseActive();

    await waitForPhase(provider.thirdEntered.promise, 'second submit wave');
    expect(provider.maxActiveCount).toBe(2);
    provider.releaseActive();

    await waitForPhase(runner.waitForIdle(), 'runner idle');
    expect(records.map((record) => jobs.get(record.id)?.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(records.map((record) => assets.countForJob(record.id))).toEqual([1, 1, 1]);

    await runner.stop();
    database.sqlite.close();
  });
});

function createRunnerJob(
  id: string,
  overrides: Partial<RunnerJob> = {},
): RunnerJob {
  const request = overrides.request ?? createMockGenerationRequest();
  return {
    id,
    request,
    status: overrides.status ?? 'queued',
    stage: overrides.stage ?? overrides.status ?? 'queued',
    progress: overrides.progress ?? null,
    revision: overrides.revision ?? 0,
    idempotencyKey: overrides.idempotencyKey ?? `key-${id}`,
    attempt: overrides.attempt ?? 0,
    remoteJobId: overrides.remoteJobId ?? null,
    pollAfterAt: overrides.pollAfterAt ?? null,
    resultAssets: overrides.resultAssets ?? [],
    materializedAssets: overrides.materializedAssets ?? [],
    error: overrides.error ?? null,
  };
}

class MemoryJobPort implements RunnerJobPort {
  public readonly records = new Map<string, RunnerJob>();
  private eventId = 0;

  public constructor(jobs: readonly RunnerJob[]) {
    for (const job of jobs) {
      this.records.set(job.id, job);
    }
  }

  public async get(jobId: string): Promise<RunnerJob | null> {
    return this.records.get(jobId) ?? null;
  }

  public async listRecoverable(): Promise<readonly RunnerJob[]> {
    return [...this.records.values()];
  }

  public async claimQueued(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null> {
    return this.transition(jobId, {
      expectedStatuses: ['queued'],
      expectedRevision,
      status: 'submitting',
      stage: 'submitting',
      incrementAttempt: true,
      pollAfterAt: null,
      error: null,
    });
  }

  public async transition(
    jobId: string,
    input: JobTransitionInput,
  ): Promise<JobTransitionCommit | null> {
    const current = this.records.get(jobId);
    if (
      !current ||
      current.revision !== input.expectedRevision ||
      !input.expectedStatuses.includes(current.status)
    ) {
      return null;
    }

    const next: RunnerJob = {
      ...current,
      status: input.status,
      stage: input.stage,
      revision: current.revision + 1,
      attempt: current.attempt + (input.incrementAttempt ? 1 : 0),
      progress: 'progress' in input ? (input.progress ?? null) : current.progress,
      remoteJobId:
        'remoteJobId' in input ? (input.remoteJobId ?? null) : current.remoteJobId,
      pollAfterAt:
        'pollAfterAt' in input ? (input.pollAfterAt ?? null) : current.pollAfterAt,
      resultAssets:
        'resultAssets' in input ? (input.resultAssets ?? []) : current.resultAssets,
      materializedAssets:
        'materializedAssets' in input
          ? (input.materializedAssets ?? [])
          : current.materializedAssets,
      error: 'error' in input ? (input.error ?? null) : current.error,
    };
    this.records.set(jobId, next);
    this.eventId += 1;
    return {
      job: next,
      event: {
        id: this.eventId,
        aggregateType: 'job',
        aggregateId: jobId,
        eventType: `job.${next.status}`,
        revision: next.revision,
        payload: { status: next.status, stage: next.stage },
      },
    };
  }
}

class MemoryAssetPort implements RunnerAssetPort {
  public readonly outputs = new Map<string, readonly MaterializedAsset[]>();

  public constructor(private readonly jobs: MemoryJobPort) {}

  public async outputsConsistent(jobId: string): Promise<boolean> {
    return this.outputs.has(jobId);
  }

  public async finalize(
    jobId: string,
    expectedRevision: number,
    assets: readonly MaterializedAsset[],
  ): Promise<JobTransitionCommit | null> {
    const committed = await this.jobs.transition(jobId, {
      expectedStatuses: ['processing'],
      expectedRevision,
      status: 'completed',
      stage: 'completed',
      progress: 100,
      pollAfterAt: null,
      error: null,
    });
    if (committed) {
      this.outputs.set(jobId, assets);
    }
    return committed;
  }
}

class AsyncTestProvider implements ProviderAdapter {
  public readonly type = 'async-test';
  public submitCount = 0;
  public pollCount = 0;
  public cancelCount = 0;
  public lastPollSignal: AbortSignal | undefined;
  public readonly pollsEntered = createDeferred();
  private readonly pollRelease = createDeferred();
  private expectedPolls: number;

  public constructor(expectedPolls = 1) {
    this.expectedPolls = expectedPolls;
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return { providerType: this.type, models: [] };
  }

  public async validate(_request: GenerationRequest, _context: ProviderContext): Promise<void> {}

  public async submit(
    _request: GenerationRequest,
    _context: ProviderContext,
  ): Promise<SubmitResult> {
    this.submitCount += 1;
    return { state: 'pending', remoteJobId: `remote-${this.submitCount}`, pollAfterMs: 0 };
  }

  public async poll(
    _remoteJobId: string,
    context: ProviderContext,
  ): Promise<PollResult> {
    this.pollCount += 1;
    this.lastPollSignal = context.signal;
    if (this.pollCount >= this.expectedPolls) {
      this.pollsEntered.resolve();
    }
    await this.pollRelease.promise;
    return { state: 'completed', assets: [submittedBase64Asset()] };
  }

  public async cancel(_remoteJobId: string, _context: ProviderContext): Promise<void> {
    this.cancelCount += 1;
  }

  public normalizeError(error: unknown): ProviderError {
    return {
      code: 'async_test_error',
      kind: 'unknown',
      message: error instanceof Error ? error.message : 'Async test error',
      retryable: false,
    };
  }

  public releasePolls(): void {
    this.pollRelease.resolve();
  }
}

class CompletedTestProvider implements ProviderAdapter {
  public readonly type = 'completed-test';

  public constructor(private readonly assets: readonly SubmittedAsset[]) {}

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return { providerType: this.type, models: [] };
  }

  public async validate(_request: GenerationRequest, _context: ProviderContext): Promise<void> {}

  public async submit(
    _request: GenerationRequest,
    _context: ProviderContext,
  ): Promise<SubmitResult> {
    return { state: 'completed', assets: this.assets };
  }

  public async poll(_remoteJobId: string, _context: ProviderContext): Promise<PollResult> {
    return { state: 'completed', assets: this.assets };
  }

  public normalizeError(error: unknown): ProviderError {
    return {
      code: 'completed_test_error',
      kind: 'unknown',
      message: error instanceof Error ? error.message : 'Completed test error',
      retryable: false,
    };
  }
}

class RetryingSubmitProvider extends CompletedTestProvider {
  public readonly attempts: number[] = [];

  public constructor() {
    super([submittedBase64Asset()]);
  }

  public override async submit(
    _request: GenerationRequest,
    context: ProviderContext,
  ): Promise<SubmitResult> {
    this.attempts.push(context.attempt ?? -1);
    throw new Error('transient submit failure');
  }

  public override normalizeError(error: unknown): ProviderError {
    return {
      code: 'transient_submit',
      kind: 'transient',
      message: error instanceof Error ? error.message : 'Transient submit failure',
      retryable: true,
      retryAfterMs: 0,
    };
  }
}

class RepollTestProvider extends CompletedTestProvider {
  public pollCount = 0;

  public constructor() {
    super([submittedBase64Asset()]);
  }

  public override async submit(
    _request: GenerationRequest,
    _context: ProviderContext,
  ): Promise<SubmitResult> {
    return { state: 'pending', remoteJobId: 'repoll', pollAfterMs: 0 };
  }

  public override async poll(
    _remoteJobId: string,
    _context: ProviderContext,
  ): Promise<PollResult> {
    this.pollCount += 1;
    if (this.pollCount === 1) {
      return { state: 'remote_running', progress: 50, pollAfterMs: 0 };
    }
    return { state: 'completed', assets: [submittedBase64Asset()] };
  }
}

function submittedBase64Asset(): SubmittedAsset {
  return {
    type: 'image',
    mimeType: 'image/png',
    source: 'base64',
    base64: 'aW1hZ2U=',
  };
}

function createMemoryRunner(
  initialJobs: readonly RunnerJob[],
  providerFor: (providerId: string) => { adapter: ProviderAdapter; submitReplaySafe: boolean },
  events: RunnerEvent[] = [],
): {
  runner: JobRunner;
  jobs: MemoryJobPort;
  assets: MemoryAssetPort;
  materializedSources: Array<SubmittedAsset['source']>;
  discardedJobIds: string[];
  finalizedJobIds: string[];
} {
  const jobs = new MemoryJobPort(initialJobs);
  const assets = new MemoryAssetPort(jobs);
  const materializedSources: Array<SubmittedAsset['source']> = [];
  const discardedJobIds: string[] = [];
  const finalizedJobIds: string[] = [];
  const options: JobRunnerOptions = {
    jobs,
    assets,
    events: {
      publish: (event) => {
        events.push(event);
      },
    },
    providers: {
      resolve: (providerId) => ({ ...providerFor(providerId), secrets: {} }),
    },
    media: {
      materialize: async (job, submitted) =>
        submitted.map((asset, index) => {
          materializedSources.push(asset.source);
          return {
            type: asset.type,
            mimeType: asset.mimeType,
            filePath: `${job.id}/${asset.source}-${index}`,
            fileSize: 1,
            sha256: `${job.id}-${index}`,
          };
        }),
      process: async (_job, materialized) => materialized,
      discard: async (job) => {
        discardedJobIds.push(job.id);
      },
      finalized: async (job) => {
        finalizedJobIds.push(job.id);
      },
    },
    concurrency: { imageSubmit: 1, videoSubmit: 1, poll: 4, download: 3, process: 2 },
    defaultPollAfterMs: 0,
    defaultRetryAfterMs: 0,
  };
  return {
    runner: new JobRunner(options),
    jobs,
    assets,
    materializedSources,
    discardedJobIds,
    finalizedJobIds,
  };
}

describe('JobRunner asynchronous state machine', () => {
  it('releases the submit slot while remote polls are pending', async () => {
    const provider = new AsyncTestProvider(2);
    const initial = [createRunnerJob('async-1'), createRunnerJob('async-2')];
    const { runner, jobs } = createMemoryRunner(initial, () => ({
      adapter: provider,
      submitReplaySafe: true,
    }));

    await runner.start();
    await waitForPhase(provider.pollsEntered.promise, 'both asynchronous polls');
    expect(provider.submitCount).toBe(2);
    expect(provider.pollCount).toBe(2);
    expect([...jobs.records.values()].map((job) => job.status)).toEqual([
      'remote_pending',
      'remote_pending',
    ]);

    provider.releasePolls();
    await waitForPhase(runner.waitForIdle(), 'asynchronous completion');
    expect([...jobs.records.values()].map((job) => job.status)).toEqual([
      'completed',
      'completed',
    ]);
    await runner.stop();
  });

  it('aborts an active poll, calls provider cancel, and rejects its late result', async () => {
    const provider = new AsyncTestProvider();
    const { runner, jobs, materializedSources } = createMemoryRunner(
      [createRunnerJob('cancel-1')],
      () => ({ adapter: provider, submitReplaySafe: true }),
    );

    await runner.start();
    await waitForPhase(provider.pollsEntered.promise, 'cancel poll entry');
    await runner.cancel('cancel-1');

    expect(provider.lastPollSignal?.aborted).toBe(true);
    expect(provider.cancelCount).toBe(1);
    provider.releasePolls();
    await waitForPhase(runner.waitForIdle(), 'late cancelled poll');
    expect(jobs.records.get('cancel-1')?.status).toBe('cancelled');
    expect(materializedSources).toEqual([]);
    await runner.stop();
  });

  it('reschedules an immediate running poll after the active poll task exits', async () => {
    const provider = new RepollTestProvider();
    const { runner, jobs } = createMemoryRunner([createRunnerJob('repoll')], () => ({
      adapter: provider,
      submitReplaySafe: true,
    }));

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'immediate repoll');

    expect(provider.pollCount).toBe(2);
    expect(jobs.records.get('repoll')).toMatchObject({ status: 'completed', progress: 100 });
    await runner.stop();
  });

  it('passes incrementing submit attempts and stops at the configured maximum', async () => {
    const provider = new RetryingSubmitProvider();
    const { runner, jobs } = createMemoryRunner([createRunnerJob('retry-limit')], () => ({
      adapter: provider,
      submitReplaySafe: true,
    }));

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'submit retry limit');

    expect(provider.attempts).toEqual([1, 2, 3]);
    expect(jobs.records.get('retry-limit')).toMatchObject({
      status: 'failed',
      attempt: 3,
      error: { code: 'transient_submit' },
    });
    await runner.stop();
  });

  it('recovers every durable stage and fails an unsafe unknown submission', async () => {
    const provider = new CompletedTestProvider([submittedBase64Asset()]);
    const materialized: MaterializedAsset = {
      type: 'image',
      mimeType: 'image/png',
      filePath: 'already-downloaded.png',
      fileSize: 1,
      sha256: 'existing',
    };
    const initial = [
      createRunnerJob('queued'),
      createRunnerJob('submit-safe', { status: 'submitting' }),
      createRunnerJob('submit-unsafe', {
        status: 'submitting',
        request: createMockGenerationRequest({ providerId: 'unsafe' }),
      }),
      createRunnerJob('remote', {
        status: 'remote_running',
        remoteJobId: 'remote-existing',
      }),
      createRunnerJob('downloading', {
        status: 'downloading',
        resultAssets: [submittedBase64Asset()],
      }),
      createRunnerJob('processing', {
        status: 'processing',
        materializedAssets: [materialized],
      }),
      createRunnerJob('completed-corrupt', { status: 'completed' }),
    ];
    const { runner, jobs } = createMemoryRunner(initial, (providerId) => ({
      adapter: provider,
      submitReplaySafe: providerId !== 'unsafe',
    }));

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'recovery');

    expect(jobs.records.get('submit-unsafe')).toMatchObject({
      status: 'failed',
      error: { code: 'submission_outcome_unknown' },
    });
    expect(jobs.records.get('completed-corrupt')).toMatchObject({
      status: 'failed',
      stage: 'output_consistency_error',
      error: { code: 'output_consistency_error' },
    });
    for (const id of ['queued', 'submit-safe', 'remote', 'downloading', 'processing']) {
      expect(jobs.records.get(id)?.status).toBe('completed');
    }
    await runner.stop();
  });

  it('hands both base64 and URL results to the media materializer', async () => {
    const provider = new CompletedTestProvider([
      submittedBase64Asset(),
      {
        type: 'image',
        mimeType: 'image/png',
        source: 'url',
        url: 'https://provider.invalid/result.png',
      },
    ]);
    const { runner, jobs, materializedSources } = createMemoryRunner(
      [createRunnerJob('sources')],
      () => ({ adapter: provider, submitReplaySafe: true }),
    );

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'source materialization');

    expect(materializedSources).toEqual(['base64', 'url']);
    expect(jobs.records.get('sources')?.status).toBe('completed');
    await runner.stop();
  });

  it('discards provisional outputs when a processing Job is cancelled', async () => {
    const materialized: MaterializedAsset = {
      type: 'image',
      mimeType: 'image/png',
      filePath: 'provisional/cancel.png',
      fileSize: 1,
      sha256: 'cancel-sha',
    };
    const { runner, jobs, discardedJobIds } = createMemoryRunner(
      [createRunnerJob('cancel-provisional', {
        status: 'processing',
        materializedAssets: [materialized],
      })],
      () => ({ adapter: new CompletedTestProvider([]), submitReplaySafe: true }),
    );

    await runner.cancel('cancel-provisional');

    expect(jobs.records.get('cancel-provisional')?.status).toBe('cancelled');
    expect(discardedJobIds).toEqual(['cancel-provisional']);
  });

  it('releases provisional markers only after atomic output finalization', async () => {
    const materialized: MaterializedAsset = {
      type: 'image',
      mimeType: 'image/png',
      filePath: 'provisional/finalize.png',
      fileSize: 1,
      sha256: 'finalize-sha',
    };
    const { runner, finalizedJobIds } = createMemoryRunner(
      [createRunnerJob('finalize-provisional', {
        status: 'processing',
        materializedAssets: [materialized],
      })],
      () => ({ adapter: new CompletedTestProvider([]), submitReplaySafe: true }),
    );

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'provisional finalization');

    expect(finalizedJobIds).toEqual(['finalize-provisional']);
    await runner.stop();
  });

  it('discards provisional outputs when cancellation wins the finalize CAS', async () => {
    const materialized: MaterializedAsset = {
      type: 'image',
      mimeType: 'image/png',
      filePath: 'provisional/cas-cancel.png',
      fileSize: 1,
      sha256: 'cas-cancel-sha',
    };
    const job = createRunnerJob('cas-cancel', {
      status: 'processing',
      materializedAssets: [materialized],
    });
    const jobs = new MemoryJobPort([job]);
    const discarded: string[] = [];
    const assets: RunnerAssetPort = {
      outputsConsistent: async () => false,
      finalize: async (_jobId, expectedRevision) => {
        await jobs.transition(job.id, {
          expectedStatuses: ['processing'],
          expectedRevision,
          status: 'cancelled',
          stage: 'cancelled',
        });
        return null;
      },
    };
    const runner = new JobRunner({
      jobs,
      assets,
      events: { publish: () => undefined },
      providers: {
        resolve: () => ({
          adapter: new CompletedTestProvider([]),
          secrets: {},
          submitReplaySafe: true,
        }),
      },
      media: {
        materialize: async (_job, outputs) => outputs.map(() => materialized),
        process: async (_job, outputs) => outputs,
        discard: async (discardedJob) => {
          discarded.push(discardedJob.id);
        },
      },
    });

    await runner.start();
    await waitForPhase(runner.waitForIdle(), 'finalize cancellation race');

    expect(jobs.records.get(job.id)?.status).toBe('cancelled');
    expect(discarded).toEqual([job.id]);
    await runner.stop();
  });
});
