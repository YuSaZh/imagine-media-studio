import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GenerationRequest } from '@imagine/shared';
import type { ProviderContext, SubmitResult } from '@imagine/provider-contract';
import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase } from '../database/client.js';
import { AssetRepository, JobRepository } from '../database/jobs.js';
import { MockProviderAdapter } from '../providers/mock-provider.js';
import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { JobRunner } from './job-runner.js';

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

    await provider.twoActive.promise;
    expect(provider.activeCount).toBe(2);
    expect(provider.maxActiveCount).toBe(2);
    provider.releaseActive();

    await provider.thirdEntered.promise;
    expect(provider.maxActiveCount).toBe(2);
    provider.releaseActive();

    await runner.waitForIdle();
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
