import { Buffer } from 'node:buffer';

import {
  AdapterDocumentFormatSchema,
  EmptyQuerySchema,
  CustomAdapterCapabilityPreviewRequestSchema,
  CustomAdapterCapabilityPreviewResponseSchema,
  CustomAdapterCompiledPreviewSchema,
  CustomAdapterDocumentSchema,
  CustomAdapterDefinitionDtoSchema,
  CustomAdapterDefinitionPageSchema,
  CustomAdapterDefinitionResponseSchema,
  CustomAdapterExportQuerySchema,
  CustomAdapterImportQuerySchema,
  CustomAdapterDryRunResponseSchema,
  CustomAdapterExtractedResponseSchema,
  CustomAdapterExportResponseSchema,
  CustomAdapterMockResponseSchema,
  CustomAdapterPathTestRequestSchema,
  CustomAdapterPathTestResponseSchema,
  CustomAdapterPreviewRequestSchema,
  CustomAdapterRefSchema,
  CustomAdapterRevisionListQuerySchema,
  CustomAdapterSimulateRequestSchema,
  CustomAdapterValidateRequestSchema,
  CustomAdapterValidationResponseSchema,
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
  ProviderIdValueSchema,
  ProviderIdParamsSchema,
  TrustedAdapterBindingDtoSchema,
  TrustedAdapterBindingPageSchema,
  TrustedAdapterBindingResponseSchema,
  TrustedAdapterDisableBodySchema,
  TrustedAdapterPageSchema,
  TrustedAdapterManagementDtoSchema,
  TrustedAdapterRefSchema,
  TrustedAdapterRevisionQuerySchema,
  TrustedAdapterRevisionListQuerySchema,
  TrustedAdapterUnbindQuerySchema,
  TrustedAdapterResponseSchema,
  TrustedAdapterBindRequestSchema,
  AdapterIdParamsSchema,
  BoundedJsonValueSchema,
  GenerationRequestSchema,
  type CustomAdapterRef,
} from '@imagine/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  MAX_ADAPTER_SOURCE_BYTES,
  MAX_MANIFEST_BYTES,
  parseAdapterManifest,
  parseBoundedManifestJson,
} from '../adapters/index.js';
import { decodePageCursor, encodePageCursor } from '../database/pagination.js';
import {
  CustomAdapterServiceError,
  type CustomAdapterExportFormat,
  type CustomAdapterService,
  type CustomAdapterServiceErrorCode,
} from '../services/custom-adapter-service.js';
import {
  TrustedAdapterServiceError,
  type TrustedAdapterBindingDto as TrustedServiceBindingDto,
  type TrustedAdapterManagementDto,
  type TrustedAdapterService,
  type TrustedAdapterServiceErrorCode,
} from '../services/trusted-adapter-service.js';

const DECLARATIVE_FORMAT = AdapterDocumentFormatSchema;
const DOCUMENT = CustomAdapterDocumentSchema;
const REF = CustomAdapterRefSchema;
const TRUSTED_REF = TrustedAdapterRefSchema;
const PROVIDER_ID = ProviderIdSchema;
const TRUSTED_UNBIND_QUERY_SCHEMA = z.union([EmptyQuerySchema, TrustedAdapterUnbindQuerySchema]);

// Provider-scoped routes inject the path provider id after parsing these
// shared schemas, so a body cannot silently target another Provider.
const DraftBodySchema = z.object({
  ref: REF.optional(),
  document: DOCUMENT.optional(),
  format: DECLARATIVE_FORMAT.optional(),
}).strict();
const ValidateBodySchema = z.object({
  document: DOCUMENT,
  format: DECLARATIVE_FORMAT.optional(),
  request: GenerationRequestSchema.optional(),
  baseUrl: z.string().min(1).max(2_048).optional(),
}).strict();
const PreviewBodySchema = z.object({
  ref: REF.optional(),
  request: GenerationRequestSchema.optional(),
  endpoint: z.enum(['submit', 'poll', 'cancel', 'connection', 'catalog']).optional(),
  baseUrl: z.string().min(1).max(2_048).optional(),
  document: DOCUMENT.optional(),
  format: DECLARATIVE_FORMAT.optional(),
}).strict();
const SimulateBodySchema = z.object({
  ref: REF.optional(),
  endpoint: z.enum(['submit', 'poll', 'cancel', 'connection', 'catalog']).optional(),
  phase: z.enum(['submit', 'poll', 'cancel', 'connection', 'catalog']).optional(),
  response: CustomAdapterMockResponseSchema,
  expectedRemoteJobId: z.string().min(1).max(255).optional(),
  document: DOCUMENT.optional(),
  format: DECLARATIVE_FORMAT.optional(),
}).strict();
const PathTestBodySchema = z.object({
  ref: REF.optional(),
  path: z.string().min(1).max(512).startsWith('/'),
  document: DOCUMENT.optional(),
  response: CustomAdapterMockResponseSchema.optional(),
  json: BoundedJsonValueSchema.optional(),
  text: z.string().max(2 * 1024 * 1024).optional(),
  format: DECLARATIVE_FORMAT.optional(),
}).strict().refine(
  (value) => value.document !== undefined || value.response !== undefined || value.json !== undefined || value.text !== undefined,
  'A path test document is required.',
);
const previewResponseSchema = z.object({
  ...CustomAdapterCompiledPreviewSchema.shape,
  capabilities: ProviderCapabilitiesSchema,
}).strict();

function extractedDto(value: unknown): unknown {
  const cloned = cloneDates(value);
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) throw new Error('Extracted response is invalid.');
  const result = cloned as Record<string, unknown>;
  if (result.state === 'completed' && Array.isArray(result.assets)) {
    result.assets = result.assets.map((candidate) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Extracted asset is invalid.');
      const asset = candidate as Record<string, unknown>;
      if (!Object.hasOwn(asset, 'source')) return asset;
      const source = asset.source;
      if (source !== 'url' && source !== 'base64' && source !== 'provider') throw new Error('Extracted asset source is invalid.');
      const { source: _source, ...safeAsset } = asset;
      return safeAsset;
    });
  }
  return CustomAdapterExtractedResponseSchema.parse(result);
}

function dryRunDto(value: unknown): unknown {
  const cloned = cloneJson(value);
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) throw new Error('Custom adapter dry-run response is invalid.');
  const result = cloned as Record<string, unknown>;
  const stripCapabilities = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Custom adapter dry-run request is invalid.');
    const { capabilities: _ignored, ...compiled } = candidate as Record<string, unknown>;
    return compiled;
  };
  return CustomAdapterDryRunResponseSchema.parse({
    ...result,
    request: stripCapabilities(result.request),
    preview: stripCapabilities(result.preview),
  });
}

type TrustedService = Pick<
  TrustedAdapterService,
  | 'bind'
  | 'get'
  | 'getBinding'
  | 'getCurrentOrDisabledBinding'
  | 'install'
  | 'list'
  | 'listBindings'
  | 'disableBinding'
  | 'remove'
  | 'unbind'
>;
type CustomService = Pick<
  CustomAdapterService,
  | 'capabilities'
  | 'delete'
  | 'disable'
  | 'dryRun'
  | 'export'
  | 'get'
  | 'list'
  | 'preview'
  | 'replace'
  | 'simulateResponse'
  | 'testPath'
  | 'validate'
>;

/**
 * Adapter routes intentionally accept a few service aliases. This keeps the
 * registration seam stable while the server composition is assembled, but
 * all operations still go through the two management services.
 */
export interface AdapterRoutesOptions {
  trusted?: TrustedService;
  trustedAdapters?: TrustedService;
  trustedAdapterService?: TrustedService;
  custom?: CustomService;
  customAdapters?: CustomService;
  customAdapterService?: CustomService;
  declarative?: CustomService;
  declarativeAdapters?: CustomService;
}

const SERVICE_MESSAGES: Readonly<Record<string, string>> = {
  administrator_required: 'Administrator authorization is required for adapter management.',
  invalid_request: 'The adapter management request is invalid.',
  invalid_manifest: 'The trusted adapter manifest is invalid.',
  invalid_source: 'The trusted adapter source is invalid.',
  source_too_large: 'The trusted adapter source exceeds the size limit.',
  manifest_too_large: 'The trusted adapter manifest exceeds the size limit.',
  digest_mismatch: 'The adapter source digest does not match its manifest.',
  already_exists: 'The adapter revision already exists.',
  adapter_id_immutable: 'The adapter id is immutable across revisions.',
  disabled_revision: 'Disabled trusted adapter revisions cannot be rebound.',
  not_found: 'The adapter was not found.',
  adapter_not_found: 'The adapter was not found.',
  provider_not_found: 'The Provider was not found.',
  provider_type_mismatch: 'The Provider type does not accept this adapter.',
  provider_adapter_kind_mismatch: 'The adapter kind does not match the Provider.',
  manifest_mismatch: 'The installed adapter manifest does not match the requested revision.',
  adapter_references_in_use: 'The adapter is still referenced and cannot be removed.',
  adapter_references_unavailable: 'Adapter references could not be verified.',
  referenced_jobs: 'The adapter is referenced by a retained Job.',
  referenced_definitions: 'The adapter is referenced by a retained definition.',
  tombstoned: 'The adapter id is no longer available.',
  invalid_format: 'The adapter document format is invalid.',
  invalid_json: 'The adapter document is invalid JSON.',
  invalid_yaml: 'The adapter document is invalid YAML.',
  unsafe_document: 'The adapter document is unsafe.',
  schema_invalid: 'The adapter document schema is invalid.',
  invalid_definition: 'The adapter definition is invalid.',
  definition_too_large: 'The adapter definition exceeds the size limit.',
  input_too_large: 'The adapter document exceeds the size limit.',
  invalid_reference: 'The adapter reference is invalid.',
  invalid_base_url: 'The adapter Base URL is invalid.',
  invalid_path: 'The adapter response path is invalid.',
  invalid_response: 'The mock adapter response is invalid.',
  invalid_header: 'The adapter header is invalid.',
  invalid_body: 'The adapter request body is invalid.',
  response_too_large: 'The mock adapter response exceeds the size limit.',
  invalid_input: 'The adapter input is invalid.',
  invalid_schema: 'The adapter schema is invalid.',
  ambiguous_result: 'The adapter result mapping is ambiguous.',
  unsupported_result: 'The adapter result is unsupported.',
  persisted_invalid: 'The stored adapter definition is invalid.',
  storage_error: 'The adapter operation could not be completed.',
  outbox_unavailable: 'The adapter change event could not be published.',
  outbox_failure: 'The adapter change event could not be published.',
  definition_failure: 'The adapter definition could not be persisted.',
  store_failure: 'The trusted adapter store operation could not be completed.',
  rollback_failed: 'The trusted adapter installation could not be rolled back.',
};

const KNOWN_SERVICE_CODES = new Set([
  ...Object.keys(SERVICE_MESSAGES),
]);

const INVALID_MULTIPART = {
  error: 'invalid_multipart',
  message: 'The trusted adapter multipart request is invalid.',
} as const;

const UNSUPPORTED_MEDIA = {
  error: 'unsupported_media_type',
  message: 'The adapter document media type is not supported.',
} as const;

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: 'invalid_request',
    message: 'The request does not match the internal adapter API contract.',
  });
}

function unsupportedMedia(reply: FastifyReply): FastifyReply {
  return reply.code(415).send(UNSUPPORTED_MEDIA);
}

function serviceErrorResponse(reply: FastifyReply, error: unknown): FastifyReply {
  const candidate = error instanceof CustomAdapterServiceError || error instanceof TrustedAdapterServiceError
    ? error
    : null;
  if (candidate !== null && KNOWN_SERVICE_CODES.has(candidate.code)) {
    const status = Number.isInteger(candidate.statusCode) && candidate.statusCode >= 400 && candidate.statusCode <= 599
      ? candidate.statusCode
      : 500;
    return reply.code(status).send({
      error: candidate.code,
      message: SERVICE_MESSAGES[candidate.code] ?? 'The adapter operation could not be completed.',
    });
  }
  return reply.code(500).send({
    error: 'adapter_operation_failed',
    message: 'The adapter operation could not be completed.',
  });
}

function bodyPresent(request: FastifyRequest): boolean {
  if (request.body !== undefined) return true;
  const contentLength = request.headers['content-length'];
  if (typeof contentLength !== 'string') return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > 0;
}

function ensureNoBody(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!bodyPresent(request)) return true;
  invalidRequest(reply);
  return false;
}

function mediaType(request: FastifyRequest): string | null {
  const value = request.headers['content-type'];
  if (typeof value !== 'string') return null;
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function formatForMediaType(request: FastifyRequest, requested?: 'json' | 'yaml'): 'json' | 'yaml' | null {
  const type = mediaType(request);
  const inferred = type === 'application/json'
    ? 'json'
    : type === 'application/yaml' || type === 'application/x-yaml' || type === 'text/yaml'
      ? 'yaml'
      : null;
  if (inferred === null) return null;
  if (requested !== undefined && requested !== inferred) return null;
  return inferred;
}

function isMultipart(request: FastifyRequest): boolean {
  return typeof request.isMultipart === 'function' && request.isMultipart();
}

function cloneJson(value: unknown, seen = new Set<object>()): unknown {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Adapter DTO contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJson(item, seen));
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) output[key] = cloneJson(child, seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('Adapter DTO timestamp is invalid.');
  return date.toISOString();
}

function cloneDates(value: unknown, seen = new Set<object>()): unknown {
  if (value instanceof Date) return isoDate(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Adapter response contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneDates(item, seen));
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) output[key] = cloneDates(child, seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

function trustedDto(value: TrustedAdapterManagementDto): unknown {
  const manifest = parseAdapterManifest(cloneJson(value.manifest));
  const ref = CustomAdapterRefSchema.parse(cloneJson(value.ref));
  if (ref.kind !== 'trusted-javascript' || ref.adapterId !== manifest.id || ref.version !== manifest.version || ref.digest !== manifest.sha256) {
    throw new Error('Trusted adapter DTO reference does not match its manifest.');
  }
  return TrustedAdapterManagementDtoSchema.parse({
    manifest,
    ref,
    createdAt: isoDate(value.createdAt),
    updatedAt: isoDate(value.updatedAt),
  });
}

function trustedBindingDto(value: TrustedServiceBindingDto): unknown {
  const cloned = cloneJson(value);
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('Trusted adapter binding DTO is invalid.');
  }
  const source = cloned as Record<string, unknown>;
  const allowedKeys = new Set([
    'providerId',
    'ref',
    'definition',
    'isCurrent',
    'disabled',
    'createdAt',
    'updatedAt',
    'manifest',
    'installation',
  ]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
    throw new Error('Trusted adapter binding DTO contains unsupported fields.');
  }
  if (source.definition !== null) throw new Error('Trusted adapter binding definition is invalid.');

  const installation = source.installation;
  if (installation === null || typeof installation !== 'object' || Array.isArray(installation)) {
    throw new Error('Trusted adapter installation timestamps are invalid.');
  }
  const installationRecord = installation as Record<string, unknown>;
  if (Object.keys(installationRecord).some((key) => key !== 'createdAt' && key !== 'updatedAt')) {
    throw new Error('Trusted adapter installation timestamps contain unsupported fields.');
  }

  const manifest = parseAdapterManifest(source.manifest);
  const ref = TrustedAdapterRefSchema.parse(source.ref);
  if (ref.adapterId !== manifest.id || ref.version !== manifest.version || ref.digest !== manifest.sha256) {
    throw new Error('Trusted adapter binding reference does not match its manifest.');
  }
  const adapter = TrustedAdapterManagementDtoSchema.parse({
    manifest,
    ref,
    createdAt: isoDate(installationRecord.createdAt),
    updatedAt: isoDate(installationRecord.updatedAt),
  });
  return TrustedAdapterBindingDtoSchema.parse({
    providerId: PROVIDER_ID.parse(source.providerId),
    adapter,
    isCurrent: z.boolean().parse(source.isCurrent),
    disabled: z.boolean().parse(source.disabled),
    createdAt: isoDate(source.createdAt),
    updatedAt: isoDate(source.updatedAt),
  });
}

function customDto(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Custom adapter DTO is invalid.');
  const source = value as Record<string, unknown>;
  const ref = CustomAdapterRefSchema.parse(cloneJson(source.ref));
  const definition = source.definition === null
    ? null
    : (() => {
        const candidate = cloneJson(source.definition);
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Custom adapter definition is invalid.');
        return candidate;
      })();
  return CustomAdapterDefinitionDtoSchema.parse({
    providerId: PROVIDER_ID.parse(source.providerId),
    ref,
    definition,
    isCurrent: z.boolean().parse(source.isCurrent),
    disabled: z.boolean().parse(source.disabled),
    createdAt: isoDate(source.createdAt),
    updatedAt: isoDate(source.updatedAt),
  });
}

function trustedParams(value: unknown): { adapterId: string } | null {
  const parsed = AdapterIdParamsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function providerParams(value: unknown): { providerId: string } | null {
  const parsed = ProviderIdParamsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

class InvalidRevisionCursorError extends Error {
  public override readonly name = 'InvalidRevisionCursorError';
}

interface RevisionCursorItem {
  readonly item: unknown;
  readonly ref: CustomAdapterRef;
  readonly timestampMs: number;
  readonly key: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function revisionKey(ref: CustomAdapterRef): string {
  return JSON.stringify([ref.kind, ref.adapterId, ref.version, ref.digest]);
}

function revisionCompare(left: RevisionCursorItem, right: RevisionCursorItem): number {
  if (left.timestampMs !== right.timestampMs) return right.timestampMs - left.timestampMs;
  const kind = compareText(left.ref.kind, right.ref.kind);
  if (kind !== 0) return kind;
  const adapterId = compareText(left.ref.adapterId, right.ref.adapterId);
  if (adapterId !== 0) return adapterId;
  const version = compareText(left.ref.version, right.ref.version);
  if (version !== 0) return version;
  return compareText(left.ref.digest, right.ref.digest);
}

function cursorForRevision(item: RevisionCursorItem): string {
  return encodePageCursor({ timestampMs: item.timestampMs, id: item.key });
}

function decodeRevisionCursor(value: string | undefined): { timestampMs: number; ref: CustomAdapterRef; key: string } | null {
  if (value === undefined) return null;
  try {
    const decoded = decodePageCursor(value);
    const rawKey: unknown = JSON.parse(decoded.id);
    if (!Array.isArray(rawKey) || rawKey.length !== 4 || rawKey.some((part) => typeof part !== 'string')) {
      throw new InvalidRevisionCursorError('The revision cursor is invalid.');
    }
    const parsedRef = CustomAdapterRefSchema.safeParse({
      kind: rawKey[0],
      adapterId: rawKey[1],
      version: rawKey[2],
      digest: rawKey[3],
    });
    if (!parsedRef.success || revisionKey(parsedRef.data) !== decoded.id) {
      throw new InvalidRevisionCursorError('The revision cursor is invalid.');
    }
    return { timestampMs: decoded.timestampMs, ref: parsedRef.data, key: decoded.id };
  } catch (error) {
    if (error instanceof InvalidRevisionCursorError) throw error;
    throw new InvalidRevisionCursorError('The revision cursor is invalid.');
  }
}

function revisionPage(value: unknown, query: {
  readonly kind?: CustomAdapterRef['kind'] | undefined;
  readonly adapterId?: string | undefined;
  readonly version?: string | undefined;
  readonly digest?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}): unknown {
  if (!Array.isArray(value)) throw new Error('Custom adapter revision list is invalid.');
  const exact = query.kind === undefined ? null : {
    kind: query.kind,
    adapterId: query.adapterId!,
    version: query.version!,
    digest: query.digest!,
  };
  const rows: RevisionCursorItem[] = value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error('Custom adapter revision is invalid.');
    const source = item as Record<string, unknown>;
    const ref = CustomAdapterRefSchema.parse(cloneJson(source.ref));
    const timestamp = source.createdAt instanceof Date ? source.createdAt.getTime() : Date.parse(String(source.createdAt));
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Custom adapter revision timestamp is invalid.');
    return { item, key: revisionKey(ref), ref, timestampMs: timestamp };
  });
  rows.sort(revisionCompare);
  const filtered = exact === null ? rows : rows.filter((row) =>
    row.ref.kind === exact.kind && row.ref.adapterId === exact.adapterId && row.ref.version === exact.version && row.ref.digest === exact.digest,
  );
  const cursor = decodeRevisionCursor(query.cursor);
  let start = 0;
  if (cursor !== null) {
    const index = filtered.findIndex((row) => row.timestampMs === cursor.timestampMs && row.key === cursor.key);
    if (index < 0) throw new InvalidRevisionCursorError('The revision cursor is invalid.');
    start = index + 1;
  }
  const lookahead = filtered.slice(start, start + query.limit + 1);
  const hasNext = lookahead.length > query.limit;
  const items = lookahead.slice(0, query.limit).map((row) => customDto(row.item));
  return CustomAdapterDefinitionPageSchema.parse({
    items,
    nextCursor: hasNext ? cursorForRevision(lookahead[query.limit - 1]!) : null,
  });
}

type TrustedRevisionListQuery = z.infer<typeof TrustedAdapterRevisionListQuerySchema>;

function trustedRevisionPage(value: unknown, query: TrustedRevisionListQuery): unknown {
  if (!Array.isArray(value)) throw new Error('Trusted adapter revision list is invalid.');
  const exact = query.kind === undefined ? null : {
    kind: 'trusted-javascript' as const,
    adapterId: query.adapterId!,
    version: query.version!,
    digest: query.digest!,
  };
  const rows: RevisionCursorItem[] = value.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Trusted adapter revision is invalid.');
    }
    const source = item as Record<string, unknown>;
    const ref = TrustedAdapterRefSchema.parse(cloneJson(source.ref));
    const timestamp = source.createdAt instanceof Date ? source.createdAt.getTime() : Date.parse(String(source.createdAt));
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Trusted adapter revision timestamp is invalid.');
    return { item, key: revisionKey(ref), ref, timestampMs: timestamp };
  });
  rows.sort(revisionCompare);
  const filtered = exact === null ? rows : rows.filter((row) =>
    row.ref.kind === exact.kind && row.ref.adapterId === exact.adapterId && row.ref.version === exact.version && row.ref.digest === exact.digest,
  );
  const cursor = decodeRevisionCursor(query.cursor);
  if (cursor !== null && cursor.ref.kind !== 'trusted-javascript') {
    throw new InvalidRevisionCursorError('The trusted adapter revision cursor is invalid.');
  }
  let start = 0;
  if (cursor !== null) {
    const index = filtered.findIndex((row) => row.timestampMs === cursor.timestampMs && row.key === cursor.key);
    if (index < 0) throw new InvalidRevisionCursorError('The trusted adapter revision cursor is invalid.');
    start = index + 1;
  }
  const lookahead = filtered.slice(start, start + query.limit + 1);
  const hasNext = lookahead.length > query.limit;
  const items = lookahead.slice(0, query.limit).map((row) => trustedBindingDto(row.item as TrustedServiceBindingDto));
  return TrustedAdapterBindingPageSchema.parse({
    items,
    nextCursor: hasNext ? cursorForRevision(lookahead[query.limit - 1]!) : null,
  });
}

function providerScopedBody(schema: z.ZodTypeAny, body: unknown, providerId: string): unknown | null {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) return null;
  if (body !== undefined && Object.hasOwn(body, 'providerId')) return null;
  const candidate = body === undefined ? { providerId } : { ...(body as Record<string, unknown>), providerId };
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

interface MultipartInstallInput {
  readonly manifest: unknown;
  readonly source: Uint8Array;
  readonly providerId?: string;
}

interface MultipartFailure {
  readonly kind: 'invalid' | 'manifest_too_large' | 'source_too_large';
}

function multipartFailureResponse(reply: FastifyReply, failure: MultipartFailure): FastifyReply {
  if (failure.kind === 'manifest_too_large') {
    return reply.code(413).send({ error: 'manifest_too_large', message: SERVICE_MESSAGES.manifest_too_large });
  }
  if (failure.kind === 'source_too_large') {
    return reply.code(413).send({ error: 'source_too_large', message: SERVICE_MESSAGES.source_too_large });
  }
  return reply.code(400).send(INVALID_MULTIPART);
}

async function readMultipartInstall(request: FastifyRequest): Promise<MultipartInstallInput | MultipartFailure> {
  let parts = 0;
  let manifestText: string | undefined;
  let manifestTooLarge = false;
  let source: Uint8Array | undefined;
  let sourceTooLarge = false;
  let providerId: string | undefined;
  let invalid = false;

  try {
    for await (const rawPart of request.parts({
      limits: {
        fieldSize: MAX_MANIFEST_BYTES,
        fileSize: MAX_ADAPTER_SOURCE_BYTES,
        files: 2,
        fields: 4,
        parts: 4,
      },
    })) {
      parts += 1;
      const part = rawPart as unknown as {
        readonly type: 'field' | 'file';
        readonly fieldname: string;
        readonly value?: unknown;
        readonly valueTruncated?: boolean;
        readonly fieldnameTruncated?: boolean;
        readonly file?: AsyncIterable<Uint8Array> & { readonly truncated?: boolean };
      };
      if (part.type === 'field') {
        const value = part.value;
        const text = typeof value === 'string' ? value : undefined;
        const isUtf8 = text !== undefined && !text.includes('\uFFFD');
        if (part.fieldnameTruncated || !isUtf8 || part.valueTruncated) {
          if (part.fieldname === 'manifest' && part.valueTruncated) manifestTooLarge = true;
          else invalid = true;
          continue;
        }
        if (part.fieldname === 'manifest') {
          if (manifestText !== undefined || text === undefined) invalid = true;
          else if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) manifestTooLarge = true;
          else manifestText = text;
        } else if (part.fieldname === 'providerId') {
          const parsedProviderId = ProviderIdValueSchema.safeParse(text);
          if (providerId !== undefined || !parsedProviderId.success) invalid = true;
          else providerId = parsedProviderId.data;
        } else if (part.fieldname === 'source') {
          invalid = true;
        } else {
          invalid = true;
        }
        continue;
      }

      const knownSource = part.fieldname === 'source';
      const captureSource = knownSource && source === undefined;
      if (!knownSource || source !== undefined) invalid = true;
      try {
        if (part.file === undefined) {
          invalid = true;
          continue;
        }
        let size = 0;
        let tooLarge = false;
        const chunks: Uint8Array[] = [];
        for await (const chunk of part.file) {
          size += chunk.byteLength;
          if (size > MAX_ADAPTER_SOURCE_BYTES) {
            tooLarge = true;
            continue;
          }
          if (captureSource && !tooLarge) chunks.push(chunk);
        }
        if (part.file.truncated === true || tooLarge) {
          if (knownSource) sourceTooLarge = true;
          else invalid = true;
        } else if (captureSource) {
          source = Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        }
      } catch (error) {
        if (knownSource && (part.file?.truncated === true || (error instanceof Error && 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE'))) sourceTooLarge = true;
        else invalid = true;
      }
    }
  } catch {
    return { kind: sourceTooLarge ? 'source_too_large' : 'invalid' };
  }

  if (parts < 2 || parts > 3 || manifestTooLarge || sourceTooLarge || invalid || manifestText === undefined || source === undefined) {
    if (manifestTooLarge) return { kind: 'manifest_too_large' };
    if (sourceTooLarge) return { kind: 'source_too_large' };
    return { kind: 'invalid' };
  }
  let manifest: unknown;
  try {
    manifest = parseBoundedManifestJson(Buffer.from(manifestText, 'utf8'));
  } catch {
    return { kind: 'invalid' };
  }
  return {
    manifest,
    source,
    ...(providerId === undefined ? {} : { providerId }),
  };
}

function resolveServices(options: AdapterRoutesOptions): { trusted: TrustedService; custom: CustomService } {
  const trusted = options.trusted ?? options.trustedAdapters ?? options.trustedAdapterService;
  const custom = options.custom ?? options.customAdapters ?? options.customAdapterService ?? options.declarative ?? options.declarativeAdapters;
  if (trusted === undefined || custom === undefined) {
    throw new TypeError('Adapter routes require trusted and declarative adapter services.');
  }
  return { trusted, custom };
}

async function callTool(
  reply: FastifyReply,
  operation: () => unknown | Promise<unknown>,
  project: (value: unknown) => unknown = (value) => cloneJson(value),
): Promise<unknown> {
  try {
    return project(await operation());
  } catch (error) {
    if (error instanceof InvalidRevisionCursorError) return invalidRequest(reply);
    return serviceErrorResponse(reply, error);
  }
}

export async function registerAdapterRoutes(
  app: FastifyInstance,
  options: AdapterRoutesOptions,
): Promise<void> {
  const services = resolveServices(options);

  app.get('/internal/adapters', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    if (!EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    return callTool(reply, () => services.trusted.list(), (value) => {
      if (!Array.isArray(value)) throw new Error('Trusted adapter list is invalid.');
      return TrustedAdapterPageSchema.parse({ items: value.map((item) => trustedDto(item as TrustedAdapterManagementDto)) });
    });
  });

  app.post('/internal/adapters/trusted-javascript', async (request, reply) => {
    if (!EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    if (!isMultipart(request)) return unsupportedMedia(reply);
    const parsed = await readMultipartInstall(request);
    if ('kind' in parsed) return multipartFailureResponse(reply, parsed);
    return callTool(
      reply,
      () => services.trusted.install(parsed),
      (value) => reply.code(201).send(TrustedAdapterResponseSchema.parse({ adapter: trustedDto(value as TrustedAdapterManagementDto) })),
    );
  });

  app.get<{ Params: { adapterId: string } }>('/internal/adapters/:adapterId', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = trustedParams(request.params);
    if (params === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    return callTool(reply, () => services.trusted.get(params.adapterId), (value) => {
      if (value === null) return reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found });
      return TrustedAdapterResponseSchema.parse({ adapter: trustedDto(value as TrustedAdapterManagementDto) });
    });
  });

  app.delete<{ Params: { adapterId: string } }>('/internal/adapters/:adapterId', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = trustedParams(request.params);
    if (params === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    return callTool(reply, async () => {
      await services.trusted.remove(params.adapterId);
      return undefined;
    }, () => reply.code(204).send());
  });

  app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/trusted-javascript', async (request, reply) => {
    const params = providerParams(request.params);
    if (params === null) return invalidRequest(reply);
    if (!EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    if (request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body) || Object.hasOwn(request.body, 'providerId'))) return invalidRequest(reply);
    const body = TrustedAdapterBindRequestSchema.safeParse({ ...(request.body as Record<string, unknown> | undefined), providerId: params.providerId });
    if (!body.success) return invalidRequest(reply);
    return callTool(
      reply,
      () => services.trusted.bind(body.data),
      (value) => reply.code(201).send(TrustedAdapterResponseSchema.parse({ adapter: trustedDto(value as TrustedAdapterManagementDto) })),
    );
  });

  app.get<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/trusted-javascript', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    const query = TrustedAdapterRevisionQuerySchema.safeParse(cloneJson(request.query));
    if (params === null || !query.success) return invalidRequest(reply);
    const ref = query.data.kind === undefined
      ? undefined
      : TRUSTED_REF.parse({
          kind: query.data.kind,
          adapterId: query.data.adapterId,
          version: query.data.version,
          digest: query.data.digest,
        });
    return callTool(reply, () => ref === undefined
      ? services.trusted.getCurrentOrDisabledBinding(params.providerId)
      : services.trusted.getBinding(params.providerId, ref), (value) => {
      if (value === null) return reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found });
      return TrustedAdapterBindingResponseSchema.parse({ binding: trustedBindingDto(value as TrustedServiceBindingDto) });
    });
  });

  app.get<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/trusted-javascript/revisions', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    const query = TrustedAdapterRevisionListQuerySchema.safeParse(cloneJson(request.query));
    if (params === null || !query.success) return invalidRequest(reply);
    return callTool(reply, () => services.trusted.listBindings(params.providerId), (value) => trustedRevisionPage(value, query.data));
  });

  app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/trusted-javascript/disable', async (request, reply) => {
    const params = providerParams(request.params);
    if (params === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    let ref: CustomAdapterRef | undefined;
    if (bodyPresent(request)) {
      const body = TrustedAdapterDisableBodySchema.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);
      ref = body.data.ref;
    }
    return callTool(reply, () => services.trusted.disableBinding(params.providerId, ref), (value) => {
      if (value === null) return reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found });
      return TrustedAdapterBindingResponseSchema.parse({ binding: trustedBindingDto(value as TrustedServiceBindingDto) });
    });
  });

  app.delete<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/trusted-javascript', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    const query = TRUSTED_UNBIND_QUERY_SCHEMA.safeParse(cloneJson(request.query));
    if (params === null || !query.success) return invalidRequest(reply);
    const ref = query.data.kind === undefined
      ? undefined
      : TRUSTED_REF.parse({
          kind: query.data.kind,
          adapterId: query.data.adapterId,
          version: query.data.version,
          digest: query.data.digest,
        });
    return callTool(reply, () => services.trusted.unbind(params.providerId, ref), (removed) => removed === true
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found }));
  });

  app.get<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    if (params === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    return callTool(reply, () => services.custom.get(params.providerId), (value) => {
      if (value === null) return reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found });
      return CustomAdapterDefinitionResponseSchema.parse({ definition: customDto(value) });
    });
  });

  app.get<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/revisions', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    const query = CustomAdapterRevisionListQuerySchema.safeParse(request.query);
    if (params === null || !query.success) return invalidRequest(reply);
    return callTool(reply, () => services.custom.list(params.providerId), (value) => revisionPage(value, query.data));
  });

  app.put<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter', async (request, reply) => {
    const params = providerParams(request.params);
    if (params === null) return invalidRequest(reply);
    const query = CustomAdapterImportQuerySchema.safeParse(cloneJson(request.query));
    if (!query.success) return invalidRequest(reply);
    const format = formatForMediaType(request);
    if (format === null) return unsupportedMedia(reply);
    const document = request.body;
    if (document === undefined || document === null || Array.isArray(document) || (typeof document !== 'string' && typeof document !== 'object')) {
      return invalidRequest(reply);
    }
    if (!DOCUMENT.safeParse(document).success) return invalidRequest(reply);
    const input: Record<string, unknown> = {
      providerId: params.providerId,
      document,
      format,
      ...(query.data.version === undefined ? {} : { version: query.data.version }),
    };
    return callTool(
      reply,
      () => services.custom.replace(input as never),
      (value) => CustomAdapterDefinitionResponseSchema.parse({ definition: customDto(value) }),
    );
  });

  app.delete<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter', async (request, reply) => {
    if (!ensureNoBody(request, reply)) return;
    const params = providerParams(request.params);
    if (params === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
    return callTool(reply, async () => {
      const deleted = await services.custom.delete(params.providerId);
      return deleted;
    }, (deleted) => deleted
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found }));
  });

  const registerProviderToolRoutes = () => {
    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/disable', async (request, reply) => {
      const params = providerParams(request.params);
      if (params === null) return invalidRequest(reply);
      if (!EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      let ref: CustomAdapterRef | undefined;
      if (bodyPresent(request)) {
        const body = z.object({ ref: REF.optional() }).strict().safeParse(request.body);
        if (!body.success) return invalidRequest(reply);
        ref = body.data.ref;
      }
      return callTool(reply, async () => {
        const value = await services.custom.disable(ref === undefined ? params.providerId : { providerId: params.providerId, ref });
        if (value === null) return reply.code(404).send({ error: 'not_found', message: SERVICE_MESSAGES.not_found });
        return CustomAdapterDefinitionResponseSchema.parse({ definition: customDto(value) });
      });
    });

    app.get<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/export', async (request, reply) => {
      if (!ensureNoBody(request, reply)) return;
      const params = providerParams(request.params);
      const query = CustomAdapterExportQuerySchema.safeParse(request.query);
      if (params === null || !query.success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.export({
        providerId: params.providerId,
        ...(query.data.format === undefined ? {} : { format: query.data.format }),
        ...(!('kind' in query.data) ? {} : {
          ref: {
            kind: query.data.kind,
            adapterId: query.data.adapterId,
            version: query.data.version,
            digest: query.data.digest,
          },
        }),
      }), (value) => {
        const output = CustomAdapterExportResponseSchema.parse(cloneJson(value));
        const ref = REF.parse(cloneJson(output.ref));
        const safeId = ref.adapterId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 63) || 'adapter';
        const safeVersion = ref.version.replace(/[^A-Za-z0-9._+-]/gu, '_').slice(0, 64) || 'revision';
        const extension = output.format as CustomAdapterExportFormat;
        reply
          .header('content-type', extension === 'yaml' ? 'application/yaml; charset=utf-8' : 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="adapter-${safeId}-${safeVersion}.${extension}"`)
          .header('x-content-type-options', 'nosniff');
        return reply.send(output.content);
      });
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/validate', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterValidateRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.validate(body as never), (value) => CustomAdapterValidationResponseSchema.parse(cloneJson(value)));
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/preview', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterPreviewRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.preview(body as never), (value) => previewResponseSchema.parse(cloneJson(value)));
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/dry-run', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterPreviewRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.dryRun(body as never), dryRunDto);
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/simulate', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterSimulateRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.simulateResponse(body as never), extractedDto);
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/path-test', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterPathTestRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.testPath(body as never), (value) => CustomAdapterPathTestResponseSchema.parse(cloneJson(value)));
    });

    app.post<{ Params: { providerId: string } }>('/internal/providers/:providerId/adapter/capabilities-preview', async (request, reply) => {
      const params = providerParams(request.params);
      const body = providerScopedBody(CustomAdapterCapabilityPreviewRequestSchema, request.body, params?.providerId ?? '');
      if (params === null || body === null || !EmptyQuerySchema.safeParse(request.query).success) return invalidRequest(reply);
      return callTool(reply, () => services.custom.capabilities(body as never), (value) => CustomAdapterCapabilityPreviewResponseSchema.parse(cloneJson(value)));
    });
  };
  registerProviderToolRoutes();
}

export {
  DraftBodySchema,
  PathTestBodySchema,
  PreviewBodySchema,
  SimulateBodySchema,
  ValidateBodySchema,
};

export type AdapterServiceErrorCode = CustomAdapterServiceErrorCode | TrustedAdapterServiceErrorCode;
