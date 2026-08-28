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

/**
 * Management payloads cross an HTTP boundary. Keep their dynamic portions
 * smaller than the server-side parser limits so malformed input is rejected
 * before it reaches an adapter or a persistence layer.
 */
export const MAX_ADAPTER_DOCUMENT_BYTES = 128 * 1024;
export const MAX_ADAPTER_DOCUMENT_DEPTH = 12;
export const MAX_ADAPTER_DOCUMENT_NODES = 10_000;
export const MAX_ADAPTER_DOCUMENT_KEYS = 512;
export const MAX_ADAPTER_DOCUMENT_ARRAY_ITEMS = 128;
export const MAX_ADAPTER_DOCUMENT_STRING_BYTES = 4_096;
export const MAX_ADAPTER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_ADAPTER_RESPONSE_DEPTH = 12;
export const MAX_ADAPTER_RESPONSE_NODES = 10_000;
export const MAX_ADAPTER_RESPONSE_KEYS = 2_048;
export const MAX_ADAPTER_RESPONSE_ARRAY_ITEMS = 512;
export const MAX_ADAPTER_RESPONSE_HEADER_COUNT = 128;
export const MAX_ADAPTER_RESPONSE_HEADER_LENGTH = 4_096;
export const MAX_ADAPTER_POINTER_LENGTH = 512;

const forbiddenJsonKeys = new Set(['__proto__', 'constructor', 'prototype']);

interface BoundedJsonOptions {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringBytes: number;
}

const documentJsonOptions: BoundedJsonOptions = {
  maxArrayItems: MAX_ADAPTER_DOCUMENT_ARRAY_ITEMS,
  maxBytes: MAX_ADAPTER_DOCUMENT_BYTES,
  maxDepth: MAX_ADAPTER_DOCUMENT_DEPTH,
  maxKeys: MAX_ADAPTER_DOCUMENT_KEYS,
  maxNodes: MAX_ADAPTER_DOCUMENT_NODES,
  maxStringBytes: MAX_ADAPTER_DOCUMENT_STRING_BYTES,
};

const responseJsonOptions: BoundedJsonOptions = {
  maxArrayItems: MAX_ADAPTER_RESPONSE_ARRAY_ITEMS,
  maxBytes: MAX_ADAPTER_RESPONSE_BYTES,
  maxDepth: MAX_ADAPTER_RESPONSE_DEPTH,
  maxKeys: MAX_ADAPTER_RESPONSE_KEYS,
  maxNodes: MAX_ADAPTER_RESPONSE_NODES,
  maxStringBytes: MAX_ADAPTER_RESPONSE_BYTES,
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Zod object schemas parse class instances as ordinary objects. HTTP request
 * contracts must reject those inputs before the object parser can discard the
 * prototype and any inherited fields.
 */
function plainObjectInput<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.infer<T>> {
  return z.preprocess(
    (value) => isPlainJsonObject(value) ? value : undefined,
    schema,
  ) as z.ZodType<z.infer<T>>;
}

function assertBoundedJson(value: unknown, options: BoundedJsonOptions): void {
  let nodes = 0;
  let keys = 0;
  let totalStringBytes = 0;
  const seen = new Set<object>();

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > options.maxNodes || depth > options.maxDepth) throw new Error('bounded JSON is too large');
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      const bytes = utf8ByteLength(current);
      totalStringBytes += bytes;
      if (bytes > options.maxStringBytes) throw new Error('bounded JSON string is too large');
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('bounded JSON number is invalid');
      return;
    }
    if (typeof current !== 'object') throw new Error('bounded JSON value is invalid');
    if (seen.has(current)) throw new Error('bounded JSON contains a cycle');
    if (!Array.isArray(current) && !isPlainJsonObject(current)) throw new Error('bounded JSON object is not plain');
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length > options.maxArrayItems) throw new Error('bounded JSON array is too large');
      for (const item of current) visit(item, depth + 1);
    } else {
      const entries = Object.entries(current);
      keys += entries.length;
      if (keys > options.maxKeys) throw new Error('bounded JSON has too many keys');
      for (const [key, item] of entries) {
        if (key.length === 0 || key.length > 256 || forbiddenJsonKeys.has(key)) {
          throw new Error('bounded JSON key is invalid');
        }
        totalStringBytes += utf8ByteLength(key);
        visit(item, depth + 1);
      }
    }
    seen.delete(current);
  };

  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('bounded JSON is not serializable');
  }
  if (serialized === undefined || utf8ByteLength(serialized) > options.maxBytes) {
    throw new Error('bounded JSON is too large');
  }
  // This also bounds documents made mostly of keys, which are not counted as
  // scalar values by the recursive string budget above.
  if (totalStringBytes > options.maxBytes) throw new Error('bounded JSON strings are too large');
}

function boundedJsonValueSchema(options: BoundedJsonOptions): z.ZodType<JsonValue> {
  return z.custom<JsonValue>((value) => {
    try {
      assertBoundedJson(value, options);
      return true;
    } catch {
      return false;
    }
  }, { message: 'JSON value is outside the bounded transport contract.' });
}

function boundedJsonObjectSchema(options: BoundedJsonOptions): z.ZodType<JsonObject> {
  return z.custom<JsonObject>((value) => {
    if (!isPlainJsonObject(value)) return false;
    try {
      assertBoundedJson(value, options);
      return true;
    } catch {
      return false;
    }
  }, { message: 'JSON object is outside the bounded transport contract.' });
}

export const BoundedJsonValueSchema = boundedJsonValueSchema(responseJsonOptions);
export const BoundedJsonObjectSchema = boundedJsonObjectSchema(documentJsonOptions);
export type BoundedJsonValue = z.infer<typeof BoundedJsonValueSchema>;

export const ProviderIdSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !hasControlCharacters(value), 'Provider id must not contain control characters.');
/** A reusable value schema for path params and multipart text fields. */
export const ProviderIdValueSchema = ProviderIdSchema;
export const AdapterIdSchema = CustomAdapterIdSchema;
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type AdapterId = z.infer<typeof AdapterIdSchema>;

export const EmptyQuerySchema: z.ZodType<Readonly<Record<string, never>>> = z.custom<Readonly<Record<string, never>>>(
  (value) => value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.keys(value).length === 0,
  { message: 'Query parameters are not accepted for this endpoint.' },
);
export const AdapterEmptyQuerySchema = EmptyQuerySchema;
export const NoQuerySchema = EmptyQuerySchema;
export const ProviderIdParamsSchema = z.object({ providerId: ProviderIdSchema }).strict();
export const AdapterIdParamsSchema = z.object({ adapterId: AdapterIdSchema }).strict();
export const ProviderAdapterParamsSchema = z.object({
  providerId: ProviderIdSchema,
  adapterId: AdapterIdSchema,
}).strict();
export type ProviderIdParams = z.infer<typeof ProviderIdParamsSchema>;
export type AdapterIdParams = z.infer<typeof AdapterIdParamsSchema>;
export type ProviderAdapterParams = z.infer<typeof ProviderAdapterParamsSchema>;

export const AdapterDocumentFormatSchema = z.enum(['json', 'yaml']);
export type AdapterDocumentFormat = z.infer<typeof AdapterDocumentFormatSchema>;
export const AdapterFormatQuerySchema = z.object({
  format: AdapterDocumentFormatSchema.default('json'),
}).strict();
export type AdapterFormatQuery = z.infer<typeof AdapterFormatQuerySchema>;

/** Export accepts either the current revision or one complete historical ref. */
export const CustomAdapterExportQuerySchema = z.union([
  z.object({
    format: AdapterDocumentFormatSchema.optional(),
  }).strict(),
  z.object({
    kind: CustomAdapterKindSchema,
    adapterId: AdapterIdSchema,
    version: CustomAdapterVersionSchema,
    digest: CustomAdapterDigestSchema,
    format: AdapterDocumentFormatSchema.optional(),
  }).strict(),
]);
export type CustomAdapterExportQuery = z.infer<typeof CustomAdapterExportQuerySchema>;
export const AdapterExportQuerySchema = CustomAdapterExportQuerySchema;

const BoundedDocumentTextSchema = z.string().refine(
  (value) => utf8ByteLength(value) <= MAX_ADAPTER_DOCUMENT_BYTES,
  'Adapter document exceeds the size limit.',
);

/** Raw JSON/YAML text or a plain JSON object. Binary input is server-only. */
export const CustomAdapterDocumentSchema = z.union([
  BoundedDocumentTextSchema,
  boundedJsonObjectSchema(documentJsonOptions),
]);
export type CustomAdapterDocument = z.infer<typeof CustomAdapterDocumentSchema>;

export const CustomHttpAdapterRefSchema = CustomAdapterRefSchema.extend({
  kind: z.literal('declarative-http'),
});
const TrustedAdapterRefObjectSchema = CustomAdapterRefSchema.extend({
  kind: z.literal('trusted-javascript'),
});
export const TrustedAdapterRefSchema = plainObjectInput(TrustedAdapterRefObjectSchema);
export type CustomHttpAdapterRef = z.infer<typeof CustomHttpAdapterRefSchema>;
export type TrustedAdapterRef = z.infer<typeof TrustedAdapterRefSchema>;

const AdapterRefQueryShape = {
  kind: CustomAdapterKindSchema,
  adapterId: AdapterIdSchema,
  version: CustomAdapterVersionSchema,
  digest: CustomAdapterDigestSchema,
};

/** Query representation of a complete immutable adapter reference. */
export const CustomAdapterRefQuerySchema = z.object(AdapterRefQueryShape).strict();
export const AdapterRefQuerySchema = CustomAdapterRefQuerySchema;
export type CustomAdapterRefQuery = z.infer<typeof CustomAdapterRefQuerySchema>;

const OptionalAdapterRefQuerySchema = z.object({
  kind: CustomAdapterKindSchema.optional(),
  adapterId: AdapterIdSchema.optional(),
  version: CustomAdapterVersionSchema.optional(),
  digest: CustomAdapterDigestSchema.optional(),
}).strict().superRefine((value, context) => {
  const present = ['kind', 'adapterId', 'version', 'digest'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (present.length !== 0 && present.length !== 4) {
    context.addIssue({
      code: 'custom',
      path: [present[0] ?? 'kind'],
      message: 'Adapter revision references must include kind, adapterId, version, and digest.',
    });
  }
});

export const CustomAdapterRevisionQuerySchema = OptionalAdapterRefQuerySchema;
export type CustomAdapterRevisionQuery = z.infer<typeof CustomAdapterRevisionQuerySchema>;
export const CustomAdapterRevisionListQuerySchema = z.object({
  ...OptionalAdapterRefQuerySchema.shape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(2048).optional(),
}).strict().superRefine((value, context) => {
  const present = ['kind', 'adapterId', 'version', 'digest'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (present.length !== 0 && present.length !== 4) {
    context.addIssue({
      code: 'custom',
      path: [present[0] ?? 'kind'],
      message: 'Adapter revision references must include kind, adapterId, version, and digest.',
    });
  }
});
export type CustomAdapterRevisionListQuery = z.infer<typeof CustomAdapterRevisionListQuerySchema>;

const TrustedAdapterKindSchema = z.literal('trusted-javascript');

/** Exact immutable reference query restricted to trusted JavaScript adapters. */
const TrustedAdapterRefQueryObjectSchema = z.object({
  ...CustomAdapterRefQuerySchema.shape,
  kind: TrustedAdapterKindSchema,
}).strict();
export const TrustedAdapterRefQuerySchema = plainObjectInput(TrustedAdapterRefQueryObjectSchema);
export type TrustedAdapterRefQuery = z.infer<typeof TrustedAdapterRefQuerySchema>;

/**
 * Optional revision filters are useful for reading the current binding when
 * omitted, or one historical binding when the complete ref is supplied.
 */
const TrustedAdapterRevisionQueryObjectSchema = z.object({
  ...CustomAdapterRevisionQuerySchema.shape,
  kind: TrustedAdapterKindSchema.optional(),
}).strict().superRefine((value, context) => {
  const present = ['kind', 'adapterId', 'version', 'digest'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (present.length !== 0 && present.length !== 4) {
    context.addIssue({
      code: 'custom',
      path: [present[0] ?? 'kind'],
      message: 'Adapter revision references must include kind, adapterId, version, and digest.',
    });
  }
});
export const TrustedAdapterRevisionQuerySchema = plainObjectInput(TrustedAdapterRevisionQueryObjectSchema);
export type TrustedAdapterRevisionQuery = z.infer<typeof TrustedAdapterRevisionQuerySchema>;

/** Revision-list query reused from the custom adapter contract. */
const TrustedAdapterRevisionListQueryObjectSchema = z.object({
  ...CustomAdapterRevisionListQuerySchema.shape,
  kind: TrustedAdapterKindSchema.optional(),
}).strict().superRefine((value, context) => {
  const present = ['kind', 'adapterId', 'version', 'digest'].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (present.length !== 0 && present.length !== 4) {
    context.addIssue({
      code: 'custom',
      path: [present[0] ?? 'kind'],
      message: 'Adapter revision references must include kind, adapterId, version, and digest.',
    });
  }
});
export const TrustedAdapterRevisionListQuerySchema = plainObjectInput(TrustedAdapterRevisionListQueryObjectSchema);
export type TrustedAdapterRevisionListQuery = z.infer<typeof TrustedAdapterRevisionListQuerySchema>;

/** Unbinding always targets one complete immutable trusted revision. */
export const TrustedAdapterUnbindQuerySchema = TrustedAdapterRefQuerySchema;
export type TrustedAdapterUnbindQuery = TrustedAdapterRefQuery;
export const TrustedJavaScriptAdapterRefQuerySchema = TrustedAdapterRefQuerySchema;
export const TrustedJavaScriptAdapterRevisionListQuerySchema = TrustedAdapterRevisionListQuerySchema;
export const TrustedJavaScriptAdapterUnbindQuerySchema = TrustedAdapterUnbindQuerySchema;

export const CustomAdapterTargetSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema.optional(),
}).strict();
export type CustomAdapterTarget = z.infer<typeof CustomAdapterTargetSchema>;

/** Provider-scoped deletion always carries the exact current revision ref. */
export const CustomAdapterDeleteBodySchema = z.object({
  ref: CustomAdapterRefSchema,
}).strict();
export type CustomAdapterDeleteBody = z.infer<typeof CustomAdapterDeleteBodySchema>;
export const CustomAdapterDeleteRequestSchema = CustomAdapterDeleteBodySchema;
export type CustomAdapterDeleteRequest = CustomAdapterDeleteBody;

/** The exact envelope emitted by declarative adapter export. */
export const CustomAdapterImportEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u),
  definition: boundedJsonObjectSchema(documentJsonOptions),
}).strict();
export type CustomAdapterImportEnvelope = z.infer<typeof CustomAdapterImportEnvelopeSchema>;
export const CustomAdapterExportEnvelopeSchema = CustomAdapterImportEnvelopeSchema;
export type CustomAdapterExportEnvelope = CustomAdapterImportEnvelope;

/** Optional version selector for raw import routes. */
export const CustomAdapterImportQuerySchema = plainObjectInput(z.object({
  version: CustomAdapterVersionSchema.optional(),
}).strict());
export type CustomAdapterImportQuery = z.infer<typeof CustomAdapterImportQuerySchema>;
export const AdapterImportQuerySchema = CustomAdapterImportQuerySchema;

/** Canonical browser payload for importing a raw document or export envelope. */
export const CustomAdapterImportRequestSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomHttpAdapterRefSchema.optional(),
  version: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u).optional(),
  format: AdapterDocumentFormatSchema.optional(),
  document: CustomAdapterDocumentSchema,
}).strict();
export type CustomAdapterImportRequest = z.infer<typeof CustomAdapterImportRequestSchema>;

export const CustomAdapterRawDocumentRequestSchema = z.object({
  providerId: ProviderIdSchema.optional(),
  format: AdapterDocumentFormatSchema.optional(),
  document: CustomAdapterDocumentSchema,
}).strict();
export type CustomAdapterRawDocumentRequest = z.infer<typeof CustomAdapterRawDocumentRequestSchema>;

const AdapterEndpointNameSchema = z.enum(['submit', 'poll', 'cancel', 'connection', 'catalog']);
export type AdapterEndpointName = z.infer<typeof AdapterEndpointNameSchema>;

function assertNoPreviewSecrets(value: unknown): void {
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) throw new Error('Preview request contains a cycle.');
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else {
      for (const [key, item] of Object.entries(current)) {
        if (key === 'adminEnabled' || key === 'secrets' || key === 'secretValues') {
          throw new Error('Preview request contains server-only fields.');
        }
        if (key === 'bytes' || key === 'source') {
          throw new Error('Preview request contains a server-only binary/source field.');
        }
        visit(item);
      }
    }
    seen.delete(current);
  };
  visit(value);
}

const PreviewGenerationRequestSchema = GenerationRequestSchema.superRefine((value, context) => {
  if (value.extra === undefined) return;
  try {
    assertBoundedJson(value.extra, responseJsonOptions);
    assertNoPreviewSecrets(value.extra);
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['extra'],
      message: 'Generation request extra fields are not safe for browser transport.',
    });
  }
});

export const CustomAdapterValidateRequestSchema = z.object({
  providerId: ProviderIdSchema.optional(),
  format: AdapterDocumentFormatSchema.optional(),
  document: CustomAdapterDocumentSchema,
  request: PreviewGenerationRequestSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
}).strict();
export type CustomAdapterValidateRequest = z.infer<typeof CustomAdapterValidateRequestSchema>;

export const CustomAdapterPreviewRequestSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema.optional(),
  request: PreviewGenerationRequestSchema.optional(),
  endpoint: AdapterEndpointNameSchema.optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  document: CustomAdapterDocumentSchema.optional(),
  format: AdapterDocumentFormatSchema.optional(),
}).strict().superRefine((value, context) => {
  try {
    // The schema intentionally has no context/secrets/inputs fields. Keep the
    // recursive check for request.extra, where unknown provider parameters
    // could otherwise smuggle server-owned values across the boundary.
    assertNoPreviewSecrets(value.request);
  } catch {
    context.addIssue({ code: 'custom', message: 'Preview request contains server-only fields.' });
  }
});
export type CustomAdapterPreviewRequest = z.infer<typeof CustomAdapterPreviewRequestSchema>;

/** Dry Run uses the same input contract and is guaranteed to perform no network call. */
export const CustomAdapterDryRunRequestSchema = CustomAdapterPreviewRequestSchema;
export type CustomAdapterDryRunRequest = z.infer<typeof CustomAdapterDryRunRequestSchema>;

export const CustomAdapterCapabilityPreviewRequestSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema.optional(),
  document: CustomAdapterDocumentSchema.optional(),
  format: AdapterDocumentFormatSchema.optional(),
}).strict();
export type CustomAdapterCapabilityPreviewRequest = z.infer<typeof CustomAdapterCapabilityPreviewRequestSchema>;

const AdapterHeaderNameSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_ADAPTER_RESPONSE_HEADER_LENGTH)
  .refine((value) => !/[\r\n]/u.test(value), 'Header names cannot contain line breaks.')
  .refine((value) => !forbiddenJsonKeys.has(value), 'Prototype-related header names are not allowed.');
const AdapterHeaderValueSchema = z.string()
  .max(MAX_ADAPTER_RESPONSE_HEADER_LENGTH)
  .refine((value) => !/[\r\n]/u.test(value), 'Header values cannot contain line breaks.');
const AdapterHeaderValuesSchema = z.union([
  AdapterHeaderValueSchema,
  z.array(AdapterHeaderValueSchema).max(32),
]);

export const CustomAdapterResponseHeadersSchema = z.record(
  AdapterHeaderNameSchema,
  AdapterHeaderValuesSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length > MAX_ADAPTER_RESPONSE_HEADER_COUNT) {
    context.addIssue({ code: 'custom', message: 'Response headers exceed the size limit.' });
  }
});
export type CustomAdapterResponseHeaders = z.infer<typeof CustomAdapterResponseHeadersSchema>;

const BoundedResponseTextSchema = z.string().refine(
  (value) => utf8ByteLength(value) <= MAX_ADAPTER_RESPONSE_BYTES,
  'Response text exceeds the size limit.',
);

/** Mock response input; body/statusCode aliases from the service stay server-only. */
export const CustomAdapterSimulateResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: CustomAdapterResponseHeadersSchema.optional(),
  json: BoundedJsonValueSchema.optional(),
  text: BoundedResponseTextSchema.optional(),
}).strict().refine(
  (value) => value.json !== undefined || value.text !== undefined,
  'A simulated response must contain JSON or text.',
);
export type CustomAdapterSimulateResponse = z.infer<typeof CustomAdapterSimulateResponseSchema>;
export const CustomAdapterMockResponseSchema = CustomAdapterSimulateResponseSchema;
export type CustomAdapterMockResponse = CustomAdapterSimulateResponse;

export const CustomAdapterSimulateRequestSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema.optional(),
  endpoint: AdapterEndpointNameSchema.optional(),
  phase: AdapterEndpointNameSchema.optional(),
  response: CustomAdapterSimulateResponseSchema,
  expectedRemoteJobId: z.string().trim().min(1).max(255).refine(
    (value) => !hasControlCharacters(value),
    'Remote job id must not contain control characters.',
  ).optional(),
  document: CustomAdapterDocumentSchema.optional(),
  format: AdapterDocumentFormatSchema.optional(),
}).strict();
export type CustomAdapterSimulateRequest = z.infer<typeof CustomAdapterSimulateRequestSchema>;

const JsonPointerSchema = z.string()
  .min(1)
  .max(MAX_ADAPTER_POINTER_LENGTH)
  .refine((value) => value.startsWith('/'), 'Response path must be a non-empty RFC 6901 JSON Pointer.')
  .refine((value) => !value.includes('\\'), 'Response path must not contain backslashes.')
  .refine((value) => !/~(?![01])/u.test(value), 'Response path must be an RFC 6901 JSON Pointer.');
export const CustomAdapterPathTestRequestSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema.optional(),
  path: JsonPointerSchema,
  document: z.union([BoundedResponseTextSchema, boundedJsonObjectSchema(responseJsonOptions)]).optional(),
  response: CustomAdapterSimulateResponseSchema.optional(),
  json: BoundedJsonValueSchema.optional(),
  text: BoundedResponseTextSchema.optional(),
}).strict().refine(
  (value) => value.document !== undefined || value.response !== undefined || value.json !== undefined || value.text !== undefined,
  'A path test document is required.',
);
export type CustomAdapterPathTestRequest = z.infer<typeof CustomAdapterPathTestRequestSchema>;

export const CustomAdapterPathTestResponseSchema = z.object({
  path: JsonPointerSchema,
  found: z.boolean(),
  value: BoundedJsonValueSchema.optional(),
}).strict();
export type CustomAdapterPathTestResponse = z.infer<typeof CustomAdapterPathTestResponseSchema>;

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

const PreviewMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PreviewRelativePathSchema = z.string().trim().min(1).max(512);
const PreviewUrlSchema = z.string().url().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}, 'Preview URL must use HTTP or HTTPS without credentials or fragments.');
const PreviewStringMapSchema = z.record(
  z.string().trim().min(1).max(256).refine((value) => !forbiddenJsonKeys.has(value)),
  z.string().max(MAX_ADAPTER_RESPONSE_HEADER_LENGTH).refine((value) => !/[\r\n]/u.test(value)),
);

const PreviewFileSchema = z.object({
  field: z.string().trim().min(1).max(256),
  filename: z.string().min(1).max(4096).refine((value) => !/[\r\n\\/]/u.test(value)),
  contentType: z.string().trim().min(1).max(255),
  assetId: z.string().trim().min(1).max(255),
  byteLength: z.number().int().nonnegative().max(MAX_ADAPTER_RESPONSE_BYTES),
}).strict();

const PreviewBodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({
    type: z.literal('json'),
    value: BoundedJsonValueSchema,
  }).strict(),
  z.object({
    type: z.literal('form'),
    fields: PreviewStringMapSchema,
  }).strict(),
  z.object({
    type: z.literal('multipart'),
    fields: PreviewStringMapSchema,
    files: z.array(PreviewFileSchema).max(32),
  }).strict(),
]);

export const CustomAdapterCompiledPreviewSchema = z.object({
  method: PreviewMethodSchema,
  relativePath: PreviewRelativePathSchema,
  query: PreviewStringMapSchema,
  headers: PreviewStringMapSchema,
  body: PreviewBodySchema,
  url: PreviewUrlSchema,
  endpoint: AdapterEndpointNameSchema,
}).strict();
export type CustomAdapterCompiledPreview = z.infer<typeof CustomAdapterCompiledPreviewSchema>;

const ProviderCapabilityModelSchema = z.object({
  id: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  capabilities: ModelCapabilitiesSchema,
}).strict().superRefine((value, context) => {
  if (value.capabilities.customFields === undefined) return;
  try {
    assertBoundedJson(value.capabilities.customFields, documentJsonOptions);
  } catch {
    context.addIssue({
      code: 'custom',
      path: ['capabilities', 'customFields'],
      message: 'Capability custom fields are outside the bounded transport contract.',
    });
  }
});

export const ProviderCapabilitiesSchema = z.object({
  providerType: z.string().trim().min(1).max(255).refine(
    (value) => !hasControlCharacters(value),
    'Provider type must not contain control characters.',
  ),
  models: z.array(ProviderCapabilityModelSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, model] of value.models.entries()) {
    if (ids.has(model.id)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index, 'id'],
        message: 'Capability model ids must be unique.',
      });
    }
    ids.add(model.id);
  }
});
export type ProviderCapabilitiesDto = z.infer<typeof ProviderCapabilitiesSchema>;
export const ProviderCapabilitiesDtoSchema = ProviderCapabilitiesSchema;

export const CustomAdapterCapabilityPreviewSchema = z.object({
  capabilities: ProviderCapabilitiesSchema,
}).strict();
export type CustomAdapterCapabilityPreview = z.infer<typeof CustomAdapterCapabilityPreviewSchema>;
export const CustomAdapterCapabilityPreviewResponseSchema = CustomAdapterCapabilityPreviewSchema;

export const CustomAdapterDryRunResponseSchema = z.object({
  network: z.literal(false),
  performed: z.literal(false),
  endpoint: AdapterEndpointNameSchema,
  request: CustomAdapterCompiledPreviewSchema,
  preview: CustomAdapterCompiledPreviewSchema,
  capabilities: ProviderCapabilitiesSchema,
}).strict();
export type CustomAdapterDryRunResponse = z.infer<typeof CustomAdapterDryRunResponseSchema>;

export const CustomAdapterExportResponseSchema = z.object({
  format: AdapterDocumentFormatSchema,
  content: BoundedDocumentTextSchema,
  document: BoundedDocumentTextSchema,
  ref: CustomAdapterRefSchema,
}).strict();
export type CustomAdapterExportResponse = z.infer<typeof CustomAdapterExportResponseSchema>;

export const CustomAdapterValidationResponseSchema = z.object({
  valid: z.literal(true),
  adapterId: AdapterIdSchema,
  canonical: BoundedDocumentTextSchema,
  spec: BoundedJsonObjectSchema,
}).strict();
export type CustomAdapterValidationResponse = z.infer<typeof CustomAdapterValidationResponseSchema>;
export const CustomAdapterValidateResponseSchema = CustomAdapterValidationResponseSchema;

export const CustomAdapterDefinitionDtoSchema = z.object({
  providerId: ProviderIdSchema,
  ref: CustomAdapterRefSchema,
  definition: BoundedJsonObjectSchema.nullable(),
  isCurrent: z.boolean(),
  disabled: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();
export type CustomAdapterDefinitionDto = z.infer<typeof CustomAdapterDefinitionDtoSchema>;

export const CustomAdapterDefinitionResponseSchema = z.object({
  definition: CustomAdapterDefinitionDtoSchema,
}).strict();
export const CustomAdapterDefinitionPageSchema = z.object({
  items: z.array(CustomAdapterDefinitionDtoSchema).max(200),
  nextCursor: z.string().max(2048).nullable().optional(),
}).strict();
export type CustomAdapterDefinitionResponse = z.infer<typeof CustomAdapterDefinitionResponseSchema>;
export type CustomAdapterDefinitionPage = z.infer<typeof CustomAdapterDefinitionPageSchema>;

const TrustedAdapterOperationSchema = MediaOperationSchema;
const TrustedAdapterManifestIdSchema = z.string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u);
const TrustedAdapterManifestVersionSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u);
const TrustedAdapterManifestStringSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !hasControlCharacters(value));
const TrustedAdapterResourceLimitsObjectSchema = z.object({
  timeoutMs: z.number().int().positive().max(10 * 60 * 1000),
  maxMessageBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxLogBytes: z.number().int().positive().max(4 * 1024 * 1024),
  maxOldGenerationSizeMb: z.number().int().positive().max(512),
  maxYoungGenerationSizeMb: z.number().int().positive().max(128),
  stackSizeMb: z.number().int().positive().max(16),
}).strict();
const TrustedAdapterResourceLimitsSchema = plainObjectInput(TrustedAdapterResourceLimitsObjectSchema);

const TrustedAdapterManifestObjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: TrustedAdapterManifestIdSchema,
  version: TrustedAdapterManifestVersionSchema,
  displayName: TrustedAdapterManifestStringSchema.max(120),
  sha256: CustomAdapterDigestSchema,
  operations: z.array(TrustedAdapterOperationSchema).min(1).max(16),
  capabilities: ProviderCapabilitiesSchema,
  allowedHosts: z.array(z.string().trim().min(1).max(253).refine(
    (value) => !hasControlCharacters(value) && !/[\s*:/?#@[\]]/u.test(value),
  )).min(1).max(32),
  requiredSecrets: z.array(z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/u)).max(16),
  resourceLimits: TrustedAdapterResourceLimitsSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.operations).size !== value.operations.length) {
    context.addIssue({ code: 'custom', path: ['operations'], message: 'Manifest operations must be unique.' });
  }
});
export const TrustedAdapterManifestSchema = plainObjectInput(TrustedAdapterManifestObjectSchema);
export type TrustedAdapterManifest = z.infer<typeof TrustedAdapterManifestSchema>;

/** Source-free projection of an installed trusted adapter. */
const TrustedAdapterManagementDtoObjectSchema = z.object({
  manifest: TrustedAdapterManifestSchema,
  ref: TrustedAdapterRefSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();
export const TrustedAdapterManagementDtoSchema = plainObjectInput(TrustedAdapterManagementDtoObjectSchema);
export type TrustedAdapterManagementDto = z.infer<typeof TrustedAdapterManagementDtoSchema>;
export const TrustedAdapterResponseSchema = z.object({
  adapter: TrustedAdapterManagementDtoSchema,
}).strict();
export const TrustedAdapterPageSchema = z.object({
  items: z.array(TrustedAdapterManagementDtoSchema).max(200),
}).strict();
export type TrustedAdapterResponse = z.infer<typeof TrustedAdapterResponseSchema>;
export type TrustedAdapterPage = z.infer<typeof TrustedAdapterPageSchema>;

const TrustedAdapterBindRequestObjectSchema = z.object({
  providerId: ProviderIdSchema,
  ref: TrustedAdapterRefSchema,
}).strict();
export const TrustedAdapterBindRequestSchema = plainObjectInput(TrustedAdapterBindRequestObjectSchema);
export type TrustedAdapterBindRequest = z.infer<typeof TrustedAdapterBindRequestSchema>;
export const TrustedJavaScriptAdapterBindRequestSchema = TrustedAdapterBindRequestSchema;

/** Provider-scoped bind bodies carry only the immutable trusted ref. */
const TrustedAdapterBindBodyObjectSchema = z.object({
  ref: TrustedAdapterRefSchema,
}).strict();
export const TrustedAdapterBindBodySchema = plainObjectInput(TrustedAdapterBindBodyObjectSchema);
export type TrustedAdapterBindBody = z.infer<typeof TrustedAdapterBindBodySchema>;
export const TrustedJavaScriptAdapterBindBodySchema = TrustedAdapterBindBodySchema;

/** A disable body is either empty or targets one exact trusted revision. */
const TrustedAdapterDisableBodyWithRefSchema = z.object({
  ref: TrustedAdapterRefSchema,
}).strict();
export const TrustedAdapterDisableBodySchema = plainObjectInput(z.union([
  EmptyQuerySchema,
  TrustedAdapterDisableBodyWithRefSchema,
]));
export type TrustedAdapterDisableBody = z.infer<typeof TrustedAdapterDisableBodySchema>;
export const TrustedAdapterDisableRequestSchema = TrustedAdapterDisableBodySchema;
export type TrustedAdapterDisableRequest = TrustedAdapterDisableBody;
export const TrustedJavaScriptAdapterDisableBodySchema = TrustedAdapterDisableBodySchema;
export const TrustedJavaScriptAdapterDisableRequestSchema = TrustedAdapterDisableRequestSchema;

/** Source-free Provider binding projection and wire envelopes. */
const TrustedAdapterBindingDtoObjectSchema = z.object({
  providerId: ProviderIdSchema,
  adapter: TrustedAdapterManagementDtoSchema,
  isCurrent: z.boolean(),
  disabled: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();
export const TrustedAdapterBindingDtoSchema = plainObjectInput(TrustedAdapterBindingDtoObjectSchema);
export type TrustedAdapterBindingDto = z.infer<typeof TrustedAdapterBindingDtoSchema>;

export const TrustedAdapterBindingResponseSchema = plainObjectInput(z.object({
  binding: TrustedAdapterBindingDtoSchema,
}).strict());
export type TrustedAdapterBindingResponse = z.infer<typeof TrustedAdapterBindingResponseSchema>;

export const TrustedAdapterBindingPageSchema = plainObjectInput(z.object({
  items: z.array(TrustedAdapterBindingDtoSchema).max(200),
  nextCursor: z.string().trim().min(1).max(2048).nullable().optional(),
}).strict());
export type TrustedAdapterBindingPage = z.infer<typeof TrustedAdapterBindingPageSchema>;

export const TrustedJavaScriptAdapterBindingDtoSchema = TrustedAdapterBindingDtoSchema;
export type TrustedJavaScriptAdapterBindingDto = TrustedAdapterBindingDto;
export const TrustedJavaScriptAdapterBindingResponseSchema = TrustedAdapterBindingResponseSchema;
export const TrustedJavaScriptAdapterBindingPageSchema = TrustedAdapterBindingPageSchema;

export const AdapterErrorCodeSchema = z.enum([
  'invalid_request',
  'administrator_required',
  'invalid_format',
  'input_too_large',
  'invalid_json',
  'invalid_yaml',
  'unsafe_document',
  'schema_invalid',
  'invalid_definition',
  'invalid_reference',
  'digest_mismatch',
  'definition_too_large',
  'provider_not_found',
  'provider_type_mismatch',
  'provider_adapter_kind_mismatch',
  'already_exists',
  'current_conflict',
  'not_found',
  'adapter_not_found',
  'referenced_jobs',
  'referenced_definitions',
  'tombstoned',
  'persisted_invalid',
  'invalid_base_url',
  'invalid_path',
  'invalid_header',
  'invalid_body',
  'invalid_input',
  'invalid_schema',
  'ambiguous_result',
  'invalid_response',
  'response_too_large',
  'unsupported_result',
  'outbox_unavailable',
  'outbox_failure',
  'storage_error',
  'invalid_manifest',
  'invalid_source',
  'source_too_large',
  'manifest_too_large',
  'adapter_id_immutable',
  'disabled_revision',
  'manifest_mismatch',
  'adapter_references_in_use',
  'adapter_references_unavailable',
  'store_failure',
  'definition_failure',
  'rollback_failed',
  'provider_unavailable',
]);
export type AdapterErrorCode = z.infer<typeof AdapterErrorCodeSchema>;

export const AdapterErrorResponseSchema = z.object({
  error: AdapterErrorCodeSchema,
  message: z.string().min(1).max(512).optional(),
  issues: z.array(BoundedJsonValueSchema).max(64).optional(),
}).strict();
export type AdapterErrorResponse = z.infer<typeof AdapterErrorResponseSchema>;
export const CustomAdapterErrorResponseSchema = AdapterErrorResponseSchema;
export const TrustedAdapterErrorResponseSchema = AdapterErrorResponseSchema;

export const CustomAdapterDefinitionListSchema = z.array(CustomAdapterDefinitionDtoSchema).max(200);
export type CustomAdapterDefinitionList = z.infer<typeof CustomAdapterDefinitionListSchema>;
export const CustomAdapterRevisionListResponseSchema = z.object({
  items: CustomAdapterDefinitionListSchema,
  nextCursor: z.string().trim().min(1).max(2048).nullable().optional(),
}).strict();
export type CustomAdapterRevisionListResponse = z.infer<typeof CustomAdapterRevisionListResponseSchema>;

const ExtractedAssetTypeSchema = z.enum(['image', 'video']);
const ExtractedAssetMimeSchema = z.string().trim().min(1).max(255).refine(
  (value) => !hasControlCharacters(value),
);
const ExtractedAssetUrlSchema = z.string().url().max(4_096).refine((value) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) return false;
    for (const name of url.searchParams.keys()) {
      if (/(?:^|[-_.])(api[-_.]?key|authorization|cookie|password|secret|token)(?:$|[-_.])/iu.test(name)) return false;
    }
    return true;
  } catch {
    return false;
  }
}, 'Extracted result URL is unsafe.');
const ExtractedAssetBase64Schema = z.string()
  .min(1)
  .max(MAX_ADAPTER_RESPONSE_BYTES)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const ExtractedAssetProviderIdSchema = ProviderIdSchema;
const ExtractedAssetRemoteIdSchema = z.string().trim().min(1).max(255).refine(
  (value) => !hasControlCharacters(value),
);

function assertNoExtractedSecrets(value: unknown): void {
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) throw new Error('Extracted response contains a cycle.');
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else {
      for (const [key, item] of Object.entries(current)) {
        if (key === 'source' || key === 'secrets' || key === 'secretValues' || key === 'body' || key === 'adminEnabled') {
          throw new Error('Extracted response contains a server-only field.');
        }
        visit(item);
      }
    }
    seen.delete(current);
  };
  visit(value);
}

const ExtractedAssetMetadataSchema = boundedJsonObjectSchema(responseJsonOptions).superRefine((value, context) => {
  try {
    assertNoExtractedSecrets(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Extracted metadata contains a server-only field.' });
  }
});

/** Safe result projection for simulation output; raw source/body are excluded. */
export const CustomAdapterExtractedAssetSchema = z.object({
  type: ExtractedAssetTypeSchema,
  mimeType: ExtractedAssetMimeSchema,
  resultId: ExtractedAssetRemoteIdSchema.optional(),
  filename: z.string().trim().min(1).max(255).refine((value) => !/[\r\n\\/]/u.test(value)).optional(),
  url: ExtractedAssetUrlSchema.optional(),
  base64: ExtractedAssetBase64Schema.optional(),
  providerId: ExtractedAssetProviderIdSchema.optional(),
  remoteJobId: ExtractedAssetRemoteIdSchema.optional(),
  variant: z.literal('video').optional(),
  metadata: ExtractedAssetMetadataSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasUrl = value.url !== undefined;
  const hasBase64 = value.base64 !== undefined;
  const hasProviderTarget = value.providerId !== undefined || value.remoteJobId !== undefined || value.variant !== undefined;
  if (Number(hasUrl) + Number(hasBase64) + Number(hasProviderTarget) !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'Extracted asset must contain exactly one safe result target.',
    });
  }
  if (hasProviderTarget && (value.providerId === undefined || value.remoteJobId === undefined || value.variant !== 'video')) {
    context.addIssue({
      code: 'custom',
      path: ['providerId'],
      message: 'Provider result targets require providerId, remoteJobId, and video variant.',
    });
  }
});
export type CustomAdapterExtractedAsset = z.infer<typeof CustomAdapterExtractedAssetSchema>;

export const CustomAdapterExtractedErrorSchema = z.object({
  code: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u),
  kind: z.enum(['expired', 'rejected', 'transient', 'unknown']),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().max(86_400_000).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
}).strict();
export type CustomAdapterExtractedError = z.infer<typeof CustomAdapterExtractedErrorSchema>;

const ExtractedResponseBase = {
  resultExpiresAt: IsoTimestampSchema.optional(),
};

export const CustomAdapterExtractedResponseSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('pending'),
    remoteJobId: ExtractedAssetRemoteIdSchema.optional(),
    progress: z.number().finite().min(0).max(100).optional(),
    status: z.string().trim().min(1).max(255).refine((value) => !hasControlCharacters(value)).optional(),
    ...ExtractedResponseBase,
  }).strict(),
  z.object({
    state: z.literal('completed'),
    assets: z.array(CustomAdapterExtractedAssetSchema).max(32),
    ...ExtractedResponseBase,
  }).strict(),
  z.object({
    state: z.literal('failed'),
    error: CustomAdapterExtractedErrorSchema,
  }).strict(),
]);
export type CustomAdapterExtractedResponse = z.infer<typeof CustomAdapterExtractedResponseSchema>;
export const CustomAdapterSimulationResultSchema = CustomAdapterExtractedResponseSchema;
export const CustomAdapterSimulatedResponseSchema = CustomAdapterExtractedResponseSchema;
export const CustomAdapterSimulateOutputSchema = CustomAdapterExtractedResponseSchema;
