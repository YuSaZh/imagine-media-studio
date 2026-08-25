import type { SubmittedAsset } from '@imagine/provider-contract';
import type { JobStatus } from '@imagine/shared';
import { createMockGenerationRequest } from '@imagine/testkit';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { ChangeEventRecord, ChangeEventRepository } from '../database/events.js';
import type {
  FinalizeOutputsResult,
  JobOutputRecord,
  JobRecord,
  JobRepository,
  UpdateJobStatusFields,
} from '../database/jobs.js';
import type { AssetMediaRecord } from '../media/types.js';
import type { JobTransitionInput, MaterializedAsset, RunnerEvent } from './ports.js';
import {
  AssetMediaMaterializer,
  SqliteRunnerAssetPort,
  SqliteRunnerEventPort,
  SqliteRunnerJobPort,
  createSqliteRunnerOptions,
  toRunnerJob,
  type AssetMediaServicePort,
  type SqliteChangeEventRepositoryPort,
  type SqliteJobRepositoryPort,
} from './sqlite-adapters.js';

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date('2026-08-25T00:00:00.000Z');
  return {
    id: overrides.id ?? 'job-1',
    request: overrides.request ?? createMockGenerationRequest(),
    providerRequestRedacted: overrides.providerRequestRedacted ?? {},
    status: overrides.status ?? 'queued',
    stage: overrides.stage ?? overrides.status ?? 'queued',
    progress: overrides.progress ?? null,
    remoteJobId: overrides.remoteJobId ?? null,
    idempotencyKey: overrides.idempotencyKey ?? 'idempotency-1',
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    retryCount: overrides.retryCount ?? 0,
    submitAttempt: overrides.submitAttempt ?? 0,
    pollAfterAt: overrides.pollAfterAt ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? null,
    revision: overrides.revision ?? 0,
    resultManifest: overrides.resultManifest ?? [],
    retryOfJobId: overrides.retryOfJobId ?? null,
    rootJobId: overrides.rootJobId ?? 'job-1',
    cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    requestSha256: overrides.requestSha256 ?? 'hash',
    deletedAt: overrides.deletedAt ?? null,
  };
}

function changeEvent(job: JobRecord): ChangeEventRecord {
  return {
    id: job.revision + 10,
    aggregateType: 'job',
    aggregateId: job.id,
    eventType: 'job.updated',
    payload: { id: job.id, status: job.status, revision: job.revision },
    createdAt: new Date('2026-08-25T00:00:01.000Z'),
  };
}

class FakeSqliteRepository implements SqliteJobRepositoryPort {
  public current: JobRecord;
  public event: ChangeEventRecord;
  public readonly calls: string[] = [];
  public outputs: readonly JobOutputRecord[] = [];
  public transitionFields: UpdateJobStatusFields | undefined;
  public finalizedAssets: readonly MaterializedAsset[] = [];

  public constructor(record = jobRecord()) {
    this.current = record;
    this.event = changeEvent(record);
  }

  public get(jobId: string): JobRecord | null {
    return jobId === this.current.id ? this.current : null;
  }

  public listRecoverable(): readonly JobRecord[] {
    this.calls.push('listRecoverable');
    return [this.current];
  }

  public claimQueued(jobId: string, expectedRevision: number): JobRecord | null {
    this.calls.push(`claim:${jobId}:${expectedRevision}`);
    if (this.current.status !== 'queued' || this.current.revision !== expectedRevision) return null;
    const submitAttempt = this.current.submitAttempt + 1;
    const claimed = this.update('submitting', 'submitting');
    this.current = { ...claimed, submitAttempt };
    return this.current;
  }

  public compareAndSetStatus(
    jobId: string,
    expectedRevision: number,
    expectedStatuses: readonly JobStatus[],
    status: JobStatus,
    stage: string,
    fields: UpdateJobStatusFields = {},
  ): JobRecord | null {
    this.calls.push(`cas:${status}:${expectedRevision}`);
    if (
      jobId !== this.current.id ||
      this.current.revision !== expectedRevision ||
      !expectedStatuses.includes(this.current.status)
    ) {
      return null;
    }
    this.transitionFields = fields;
    return this.update(status, stage, fields);
  }

  public requestCancel(jobId: string, expectedRevision: number): JobRecord | null {
    this.calls.push(`requestCancel:${expectedRevision}`);
    if (jobId !== this.current.id || expectedRevision !== this.current.revision) return null;
    return this.update(this.current.status, 'cancel_requested');
  }

  public listOutputs(_jobId: string): readonly JobOutputRecord[] {
    return this.outputs;
  }

  public finalizeOutputs(
    jobId: string,
    expectedRevision: number,
    assets: readonly MaterializedAsset[],
  ): FinalizeOutputsResult | null {
    this.calls.push(`finalize:${expectedRevision}`);
    if (jobId !== this.current.id || expectedRevision !== this.current.revision) return null;
    this.finalizedAssets = assets;
    const job = this.update('completed', 'completed', { progress: 100 });
    return {
      job,
      assets: assets.map((asset, index) =>
        ({
          ...assetRecord({
            id: `asset-${index}`,
            jobId,
            type: asset.type,
            mimeType: asset.mimeType,
            filePath: asset.filePath,
            fileSize: asset.fileSize,
            sha256: asset.sha256,
            originalFilename: asset.filename ?? null,
            metadata: asset.metadata ?? {},
          }),
          favorite: false,
        }),
      ),
      event: this.event,
    };
  }

  private update(
    status: JobStatus,
    stage: string,
    fields: UpdateJobStatusFields = {},
  ): JobRecord {
    this.current = {
      ...this.current,
      status,
      stage,
      revision: this.current.revision + 1,
      progress: 'progress' in fields ? (fields.progress ?? null) : this.current.progress,
      remoteJobId:
        'remoteJobId' in fields ? (fields.remoteJobId ?? null) : this.current.remoteJobId,
      pollAfterAt:
        'pollAfterAt' in fields ? (fields.pollAfterAt ?? null) : this.current.pollAfterAt,
      errorCode: 'errorCode' in fields ? (fields.errorCode ?? null) : this.current.errorCode,
      errorMessage:
        'errorMessage' in fields ? (fields.errorMessage ?? null) : this.current.errorMessage,
      resultManifest: fields.resultManifest ?? this.current.resultManifest,
    };
    this.event = changeEvent(this.current);
    return this.current;
  }
}

class FakeEventRepository implements SqliteChangeEventRepositoryPort {
  public constructor(private readonly jobs: FakeSqliteRepository) {}

  public latestForAggregate(_aggregateType: string, _aggregateId: string): ChangeEventRecord {
    return this.jobs.event;
  }
}

function materializedAsset(): MaterializedAsset {
  return {
    type: 'image',
    mimeType: 'image/png',
    filePath: 'media/originals/result.png',
    fileSize: 8,
    sha256: 'abc123',
    metadata: { assetId: 'asset-1' },
  };
}

function submittedAssets(): readonly SubmittedAsset[] {
  return [
    {
      type: 'image',
      mimeType: 'image/png',
      source: 'base64',
      base64: 'aW1hZ2U=',
      resultId: 'provider-result-1',
    },
  ];
}

describe('SqliteRunnerJobPort', () => {
  it('maps durable manifests and errors into complete runner jobs', () => {
    const submitted = submittedAssets();
    const record = jobRecord({
      status: 'downloading',
      revision: 4,
      retryCount: 2,
      submitAttempt: 4,
      remoteJobId: 'remote-1',
      errorCode: 'retrying',
      errorMessage: 'Retry later',
      resultManifest: [{ version: 1, resultAssets: submitted }],
    });

    expect(toRunnerJob(record)).toMatchObject({
      id: 'job-1',
      status: 'downloading',
      revision: 4,
      attempt: 4,
      remoteJobId: 'remote-1',
      resultAssets: submitted,
      error: { code: 'retrying', kind: 'unknown', retryable: false },
    });
  });

  it('claims with the observed revision and returns the committed outbox event', async () => {
    const repository = new FakeSqliteRepository();
    const port = new SqliteRunnerJobPort(repository, new FakeEventRepository(repository));

    const committed = await port.claimQueued('job-1', 0);

    expect(repository.calls).toEqual(['claim:job-1:0']);
    expect(committed).toMatchObject({
      job: { status: 'submitting', revision: 1, attempt: 1 },
      event: { id: 11, aggregateId: 'job-1', revision: 1 },
    });
  });

  it('stores a versioned provider result manifest through CAS', async () => {
    const repository = new FakeSqliteRepository(jobRecord({ status: 'submitting', revision: 1 }));
    const port = new SqliteRunnerJobPort(repository, new FakeEventRepository(repository));
    const input: JobTransitionInput = {
      expectedStatuses: ['submitting'],
      expectedRevision: 1,
      status: 'downloading',
      stage: 'materializing_results',
      resultAssets: submittedAssets(),
    };

    const committed = await port.transition('job-1', input);

    expect(repository.calls).toEqual(['cas:downloading:1']);
    expect(repository.transitionFields?.resultManifest).toEqual([
      { version: 1, resultAssets: submittedAssets() },
    ]);
    expect(committed?.job.resultAssets).toEqual(submittedAssets());
  });

  it('durably requests cancellation before committing the terminal status', async () => {
    const repository = new FakeSqliteRepository(jobRecord({ status: 'remote_running', revision: 3 }));
    const port = new SqliteRunnerJobPort(repository, new FakeEventRepository(repository));

    const committed = await port.transition('job-1', {
      expectedStatuses: ['remote_running'],
      expectedRevision: 3,
      status: 'cancelled',
      stage: 'cancelled',
    });

    expect(repository.calls).toEqual(['requestCancel:3', 'cas:cancelled:4']);
    expect(committed?.job).toMatchObject({ status: 'cancelled', revision: 5 });
  });
});

describe('SqliteRunnerAssetPort', () => {
  it('checks output links and delegates atomic finalization', async () => {
    const repository = new FakeSqliteRepository(jobRecord({ status: 'processing', revision: 2 }));
    const events = new FakeEventRepository(repository);
    const port = new SqliteRunnerAssetPort(repository, events);
    repository.outputs = [
      {
        jobId: 'job-1',
        slot: 0,
        assetId: 'asset-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    expect(await port.outputsConsistent('job-1')).toBe(true);
    const committed = await port.finalize('job-1', 2, [materializedAsset()]);

    expect(repository.calls).toContain('finalize:2');
    expect(repository.finalizedAssets).toEqual([materializedAsset()]);
    expect(committed?.job.status).toBe('completed');

    repository.outputs = [{ ...repository.outputs[0]!, assetId: null }];
    expect(await port.outputsConsistent('job-1')).toBe(false);
  });
});

function assetRecord(overrides: Partial<AssetMediaRecord> = {}): AssetMediaRecord {
  return {
    id: overrides.id ?? 'asset-1',
    jobId: overrides.jobId ?? 'job-1',
    parentAssetId: overrides.parentAssetId ?? null,
    type: overrides.type ?? 'image',
    role: overrides.role ?? 'output',
    filePath: overrides.filePath ?? 'media/originals/asset-1.png',
    thumbnailPath: overrides.thumbnailPath ?? 'media/thumbnails/asset-1.webp',
    posterPath: overrides.posterPath ?? null,
    originalFilename: overrides.originalFilename ?? 'result.png',
    mimeType: overrides.mimeType ?? 'image/png',
    width: overrides.width ?? 1024,
    height: overrides.height ?? 1024,
    durationMs: overrides.durationMs ?? null,
    fileSize: overrides.fileSize ?? 8,
    sha256: overrides.sha256 ?? 'abc123',
    metadata: overrides.metadata ?? { format: 'png' },
    createdAt: overrides.createdAt ?? new Date(),
    deletedAt: overrides.deletedAt ?? null,
  };
}

describe('AssetMediaMaterializer', () => {
  it('routes base64 and URL assets through AssetMediaService and maps their records', async () => {
    const base64Inputs: unknown[] = [];
    const urlInputs: unknown[] = [];
    const media: AssetMediaServicePort = {
      materializeBase64: vi.fn(async (input) => {
        base64Inputs.push(input);
        return assetRecord({ id: 'asset-base64', filePath: 'base64.png' });
      }),
      materializeUrl: vi.fn(async (input) => {
        urlInputs.push(input);
        return assetRecord({ id: 'asset-url', filePath: 'url.png' });
      }),
    };
    const materializer = new AssetMediaMaterializer(media);
    const controller = new AbortController();
    const submitted: readonly SubmittedAsset[] = [
      ...submittedAssets(),
      {
        type: 'image',
        mimeType: 'image/png',
        source: 'url',
        url: 'https://provider.invalid/result.png',
      },
    ];

    const result = await materializer.materialize(
      toRunnerJob(jobRecord()),
      submitted,
      controller.signal,
    );

    expect(base64Inputs[0]).toMatchObject({
      jobId: 'job-1',
      claimedMimeType: 'image/png',
      expectedKind: 'image',
      role: 'output',
      signal: controller.signal,
    });
    expect(urlInputs[0]).toMatchObject({ url: 'https://provider.invalid/result.png' });
    expect(result).toEqual([
      expect.objectContaining({
        filePath: 'base64.png',
        resultId: 'provider-result-1',
        metadata: expect.objectContaining({ assetId: 'asset-base64' }),
      }),
      expect.objectContaining({
        filePath: 'url.png',
        metadata: expect.objectContaining({ assetId: 'asset-url' }),
      }),
    ]);
    await expect(
      materializer.process(toRunnerJob(jobRecord()), result, controller.signal),
    ).resolves.toBe(result);
  });
});

describe('SqliteRunnerEventPort', () => {
  it('stays structurally compatible with the concrete SQLite repositories', () => {
    expectTypeOf<JobRepository>().toExtend<SqliteJobRepositoryPort>();
    expectTypeOf<ChangeEventRepository>().toExtend<SqliteChangeEventRepositoryPort>();
  });

  it('publishes the existing durable event without appending a second event', () => {
    const published: unknown[] = [];
    const port = new SqliteRunnerEventPort({
      publish: (event) => {
        published.push(event);
      },
    });
    const event: RunnerEvent = {
      id: 42,
      aggregateType: 'job',
      aggregateId: 'job-1',
      eventType: 'job.updated',
      revision: 7,
      payload: { occurredAt: '2026-08-25T00:00:01.000Z' },
    };

    port.publish(event);

    expect(published).toEqual([
      {
        version: 1,
        id: 42,
        type: 'job.updated',
        entityId: 'job-1',
        revision: 7,
        occurredAt: '2026-08-25T00:00:01.000Z',
      },
    ]);
  });

  it('passes the provider registry through the integration factory', () => {
    const repository = new FakeSqliteRepository();
    const providers = {
      resolve: vi.fn(() => {
        throw new Error('not invoked by construction');
      }),
    };
    const media: AssetMediaServicePort = {
      materializeBase64: vi.fn(),
      materializeUrl: vi.fn(),
    };

    const options = createSqliteRunnerOptions({
      jobs: repository,
      changeEvents: new FakeEventRepository(repository),
      broker: { publish: vi.fn() },
      providers,
      media,
    });

    expect(options.providers).toBe(providers);
    expect(options.jobs).toBeInstanceOf(SqliteRunnerJobPort);
    expect(options.assets).toBeInstanceOf(SqliteRunnerAssetPort);
    expect(options.media).toBeInstanceOf(AssetMediaMaterializer);
  });
});
