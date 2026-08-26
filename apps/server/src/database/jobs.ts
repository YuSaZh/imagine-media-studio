import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import {
  MAX_GENERATION_COUNT,
  GenerationRequestSchema,
  type GenerationRequest,
  type JobStatus,
} from '@imagine/shared';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { mapAssetRow, type AssetRecord } from './assets.js';
import {
  mapChangeEventRow,
  toChangeEventValues,
  type ChangeEventRecord,
} from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { assets, changeEvents, jobInputs, jobOutputs, jobs } from './schema.js';
import { parseStageRetryCounts, type StageRetryCounts } from '../jobs/retry-budget.js';
import {
  MAX_SUBMITTED_MANIFEST_BYTES,
  SubmittedAssetValidationError,
  assertDurableResultManifest,
} from '../jobs/submitted-asset-validator.js';

export { AssetRepository } from './assets.js';

const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
];

const ACTIVE_STATUSES: readonly JobStatus[] = [
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
];
const MAX_PERSISTED_REQUEST_BYTES = 1 * 1024 * 1024;

const COMPATIBLE_PREVIOUS_STATUSES: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['queued', 'submitting'],
  submitting: ['queued', 'submitting'],
  remote_pending: ['submitting', 'remote_pending', 'remote_running'],
  remote_running: ['remote_pending', 'remote_running'],
  downloading: ['submitting', 'remote_pending', 'remote_running', 'downloading'],
  processing: ['submitting', 'downloading', 'processing', 'completed'],
  completed: ['processing', 'completed'],
  failed: ACTIVE_STATUSES,
  cancelled: ACTIVE_STATUSES,
  rejected: ['submitting', 'remote_pending', 'remote_running', 'rejected'],
  expired: ['remote_pending', 'remote_running', 'expired'],
};

export interface JobRecord {
  readonly id: string;
  readonly request: GenerationRequest;
  readonly providerRequestRedacted: Readonly<Record<string, unknown>>;
  readonly status: JobStatus;
  readonly stage: string;
  readonly progress: number | null;
  readonly remoteJobId: string | null;
  readonly remoteDeadlineAt: Date | null;
  readonly resultExpiresAt: Date | null;
  readonly idempotencyKey: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly submitAttempt: number;
  readonly stageRetryCounts: StageRetryCounts;
  readonly pollAfterAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
  readonly revision: number;
  readonly resultManifest: readonly unknown[];
  readonly retryOfJobId: string | null;
  readonly rootJobId: string | null;
  readonly cancelRequestedAt: Date | null;
  readonly requestSha256: string;
  readonly deletedAt: Date | null;
}

export interface CreateJobInput {
  readonly assetId: string;
  readonly role: string;
  readonly sortOrder: number;
}

export interface JobInputRecord extends CreateJobInput {
  readonly jobId: string;
}

export interface JobOutputRecord {
  readonly jobId: string;
  readonly slot: number;
  readonly assetId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface JobPageRequest extends PageRequest {
  readonly status?: JobStatus;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly includeDeleted?: boolean;
}

export interface UpdateJobStatusFields {
  readonly progress?: number | null;
  readonly remoteJobId?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly pollAfterAt?: Date | null;
  readonly remoteDeadlineAt?: Date | null;
  readonly resultExpiresAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly resultManifest?: readonly unknown[];
  readonly stageRetryCounts?: StageRetryCounts;
}

export interface FinalizeOutputInput {
  readonly type: 'image' | 'video';
  readonly mimeType: string;
  readonly filePath: string;
  readonly thumbnailPath?: string | null;
  readonly posterPath?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly fileSize: number;
  readonly sha256: string;
  readonly resultId?: string;
  readonly filename?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FinalizeOutputsResult {
  readonly job: JobRecord;
  readonly assets: readonly AssetRecord[];
  readonly event: ChangeEventRecord;
}

export class JobRepositoryError extends Error {
  public override readonly name = 'JobRepositoryError';

  public constructor(
    public readonly code:
      | 'input_asset_not_found'
      | 'output_asset_conflict'
      | 'output_slot_mismatch'
      | 'source_input_required',
    message: string,
  ) {
    super(message);
  }
}

function parseJsonDocument(value: string, label: string, maxBytes: number): unknown {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds the persistence safety limit.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseJsonObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = parseJsonDocument(value, label, MAX_PERSISTED_REQUEST_BYTES);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseJsonArray(value: string, label: string): readonly unknown[] {
  if (Buffer.byteLength(value, 'utf8') > MAX_SUBMITTED_MANIFEST_BYTES) {
    throw new SubmittedAssetValidationError(`${label} exceeds the persistence safety limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SubmittedAssetValidationError(`${label} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new SubmittedAssetValidationError(`${label} must contain a JSON array.`);
  }
  return parsed;
}

function requestFromJson(value: string, label: string): GenerationRequest {
  return GenerationRequestSchema.parse(parseJsonDocument(value, label, MAX_PERSISTED_REQUEST_BYTES));
}

function mapJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    request: requestFromJson(row.requestJson, `Job ${row.id} request`),
    providerRequestRedacted: parseJsonObject(
      row.providerRequestRedactedJson,
      `Job ${row.id} provider request`,
    ),
    status: row.status as JobStatus,
    stage: row.stage,
    progress: row.progress,
    remoteJobId: row.remoteJobId,
    remoteDeadlineAt: row.remoteDeadlineAt,
    resultExpiresAt: row.resultExpiresAt,
    idempotencyKey: row.idempotencyKey,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    submitAttempt: row.submitAttempt,
    stageRetryCounts: parseStageRetryCounts(JSON.parse(row.stageRetryCountsJson)),
    pollAfterAt: row.pollAfterAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
    revision: row.revision,
    resultManifest: parseJsonArray(row.resultManifestJson, `Job ${row.id} result manifest`),
    retryOfJobId: row.retryOfJobId,
    rootJobId: row.rootJobId,
    cancelRequestedAt: row.cancelRequestedAt,
    requestSha256: row.requestSha256,
    deletedAt: row.deletedAt,
  };
}

function jobCursorCondition(cursor: { timestampMs: number; id: string }): SQL {
  const timestamp = new Date(cursor.timestampMs);
  return or(
    lt(jobs.createdAt, timestamp),
    and(eq(jobs.createdAt, timestamp), lt(jobs.id, cursor.id)),
  )!;
}

function requestHash(requestJson: string): string {
  return createHash('sha256').update(requestJson).digest('hex');
}

type JobUpdateSet = Omit<Partial<typeof jobs.$inferInsert>, 'revision'> & {
  revision?: number | SQL;
};

function statusUpdateValues(
  status: JobStatus,
  stage: string,
  fields: UpdateJobStatusFields,
  now: Date,
  maxAssets = MAX_GENERATION_COUNT,
): JobUpdateSet {
  const changes: JobUpdateSet = {
    status,
    stage,
    updatedAt: now,
    revision: sql<number>`${jobs.revision} + 1`,
  };
  if ('progress' in fields) changes.progress = fields.progress ?? null;
  if ('remoteJobId' in fields) changes.remoteJobId = fields.remoteJobId ?? null;
  if ('errorCode' in fields) changes.errorCode = fields.errorCode ?? null;
  if ('errorMessage' in fields) changes.errorMessage = fields.errorMessage ?? null;
  if ('pollAfterAt' in fields) changes.pollAfterAt = fields.pollAfterAt ?? null;
  if ('remoteDeadlineAt' in fields) changes.remoteDeadlineAt = fields.remoteDeadlineAt ?? null;
  if ('resultExpiresAt' in fields) changes.resultExpiresAt = fields.resultExpiresAt ?? null;
  if ('completedAt' in fields) changes.completedAt = fields.completedAt ?? null;
  if (fields.resultManifest !== undefined) {
    assertDurableResultManifest(fields.resultManifest, maxAssets);
    changes.resultManifestJson = JSON.stringify(fields.resultManifest);
  }
  if (fields.stageRetryCounts !== undefined) {
    changes.stageRetryCountsJson = JSON.stringify(fields.stageRetryCounts);
  }
  return changes;
}

export class JobRepository {
  public constructor(private readonly database: AppDatabase) {}

  public create(request: GenerationRequest): JobRecord {
    return this.createWithInputs(
      request,
      request.inputs.map((input, sortOrder) => ({ ...input, sortOrder })),
    );
  }

  public createWithInputs(
    rawRequest: GenerationRequest,
    inputs: readonly CreateJobInput[],
  ): JobRecord {
    const request = GenerationRequestSchema.parse(rawRequest);
    const id = randomUUID();
    const now = new Date();
    const requestJson = JSON.stringify(request);
    return this.database.transaction((transaction) => {
      const inputIds = [...new Set(inputs.map((input) => input.assetId))];
      if (inputIds.length > 0) {
        const available = transaction
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, inputIds), isNull(assets.deletedAt)))
          .all();
        if (available.length !== inputIds.length) {
          throw new JobRepositoryError(
            'input_asset_not_found',
            'One or more job input assets do not exist.',
          );
        }
      }
      transaction
        .insert(jobs)
        .values({
          id,
          operation: request.operation,
          providerId: request.providerId,
          modelId: request.modelId,
          prompt: request.prompt,
          requestJson,
          providerRequestRedactedJson: '{}',
          status: 'queued',
          stage: 'queued',
          progress: null,
          remoteJobId: null,
          remoteDeadlineAt: null,
          resultExpiresAt: null,
          idempotencyKey: randomUUID(),
          errorCode: null,
          errorMessage: null,
          retryCount: 0,
          submitAttempt: 0,
          stageRetryCountsJson: '{}',
          pollAfterAt: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          revision: 0,
          resultManifestJson: '[]',
          retryOfJobId: null,
          rootJobId: id,
          cancelRequestedAt: null,
          requestSha256: requestHash(requestJson),
          deletedAt: null,
        })
        .run();
      for (const input of inputs) {
        transaction.insert(jobInputs).values({ jobId: id, ...input }).run();
      }
      const outputCount = Math.max(1, request.count ?? 1);
      for (let slot = 0; slot < outputCount; slot += 1) {
        transaction
          .insert(jobOutputs)
          .values({ jobId: id, slot, assetId: null, createdAt: now, updatedAt: now })
          .run();
      }
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.created',
            payload: { id, status: 'queued', revision: 0 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      if (!row) throw new Error('Job creation did not return a row.');
      return mapJob(row);
    });
  }

  public get(id: string, includeDeleted = false): JobRecord | null {
    const condition = includeDeleted
      ? eq(jobs.id, id)
      : and(eq(jobs.id, id), isNull(jobs.deletedAt));
    const row = this.database.select().from(jobs).where(condition).get();
    return row ? mapJob(row) : null;
  }

  public page(request: JobPageRequest = {}): CursorPage<JobRecord> {
    const page = normalizePageRequest(request);
    const conditions: SQL[] = [];
    if (!request.includeDeleted) conditions.push(isNull(jobs.deletedAt));
    if (page.cursor) conditions.push(jobCursorCondition(page.cursor));
    if (request.status !== undefined) conditions.push(eq(jobs.status, request.status));
    if (request.providerId !== undefined) conditions.push(eq(jobs.providerId, request.providerId));
    if (request.modelId !== undefined) conditions.push(eq(jobs.modelId, request.modelId));
    const rows = this.database
      .select()
      .from(jobs)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(page.limit + 1)
      .all()
      .map(mapJob);
    return toCursorPage(rows, page.limit, (job) => ({
      timestampMs: job.createdAt.getTime(),
      id: job.id,
    }));
  }

  public list(): JobRecord[] {
    return this.database
      .select()
      .from(jobs)
      .where(isNull(jobs.deletedAt))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .all()
      .map(mapJob);
  }

  public listQueued(): JobRecord[] {
    return this.database
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), isNull(jobs.deletedAt)))
      .orderBy(jobs.createdAt, jobs.id)
      .all()
      .map(mapJob);
  }

  public listRecoverable(): readonly JobRecord[] {
    const rows = this.database
      .select()
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, [...ACTIVE_STATUSES, 'completed']),
          isNull(jobs.deletedAt),
        ),
      )
      .orderBy(jobs.createdAt, jobs.id)
      .all();
    const candidates: JobRecord[] = [];
    for (const row of rows) {
      try {
        candidates.push(mapJob(row));
      } catch (error) {
        if (!(error instanceof SubmittedAssetValidationError)) throw error;
        this.quarantineInvalidManifest(row.id, row.revision);
      }
    }
    return candidates.filter((job) => {
      if (job.status !== 'completed') return true;
      const outputs = this.listOutputs(job.id);
      return outputs.length === 0 || outputs.some((output) => output.assetId === null);
    });
  }

  /** Isolate a corrupt durable output manifest so other jobs can recover. */
  public quarantineInvalidManifest(id: string, expectedRevision: number): JobRecord | null {
    return this.database.transaction((transaction) => {
      const now = new Date();
      const changed = transaction
        .update(jobs)
        .set({
          status: 'rejected',
          stage: 'rejected',
          progress: null,
          pollAfterAt: null,
          resultManifestJson: '[]',
          remoteDeadlineAt: null,
          resultExpiresAt: null,
          completedAt: null,
          errorCode: 'provider_output_rejected',
          errorMessage: 'The persisted provider output manifest was rejected.',
          stageRetryCountsJson: '{}',
          updatedAt: now,
          revision: expectedRevision + 1,
        })
        .where(and(
          eq(jobs.id, id),
          eq(jobs.revision, expectedRevision),
          inArray(jobs.status, [...ACTIVE_STATUSES, 'completed']),
          isNull(jobs.deletedAt),
        ))
        .run();
      if (changed.changes !== 1) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.updated',
            payload: { id, status: 'rejected', revision: expectedRevision + 1 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  public listInputs(jobId: string): readonly JobInputRecord[] {
    return this.database
      .select()
      .from(jobInputs)
      .where(eq(jobInputs.jobId, jobId))
      .orderBy(jobInputs.role, jobInputs.sortOrder)
      .all();
  }

  public listOutputs(jobId: string): readonly JobOutputRecord[] {
    return this.database
      .select()
      .from(jobOutputs)
      .where(eq(jobOutputs.jobId, jobId))
      .orderBy(jobOutputs.slot)
      .all();
  }

  public requeueRecoverableMockJobs(): number {
    return this.database.transaction((transaction) => {
      const recoverable = transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.providerId, 'mock'),
            inArray(jobs.status, ['submitting', 'processing']),
            isNull(jobs.remoteJobId),
            isNull(jobs.deletedAt),
          ),
        )
        .all();
      if (recoverable.length === 0) return 0;
      const now = new Date();
      transaction
        .update(jobs)
        .set({
          status: 'queued',
          stage: 'recovered_after_restart',
          updatedAt: now,
          revision: sql`${jobs.revision} + 1`,
        })
        .where(inArray(jobs.id, recoverable.map((job) => job.id)))
        .run();
      for (const job of recoverable) {
        transaction
          .insert(changeEvents)
          .values(
            toChangeEventValues({
              aggregateType: 'job',
              aggregateId: job.id,
              eventType: 'job.recovered',
              payload: { id: job.id, status: 'queued' },
              createdAt: now,
            }),
          )
          .run();
      }
      return recoverable.length;
    });
  }

  public claimQueued(id: string, expectedRevision?: number): JobRecord | null {
    return this.database.transaction((transaction) => {
      const current = transaction
        .select({ revision: jobs.revision, submitAttempt: jobs.submitAttempt })
        .from(jobs)
        .where(and(eq(jobs.id, id), eq(jobs.status, 'queued'), isNull(jobs.deletedAt)))
        .get();
      if (!current || (expectedRevision !== undefined && current.revision !== expectedRevision)) {
        return null;
      }
      const now = new Date();
      const claimed = transaction
        .update(jobs)
        .set({
          status: 'submitting',
          stage: 'submitting',
          submitAttempt: current.submitAttempt + 1,
          updatedAt: now,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.status, 'queued'),
            eq(jobs.revision, current.revision),
            isNull(jobs.deletedAt),
          ),
        )
        .run();
      if (claimed.changes !== 1) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.updated',
            payload: {
              id,
              status: 'submitting',
              revision: current.revision + 1,
              submitAttempt: current.submitAttempt + 1,
            },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  public compareAndSetStatus(
    id: string,
    expectedRevision: number,
    expectedStatuses: readonly JobStatus[],
    status: JobStatus,
    stage: string,
    fields: UpdateJobStatusFields = {},
  ): JobRecord | null {
    if (expectedStatuses.length === 0) return null;
    return this.database.transaction((transaction) => {
      const now = new Date();
      const current = transaction
        .select({ requestJson: jobs.requestJson })
        .from(jobs)
        .where(eq(jobs.id, id))
        .get();
      const maxAssets = current === undefined
        ? MAX_GENERATION_COUNT
        : (requestFromJson(current.requestJson, `Job ${id} request`).count ?? 1);
      const conditions: SQL[] = [
        eq(jobs.id, id),
        eq(jobs.revision, expectedRevision),
        inArray(jobs.status, expectedStatuses),
        isNull(jobs.deletedAt),
      ];
      if (!['failed', 'cancelled', 'rejected', 'expired'].includes(status)) {
        conditions.push(isNull(jobs.cancelRequestedAt));
      }
      const changed = transaction
        .update(jobs)
        .set(statusUpdateValues(status, stage, fields, now, maxAssets))
        .where(and(...conditions))
        .run();
      if (changed.changes !== 1) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.updated',
            payload: { id, status, revision: expectedRevision + 1 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  public updateStatus(
    id: string,
    status: JobStatus,
    stage: string,
    fields: UpdateJobStatusFields = {},
  ): void {
    const current = this.get(id);
    if (!current) return;
    const compatible = COMPATIBLE_PREVIOUS_STATUSES[status];
    if (!compatible.includes(current.status)) return;
    this.compareAndSetStatus(id, current.revision, compatible, status, stage, fields);
  }

  public requestCancel(id: string, expectedRevision: number): JobRecord | null {
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.revision, expectedRevision),
            inArray(jobs.status, ACTIVE_STATUSES),
            isNull(jobs.deletedAt),
          ),
        )
        .get();
      if (!current) return null;
      const now = new Date();
      const nextStatus: JobStatus = current.status === 'queued' ? 'cancelled' : (current.status as JobStatus);
      const changed = transaction
        .update(jobs)
        .set({
          cancelRequestedAt: now,
          status: nextStatus,
          stage: nextStatus === 'cancelled' ? 'cancelled' : 'cancel_requested',
          ...(nextStatus === 'cancelled'
            ? {
                stageRetryCountsJson: '{}',
                resultManifestJson: '[]',
                remoteDeadlineAt: null,
                resultExpiresAt: null,
              }
            : {}),
          updatedAt: now,
          revision: expectedRevision + 1,
        })
        .where(and(eq(jobs.id, id), eq(jobs.revision, expectedRevision)))
        .run();
      if (changed.changes !== 1) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.cancel-requested',
            payload: { id, status: nextStatus, revision: expectedRevision + 1 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  /** Atomically settles a cancellation request observed during startup recovery. */
  public recoverCancellation(id: string, expectedRevision: number): JobRecord | null {
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.revision, expectedRevision),
            inArray(jobs.status, ACTIVE_STATUSES),
            isNotNull(jobs.cancelRequestedAt),
            isNull(jobs.deletedAt),
          ),
        )
        .get();
      if (!current) return null;

      const now = new Date();
      const changed = transaction
        .update(jobs)
        .set({
          status: 'cancelled',
          stage: 'cancelled',
          errorCode: null,
          errorMessage: null,
          pollAfterAt: null,
          resultManifestJson: '[]',
          remoteDeadlineAt: null,
          resultExpiresAt: null,
          stageRetryCountsJson: '{}',
          updatedAt: now,
          revision: expectedRevision + 1,
        })
        .where(
          and(
            eq(jobs.id, id),
            eq(jobs.revision, expectedRevision),
            inArray(jobs.status, ACTIVE_STATUSES),
            isNotNull(jobs.cancelRequestedAt),
            isNull(jobs.deletedAt),
          ),
        )
        .run();
      if (changed.changes !== 1) return null;

      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.cancelled-after-restart',
            payload: { id, status: 'cancelled', revision: expectedRevision + 1 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, id)).get();
      return row ? mapJob(row) : null;
    });
  }

  public retry(id: string): JobRecord | null {
    return this.database.transaction((transaction) => {
      const source = transaction
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, id), inArray(jobs.status, TERMINAL_STATUSES), isNull(jobs.deletedAt)))
        .get();
      if (!source) return null;
      const request = requestFromJson(source.requestJson, `Job ${source.id} request`);
      const retryId = randomUUID();
      const now = new Date();
      const inputs = transaction.select().from(jobInputs).where(eq(jobInputs.jobId, source.id)).all();
      const inputIds = [...new Set(inputs.map((input) => input.assetId))];
      if (inputIds.length > 0) {
        const activeInputs = transaction
          .select({ id: assets.id })
          .from(assets)
          .where(and(inArray(assets.id, inputIds), isNull(assets.deletedAt)))
          .all();
        if (activeInputs.length !== inputIds.length) {
          throw new JobRepositoryError(
            'input_asset_not_found',
            'A retry input asset is missing or deleted.',
          );
        }
      }
      transaction
        .insert(jobs)
        .values({
          id: retryId,
          operation: source.operation,
          providerId: source.providerId,
          modelId: source.modelId,
          prompt: source.prompt,
          requestJson: source.requestJson,
          providerRequestRedactedJson: '{}',
          status: 'queued',
          stage: 'queued',
          progress: null,
          remoteJobId: null,
          remoteDeadlineAt: null,
          resultExpiresAt: null,
          idempotencyKey: randomUUID(),
          errorCode: null,
          errorMessage: null,
          retryCount: source.retryCount + 1,
          submitAttempt: 0,
          stageRetryCountsJson: '{}',
          pollAfterAt: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          revision: 0,
          resultManifestJson: '[]',
          retryOfJobId: source.id,
          rootJobId: source.rootJobId ?? source.id,
          cancelRequestedAt: null,
          requestSha256: source.requestSha256 || requestHash(source.requestJson),
          deletedAt: null,
        })
        .run();
      for (const input of inputs) {
        transaction.insert(jobInputs).values({ ...input, jobId: retryId }).run();
      }
      const outputCount = Math.max(1, request.count ?? 1);
      for (let slot = 0; slot < outputCount; slot += 1) {
        transaction
          .insert(jobOutputs)
          .values({ jobId: retryId, slot, assetId: null, createdAt: now, updatedAt: now })
          .run();
      }
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: retryId,
            eventType: 'job.retried',
            payload: { id: retryId, retryOfJobId: source.id, status: 'queued', revision: 0 },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(jobs).where(eq(jobs.id, retryId)).get();
      return row ? mapJob(row) : null;
    });
  }

  public assignOutput(jobId: string, slot: number, assetId: string): JobOutputRecord | null {
    return this.database.transaction((transaction) => {
      const now = new Date();
      const changed = transaction
        .update(jobOutputs)
        .set({ assetId, updatedAt: now })
        .where(and(eq(jobOutputs.jobId, jobId), eq(jobOutputs.slot, slot)))
        .run();
      if (changed.changes !== 1) return null;
      const manifest = transaction
        .select({ slot: jobOutputs.slot, assetId: jobOutputs.assetId })
        .from(jobOutputs)
        .where(eq(jobOutputs.jobId, jobId))
        .orderBy(jobOutputs.slot)
        .all();
      assertDurableResultManifest(manifest);
      transaction
        .update(jobs)
        .set({
          resultManifestJson: JSON.stringify(manifest),
          updatedAt: now,
          revision: sql`${jobs.revision} + 1`,
        })
        .where(eq(jobs.id, jobId))
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: jobId,
            eventType: 'job.output-assigned',
            payload: { id: jobId, slot, assetId },
            createdAt: now,
          }),
        )
        .run();
      return (
        transaction
          .select()
          .from(jobOutputs)
          .where(and(eq(jobOutputs.jobId, jobId), eq(jobOutputs.slot, slot)))
          .get() ?? null
      );
    });
  }

  public finalizeOutputs(
    jobId: string,
    expectedRevision: number,
    materializedAssets: readonly FinalizeOutputInput[],
  ): FinalizeOutputsResult | null {
    if (materializedAssets.length === 0) {
      throw new JobRepositoryError('output_slot_mismatch', 'At least one output is required.');
    }
    return this.database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'processing'),
            eq(jobs.revision, expectedRevision),
            isNull(jobs.cancelRequestedAt),
            isNull(jobs.deletedAt),
          ),
        )
        .get();
      if (!current) return null;

      const request = requestFromJson(current.requestJson, `Job ${current.id} request`);
      const parentAssetId =
        request.operation === 'image.edit'
          ? (request.inputs.find((input) => input.role === 'source')?.assetId ?? null)
          : null;
      if (request.operation === 'image.edit' && parentAssetId === null) {
        throw new JobRepositoryError(
          'source_input_required',
          'An image.edit output requires a source Asset parent.',
        );
      }

      if (materializedAssets.length > MAX_GENERATION_COUNT ||
        materializedAssets.length > (request.count ?? 1)) {
        throw new JobRepositoryError(
          'output_slot_mismatch',
          `Job ${jobId} received more outputs than its request allows.`,
        );
      }

      const now = new Date();
      let slots = transaction
        .select()
        .from(jobOutputs)
        .where(eq(jobOutputs.jobId, jobId))
        .orderBy(jobOutputs.slot)
        .all();
      if (slots.length === 0) {
        for (let slot = 0; slot < materializedAssets.length; slot += 1) {
          transaction
            .insert(jobOutputs)
            .values({ jobId, slot, assetId: null, createdAt: now, updatedAt: now })
            .run();
        }
        slots = transaction
          .select()
          .from(jobOutputs)
          .where(eq(jobOutputs.jobId, jobId))
          .orderBy(jobOutputs.slot)
          .all();
      }
      if (slots.length !== materializedAssets.length) {
        throw new JobRepositoryError(
          'output_slot_mismatch',
          `Job ${jobId} expects ${slots.length} outputs but received ${materializedAssets.length}.`,
        );
      }

      const assetIds: string[] = [];
      for (const [index, input] of materializedAssets.entries()) {
        const existing = transaction
          .select()
          .from(assets)
          .where(eq(assets.filePath, input.filePath))
          .get();
        let assetId: string;
        if (existing) {
          if (
            existing.jobId !== jobId ||
            existing.parentAssetId !== parentAssetId ||
            existing.deletedAt !== null ||
            existing.type !== input.type ||
            existing.mimeType !== input.mimeType ||
            existing.fileSize !== input.fileSize ||
            existing.sha256 !== input.sha256
          ) {
            throw new JobRepositoryError(
              'output_asset_conflict',
              `Output path ${input.filePath} conflicts with an existing asset.`,
            );
          }
          assetId = existing.id;
        } else {
          assetId = randomUUID();
          const metadata = {
            ...(input.metadata ?? {}),
            ...(input.resultId === undefined ? {} : { resultId: input.resultId }),
          };
          transaction
            .insert(assets)
            .values({
              id: assetId,
              jobId,
              parentAssetId,
              type: input.type,
              role: 'output',
              filePath: input.filePath,
              thumbnailPath: input.thumbnailPath ?? null,
              posterPath: input.posterPath ?? null,
              originalFilename: input.filename ?? null,
              mimeType: input.mimeType,
              width: input.width ?? null,
              height: input.height ?? null,
              durationMs: input.durationMs ?? null,
              fileSize: input.fileSize,
              sha256: input.sha256,
              metadataJson: JSON.stringify(metadata),
              favorite: false,
              createdAt: now,
              deletedAt: null,
            })
            .run();
          transaction
            .insert(changeEvents)
            .values(
              toChangeEventValues({
                aggregateType: 'asset',
                aggregateId: assetId,
                eventType: 'asset.created',
                payload: { id: assetId, jobId, parentAssetId, type: input.type, slot: index },
                createdAt: now,
              }),
            )
            .run();
        }

        const bound = transaction
          .update(jobOutputs)
          .set({ assetId, updatedAt: now })
          .where(
            and(
              eq(jobOutputs.jobId, jobId),
              eq(jobOutputs.slot, index),
              or(isNull(jobOutputs.assetId), eq(jobOutputs.assetId, assetId)),
            ),
          )
          .run();
        if (bound.changes !== 1) {
          throw new JobRepositoryError(
            'output_asset_conflict',
            `Output slot ${index} is already bound to another asset.`,
          );
        }
        assetIds.push(assetId);
      }

      const manifest = assetIds.map((assetId, slot) => ({ slot, assetId }));
      assertDurableResultManifest(manifest);
      const completed = transaction
        .update(jobs)
        .set({
          status: 'completed',
          stage: 'completed',
          progress: 100,
          errorCode: null,
          errorMessage: null,
          pollAfterAt: null,
          completedAt: now,
          resultManifestJson: JSON.stringify(manifest),
          stageRetryCountsJson: '{}',
          updatedAt: now,
          revision: expectedRevision + 1,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'processing'),
            eq(jobs.revision, expectedRevision),
            isNull(jobs.cancelRequestedAt),
            isNull(jobs.deletedAt),
          ),
        )
        .run();
      if (completed.changes !== 1) {
        throw new Error(`Job ${jobId} changed while its outputs were finalized.`);
      }
      const eventInsert = transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: jobId,
            eventType: 'job.updated',
            payload: { id: jobId, status: 'completed', revision: expectedRevision + 1 },
            createdAt: now,
          }),
        )
        .run();

      const jobRow = transaction.select().from(jobs).where(eq(jobs.id, jobId)).get();
      const assetRows = transaction.select().from(assets).where(inArray(assets.id, assetIds)).all();
      const assetsById = new Map(assetRows.map((row) => [row.id, mapAssetRow(row)]));
      const eventRow = transaction
        .select()
        .from(changeEvents)
        .where(eq(changeEvents.id, Number(eventInsert.lastInsertRowid)))
        .get();
      if (!jobRow || !eventRow) throw new Error('Finalize output commit could not be reloaded.');
      return {
        job: mapJob(jobRow),
        assets: assetIds.map((assetId) => {
          const asset = assetsById.get(assetId);
          if (!asset) throw new Error(`Finalized asset ${assetId} could not be reloaded.`);
          return asset;
        }),
        event: mapChangeEventRow(eventRow),
      };
    });
  }

  public softDelete(id: string): boolean {
    return this.database.transaction((transaction) => {
      const now = new Date();
      const changed = transaction
        .update(jobs)
        .set({ deletedAt: now, updatedAt: now, revision: sql`${jobs.revision} + 1` })
        .where(and(eq(jobs.id, id), inArray(jobs.status, TERMINAL_STATUSES), isNull(jobs.deletedAt)))
        .run();
      if (changed.changes !== 1) return false;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'job',
            aggregateId: id,
            eventType: 'job.deleted',
            payload: { id },
            createdAt: now,
          }),
        )
        .run();
      return true;
    });
  }
}
