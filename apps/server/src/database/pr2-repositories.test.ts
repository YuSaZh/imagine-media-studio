import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { AssetRepository } from './assets.js';
import { createDatabase, type DatabaseClient } from './client.js';
import { CollectionRepository, CollectionRepositoryError } from './collections.js';
import { ChangeEventRepository } from './events.js';
import { JobRepository, JobRepositoryError } from './jobs.js';
import { ModelRepository } from './models.js';
import { ProviderRepository } from './providers.js';
import { SettingsRepository } from './settings.js';

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createTestDatabase(): Promise<DatabaseClient> {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-pr2-repository-test-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  return database;
}

function assetInput(path: string) {
  return {
    type: 'image' as const,
    role: 'upload',
    filePath: path,
    originalFilename: path.split('/').at(-1) ?? 'fixture.png',
    mimeType: 'image/png',
    width: 512,
    height: 512,
    fileSize: 128,
    sha256: `sha-${path}`,
    metadata: { source: 'test' },
  };
}

describe('PR 2 database repositories', () => {
  it('stores typed settings and emits replayable ordered events', async () => {
    const database = await createTestDatabase();
    const settings = new SettingsRepository(database.orm);
    const events = new ChangeEventRepository(database.orm);

    settings.upsertMany({ defaultMode: 'image', clearPromptAfterSubmit: true });
    settings.upsertMany({ defaultMode: 'video' });

    expect(settings.get('defaultMode')?.value).toBe('video');
    expect(settings.list()).toHaveLength(2);
    const replay = events.replay(0);
    expect(replay.map((event) => event.id)).toEqual([...replay.map((event) => event.id)].sort((a, b) => a - b));
    expect(replay.map((event) => event.eventType)).toEqual([
      'setting.updated',
      'setting.updated',
      'setting.updated',
    ]);
    expect(events.replay(replay[0]?.id ?? 0)).toHaveLength(2);
    expect(events.latestId()).toBe(replay.at(-1)?.id);
    expect(events.listAfter(0, 10)).toHaveLength(3);
    expect(events.latestForAggregate('setting', 'defaultMode')).toMatchObject({
      aggregateId: 'defaultMode',
      eventType: 'setting.updated',
    });
  });

  it('keeps exactly one default provider and paginates stable cursor ties', async () => {
    const database = await createTestDatabase();
    const providers = new ProviderRepository(database.orm);
    const first = providers.create({
      id: 'mock',
      name: 'Provider A',
      type: 'mock',
      apiKeyCiphertext: 'ciphertext-a',
      isDefault: true,
    });
    const second = providers.create({ name: 'Provider B', type: 'mock' });
    const third = providers.create({ name: 'Provider C', type: 'mock', isDefault: true });

    expect(providers.get(first.id)?.apiKeyCiphertext).toBe('ciphertext-a');
    expect(first.id).toBe('mock');
    expect(providers.get(first.id)?.isDefault).toBe(false);
    expect(providers.get(third.id)?.isDefault).toBe(true);
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM providers WHERE is_default = 1').get(),
    ).toEqual({ count: 1 });

    const pageOne = providers.page({ limit: 2 });
    if (!pageOne.nextCursor) throw new Error('Expected a second provider page.');
    const pageTwo = providers.page({ cursor: pageOne.nextCursor, limit: 2 });
    expect(pageOne.items).toHaveLength(2);
    expect(pageTwo.items).toHaveLength(1);
    expect(new Set([...pageOne.items, ...pageTwo.items].map((provider) => provider.id))).toEqual(
      new Set([first.id, second.id, third.id]),
    );
  });

  it('refreshes models atomically and disables entries missing from the new catalog', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Models', type: 'mock' });
    const models = new ModelRepository(database.orm);

    models.replaceForProvider(provider.id, [
      {
        modelId: 'image-v1',
        displayName: 'Image',
        capabilities: { operations: ['image.generate'] },
        capabilitySource: 'provider',
      },
      {
        modelId: 'video-v1',
        displayName: 'Video',
        capabilities: { operations: ['video.generate'] },
        capabilitySource: 'provider',
      },
    ]);
    const refreshed = models.replaceForProvider(provider.id, [
      {
        modelId: 'image-v1',
        displayName: 'Image Updated',
        capabilities: { operations: ['image.generate'], maxBatchCount: 4 },
        capabilitySource: 'provider',
      },
    ]);

    expect(refreshed.find((model) => model.modelId === 'image-v1')).toMatchObject({
      displayName: 'Image Updated',
      enabled: true,
    });
    expect(refreshed.find((model) => model.modelId === 'video-v1')?.enabled).toBe(false);
  });

  it('creates jobs with inputs and slots, enforces revision CAS, and preserves retry lineage', async () => {
    const database = await createTestDatabase();
    const assets = new AssetRepository(database.orm);
    const inputAsset = assets.create(assetInput('media/uploads/input.png'));
    const jobs = new JobRepository(database.orm);
    const request = createMockGenerationRequest({
      count: 2,
      inputs: [{ assetId: inputAsset.id, role: 'reference' }],
    });
    const job = jobs.createWithInputs(request, [
      { assetId: inputAsset.id, role: 'reference', sortOrder: 0 },
    ]);

    const eventCountBeforeInvalid = new ChangeEventRepository(database.orm).replay(0).length;
    expect(() =>
      jobs.createWithInputs(createMockGenerationRequest(), [
        { assetId: 'missing', role: 'reference', sortOrder: 0 },
      ]),
    ).toThrow(JobRepositoryError);
    expect(new ChangeEventRepository(database.orm).replay(0)).toHaveLength(eventCountBeforeInvalid);

    expect(job.rootJobId).toBe(job.id);
    expect(job.requestSha256).toHaveLength(64);
    expect(jobs.listInputs(job.id)).toHaveLength(1);
    expect(jobs.listOutputs(job.id)).toHaveLength(2);
    expect(job).toMatchObject({ retryCount: 0, submitAttempt: 0 });
    expect(jobs.claimQueued(job.id, job.revision + 1)).toBeNull();
    const claimed = jobs.claimQueued(job.id, job.revision);
    expect(claimed).toMatchObject({ status: 'submitting', revision: 1, submitAttempt: 1 });
    expect(
      jobs.compareAndSetStatus(job.id, 0, ['submitting'], 'failed', 'failed'),
    ).toBeNull();
    const failed = jobs.compareAndSetStatus(
      job.id,
      claimed?.revision ?? -1,
      ['submitting'],
      'failed',
      'failed',
      { errorCode: 'fixture_error', errorMessage: 'Expected failure' },
    );
    expect(failed).toMatchObject({ status: 'failed', revision: 2 });

    const retry = jobs.retry(job.id);
    if (!retry) throw new Error('Expected the failed job to be retryable.');
    expect(retry).toMatchObject({
      retryOfJobId: job.id,
      rootJobId: job.id,
      retryCount: 1,
      submitAttempt: 0,
      status: 'queued',
    });
    expect(jobs.listInputs(retry.id)).toHaveLength(1);
    expect(jobs.listOutputs(retry.id)).toHaveLength(2);
    const firstPage = jobs.page({ limit: 1 });
    if (!firstPage.nextCursor) throw new Error('Expected a second job page.');
    const secondPage = jobs.page({ cursor: firstPage.nextCursor, limit: 1 });
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id))).toEqual(
      new Set([job.id, retry.id]),
    );

    const outputAsset = assets.create({
      ...assetInput('media/originals/output.png'),
      jobId: job.id,
      role: 'output',
    });
    expect(jobs.assignOutput(job.id, 0, outputAsset.id)).toMatchObject({
      jobId: job.id,
      slot: 0,
      assetId: outputAsset.id,
    });
    expect(jobs.get(job.id)?.resultManifest).toEqual([
      { slot: 0, assetId: outputAsset.id },
      { slot: 1, assetId: null },
    ]);

    const cancellable = jobs.create(createMockGenerationRequest({ prompt: 'Cancel me' }));
    expect(jobs.requestCancel(cancellable.id, cancellable.revision)).toMatchObject({
      status: 'cancelled',
      revision: 1,
    });
    expect(jobs.requestCancel(cancellable.id, cancellable.revision)).toBeNull();
    const running = jobs.create(createMockGenerationRequest({ prompt: 'Cancel running' }));
    const runningClaim = jobs.claimQueued(running.id);
    const cancelRequested = jobs.requestCancel(running.id, runningClaim?.revision ?? -1);
    jobs.updateStatus(running.id, 'processing', 'processing');
    expect(jobs.get(running.id)).toMatchObject({
      status: 'submitting',
      stage: 'cancel_requested',
      revision: cancelRequested?.revision,
    });
    expect(jobs.softDelete(job.id)).toBe(true);
    expect(jobs.get(job.id)).toBeNull();
    expect(jobs.get(job.id, true)?.deletedAt).toBeInstanceOf(Date);
  });

  it('persists favorite and soft-delete state while keeping asset pages stable', async () => {
    const database = await createTestDatabase();
    const assets = new AssetRepository(database.orm);
    const first = assets.create(assetInput('media/uploads/first.png'));
    const second = assets.create(assetInput('media/uploads/second.png'));
    const third = assets.create(assetInput('media/uploads/third.png'));

    expect(assets.setFavorite(second.id, true)?.favorite).toBe(true);
    const pageOne = assets.page({ limit: 2 });
    if (!pageOne.nextCursor) throw new Error('Expected a second asset page.');
    const pageTwo = assets.page({ cursor: pageOne.nextCursor, limit: 2 });
    expect(new Set([...pageOne.items, ...pageTwo.items].map((asset) => asset.id))).toEqual(
      new Set([first.id, second.id, third.id]),
    );
    const mask = assets.create({
      ...assetInput('media/masks/edit-mask.png'),
      role: 'mask',
      parentAssetId: first.id,
    });
    expect(assets.page().items.map((asset) => asset.id)).not.toContain(mask.id);
    expect(assets.page({ role: 'mask' }).items.map((asset) => asset.id)).toEqual([mask.id]);
    expect(assets.softDelete(second.id)).toBe(true);
    expect(assets.get(second.id)).toBeNull();
    expect(assets.get(second.id, true)?.deletedAt).toBeInstanceOf(Date);
    expect(assets.page().items.map((asset) => asset.id)).not.toContain(second.id);
  });

  it('adds collection assets atomically and idempotently and removes joins on soft delete', async () => {
    const database = await createTestDatabase();
    const assets = new AssetRepository(database.orm);
    const first = assets.create(assetInput('media/uploads/collection-1.png'));
    const second = assets.create(assetInput('media/uploads/collection-2.png'));
    const collections = new CollectionRepository(database.orm);
    const collection = collections.create('Editorial');

    expect(collections.addAssets(collection.id, [first.id, second.id])).toBe(2);
    expect(collections.addAssets(collection.id, [first.id, second.id])).toBe(0);
    expect(collections.listAssetIds(collection.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(assets.collectionIdsForAsset(first.id)).toEqual([collection.id]);
    expect(assets.page({ collectionId: collection.id }).items.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    const other = collections.create('Atomic');
    const events = new ChangeEventRepository(database.orm);
    const eventCountBeforeInvalid = events.replay(0).length;
    expect(() => collections.addAssets(other.id, [first.id, 'missing'])).toThrow(
      CollectionRepositoryError,
    );
    expect(collections.listAssetIds(other.id)).toEqual([]);
    expect(events.replay(0)).toHaveLength(eventCountBeforeInvalid);

    assets.softDelete(first.id);
    expect(collections.listAssetIds(collection.id)).toEqual([second.id]);
    expect(collections.get(collection.id)?.itemCount).toBe(1);
    expect(assets.listForMaintenance().map((asset) => asset.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
  });

  it('finalizes output assets, slots, job state, and outbox in one transaction', async () => {
    const database = await createTestDatabase();
    const jobs = new JobRepository(database.orm);
    const assets = new AssetRepository(database.orm);
    const events = new ChangeEventRepository(database.orm);
    const job = jobs.create(createMockGenerationRequest({ count: 2 }));
    const claimed = jobs.claimQueued(job.id);
    const processing = jobs.compareAndSetStatus(
      job.id,
      claimed?.revision ?? -1,
      ['submitting'],
      'processing',
      'processing',
    );
    if (!processing) throw new Error('Expected a processing job fixture.');
    const beforeEventId = events.latestId();

    const finalized = jobs.finalizeOutputs(job.id, processing.revision, [
      {
        type: 'image',
        mimeType: 'image/png',
        filePath: 'media/originals/final-0.png',
        thumbnailPath: 'media/thumbnails/final-0.webp',
        posterPath: null,
        width: 512,
        height: 768,
        durationMs: null,
        fileSize: 100,
        sha256: 'final-sha-0',
        resultId: 'result-0',
        filename: 'first.png',
        metadata: { width: 512 },
      },
      {
        type: 'image',
        mimeType: 'image/png',
        filePath: 'media/originals/final-1.png',
        fileSize: 200,
        sha256: 'final-sha-1',
      },
    ]);

    expect(finalized?.job).toMatchObject({
      status: 'completed',
      progress: 100,
      revision: processing.revision + 1,
    });
    expect(finalized?.assets).toHaveLength(2);
    expect(finalized?.assets[0]).toMatchObject({
      thumbnailPath: 'media/thumbnails/final-0.webp',
      posterPath: null,
      width: 512,
      height: 768,
      durationMs: null,
    });
    expect(finalized?.job.resultManifest).toEqual([
      { slot: 0, assetId: finalized?.assets[0]?.id },
      { slot: 1, assetId: finalized?.assets[1]?.id },
    ]);
    expect(jobs.listOutputs(job.id).every((output) => output.assetId !== null)).toBe(true);
    expect(events.latestForAggregate('job', job.id, beforeEventId)?.id).toBe(finalized?.event.id);
    expect(events.listAfter(beforeEventId, 10).map((event) => event.type)).toEqual([
      'asset.created',
      'asset.created',
      'job.updated',
    ]);
    expect(jobs.listRecoverable().map((candidate) => candidate.id)).not.toContain(job.id);

    const conflictPath = 'media/originals/conflict.png';
    assets.create(assetInput(conflictPath));
    const conflictJob = jobs.create(createMockGenerationRequest());
    const conflictClaim = jobs.claimQueued(conflictJob.id);
    const conflictProcessing = jobs.compareAndSetStatus(
      conflictJob.id,
      conflictClaim?.revision ?? -1,
      ['submitting'],
      'processing',
      'processing',
    );
    if (!conflictProcessing) throw new Error('Expected a conflict processing fixture.');
    const beforeConflictEventId = events.latestId();
    const beforeConflictAssetCount = assets.listForMaintenance().length;
    expect(() =>
      jobs.finalizeOutputs(conflictJob.id, conflictProcessing.revision, [
        {
          type: 'image',
          mimeType: 'image/png',
          filePath: conflictPath,
          fileSize: 999,
          sha256: 'different-sha',
        },
      ]),
    ).toThrow(JobRepositoryError);
    expect(jobs.get(conflictJob.id)?.status).toBe('processing');
    expect(assets.listForMaintenance()).toHaveLength(beforeConflictAssetCount);
    expect(events.latestId()).toBe(beforeConflictEventId);
    expect(jobs.listRecoverable().map((candidate) => candidate.id)).toContain(conflictJob.id);

    const incomplete = jobs.create(createMockGenerationRequest());
    const incompleteClaim = jobs.claimQueued(incomplete.id);
    const incompleteProcessing = jobs.compareAndSetStatus(
      incomplete.id,
      incompleteClaim?.revision ?? -1,
      ['submitting'],
      'processing',
      'processing',
    );
    const incompleteCompleted = jobs.compareAndSetStatus(
      incomplete.id,
      incompleteProcessing?.revision ?? -1,
      ['processing'],
      'completed',
      'completed',
      { completedAt: new Date(), progress: 100 },
    );
    expect(incompleteCompleted?.status).toBe('completed');
    expect(jobs.listRecoverable().map((candidate) => candidate.id)).toContain(incomplete.id);
  });

  it('links image.edit outputs to the durable source Asset parent', async () => {
    const database = await createTestDatabase();
    const assets = new AssetRepository(database.orm);
    const jobs = new JobRepository(database.orm);
    const source = assets.create(assetInput('media/uploads/edit-source.png'));
    const job = jobs.create(createMockGenerationRequest({
      operation: 'image.edit',
      inputs: [{ assetId: source.id, role: 'source' }],
    }));
    const claimed = jobs.claimQueued(job.id, job.revision);
    const processing = jobs.compareAndSetStatus(
      job.id,
      claimed?.revision ?? -1,
      ['submitting'],
      'processing',
      'processing',
    );
    if (!processing) throw new Error('Expected an image edit processing fixture.');

    const finalized = jobs.finalizeOutputs(job.id, processing.revision, [
      {
        type: 'image',
        mimeType: 'image/png',
        filePath: 'media/originals/edit-result.png',
        fileSize: 100,
        sha256: 'edit-result-sha',
      },
    ]);

    expect(finalized?.assets[0]).toMatchObject({
      jobId: job.id,
      parentAssetId: source.id,
      role: 'output',
    });
  });
});
