import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { ProviderInput } from '@imagine/provider-contract';
import {
  MAX_GENERATION_COUNT,
  ModelCapabilitiesSchema,
  type GenerationRequest,
  type JsonValue,
} from '@imagine/shared';

import {
  MAX_FILES,
  MAX_PATH_SEGMENTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_SPEC_KEYS,
  MAX_SPEC_STRING_LENGTH,
  isCredentialLikeQueryName,
  type DeclarativeAuth,
  type DeclarativeBody,
  type DeclarativeEndpoint,
  type DeclarativeHttpSpec,
  type DeclarativeInputSelector,
  type RestrictedRequestSchema,
} from './schema.js';
import {
  DeclarativeTemplateError,
  assertAuthenticationHeaderName,
  assertHeaderName,
  assertHeaderValue,
  encodePathSegment,
  isSecretTemplate,
  resolveTemplate,
  scalarToString,
  type DeclarativeTemplateContext,
  type TemplateMode,
} from './template.js';

export class DeclarativeCompileError extends Error {
  public override readonly name = 'DeclarativeCompileError';

  public constructor(
    public readonly code:
      | 'invalid_base_url'
      | 'invalid_path'
      | 'invalid_header'
      | 'invalid_body'
      | 'invalid_input'
      | 'invalid_request'
      | 'invalid_schema'
      | 'ambiguous_result',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface CompiledFilePart {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly input: ProviderInput;
}

export type CompiledBody =
  | { readonly type: 'none' }
  | { readonly type: 'json'; readonly value: JsonValue }
  | { readonly type: 'form'; readonly fields: Readonly<Record<string, string>> }
  | {
      readonly type: 'multipart';
      readonly fields: Readonly<Record<string, string>>;
      readonly files: readonly CompiledFilePart[];
    };

export interface CompiledRequest {
  readonly method: DeclarativeEndpoint['method'];
  readonly relativePath: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: CompiledBody;
  readonly expectedStatus: readonly number[];
  readonly responseType: DeclarativeEndpoint['responseType'];
  readonly extract: DeclarativeEndpoint['extract'];
}

export interface CompileOptions {
  readonly mode?: TemplateMode;
  readonly allowedExtraFields?: ReadonlySet<string>;
  /** Injectable only for deterministic tests; production boundaries are random. */
  readonly boundaryFactory?: () => string;
}

function fail(code: DeclarativeCompileError['code'], message: string, options?: ErrorOptions): never {
  throw new DeclarativeCompileError(code, message, options);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('invalid_body', 'Prototype-related body keys are not allowed.');
    if (Object.keys(result).length >= MAX_SPEC_KEYS) fail('invalid_body', 'Body contains too many keys.');
    result[key] = child;
  }
  return result;
}

function asTemplateContext(
  request: GenerationRequest,
  context: Omit<DeclarativeTemplateContext, 'request'>,
): DeclarativeTemplateContext {
  return { ...context, request };
}

function resolvePath(
  rawPath: string,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
): string {
  if (isSecretTemplate(rawPath)) fail('invalid_path', 'Secrets may not be placed in endpoint paths.');
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\') || rawPath.includes('://') || rawPath.includes('?') || rawPath.includes('#') || rawPath.includes('%')) {
    fail('invalid_path', 'Endpoint paths must be relative URL paths without query, fragment, or traversal syntax.');
  }
  const segments = rawPath.split('/');
  if (segments.length - 1 > MAX_PATH_SEGMENTS) fail('invalid_path', 'Endpoint path contains too many segments.');
  const compiled: string[] = [''];
  for (const segment of segments.slice(1)) {
    if (segment === '' || segment === '.' || segment === '..') {
      if (segment !== '') fail('invalid_path', 'Endpoint paths cannot contain dot traversal.');
      compiled.push('');
      continue;
    }
    let value: string;
    try {
      value = scalarToString(resolveTemplate(segment, context, { mode: 'runtime', allowedExtraFields }), 'Path segment');
    } catch (error) {
      if (error instanceof DeclarativeTemplateError) fail('invalid_path', error.message, { cause: error });
      throw error;
    }
    if (value === '.' || value === '..' || value.includes('\\')) fail('invalid_path', 'Resolved endpoint path contains traversal.');
    const hasTemplate = segment.includes('{{') || segment.includes('}}');
    if (hasTemplate) compiled.push(encodePathSegment(value));
    else if (!/^[A-Za-z0-9._~-]+$/u.test(value)) fail('invalid_path', 'Static endpoint path contains unsupported characters.');
    else compiled.push(value);
  }
  return compiled.join('/');
}

function resolveScalar(
  value: string | number | boolean | null,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
  label: string,
): string | number | boolean | null {
  try {
    return resolveTemplate(value, asTemplateContext(context.request, context), { mode, allowedExtraFields });
  } catch (error) {
    if (error instanceof DeclarativeTemplateError) fail('invalid_body', `${label} template is invalid.`, { cause: error });
    throw error;
  }
}

function compileJsonNode(
  value: unknown,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
  depth = 0,
): JsonValue {
  if (depth > 12) fail('invalid_body', 'JSON body is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'string' && isSecretTemplate(value)) fail('invalid_body', 'Secrets may only be sent through header authentication.');
    return resolveScalar(value, context, allowedExtraFields, mode, 'JSON body') as JsonValue;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) fail('invalid_body', 'JSON body array is too large.');
    return value.map((child) => compileJsonNode(child, context, allowedExtraFields, mode, depth + 1));
  }
  if (!isRecord(value)) fail('invalid_body', 'JSON body must contain JSON values only.');
  const output = safeRecord(value);
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(output)) result[key] = compileJsonNode(child, context, allowedExtraFields, mode, depth + 1);
  return result;
}

function compileStringMap(
  values: Readonly<Record<string, string | number | boolean | null>> | undefined,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
  label: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, raw] of Object.entries(values ?? {})) {
    if (isSecretTemplate(String(raw)) && label !== 'header') fail('invalid_body', 'Secrets may only be sent through headers.');
    const value = resolveScalar(raw, context, allowedExtraFields, mode, label);
    result[name] = scalarToString(value, label);
  }
  return result;
}

function findInput(
  selector: DeclarativeInputSelector,
  inputs: readonly ProviderInput[] | undefined,
): ProviderInput {
  if (inputs === undefined) fail('invalid_input', 'This request requires loaded provider inputs.');
  const matching = inputs.filter((input) => input.role === selector.role);
  if (matching.length > MAX_FILES || matching[selector.index] === undefined) fail('invalid_input', `Input ${selector.role}[${selector.index}] is unavailable.`);
  return matching[selector.index]!;
}

function compileBody(
  body: DeclarativeBody | undefined,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
): CompiledBody {
  if (body === undefined) return { type: 'none' };
  if (body.type === 'json') return { type: 'json', value: compileJsonNode(body.value, context, allowedExtraFields, mode) };
  if (body.type === 'form') return { type: 'form', fields: compileStringMap(body.fields, context, allowedExtraFields, mode, 'form') };
  const fields = compileStringMap(body.fields, context, allowedExtraFields, mode, 'multipart');
  const files = body.files.map((file) => {
    const input = findInput(file.input, context.inputs);
    if (file.filename !== undefined && isSecretTemplate(String(file.filename))) fail('invalid_input', 'Secrets may not be placed in filenames.');
    const filename = scalarToString(
      resolveScalar(file.filename ?? input.filename ?? `${input.assetId}.bin`, context, allowedExtraFields, mode, 'filename'),
      'filename',
    );
    if (!filename || filename.length > MAX_SPEC_STRING_LENGTH || /[\r\n\\/]/u.test(filename)) fail('invalid_input', 'Multipart filename is invalid.');
    const contentType = file.contentType ?? input.mimeType;
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(contentType)) fail('invalid_input', 'Multipart content type is invalid.');
    return { contentType, field: file.field, filename, input };
  });
  return { type: 'multipart', fields, files };
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

const ALLOWED_IMAGE_MIMES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

function validateCapabilityOptions(
  capabilities: ReturnType<typeof ModelCapabilitiesSchema.parse>,
  request: GenerationRequest,
): void {
  if (request.count !== undefined && (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > MAX_GENERATION_COUNT)) {
    fail('invalid_request', 'Requested batch count is outside the safety limit.');
  }
  if (request.count !== undefined && request.count > 1) fail('invalid_request', 'Declarative adapters produce one result and do not support batch count above one.');
  if (request.aspectRatio !== undefined && capabilities.aspectRatios !== undefined && !capabilities.aspectRatios.includes(request.aspectRatio)) {
    fail('invalid_request', 'Requested aspect ratio is not supported by this model.');
  }
  if (request.aspectRatio !== undefined && capabilities.aspectRatios === undefined) {
    fail('invalid_request', 'This model does not declare aspect ratio support.');
  }
  if (request.resolution !== undefined && capabilities.resolutions !== undefined && !capabilities.resolutions.includes(request.resolution)) {
    fail('invalid_request', 'Requested resolution is not supported by this model.');
  }
  if (request.resolution !== undefined && capabilities.resolutions === undefined) {
    fail('invalid_request', 'This model does not declare resolution support.');
  }
  if (request.width !== undefined || request.height !== undefined) {
    if (request.width === undefined || request.height === undefined || !Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height)) {
      fail('invalid_request', 'Width and height must be supplied together as safe integers.');
    }
    if (capabilities.resolutions === undefined || !capabilities.resolutions.includes(`${request.width}x${request.height}`)) {
      fail('invalid_request', 'Requested dimensions are not supported by this model.');
    }
  }
  if (request.durationSeconds !== undefined) {
    if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0) fail('invalid_request', 'Duration must be a finite positive number.');
    const durations = capabilities.durations;
    if (durations === undefined) fail('invalid_request', 'This model does not declare duration support.');
    if (Array.isArray(durations) && !durations.includes(request.durationSeconds)) fail('invalid_request', 'Requested duration is not supported by this model.');
    if (!Array.isArray(durations) && (request.durationSeconds < durations.min || request.durationSeconds > durations.max)) fail('invalid_request', 'Requested duration is outside this model range.');
  }
}

function validateOperationInputs(
  capabilities: ReturnType<typeof ModelCapabilitiesSchema.parse>,
  request: GenerationRequest,
  inputs: readonly ProviderInput[] | undefined,
): void {
  const count = (role: ProviderInput['role']) => request.inputs.filter((input) => input.role === role).length;
  const roles = new Set(request.inputs.map((input) => input.role));
  if (new Set(request.inputs.map((input) => input.assetId)).size !== request.inputs.length) fail('invalid_input', 'An asset may only appear once in a declarative request.');
  if (request.operation === 'image.generate' && [...roles].some((role) => role !== 'reference')) fail('invalid_input', 'image.generate only accepts reference inputs.');
  if (request.operation === 'video.generate' && request.inputs.length > 0) fail('invalid_input', 'video.generate does not accept input assets.');
  if (request.operation === 'video.image_to_video' && (count('first_frame') !== 1 || request.inputs.some((input) => input.role !== 'first_frame'))) fail('invalid_input', 'video.image_to_video requires exactly one first_frame input.');
  if (request.operation === 'video.reference_to_video' && (count('reference') < 1 || request.inputs.some((input) => input.role !== 'reference'))) fail('invalid_input', 'video.reference_to_video requires reference inputs only.');
  if (request.operation === 'image.edit') {
    if (count('source') !== 1 || count('first_frame') > 0 || count('last_frame') > 0) fail('invalid_input', 'image.edit requires one source and no frame inputs.');
    if (count('mask') > 1) fail('invalid_input', 'image.edit accepts at most one mask.');
    if (count('mask') > 0 && capabilities.supportsMask !== true) fail('invalid_input', 'This model does not support mask inputs.');
  }
  if (inputs === undefined) {
    return;
  }
  for (const requested of request.inputs) {
    const loaded = inputs.find((input) => input.assetId === requested.assetId && input.role === requested.role);
    if (loaded === undefined) fail('invalid_input', `Loaded input '${requested.assetId}' does not match the request.`);
    const mime = normalizeMimeType(loaded.mimeType);
    if (!ALLOWED_IMAGE_MIMES.has(mime)) fail('invalid_input', 'Custom declarative inputs must be validated allowed images.');
    const width = loaded.width;
    const height = loaded.height;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('invalid_input', 'Loaded image dimensions are invalid.');
    const fileSize = loaded.fileSize ?? loaded.bytes.byteLength;
    if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize !== loaded.bytes.byteLength) fail('invalid_input', 'Loaded input file size is invalid.');
    if (!Number.isSafeInteger(width * height)) fail('invalid_input', 'Loaded image pixel count is invalid.');
    const constraints = capabilities.inputImageConstraints;
    if (constraints?.mimeTypes !== undefined && !constraints.mimeTypes.some((candidate) => normalizeMimeType(candidate) === mime)) fail('invalid_input', 'Loaded input MIME type is not supported.');
    if (constraints?.maxBytes !== undefined && fileSize > constraints.maxBytes) fail('invalid_input', 'Loaded input exceeds the byte limit.');
    if (constraints?.maxWidth !== undefined && width > constraints.maxWidth) fail('invalid_input', 'Loaded input exceeds the width limit.');
    if (constraints?.maxHeight !== undefined && height > constraints.maxHeight) fail('invalid_input', 'Loaded input exceeds the height limit.');
    if (constraints?.maxPixels !== undefined && width * height > constraints.maxPixels) fail('invalid_input', 'Loaded input exceeds the pixel limit.');
  }
  const source = inputs.find((input) => input.assetId === request.inputs.find((item) => item.role === 'source')?.assetId);
  const mask = inputs.find((input) => input.assetId === request.inputs.find((item) => item.role === 'mask')?.assetId);
  if (mask !== undefined) {
    if (source === undefined || normalizeMimeType(mask.mimeType) !== 'image/png' || mask.parentAssetId !== source.assetId || mask.width !== source.width || mask.height !== source.height) {
      fail('invalid_input', 'Mask must be a PNG matching the source image relationship and dimensions.');
    }
  }
}

function compileHeaders(
  endpoint: DeclarativeEndpoint,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const names = new Set<string>();
  for (const [name, raw] of Object.entries(endpoint.headers ?? {})) {
    try {
      assertHeaderName(name);
      const normalized = name.toLowerCase();
      if (names.has(normalized)) fail('invalid_header', 'Header names must be unique case-insensitively.');
      names.add(normalized);
      const value = scalarToString(resolveScalar(raw, context, allowedExtraFields, mode, 'header'), 'Header value');
      assertHeaderValue(value);
      result[name] = value;
    } catch (error) {
      if (error instanceof DeclarativeTemplateError || error instanceof DeclarativeCompileError) fail('invalid_header', 'Declarative header is invalid.', { cause: error });
      throw error;
    }
  }
  if (endpoint.auth !== undefined) {
    const auth = compileAuth(endpoint.auth, context, mode);
    const name = auth.name.toLowerCase();
    if (Object.keys(result).some((header) => header.toLowerCase() === name)) fail('invalid_header', 'Authentication header cannot be overridden.');
    result[auth.name] = auth.value;
  }
  return result;
}

function compileAuth(
  auth: DeclarativeAuth,
  context: DeclarativeTemplateContext,
  mode: TemplateMode,
): { name: string; value: string } {
  const name = auth.name ?? (auth.type === 'bearer' ? 'Authorization' : 'X-API-Key');
  try {
    assertAuthenticationHeaderName(name);
  } catch (error) {
    fail('invalid_header', 'Authentication header name is protected or invalid.', { cause: error });
  }
  const configuredSecret = context.secrets?.[auth.secretRef];
  if (configuredSecret === undefined || configuredSecret.length === 0) fail('invalid_header', `Authentication secret '${auth.secretRef}' is unavailable.`);
  const secret = mode === 'redacted' ? '[REDACTED]' : configuredSecret;
  const value = mode === 'redacted' ? '[REDACTED]' : auth.type === 'bearer' ? `Bearer ${secret}` : secret;
  assertHeaderValue(value);
  return { name, value };
}

function compileQuery(
  endpoint: DeclarativeEndpoint,
  context: DeclarativeTemplateContext,
  allowedExtraFields: ReadonlySet<string>,
  mode: TemplateMode,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, raw] of Object.entries(endpoint.query ?? {})) {
    if (isSecretTemplate(String(raw))) fail('invalid_header', 'Secrets may not be placed in query parameters.');
    if (name.length > 256 || /[\r\n[\]#?]/u.test(name) || !/^[A-Za-z0-9._~-]+$/u.test(name)) fail('invalid_header', 'Query parameter name is invalid.');
    if (isCredentialLikeQueryName(name)) fail('invalid_header', 'Credential-like query parameter names are not allowed.');
    result[name] = scalarToString(resolveScalar(raw, context, allowedExtraFields, mode, 'query'), 'Query value');
  }
  return result;
}

function assertEndpointShape(endpoint: DeclarativeEndpoint): void {
  const extract = endpoint.extract;
  if (extract.resultUrlPath !== undefined && extract.resultBase64Path !== undefined) fail('ambiguous_result', 'An endpoint cannot extract both a result URL and Base64 result.');
  if ((extract.resultUrlPath !== undefined || extract.resultBase64Path !== undefined) && extract.resultType === undefined) fail('ambiguous_result', 'Result extraction requires resultType.');
  if (extract.resultMimeType !== undefined && extract.resultMimeTypePath !== undefined) fail('ambiguous_result', 'Result MIME type must be fixed or extracted, not both.');
  if (endpoint.method === 'GET' && endpoint.body !== undefined) fail('invalid_body', 'GET endpoints cannot contain a body.');
  if (endpoint.body?.type === 'multipart' && endpoint.body.files.length > MAX_FILES) fail('invalid_body', 'Multipart contains too many files.');
}

function allowedExtraFields(model: DeclarativeHttpSpec['models'][number]): ReadonlySet<string> {
  const properties = model.requestSchema?.properties;
  return new Set(properties === undefined ? [] : Object.keys(properties));
}

function validateRestrictedSchema(
  schema: RestrictedRequestSchema,
  value: unknown,
  path: readonly string[] = [],
  depth = 0,
): void {
  if (depth > 12) fail('invalid_schema', `Request schema is too deeply nested at ${path.join('.')}.`);
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) fail('invalid_request', `Request value at ${path.join('.')} is outside the enum.`);
  if (schema.type === 'object') {
    if (!isRecord(value)) fail('invalid_request', `Request value at ${path.join('.')} must be an object.`);
    const properties = schema.properties ?? {};
    const keys = Object.keys(value);
    if (keys.length > MAX_SPEC_KEYS) fail('invalid_request', 'Request parameter object has too many keys.');
    if (schema.additionalProperties !== false && keys.some((key) => !Object.hasOwn(properties, key))) fail('invalid_schema', 'Request schemas must set additionalProperties to false.');
    if (keys.some((key) => !Object.hasOwn(properties, key))) fail('invalid_request', `Unknown request parameter '${keys.find((key) => !Object.hasOwn(properties, key))}'.`);
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) fail('invalid_request', `Missing request parameter '${required}'.`);
    for (const [key, child] of Object.entries(value)) validateRestrictedSchema(properties[key]!, child, [...path, key], depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('invalid_request', `Request value at ${path.join('.')} must be a string.`);
    if (value.length > MAX_SPEC_STRING_LENGTH) fail('invalid_request', `Request value at ${path.join('.')} is too long.`);
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('invalid_request', `Request value at ${path.join('.')} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('invalid_request', `Request value at ${path.join('.')} is too long.`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_request', `Request value at ${path.join('.')} must be a finite number.`);
    if (schema.min !== undefined && value < schema.min) fail('invalid_request', `Request value at ${path.join('.')} is below minimum.`);
    if (schema.max !== undefined && value > schema.max) fail('invalid_request', `Request value at ${path.join('.')} is above maximum.`);
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_request', `Request value at ${path.join('.')} must be a safe integer.`);
    if (schema.min !== undefined && value < schema.min) fail('invalid_request', `Request value at ${path.join('.')} is below minimum.`);
    if (schema.max !== undefined && value > schema.max) fail('invalid_request', `Request value at ${path.join('.')} is above maximum.`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') {
    fail('invalid_request', `Request value at ${path.join('.')} must be a boolean.`);
  }
}

function assertRestrictedSchemaShape(
  schema: RestrictedRequestSchema,
  depth = 0,
): void {
  if (depth > 12) fail('invalid_schema', 'Request schema is too deeply nested.');
  const propertyNames = Object.keys(schema.properties ?? {});
  if (propertyNames.length > MAX_SPEC_KEYS) fail('invalid_schema', 'Request schema has too many properties.');
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) fail('invalid_schema', 'Object request schemas must set additionalProperties to false.');
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length || required.some((key) => !propertyNames.includes(key))) fail('invalid_schema', 'Request schema required keys must be unique declared properties.');
    for (const child of Object.values(schema.properties ?? {})) assertRestrictedSchemaShape(child, depth + 1);
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    fail('invalid_schema', 'Only object request schemas may declare properties or required fields.');
  }
  if (schema.type === 'object' && schema.enum !== undefined) fail('invalid_schema', 'Object request schemas cannot declare enum values.');
  if (schema.type === 'string' && schema.enum?.some((value) => typeof value !== 'string')) fail('invalid_schema', 'String request schemas require string enum values.');
  if ((schema.type === 'number' || schema.type === 'integer') && schema.enum?.some((value) => typeof value !== 'number')) fail('invalid_schema', 'Numeric request schemas require numeric enum values.');
  if (schema.type === 'boolean' && schema.enum?.some((value) => typeof value !== 'boolean')) fail('invalid_schema', 'Boolean request schemas require boolean enum values.');
  if (schema.type === 'string' && (schema.min !== undefined || schema.max !== undefined)) fail('invalid_schema', 'String request schemas may not declare numeric bounds.');
  if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined)) fail('invalid_schema', 'Only string request schemas may declare length bounds.');
  if (schema.type !== 'number' && schema.type !== 'integer' && schema.min !== undefined) fail('invalid_schema', 'Only numeric request schemas may declare min.');
  if (schema.type !== 'number' && schema.type !== 'integer' && schema.max !== undefined) fail('invalid_schema', 'Only numeric request schemas may declare max.');
  if (schema.type === 'integer' && schema.enum?.some((value) => !Number.isSafeInteger(value))) fail('invalid_schema', 'Integer request schemas require safe integer enum values.');
  if (schema.min !== undefined && schema.max !== undefined && schema.max < schema.min) fail('invalid_schema', 'Request schema maximum must not be below minimum.');
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.maxLength < schema.minLength) fail('invalid_schema', 'Request schema maxLength must not be below minLength.');
}

export function validateDeclarativeRequest(
  spec: DeclarativeHttpSpec,
  request: GenerationRequest,
): DeclarativeHttpSpec['models'][number] {
  if (request.providerId.length > MAX_SPEC_STRING_LENGTH || request.modelId.length > MAX_SPEC_STRING_LENGTH) fail('invalid_request', 'Request provider or model ID is too long.');
  if (request.prompt.length > MAX_SPEC_STRING_LENGTH) fail('invalid_request', 'Request prompt is too long.');
  if (!spec.operations.includes(request.operation)) fail('invalid_request', `Operation '${request.operation}' is not declared by this adapter.`);
  const model = spec.models.find((candidate) => candidate.id === request.modelId);
  if (model === undefined) fail('invalid_request', `Model '${request.modelId}' is not declared by this adapter.`);
  const capabilities = ModelCapabilitiesSchema.parse(model.capabilities);
  if (request.operation === 'video.edit' || request.operation === 'video.extend') fail('invalid_request', `Operation '${request.operation}' is not reachable by the current input runtime.`);
  if (!capabilities.operations.includes(request.operation)) fail('invalid_request', `Model '${request.modelId}' does not support '${request.operation}'.`);
  validateCapabilityOptions(capabilities, request);
  if (request.count !== undefined && (capabilities.maxBatchCount !== 1 || request.count > 1)) fail('invalid_request', 'Requested batch count is not supported by this single-result adapter.');
  const references = request.inputs.filter((input) => input.role === 'reference').length;
  if (capabilities.maxReferenceImages !== undefined && references > capabilities.maxReferenceImages) fail('invalid_input', 'Request contains too many reference images.');
  if (request.inputs.some((input) => input.role === 'mask') && capabilities.supportsMask !== true) fail('invalid_input', 'This model does not support mask inputs.');
  if (request.negativePrompt !== undefined && capabilities.supportsNegativePrompt !== true) fail('invalid_request', 'This model does not support negative prompts.');
  if (request.seed !== undefined && capabilities.supportsSeed !== true) fail('invalid_request', 'This model does not support seeds.');
  if (request.audio !== undefined && capabilities.supportsAudio !== true) fail('invalid_request', 'This model does not support audio.');
  if (request.extra !== undefined && !isRecord(request.extra)) fail('invalid_request', 'Request extra parameters must be an object.');
  if (model.requestSchema !== undefined) assertRestrictedSchemaShape(model.requestSchema);
  if (request.extra !== undefined) {
    if (model.requestSchema === undefined) fail('invalid_request', 'This model does not declare extra request parameters.');
    validateRestrictedSchema(model.requestSchema, request.extra);
  }
  if (request.inputs.length > MAX_FILES) fail('invalid_input', 'Request contains too many input assets.');
  validateOperationInputs(capabilities, request, undefined);
  for (const rule of spec.inputRules ?? []) {
    const count = request.inputs.filter((input) => input.role === rule.role).length;
    if (count < rule.min || count > rule.max) fail('invalid_input', `Input role '${rule.role}' is outside its cardinality bounds.`);
  }
  const declaredRoles = new Set((spec.inputRules ?? []).map((rule) => rule.role));
  if (declaredRoles.size > 0 && request.inputs.some((input) => !declaredRoles.has(input.role))) fail('invalid_input', 'Request contains an undeclared input role.');
  return model;
}

export function compileEndpoint(
  endpoint: DeclarativeEndpoint,
  request: GenerationRequest,
  context: Omit<DeclarativeTemplateContext, 'request'>,
  options: CompileOptions = {},
): CompiledRequest {
  assertEndpointShape(endpoint);
  const allowed = options.allowedExtraFields ?? new Set<string>();
  const relativePath = resolvePath(endpoint.path, asTemplateContext(request, context), allowed);
  const headers = compileHeaders(endpoint, asTemplateContext(request, context), allowed, options.mode ?? 'runtime');
  const query = compileQuery(endpoint, asTemplateContext(request, context), allowed, options.mode ?? 'runtime');
  const body = compileBody(endpoint.body, asTemplateContext(request, context), allowed, options.mode ?? 'runtime');
  if (endpoint.method === 'GET' && body.type !== 'none') fail('invalid_body', 'GET endpoints cannot contain a body.');
  if (body.type === 'json') headers['Content-Type'] = 'application/json';
  if (body.type === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (body.type === 'multipart') headers['Content-Type'] = 'multipart/form-data';
  return {
    body,
    expectedStatus: endpoint.expectedStatus,
    extract: endpoint.extract,
    headers,
    method: endpoint.method,
    query,
    relativePath,
    responseType: endpoint.responseType,
  };
}

export function compileDeclarativeRequest(
  spec: DeclarativeHttpSpec,
  request: GenerationRequest,
  context: Omit<DeclarativeTemplateContext, 'request'>,
  endpoint: DeclarativeEndpoint = spec.submit,
  options: CompileOptions = {},
): CompiledRequest {
  const model = validateDeclarativeRequest(spec, request);
  if (request.inputs.length > 0 && context.inputs === undefined) fail('invalid_input', 'This request requires loaded provider inputs.');
  const allowed = allowedExtraFields(model);
  const endpointContext = asTemplateContext(request, context);
  validateOperationInputs(ModelCapabilitiesSchema.parse(model.capabilities), request, context.inputs);
  const compiled = compileEndpoint(endpoint, request, endpointContext, { ...options, allowedExtraFields: allowed });
  for (const rule of spec.inputRules ?? []) {
    const inputs = context.inputs?.filter((input) => input.role === rule.role) ?? [];
    if (inputs.some((input) => rule.mimeTypes !== undefined && !rule.mimeTypes.some((mime) => normalizeMimeType(mime) === normalizeMimeType(input.mimeType)))) {
      fail('invalid_input', `Input role '${rule.role}' contains an unsupported MIME type.`);
    }
  }
  return compiled;
}

export function assertDeclarativeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch (error) {
    fail('invalid_base_url', 'Provider Base URL is invalid.', { cause: error });
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    fail('invalid_base_url', 'Provider Base URL must use HTTP or HTTPS without credentials, query, or fragment.');
  }
  return url;
}

export function encodeCompiledBody(
  body: CompiledBody,
  boundaryFactory?: () => string,
): { readonly body?: string; readonly bodyBytes?: Uint8Array; readonly contentType?: string } {
  if (body.type === 'none') return {};
  if (body.type === 'json') {
    const value = JSON.stringify(body.value);
    if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BODY_BYTES) fail('invalid_body', 'JSON request body exceeds the safety limit.');
    return { body: value, contentType: 'application/json' };
  }
  if (body.type === 'form') {
    const encoded = new URLSearchParams(body.fields).toString();
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BODY_BYTES) fail('invalid_body', 'Form request body exceeds the safety limit.');
    return { body: encoded, contentType: 'application/x-www-form-urlencoded' };
  }
  const boundary = boundaryFactory?.() ?? `----imagine-custom-http-v1-${randomUUID()}`;
  if (!/^[A-Za-z0-9'()+_,-./:=?]{1,70}$/u.test(boundary) || /[\r\n]/u.test(boundary)) fail('invalid_body', 'Multipart boundary is invalid.');
  const boundaryBytes = new TextEncoder().encode(boundary);
  const containsBoundary = (bytes: Uint8Array): boolean => {
    if (bytes.length < boundaryBytes.length) return false;
    outer: for (let start = 0; start <= bytes.length - boundaryBytes.length; start += 1) {
      for (let index = 0; index < boundaryBytes.length; index += 1) if (bytes[start + index] !== boundaryBytes[index]) continue outer;
      return true;
    }
    return false;
  };
  for (const [name, value] of Object.entries(body.fields)) {
    if (name.includes(boundary) || value.includes(boundary)) fail('invalid_body', 'Multipart boundary collides with a field.');
  }
  for (const file of body.files) {
    if (file.field.includes(boundary) || file.filename.includes(boundary) || file.contentType.includes(boundary) || containsBoundary(file.input.bytes)) fail('invalid_body', 'Multipart boundary collides with a file part.');
  }
  const chunks: Uint8Array[] = [];
  const append = (value: string) => chunks.push(new TextEncoder().encode(value));
  for (const [name, value] of Object.entries(body.fields)) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipart(name)}"\r\n\r\n${value}\r\n`);
  }
  for (const file of body.files) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipart(file.field)}"; filename="${escapeMultipart(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`);
    chunks.push(file.input.bytes);
    append('\r\n');
  }
  append(`--${boundary}--\r\n`);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  if (total > MAX_REQUEST_BODY_BYTES) fail('invalid_body', 'Multipart request body exceeds the safety limit.');
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bodyBytes: output, contentType: `multipart/form-data; boundary=${boundary}` };
}

function escapeMultipart(value: string): string {
  return value.replace(/["\\\r\n]/gu, '_');
}
