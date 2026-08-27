import { z } from 'zod';

import { MediaOperationSchema, ModelCapabilitiesSchema } from '@imagine/shared';
import { isCredentialLikeQueryName as isCredentialLikeQueryNameShared } from '../../security/network-policy.js';

export const DECLARATIVE_HTTP_ADAPTER_TYPE = 'custom-http-v1' as const;

export const MAX_SPEC_BYTES = 128 * 1024;
export const MAX_SPEC_DEPTH = 12;
export const MAX_SPEC_NODES = 10_000;
export const MAX_SPEC_KEYS = 512;
export const MAX_SPEC_ARRAY_ITEMS = 128;
export const MAX_SPEC_STRING_LENGTH = 4_096;
export const MAX_TEMPLATE_TOKENS = 64;
export const MAX_PATH_SEGMENTS = 32;
export const MAX_RESPONSE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_RESPONSE_DEPTH = 12;
export const MAX_RESPONSE_NODES = 10_000;
export const MAX_RESPONSE_KEYS = 2_048;
export const MAX_RESPONSE_ARRAY_ITEMS = 512;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_ID_LENGTH = 255;
export const MAX_ERROR_LENGTH = 512;
export const MAX_RESULT_URL_LENGTH = 4_096;
export const MAX_BASE64_BYTES = 64 * 1024 * 1024;
export const MAX_MODELS = 200;
export const MAX_FILES = 32;

/** Operations currently expressible by GenerationInputResolver/ProviderInputLoader. */
export const DECLARATIVE_OPERATIONS = [
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
] as const;

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const safeKey = z.string().min(1).max(128).refine((value) => !DANGEROUS_KEYS.has(value), {
  message: 'Prototype-related keys are not allowed.',
});

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const TemplateNodeSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  scalar,
  z.array(TemplateNodeSchema).max(MAX_SPEC_ARRAY_ITEMS),
  z.record(safeKey, TemplateNodeSchema),
]));

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const JsonResponseTypeSchema = z.enum(['json', 'text']);
const RoleSchema = z.enum(['source', 'reference', 'mask', 'first_frame', 'last_frame']);

const PointerSchema = z.string().max(512).refine(
  (value) => value === '' || (value.startsWith('/') && !value.includes('\\') && !/~(?![01])/u.test(value)),
  'Response paths must be RFC 6901 JSON Pointers.',
);

const PathSchema = z.string().trim().min(1).max(512);
const TemplateScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const TemplateMapSchema = z.record(safeKey, TemplateScalarSchema);

const AuthSchema = z.object({
  type: z.enum(['bearer', 'api-key', 'header']),
  secretRef: z.string().trim().min(1).max(128).refine((value) => !DANGEROUS_KEYS.has(value)),
  location: z.literal('header'),
  name: z.string().trim().min(1).max(256).optional(),
}).strict();

const InputSelectorSchema = z.object({
  role: RoleSchema,
  index: z.number().int().min(0).max(MAX_FILES - 1).default(0),
}).strict();

const FilePartSchema = z.object({
  field: safeKey,
  input: InputSelectorSchema,
  filename: TemplateScalarSchema.optional(),
  contentType: z.string().trim().min(1).max(255).optional(),
}).strict();

const JsonBodySchema = z.object({
  type: z.literal('json'),
  value: TemplateNodeSchema,
}).strict();

const FormBodySchema = z.object({
  type: z.literal('form'),
  fields: z.record(safeKey, TemplateScalarSchema),
}).strict();

const MultipartBodySchema = z.object({
  type: z.literal('multipart'),
  fields: z.record(safeKey, TemplateScalarSchema).optional(),
  files: z.array(FilePartSchema).min(1).max(MAX_FILES),
}).strict();

export const BodySchema = z.discriminatedUnion('type', [
  JsonBodySchema,
  FormBodySchema,
  MultipartBodySchema,
]);

const BoundedValuesSchema = z.array(z.string().trim().min(1).max(255)).max(64);

export const ExtractSchema = z.object({
  remoteIdPath: PointerSchema.optional(),
  remoteJobIdPath: PointerSchema.optional(),
  statusPath: PointerSchema.optional(),
  progressPath: PointerSchema.optional(),
  resultUrlPath: PointerSchema.optional(),
  resultBase64Path: PointerSchema.optional(),
  resultMimeTypePath: PointerSchema.optional(),
  resultMimeType: z.string().trim().min(1).max(255).optional(),
  resultType: z.enum(['image', 'video']).optional(),
  resultIdPath: PointerSchema.optional(),
  filenamePath: PointerSchema.optional(),
  errorPath: PointerSchema.optional(),
  errorCodePath: PointerSchema.optional(),
  modelsPath: PointerSchema.optional(),
  modelIdPath: PointerSchema.optional(),
  modelNamePath: PointerSchema.optional(),
  successValues: BoundedValuesSchema.optional(),
  failureValues: BoundedValuesSchema.optional(),
  failedValues: BoundedValuesSchema.optional(),
  expiredValues: BoundedValuesSchema.optional(),
  pendingValues: BoundedValuesSchema.optional(),
  runningValues: BoundedValuesSchema.optional(),
  resultExpiresAtPath: PointerSchema.optional(),
}).strict();

export const EndpointSchema = z.object({
  method: HttpMethodSchema,
  path: PathSchema,
  headers: TemplateMapSchema.optional(),
  query: TemplateMapSchema.optional(),
  auth: AuthSchema.optional(),
  body: BodySchema.optional(),
  responseType: JsonResponseTypeSchema.default('json'),
  expectedStatus: z.array(z.number().int().min(100).max(599)).min(1).max(32).default([200]),
  extract: ExtractSchema.default({}),
}).strict();

const RequestSchemaType = z.enum(['object', 'string', 'number', 'integer', 'boolean']);

export interface RestrictedRequestSchema {
  readonly type: z.infer<typeof RequestSchemaType>;
  readonly properties?: Readonly<Record<string, RestrictedRequestSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: false | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
}

export const RestrictedRequestSchema: z.ZodType<RestrictedRequestSchema> = z.lazy(() => z.object({
  type: RequestSchemaType,
  properties: z.record(safeKey, RestrictedRequestSchema).optional(),
  required: z.array(safeKey).max(MAX_SPEC_KEYS).optional(),
  additionalProperties: z.literal(false).optional(),
  enum: z.array(z.union([z.string(), z.number().finite(), z.boolean()])).max(64).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  minLength: z.number().int().min(0).max(MAX_SPEC_STRING_LENGTH).optional(),
  maxLength: z.number().int().min(0).max(MAX_SPEC_STRING_LENGTH).optional(),
}).strict());

const InputRuleSchema = z.object({
  role: RoleSchema,
  min: z.number().int().min(0).max(MAX_FILES),
  max: z.number().int().min(0).max(MAX_FILES),
  mimeTypes: z.array(z.string().trim().min(1).max(255)).max(32).optional(),
}).strict().refine((value) => value.max >= value.min, 'Input rule maximum must not be below minimum.');

const ModelSchema = z.object({
  id: z.string().trim().min(1).max(255),
  displayName: z.string().trim().min(1).max(255),
  capabilities: ModelCapabilitiesSchema,
  requestSchema: RestrictedRequestSchema.optional(),
}).strict();

export const DeclarativeHttpSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  operations: z.array(MediaOperationSchema).min(1).max(7),
  models: z.array(ModelSchema).min(1).max(MAX_MODELS),
  inputRules: z.array(InputRuleSchema).max(5).optional(),
  submit: EndpointSchema,
  poll: EndpointSchema.optional(),
  cancel: EndpointSchema.optional(),
  connection: EndpointSchema.optional(),
  catalog: EndpointSchema.optional(),
}).strict().superRefine((value, context) => {
  const allowedOperations = new Set<string>(DECLARATIVE_OPERATIONS);
  for (const [index, operation] of value.operations.entries()) {
    if (!allowedOperations.has(operation)) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: `Operation '${operation}' is not reachable by the current input resolver.` });
    }
    if (value.operations.indexOf(operation) !== index) {
      context.addIssue({ code: 'custom', path: ['operations', index], message: 'Operations must be unique.' });
    }
  }
  const modelIds = new Set<string>();
  for (const [index, model] of value.models.entries()) {
    if (modelIds.has(model.id)) {
      context.addIssue({ code: 'custom', path: ['models', index, 'id'], message: 'Model IDs must be unique.' });
    }
    modelIds.add(model.id);
    for (const [operationIndex, operation] of model.capabilities.operations.entries()) {
      if (!allowedOperations.has(operation)) {
        context.addIssue({ code: 'custom', path: ['models', index, 'capabilities', 'operations', operationIndex], message: `Operation '${operation}' is not reachable by the current input resolver.` });
      }
      if (!value.operations.includes(operation)) {
        context.addIssue({ code: 'custom', path: ['models', index, 'capabilities', 'operations', operationIndex], message: `Operation '${operation}' is not declared by the adapter.` });
      }
    }
    if (model.capabilities.supportsBatchCount !== false || model.capabilities.maxBatchCount !== 1) {
      context.addIssue({ code: 'custom', path: ['models', index, 'capabilities'], message: 'Declarative single-result extraction requires supportsBatchCount=false and maxBatchCount=1.' });
    }
  }
  const rules = value.inputRules ?? [];
  const roles = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (roles.has(rule.role)) {
      context.addIssue({ code: 'custom', path: ['inputRules', index, 'role'], message: 'Input roles must be unique.' });
    }
    roles.add(rule.role);
    const reachableRoles = new Set<string>();
    for (const operation of value.operations) {
      if (operation === 'image.edit') reachableRoles.add('source').add('mask').add('reference');
      if (operation === 'image.generate' || operation === 'video.reference_to_video') reachableRoles.add('reference');
      if (operation === 'video.image_to_video') reachableRoles.add('first_frame');
    }
    if (!reachableRoles.has(rule.role)) {
      context.addIssue({ code: 'custom', path: ['inputRules', index, 'role'], message: `Input role '${rule.role}' is not reachable by the declared operations.` });
    }
  }
  const supportsCancel = value.models.some((model) => model.capabilities.supportsCancel === true);
  if (supportsCancel && value.cancel === undefined) {
    context.addIssue({ code: 'custom', path: ['cancel'], message: 'A cancellable model requires a cancel endpoint.' });
  }
  if (value.cancel !== undefined && !supportsCancel) {
    context.addIssue({ code: 'custom', path: ['cancel'], message: 'A cancel endpoint requires at least one model with supportsCancel=true.' });
  }
  const submitExtract = value.submit.extract;
  const submitRemoteId = submitExtract.remoteIdPath ?? submitExtract.remoteJobIdPath;
  const submitHasResult = submitExtract.resultUrlPath !== undefined || submitExtract.resultBase64Path !== undefined;
  if (submitRemoteId !== undefined && value.poll === undefined) {
    context.addIssue({ code: 'custom', path: ['poll'], message: 'A submit remote ID requires a poll endpoint.' });
  }
  if (submitRemoteId !== undefined && submitHasResult) {
    context.addIssue({ code: 'custom', path: ['submit', 'extract'], message: 'Submit cannot declare both asynchronous remote ID and synchronous result.' });
  }
  if (submitRemoteId === undefined && !submitHasResult) {
    context.addIssue({ code: 'custom', path: ['submit', 'extract'], message: 'Submit must declare a remote ID or a result path.' });
  }
  if (value.poll !== undefined) {
    if (submitRemoteId === undefined) {
      context.addIssue({ code: 'custom', path: ['poll'], message: 'A poll endpoint requires an asynchronous submit remote ID.' });
    }
    if (value.poll.extract.statusPath === undefined) {
      context.addIssue({ code: 'custom', path: ['poll', 'extract', 'statusPath'], message: 'Poll requires an explicit status path.' });
    }
    const extract = value.poll.extract;
    const mapped = [extract.successValues, extract.failureValues ?? extract.failedValues, extract.expiredValues, extract.pendingValues, extract.runningValues];
    const mappedValues = new Set<string>();
    for (const values of mapped) {
      for (const status of values ?? []) {
        if (mappedValues.has(status)) context.addIssue({ code: 'custom', path: ['poll', 'extract'], message: `Status '${status}' is mapped more than once.` });
        mappedValues.add(status);
      }
    }
    if (mappedValues.size === 0) context.addIssue({ code: 'custom', path: ['poll', 'extract'], message: 'Poll requires explicit pending/running/success/failure/expired status values.' });
  }
  for (const [name, endpoint] of Object.entries({
    submit: value.submit,
    poll: value.poll,
    cancel: value.cancel,
    connection: value.connection,
    catalog: value.catalog,
  })) {
    if (endpoint?.auth !== undefined && endpoint.auth.location !== 'header') {
      context.addIssue({ code: 'custom', path: [name, 'auth', 'location'], message: 'Secrets may only be sent in headers.' });
    }
    if (endpoint?.method === 'GET' && endpoint.body !== undefined) {
      context.addIssue({ code: 'custom', path: [name, 'body'], message: 'GET requests cannot contain a body.' });
    }
    if (endpoint?.body?.type === 'multipart' && endpoint.body.files.length === 0) {
      context.addIssue({ code: 'custom', path: [name, 'body', 'files'], message: 'Multipart requests require a file part.' });
    }
    if (endpoint?.extract.remoteIdPath !== undefined && endpoint.extract.remoteJobIdPath !== undefined) {
      context.addIssue({ code: 'custom', path: [name, 'extract'], message: 'Use only one remote ID path.' });
    }
    if (endpoint?.extract.failureValues !== undefined && endpoint.extract.failedValues !== undefined) {
      context.addIssue({ code: 'custom', path: [name, 'extract'], message: 'Use only one failure status mapping.' });
    }
    if (endpoint !== undefined && endpoint.extract.resultUrlPath !== undefined && endpoint.extract.resultBase64Path !== undefined) {
      context.addIssue({ code: 'custom', path: [name, 'extract'], message: 'An endpoint cannot declare both URL and Base64 result paths.' });
    }
    if (endpoint !== undefined && (endpoint.extract.resultUrlPath !== undefined || endpoint.extract.resultBase64Path !== undefined) && endpoint.extract.resultType === undefined) {
      context.addIssue({ code: 'custom', path: [name, 'extract', 'resultType'], message: 'Result extraction requires resultType.' });
    }
    if (endpoint?.extract.resultMimeType !== undefined && endpoint.extract.resultMimeTypePath !== undefined) {
      context.addIssue({ code: 'custom', path: [name, 'extract'], message: 'Result MIME type must be fixed or extracted, not both.' });
    }
    const statusValues = [endpoint?.extract.successValues, endpoint?.extract.failureValues ?? endpoint?.extract.failedValues, endpoint?.extract.expiredValues, endpoint?.extract.pendingValues, endpoint?.extract.runningValues].flatMap((values) => values ?? []);
    if (new Set(statusValues).size !== statusValues.length) {
      context.addIssue({ code: 'custom', path: [name, 'extract'], message: 'Status mapping values must be unique.' });
    }
  }
});

export type DeclarativeHttpSpec = z.infer<typeof DeclarativeHttpSpecSchema>;
export type DeclarativeEndpoint = z.infer<typeof EndpointSchema>;
export type DeclarativeExtract = z.infer<typeof ExtractSchema>;
export type DeclarativeBody = z.infer<typeof BodySchema>;
export type DeclarativeInputSelector = z.infer<typeof InputSelectorSchema>;
export type DeclarativeAuth = z.infer<typeof AuthSchema>;
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export function isDangerousKey(value: string): boolean {
  return DANGEROUS_KEYS.has(value);
}

export function isCredentialLikeQueryName(value: string): boolean {
  return isCredentialLikeQueryNameShared(value);
}
