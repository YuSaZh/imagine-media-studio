import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  PollResult,
  SubmitResult,
} from '@imagine/provider-contract';
import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from '../database/client.js';
import { ChangeEventRepository } from '../database/events.js';
import { JobRepository } from '../database/jobs.js';
import type { RunnerClock } from './ports.js';
import type { AssetMediaServicePort } from './sqlite-adapters.js';
import { createSqliteRunnerOptions } from './sqlite-adapters.js';
import { JobRunner } from './job-runner.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const directories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

class ManualClock implements RunnerClock {
  private nextHandle = 1;
  private readonly timers = new Map<number, () => void>();

  public constructor(private readonly currentTime: number) {}

  public now(): number {
    return this.currentTime;
  }

  public setTimeout(callback: () => void, _delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, callback);
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

class RetryablePollProvider implements ProviderAdapter {
  public readonly type = 'sqlite-retry-provider';
  public pollCount = 0;
  public cancelCount = 0;

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return { providerType: this.type, models: [] };
  }

  public async validate(_request: Parameters<ProviderAdapter['validate']>[0], _context: ProviderContext): Promise<void> {}

  public async submit(_request: Parameters<ProviderAdapter['submit']>[0], _context: ProviderContext): Promise<SubmitResult> {
    return { state: 'pending', remoteJobId: 'sqlite-retry-remote' };
  }

  public async poll(_remoteJobId: string, _context: ProviderContext): Promise<PollResult> {
    this.pollCount += 1;
    throw new Error('SQLite retry fixture failure');
  }

  public async cancel(_remoteJobId: string, _context: ProviderContext): Promise<void> {
    this.cancelCount += 1;
  }

  public normalizeError(error: unknown): ProviderError {
    return {
      code: 'sqlite_retry_fixture_failure',
      kind: 'transient',
      message: error instanceof Error ? error.message : 'SQLite retry fixture failure',
      retryable: true,
      retryAfterMs: 1,
    };
  }
}

const media: AssetMediaServicePort = {
  cleanupProviderOutputs: async () => undefined,
  materializeProviderBase64: async () => {
    throw new Error('The SQLite retry fixture does not materialize outputs.');
  },
  materializeProviderUrl: async () => {
    throw new Error('The SQLite retry fixture does not materialize outputs.');
  },
  releaseProviderOutputs: async () => undefined,
  validateProviderOutputs: async () => true,
};

function createRunner(
  jobs: JobRepository,
  events: ChangeEventRepository,
  provider: RetryablePollProvider,
  clock: RunnerClock,
): JobRunner {
  return new JobRunner({
    ...createSqliteRunnerOptions({
      jobs,
      changeEvents: events,
      broker: { publish: () => undefined },
      providers: {
        resolve: () => ({ adapter: provider, secrets: {}, submitReplaySafe: true }),
      },
      media,
    }),
    clock,
    maxAttempts: 2,
    defaultPollAfterMs: 0,
    defaultRetryAfterMs: 1,
    concurrency: { imageSubmit: 1, videoSubmit: 1, poll: 1, download: 1, process: 1 },
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe('SQLite stage retry budget recovery', () => {
  it('preserves the remaining poll budget across close and reopen', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'imagine-sqlite-retry-budget-'));
    directories.push(directory);
    const databasePath = resolve(directory, 'app.db');
    const firstDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(firstDatabase);
    const firstJobs = new JobRepository(firstDatabase.orm);
    const firstEvents = new ChangeEventRepository(firstDatabase.orm);
    const provider = new RetryablePollProvider();
    const request = createMockGenerationRequest({
      providerId: provider.type,
      modelId: 'sqlite-retry-image-v1',
    });
    const created = firstJobs.create(request);
    const claimed = firstJobs.claimQueued(created.id, created.revision);
    if (!claimed) throw new Error('Expected the SQLite retry fixture Job to be claimed.');
    const pending = firstJobs.compareAndSetStatus(
      created.id,
      claimed.revision,
      ['submitting'],
      'remote_pending',
      'remote_pending',
      { remoteJobId: 'sqlite-retry-remote', pollAfterAt: new Date(1_000) },
    );
    if (!pending) throw new Error('Expected the SQLite retry fixture Job to become pending.');

    const firstRunner = createRunner(firstJobs, firstEvents, provider, new ManualClock(1_000));
    await firstRunner.start();
    await waitFor(() => firstJobs.get(created.id)?.stageRetryCounts.poll === 1, 'first persisted retry');
    const retryAt = firstJobs.get(created.id)?.pollAfterAt?.getTime();
    expect(retryAt).toBe(1_001);
    expect(provider.pollCount).toBe(1);
    await firstRunner.stop();
    databases.splice(databases.indexOf(firstDatabase), 1);
    firstDatabase.sqlite.close();

    const secondDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(secondDatabase);
    const secondJobs = new JobRepository(secondDatabase.orm);
    const secondEvents = new ChangeEventRepository(secondDatabase.orm);
    expect(secondJobs.get(created.id)).toMatchObject({
      status: 'remote_pending',
      stageRetryCounts: { poll: 1, download: 0, process: 0 },
    });

    const secondRunner = createRunner(secondJobs, secondEvents, provider, new ManualClock(1_002));
    await secondRunner.start();
    await waitFor(() => secondJobs.get(created.id)?.status === 'failed', 'remaining retry exhaustion');

    expect(provider.pollCount).toBe(2);
    expect(secondJobs.get(created.id)).toMatchObject({
      status: 'failed',
      errorCode: 'sqlite_retry_fixture_failure',
      stageRetryCounts: { poll: 0, download: 0, process: 0 },
    });
    await secondRunner.stop();
  });

  it('settles a cancellation request after a SQLite close and reopen', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'imagine-sqlite-cancel-recovery-'));
    directories.push(directory);
    const databasePath = resolve(directory, 'app.db');
    const firstDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(firstDatabase);
    const firstJobs = new JobRepository(firstDatabase.orm);
    const provider = new RetryablePollProvider();
    const created = firstJobs.create(createMockGenerationRequest({
      providerId: provider.type,
      modelId: 'sqlite-cancel-image-v1',
    }));
    const claimed = firstJobs.claimQueued(created.id, created.revision);
    if (!claimed) throw new Error('Expected the SQLite cancellation fixture Job to be claimed.');
    const pending = firstJobs.compareAndSetStatus(
      created.id,
      claimed.revision,
      ['submitting'],
      'remote_pending',
      'remote_pending',
      { remoteJobId: 'sqlite-cancel-remote', pollAfterAt: new Date(1_000) },
    );
    if (!pending) throw new Error('Expected the SQLite cancellation fixture Job to become pending.');
    expect(firstJobs.requestCancel(created.id, pending.revision)?.status).toBe('remote_pending');
    databases.splice(databases.indexOf(firstDatabase), 1);
    firstDatabase.sqlite.close();

    const secondDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(secondDatabase);
    const secondJobs = new JobRepository(secondDatabase.orm);
    const secondEvents = new ChangeEventRepository(secondDatabase.orm);
    const runner = createRunner(secondJobs, secondEvents, provider, new ManualClock(2_000));

    await runner.start();

    expect(provider.pollCount).toBe(0);
    expect(provider.cancelCount).toBe(1);
    expect(secondJobs.get(created.id)).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
    });
    await runner.stop();
  });

  it('persists a polling deadline separately from result expiry and fails before polling after reopen', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'imagine-sqlite-expiry-recovery-'));
    directories.push(directory);
    const databasePath = resolve(directory, 'app.db');
    const firstDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(firstDatabase);
    const firstJobs = new JobRepository(firstDatabase.orm);
    const provider = new RetryablePollProvider();
    const created = firstJobs.create(createMockGenerationRequest({
      providerId: provider.type,
      modelId: 'sqlite-expiry-video-v1',
      operation: 'video.generate',
      count: 3,
    }));
    const claimed = firstJobs.claimQueued(created.id, created.revision);
    if (!claimed) throw new Error('Expected the SQLite expiry fixture Job to be claimed.');
    const pending = firstJobs.compareAndSetStatus(
      created.id,
      claimed.revision,
      ['submitting'],
      'remote_pending',
      'remote_pending',
      {
        remoteJobId: 'sqlite-expiry-remote',
        resultManifest: [{
          version: 1,
          resultAssets: [
            { type: 'image', mimeType: 'image/png', source: 'base64', base64: 'AQ==' },
            { type: 'image', mimeType: 'image/png', source: 'url', url: 'https://cdn.example.invalid/result.png' },
            {
              type: 'video',
              mimeType: 'video/mp4',
              source: 'provider',
              providerId: provider.type,
              remoteJobId: 'sqlite-expiry-remote',
              variant: 'video',
            },
          ],
        }],
        remoteDeadlineAt: new Date(1_000),
        resultExpiresAt: new Date(1_000),
        pollAfterAt: new Date(1_000),
      },
    );
    if (!pending) throw new Error('Expected the SQLite expiry fixture Job to become pending.');
    expect(firstJobs.get(created.id)?.remoteDeadlineAt).toEqual(new Date(1_000));
    expect(firstJobs.get(created.id)?.resultExpiresAt).toEqual(new Date(1_000));
    databases.splice(databases.indexOf(firstDatabase), 1);
    firstDatabase.sqlite.close();

    const secondDatabase = createDatabase(databasePath, migrationsDirectory);
    databases.push(secondDatabase);
    const secondJobs = new JobRepository(secondDatabase.orm);
    const secondEvents = new ChangeEventRepository(secondDatabase.orm);
    expect(secondJobs.get(created.id)).toMatchObject({
      remoteDeadlineAt: new Date(1_000),
      resultExpiresAt: new Date(1_000),
    });
    const runner = createRunner(secondJobs, secondEvents, provider, new ManualClock(2_000));

    await runner.start();
    await waitFor(() => secondJobs.get(created.id)?.status === 'expired', 'expired remote recovery');

    expect(provider.pollCount).toBe(0);
    expect(secondJobs.get(created.id)).toMatchObject({
      status: 'expired',
      errorCode: 'provider_result_expired',
      resultManifest: [],
      remoteJobId: 'sqlite-expiry-remote',
      remoteDeadlineAt: null,
      resultExpiresAt: null,
    });
    expect(JSON.stringify(secondJobs.get(created.id))).not.toContain('https://cdn.example.invalid');
    expect(JSON.stringify(secondJobs.get(created.id))).not.toContain('AQ==');
    expect(JSON.stringify(secondJobs.get(created.id))).not.toContain('"source":"provider"');
    await runner.stop();
  });
});
