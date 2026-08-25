import { z } from 'zod';

import { GenerationRequestSchema, JobStatusSchema, MediaOperationSchema } from './generation.js';

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

const secretLikeKey = /(?:^|[-_.])(api[-_.]?key|authorization|cookie|password|secret|token)(?:$|[-_.])/i;

function findSecretLikePath(value: JsonValue, path: readonly string[] = []): readonly string[] | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSecretLikePath(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (secretLikeKey.test(key)) return nextPath;
    const found = findSecretLikePath(item, nextPath);
    if (found) return found;
  }
  return null;
}

export const SafeConfigSchema = JsonObjectSchema.superRefine((value, context) => {
  const path = findSecretLikePath(value);
  if (path) {
    context.addIssue({
      code: 'custom',
      message: `Secret-like config key is not allowed: ${path.join('.')}`,
      path: [...path],
    });
  }
});

export const IsoTimestampSchema = z.string().datetime({ offset: true });

export const CursorPageQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const SettingsPatchSchema = z.object({
  values: z.record(
    z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    JsonValueSchema,
  ),
}).strict().superRefine((value, context) => {
  for (const key of Object.keys(value.values)) {
    if (secretLikeKey.test(key)) {
      context.addIssue({
        code: 'custom',
        message: `Secret-like settings key is not allowed: ${key}`,
        path: ['values', key],
      });
    }
  }
});

export const SettingsResponseSchema = z.object({
  settings: JsonObjectSchema,
}).strict();

const HeadersSchema = z.record(z.string().min(1).max(256), z.string().max(8192));

export const ProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string().trim().min(1).max(80),
  baseUrl: z.string().url().max(2048).nullable().optional(),
  apiKey: z.string().min(1).max(16_384).optional(),
  headers: HeadersSchema.optional(),
  config: SafeConfigSchema.default({}),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
}).strict();

export const ProviderPatchSchema = ProviderCreateSchema.partial().extend({
  apiKey: z.string().min(1).max(16_384).nullable().optional(),
  headers: HeadersSchema.nullable().optional(),
}).strict();

export const ProviderDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  baseUrl: z.string().nullable(),
  config: JsonObjectSchema,
  enabled: z.boolean(),
  isDefault: z.boolean(),
  hasApiKey: z.boolean(),
  hasCustomHeaders: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type ProviderDto = z.infer<typeof ProviderDtoSchema>;

export const ProviderPageSchema = z.object({
  items: z.array(ProviderDtoSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const ProviderResponseSchema = z.object({ provider: ProviderDtoSchema }).strict();

export const ProviderTestResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  message: z.string(),
}).strict();

export const ModelDtoSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  capabilities: JsonObjectSchema,
  capabilitySource: z.enum(['provider', 'profile', 'manual', 'mock']),
  enabled: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type ModelDto = z.infer<typeof ModelDtoSchema>;

export const ModelPageSchema = z.object({
  items: z.array(ModelDtoSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const ModelsResponseSchema = z.object({ items: z.array(ModelDtoSchema) }).strict();

export const JobDtoSchema = z.object({
  id: z.string().min(1),
  operation: MediaOperationSchema,
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  prompt: z.string(),
  request: GenerationRequestSchema,
  status: JobStatusSchema,
  stage: z.string(),
  progress: z.number().min(0).max(100).nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  retryOfJobId: z.string().nullable(),
  rootJobId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  outputCount: z.number().int().nonnegative(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
}).strict();

export type JobDto = z.infer<typeof JobDtoSchema>;

export const JobPageSchema = z.object({
  items: z.array(JobDtoSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const JobResponseSchema = z.object({ job: JobDtoSchema }).strict();

export const JobDetailResponseSchema = z.object({
  job: JobDtoSchema,
  inputs: z.array(z.object({
    assetId: z.string().min(1),
    role: z.string().min(1),
    sortOrder: z.number().int().nonnegative(),
  }).strict()),
  assets: z.array(z.lazy(() => AssetDtoSchema)),
}).strict();

export const JobRetryResponseSchema = z.object({
  job: JobDtoSchema,
  sourceJobId: z.string().min(1),
}).strict();

export const AssetTypeSchema = z.enum(['image', 'video']);
export const AssetRoleSchema = z.enum([
  'output',
  'upload',
  'reference',
  'mask',
  'first_frame',
  'last_frame',
]);

export const AssetDtoSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().nullable(),
  parentAssetId: z.string().nullable(),
  type: AssetTypeSchema,
  role: AssetRoleSchema,
  contentUrl: z.string(),
  thumbnailUrl: z.string().nullable(),
  posterUrl: z.string().nullable(),
  originalFilename: z.string().nullable(),
  mimeType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  fileSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: JsonObjectSchema,
  favorite: z.boolean(),
  collectionIds: z.array(z.string().min(1)),
  createdAt: IsoTimestampSchema,
}).strict();

export type AssetDto = z.infer<typeof AssetDtoSchema>;

export const AssetPageSchema = z.object({
  items: z.array(AssetDtoSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const AssetResponseSchema = z.object({ asset: AssetDtoSchema }).strict();

export const AssetPatchSchema = z.object({
  favorite: z.boolean(),
}).strict();

export const CollectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

export const CollectionPatchSchema = CollectionCreateSchema;

export const CollectionAssetsPatchSchema = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();

export const CollectionDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  itemCount: z.number().int().nonnegative(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type CollectionDto = z.infer<typeof CollectionDtoSchema>;

export const CollectionPageSchema = z.object({
  items: z.array(CollectionDtoSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const CollectionResponseSchema = z.object({ collection: CollectionDtoSchema }).strict();

export const CollectionAssetsResponseSchema = z.object({
  collection: CollectionDtoSchema,
  added: z.number().int().nonnegative(),
}).strict();

export const InternalEventTypeSchema = z.enum([
  'job.created',
  'job.updated',
  'job.deleted',
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'collection.updated',
  'provider.updated',
  'model.updated',
  'reset',
]);

export const InternalEventSchema = z.object({
  version: z.literal(1),
  id: z.number().int().positive(),
  type: InternalEventTypeSchema,
  entityId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  occurredAt: IsoTimestampSchema,
}).strict();

export type InternalEvent = z.infer<typeof InternalEventSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
}).strict();
