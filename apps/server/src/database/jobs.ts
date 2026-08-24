import { randomUUID } from 'node:crypto';

import {
  GenerationRequestSchema,
  type GenerationRequest,
  type JobStatus,
} from '@imagine/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { assets, jobs } from './schema.js';

export interface JobRecord {
  id: string;
  request: GenerationRequest;
  status: JobStatus;
  stage: string;
  progress: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

function mapJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    request: GenerationRequestSchema.parse(JSON.parse(row.requestJson)),
    status: row.status as JobStatus,
    stage: row.stage,
    progress: row.progress,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export class JobRepository {
  public constructor(private readonly database: AppDatabase) {}

  public create(request: GenerationRequest): JobRecord {
    const now = new Date();
    const id = randomUUID();
    const row: typeof jobs.$inferInsert = {
      id,
      operation: request.operation,
      providerId: request.providerId,
      modelId: request.modelId,
      prompt: request.prompt,
      requestJson: JSON.stringify(request),
      status: 'queued',
      stage: 'queued',
      idempotencyKey: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };

    this.database.insert(jobs).values(row).run();
    return mapJob({
      ...row,
      providerRequestRedactedJson: '{}',
      progress: null,
      remoteJobId: null,
      errorCode: null,
      errorMessage: null,
      retryCount: 0,
      pollAfterAt: null,
      completedAt: null,
    });
  }

  public get(id: string): JobRecord | null {
    const row = this.database.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? mapJob(row) : null;
  }

  public list(): JobRecord[] {
    return this.database.select().from(jobs).orderBy(desc(jobs.createdAt)).all().map(mapJob);
  }

  public listQueued(): JobRecord[] {
    return this.database
      .select()
      .from(jobs)
      .where(eq(jobs.status, 'queued'))
      .orderBy(jobs.createdAt)
      .all()
      .map(mapJob);
  }

  public requeueRecoverableMockJobs(): number {
    const recovered = this.database
      .update(jobs)
      .set({
        status: 'queued',
        stage: 'recovered_after_restart',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.providerId, 'mock'),
          inArray(jobs.status, ['submitting', 'processing']),
          isNull(jobs.remoteJobId),
        ),
      )
      .run();

    return recovered.changes;
  }

  public claimQueued(id: string): JobRecord | null {
    return this.database.transaction((transaction) => {
      const claimed = transaction
        .update(jobs)
        .set({
          status: 'submitting',
          stage: 'submitting',
          updatedAt: new Date(),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
        .run();

      if (claimed.changes !== 1) {
        return null;
      }

      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  public updateStatus(
    id: string,
    status: JobStatus,
    stage: string,
    fields: {
      progress?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      completedAt?: Date | null;
    } = {},
  ): void {
    this.database
      .update(jobs)
      .set({
        status,
        stage,
        updatedAt: new Date(),
        ...fields,
      })
      .where(eq(jobs.id, id))
      .run();
  }
}

export class AssetRepository {
  public constructor(private readonly database: AppDatabase) {}

  public createIfMissing(input: Omit<typeof assets.$inferInsert, 'id' | 'createdAt'>): string {
    const existing = this.database
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.jobId, input.jobId), eq(assets.filePath, input.filePath)))
      .get();
    if (existing) {
      return existing.id;
    }

    const id = randomUUID();
    this.database
      .insert(assets)
      .values({
        ...input,
        id,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .run();

    return (
      this.database
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.jobId, input.jobId), eq(assets.filePath, input.filePath)))
        .get()?.id ?? id
    );
  }

  public countForJob(jobId: string): number {
    return this.database.select().from(assets).where(eq(assets.jobId, jobId)).all().length;
  }
}
