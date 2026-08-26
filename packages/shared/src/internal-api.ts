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

const secretLikeKey = /(?:^|[-_.])(api[-_.]?key|authorization|cookie|password|secret|token|headers?|custom[-_.]?headers?)(?:$|[-_.])/i;

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

function stripSecretLikeKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripSecretLikeKeys(item));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (secretLikeKey.test(key)) continue;
      result[key] = stripSecretLikeKeys(item);
    }
    return result;
  }
  return value;
}

function sanitizeConfig(value: JsonObject): JsonObject {
  return stripSecretLikeKeys(value) as JsonObject;
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

export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  required: z.boolean(),
}).strict();

export const AuthLoginSchema = z.object({
  password: z.string().min(1).max(1024),
}).strict();

export type AuthStatus = z.infer<typeof AuthStatusSchema>;
export type AuthLogin = z.infer<typeof AuthLoginSchema>;

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
  for (const [key, item] of Object.entries(value.values)) {
    const path = secretLikeKey.test(key) ? [key] : findSecretLikePath(item, [key]);
    if (path) {
      context.addIssue({
        code: 'custom',
        message: `Secret-like settings key is not allowed: ${path.join('.')}`,
        path: ['values', ...path],
      });
    }
  }
});

export const SettingsResponseSchema = z.object({
  settings: JsonObjectSchema,
}).strict();

function hasHeaderLineBreak(value: string): boolean {
  return value.includes('\r') || value.includes('\n');
}

export const ProviderHeadersSchema = z.record(
  z.string().trim().min(1).max(256).refine((value) => !hasHeaderLineBreak(value), {
    message: 'Header names cannot contain line breaks.',
  }),
  z.string().max(8192).refine((value) => !hasHeaderLineBreak(value), {
    message: 'Header values cannot contain line breaks.',
  }),
);

function isSafeProviderBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export const ProviderBaseUrlSchema = z.string().url().max(2048).refine(isSafeProviderBaseUrl, {
  message: 'Provider Base URL must use HTTP or HTTPS without credentials, query, or fragment.',
});

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

const CustomAdapterIdSchema = z.string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u)
  .refine((value) => !hasControlCharacters(value), 'Adapter id must not contain control characters.')
  .refine((value) => !value.includes('..') && !value.includes('/') && !value.includes('\\'), 'Adapter id must not contain path syntax.');
const CustomAdapterVersionSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u)
  .refine((value) => !hasControlCharacters(value), 'Adapter version must not contain control characters.');
const CustomAdapterDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const CustomAdapterKindSchema = z.enum(['declarative-http', 'trusted-javascript']);
export const CustomAdapterRefSchema = z.object({
  kind: CustomAdapterKindSchema,
  adapterId: CustomAdapterIdSchema,
  version: CustomAdapterVersionSchema,
  digest: CustomAdapterDigestSchema,
}).strict();
export type CustomAdapterKind = z.infer<typeof CustomAdapterKindSchema>;
export type CustomAdapterRef = z.infer<typeof CustomAdapterRefSchema>;

export const ProviderTypeSchema = z.enum([
  'mock',
  'openai-images-v1',
  'openai-responses-image-v1',
  'openai-videos-v1-compatible',
  'gemini-interactions-image-v1',
  'gemini-generate-content-image-v1',
  'gemini-veo-operation-v1',
  'gemini-omni-interactions-video-v1',
  'xai-imagine-image-v1',
  'xai-imagine-video-v1',
  'custom-http-v1',
  'custom-js-v1',
]);

const ProviderDtoBaseUrlSchema = z.string().transform((value) =>
  value.length <= 2048 && isSafeProviderBaseUrl(value) ? value : null,
).nullable();

export const ProviderCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: ProviderTypeSchema,
  baseUrl: ProviderBaseUrlSchema.nullable().optional(),
  apiKey: z.string().min(1).max(16_384).optional(),
  headers: ProviderHeadersSchema.optional(),
  config: SafeConfigSchema.default({}),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
}).strict();

export const ProviderPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: ProviderTypeSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.nullable().optional(),
  apiKey: z.string().min(1).max(16_384).nullable().optional(),
  headers: ProviderHeadersSchema.nullable().optional(),
  config: SafeConfigSchema.optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
}).strict();

export const ProviderDtoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  baseUrl: ProviderDtoBaseUrlSchema,
  config: JsonObjectSchema.transform(sanitizeConfig),
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

export const ModelCapabilitySourceSchema = z.enum(['provider', 'profile', 'manual', 'mock']);

export type ModelCapabilitySource = z.infer<typeof ModelCapabilitySourceSchema>;

export const ModelDtoSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  capabilities: JsonObjectSchema,
  capabilitySource: ModelCapabilitySourceSchema,
  enabled: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type ModelDto = z.infer<typeof ModelDtoSchema>;

const ImageInputConstraintsSchema = z.object({
  mimeTypes: z.array(z.string().trim().min(1).max(255)).min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxPixels: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
}).strict();

const DurationSchema = z.union([
  z.array(z.number().finite().positive()),
  z.object({ min: z.number().finite().positive(), max: z.number().finite().positive() })
    .strict()
    .refine((value) => value.max >= value.min, 'Duration maximum must not be below minimum.'),
]);

export const ModelCapabilitiesSchema = z.object({
  operations: z.array(MediaOperationSchema).min(1),
  aspectRatios: z.array(z.string().trim().min(1).max(32)).optional(),
  resolutions: z.array(z.string().trim().min(1).max(64)).optional(),
  durations: DurationSchema.optional(),
  maxReferenceImages: z.number().int().nonnegative().optional(),
  inputImageConstraints: ImageInputConstraintsSchema.optional(),
  supportsMask: z.boolean().optional(),
  supportsNegativePrompt: z.boolean().optional(),
  supportsSeed: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  supportsProgress: z.boolean().optional(),
  supportsCancel: z.boolean().optional(),
  supportsBatchCount: z.boolean().optional(),
  maxBatchCount: z.number().int().positive().optional(),
  customFields: JsonObjectSchema.optional(),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, operation] of value.operations.entries()) {
    if (seen.has(operation)) {
      context.addIssue({
        code: 'custom',
        message: 'Capability operations must not contain duplicates.',
        path: ['operations', index],
      });
    }
    seen.add(operation);
  }
});

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

// Keep the older name as an explicit alias for callers that only validate
// request bodies. Both manual writes and stored model inputs use this schema.
export const ModelCapabilitiesInputSchema = ModelCapabilitiesSchema;

export const ManualModelCreateSchema = z.object({
  providerId: z.string().trim().min(1).max(255),
  modelId: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  capabilities: ModelCapabilitiesSchema,
  enabled: z.boolean().default(true),
}).strict();

export type ManualModelCreate = z.infer<typeof ManualModelCreateSchema>;

export const ManualModelPatchSchema = z.object({
  modelId: z.string().trim().min(1).max(255).optional(),
  displayName: z.string().trim().min(1).max(255).optional(),
  capabilities: ModelCapabilitiesSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one model field is required.');

export type ManualModelPatch = z.infer<typeof ManualModelPatchSchema>;

export const ModelResponseSchema = z.object({ model: ModelDtoSchema }).strict();

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
  resultExpiresAt: IsoTimestampSchema.nullable().optional(),
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
