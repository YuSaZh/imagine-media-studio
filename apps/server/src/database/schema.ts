import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    baseUrl: text('base_url'),
    encryptedApiKey: text('encrypted_api_key'),
    headersEncryptedJson: text('headers_encrypted_json'),
    configJson: text('config_json').notNull().default('{}'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('providers_name_idx').on(table.name),
    index('providers_type_idx').on(table.type),
    index('providers_updated_at_idx').on(table.updatedAt, table.id),
    uniqueIndex('providers_single_default_idx').on(table.isDefault).where(sql`${table.isDefault} = 1`),
  ],
);

export const providerAdapterDefinitions = sqliteTable(
  'provider_adapter_definitions',
  {
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    adapterId: text('adapter_id').notNull(),
    version: text('version').notNull(),
    digest: text('digest').notNull(),
    definitionJson: text('definition_json'),
    isCurrent: integer('is_current', { mode: 'boolean' }).notNull().default(false),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.kind, table.adapterId, table.version, table.digest] }),
    uniqueIndex('provider_adapter_definitions_current_idx')
      .on(table.providerId)
      .where(sql`${table.isCurrent} = 1`),
    index('provider_adapter_definitions_provider_idx').on(table.providerId),
  ],
);

export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    capabilitiesJson: text('capabilities_json').notNull().default('{}'),
    capabilitySource: text('capability_source').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('models_provider_model_idx').on(table.providerId, table.modelId),
    index('models_updated_at_idx').on(table.updatedAt, table.id),
    index('models_enabled_idx').on(table.enabled, table.providerId),
  ],
);

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
    /** Local maximum polling deadline, independent from provider result expiry. */
    remoteDeadlineAt: integer('remote_deadline_at', { mode: 'timestamp_ms' }),
    /** Provider-declared downloadable result expiry. */
    resultExpiresAt: integer('result_expires_at', { mode: 'timestamp_ms' }),
    idempotencyKey: text('idempotency_key').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    submitAttempt: integer('submit_attempt').notNull().default(0),
    stageRetryCountsJson: text('stage_retry_counts_json').notNull().default('{}'),
    pollAfterAt: integer('poll_after_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    revision: integer('revision').notNull().default(0),
    resultManifestJson: text('result_manifest_json').notNull().default('[]'),
    retryOfJobId: text('retry_of_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    rootJobId: text('root_job_id').references((): AnySQLiteColumn => jobs.id, {
      onDelete: 'set null',
    }),
    cancelRequestedAt: integer('cancel_requested_at', { mode: 'timestamp_ms' }),
    requestSha256: text('request_sha256').notNull().default(''),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    adapterKind: text('adapter_kind'),
    adapterId: text('adapter_id'),
    adapterVersion: text('adapter_version'),
    adapterDigest: text('adapter_digest'),
  },
  (table) => [
    index('jobs_status_idx').on(table.status),
    index('jobs_created_at_idx').on(table.createdAt),
    uniqueIndex('jobs_idempotency_key_idx').on(table.idempotencyKey),
    index('jobs_page_idx').on(table.deletedAt, table.createdAt, table.id),
    index('jobs_provider_model_idx').on(table.providerId, table.modelId),
    index('jobs_retry_of_idx').on(table.retryOfJobId),
    index('jobs_root_idx').on(table.rootJobId),
  ],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    parentAssetId: text('parent_asset_id').references((): AnySQLiteColumn => assets.id, {
      onDelete: 'set null',
    }),
    type: text('type').notNull(),
    role: text('role').notNull(),
    filePath: text('file_path').notNull(),
    thumbnailPath: text('thumbnail_path'),
    posterPath: text('poster_path'),
    originalFilename: text('original_filename'),
    mimeType: text('mime_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    fileSize: integer('file_size').notNull(),
    sha256: text('sha256').notNull(),
    metadataJson: text('metadata_json').notNull().default('{}'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('assets_job_id_idx').on(table.jobId),
    index('assets_parent_asset_id_idx').on(table.parentAssetId),
    uniqueIndex('assets_file_path_idx').on(table.filePath),
    index('assets_gallery_page_idx').on(table.deletedAt, table.createdAt, table.id),
    index('assets_favorite_idx').on(table.favorite, table.createdAt, table.id),
    index('assets_sha256_idx').on(table.sha256),
  ],
);

export const jobInputs = sqliteTable(
  'job_inputs',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.role, table.sortOrder] }),
    uniqueIndex('job_inputs_job_asset_role_idx').on(table.jobId, table.assetId, table.role),
    index('job_inputs_asset_id_idx').on(table.assetId),
  ],
);

export const jobOutputs = sqliteTable(
  'job_outputs',
  {
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    slot: integer('slot').notNull(),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.slot] }),
    uniqueIndex('job_outputs_asset_id_idx').on(table.assetId),
  ],
);

export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('collections_name_idx').on(table.name),
    index('collections_updated_at_idx').on(table.updatedAt, table.id),
  ],
);

export const collectionAssets = sqliteTable(
  'collection_assets',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.assetId] }),
    index('collection_assets_asset_id_idx').on(table.assetId),
  ],
);

export const changeEvents = sqliteTable(
  'change_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payloadJson: text('payload_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('change_events_aggregate_idx').on(table.aggregateType, table.aggregateId, table.id),
    index('change_events_created_at_idx').on(table.createdAt, table.id),
  ],
);
