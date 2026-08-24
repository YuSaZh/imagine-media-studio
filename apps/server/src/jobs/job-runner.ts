import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import type { ProviderAdapter, SubmittedAsset } from '@imagine/provider-contract';

import type { AssetRepository, JobRepository } from '../database/jobs.js';
import type { StoragePaths } from '../storage/paths.js';

export class JobRunner {
  private running = false;
  private activeCount = 0;
  private readonly knownJobIds = new Set<string>();
  private readonly pendingJobIds: string[] = [];
  private readonly idleWaiters = new Set<() => void>();

  public constructor(
    private readonly jobs: JobRepository,
    private readonly assets: AssetRepository,
    private readonly provider: ProviderAdapter,
    private readonly storage: StoragePaths,
    private readonly maxConcurrency = 2,
  ) {}

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.resumePendingJobs();
  }

  public async stop(): Promise<void> {
    this.running = false;
    for (const jobId of this.pendingJobIds.splice(0)) {
      this.knownJobIds.delete(jobId);
    }
    this.resolveIdleWaiters();
    await this.waitForIdle();
  }

  public async enqueue(jobId: string): Promise<void> {
    if (!this.running || this.knownJobIds.has(jobId)) {
      return;
    }

    this.knownJobIds.add(jobId);
    this.pendingJobIds.push(jobId);
    this.drain();
  }

  public async resumePendingJobs(): Promise<void> {
    this.jobs.requeueRecoverableMockJobs();
    for (const job of this.jobs.listQueued()) {
      await this.enqueue(job.id);
    }
  }

  public async cancel(jobId: string): Promise<void> {
    if (this.jobs.get(jobId)) {
      this.jobs.updateStatus(jobId, 'cancelled', 'cancelled');
    }
  }

  public async waitForIdle(): Promise<void> {
    if (this.activeCount === 0 && this.pendingJobIds.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private async process(jobId: string): Promise<void> {
    const job = this.jobs.claimQueued(jobId);
    if (!job) {
      return;
    }

    const context = {
      providerId: job.request.providerId,
      secrets: {},
    };

    try {
      await this.provider.validate(job.request, context);
      const result = await this.provider.submit(job.request, context);

      if (result.state !== 'completed') {
        throw new Error('The PR 0 Mock Provider must complete synchronously.');
      }

      this.jobs.updateStatus(jobId, 'processing', 'saving_result');
      for (const [index, asset] of result.assets.entries()) {
        await this.persistAsset(jobId, index, asset);
      }

      this.jobs.updateStatus(jobId, 'completed', 'completed', {
        progress: 100,
        completedAt: new Date(),
      });
    } catch (error) {
      const normalized = this.provider.normalizeError(error);
      this.jobs.updateStatus(jobId, 'failed', 'failed', {
        errorCode: normalized.code,
        errorMessage: normalized.message,
      });
    }
  }

  private drain(): void {
    while (
      this.running &&
      this.activeCount < this.maxConcurrency &&
      this.pendingJobIds.length > 0
    ) {
      const jobId = this.pendingJobIds.shift();
      if (!jobId) {
        break;
      }

      this.activeCount += 1;
      void this.process(jobId).finally(() => {
        this.activeCount -= 1;
        this.knownJobIds.delete(jobId);
        this.drain();
        this.resolveIdleWaiters();
      });
    }
  }

  private resolveIdleWaiters(): void {
    if (this.activeCount !== 0 || this.pendingJobIds.length !== 0) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }

  private async persistAsset(
    jobId: string,
    index: number,
    asset: SubmittedAsset,
  ): Promise<void> {
    if (asset.source !== 'base64') {
      throw new Error('PR 0 persistence only accepts the Mock Provider base64 fixture.');
    }

    const extension = asset.mimeType === 'image/png' ? 'png' : 'bin';
    const filename = `${jobId}-${index}.${extension}`;
    const absolutePath = join(this.storage.originals, filename);
    const relativePath = relative(this.storage.root, absolutePath);
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
      const temporaryPath = join(
        this.storage.temporary,
        `${jobId}-${index}-${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporaryPath, bytes, { flag: 'wx' });
        await rename(temporaryPath, absolutePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }

    this.assets.createIfMissing({
      jobId,
      type: asset.type,
      role: 'output',
      filePath: relativePath,
      mimeType: asset.mimeType,
      fileSize: bytes.byteLength,
      sha256,
    });
  }
}
