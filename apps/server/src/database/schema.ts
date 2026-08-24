import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    operation: text('operation').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    prompt: text('prompt').notNull(),
    requestJson: text('request_json').notNull(),
    providerRequestRedactedJson: text('provider_request_redacted_json')
      .notNull()
      .default('{}'),
    status: text('status').notNull(),
    stage: text('stage').notNull(),
    progress: integer('progress'),
    remoteJobId: text('remote_job_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    pollAfterAt: integer('poll_after_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('jobs_status_idx').on(table.status),
    index('jobs_created_at_idx').on(table.createdAt),
    uniqueIndex('jobs_idempotency_key_idx').on(table.idempotencyKey),
  ],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    role: text('role').notNull(),
    filePath: text('file_path').notNull(),
    mimeType: text('mime_type').notNull(),
    fileSize: integer('file_size').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('assets_job_id_idx').on(table.jobId),
    uniqueIndex('assets_job_path_idx').on(table.jobId, table.filePath),
  ],
);
