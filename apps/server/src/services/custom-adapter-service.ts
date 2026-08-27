import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
  ProviderCapabilities,
  ProviderContext,
  ProviderInput,
} from '@imagine/provider-contract';
import {
  CustomAdapterRefSchema,
  GenerationRequestSchema,
  type CustomAdapterRef,
  type GenerationRequest,
} from '@imagine/shared';
import { isAlias, isMap, isSeq, parseDocument as parseYamlDocument, stringify as stringifyYaml } from 'yaml';

import {
  ProviderAdapterDefinitionError,
  assertNoStaticCredentialLiterals,
  isCredentialLikeFieldName,
  type ProviderAdapterDefinitionRecord,
  type ProviderAdapterDefinitionRepository,
} from '../database/adapter-definitions.js';
import type { ProviderRepository, ProviderStorageRecord } from '../database/providers.js';
import {
  DeclarativeHttpAdapter,
  DeclarativeResponseError,
  DeclarativeSpecError,
  assertDeclarativeBaseUrl,
  assertBoundedJsonTree,
  canonicalDeclarativeSpec,
  compileEndpoint,
  extractDeclarativeResponse,
  MAX_RESPONSE_ARRAY_ITEMS,
  MAX_RESPONSE_DEPTH,
  MAX_RESPONSE_JSON_BYTES,
  MAX_RESPONSE_KEYS,
  MAX_RESPONSE_NODES,
  MAX_SPEC_BYTES,
  parseDeclarativeJson,
  parseDeclarativeYaml,
  parseBoundedJsonDocument,
  readJsonPointer,
  redactedRequestPreview,
  type DeclarativeDocumentFormat,
  type DeclarativeEndpoint,
  type DeclarativeExtractedResponse,
  type DeclarativeHttpSpec,
  type DeclarativeResponse,
  type ParseLimits,
  type RedactedBodyPreview,
  type RedactedRequestPreview,
} from '../providers/custom-http/index.js';
import { projectDeclarativeModel } from '../providers/custom-http/capabilities.js';
import {
  DeclarativeCompileError,
  type CompiledRequest,
} from '../providers/custom-http/compiler.js';

const CUSTOM_HTTP_PROVIDER_TYPE = 'custom-http-v1' as const;
const DECLARATIVE_HTTP_KIND = 'declarative-http' as const;
const MAX_POINTER_LENGTH = 512;
const MAX_MOCK_RESPONSE_HEADERS = 128;
const MAX_MOCK_RESPONSE_HEADER_LENGTH = 4096;
const IMPORT_KEYS = new Set(['providerId', 'ref', 'version', 'format', 'document', 'input', 'spec', 'definition']);
const VALIDATE_KEYS = new Set(['providerId', 'format', 'document', 'input', 'spec', 'definition', 'request', 'baseUrl']);
const TARGET_KEYS = new Set(['providerId', 'ref']);
const EXPORT_KEYS = new Set(['providerId', 'ref', 'format']);
const PREVIEW_KEYS = new Set(['providerId', 'ref', 'request', 'context', 'baseUrl', 'secrets', 'secretValues', 'inputs', 'endpoint', 'document', 'input', 'spec', 'definition', 'format']);
const SIMULATE_KEYS = new Set(['providerId', 'ref', 'endpoint', 'phase', 'response', 'expectedRemoteJobId', 'document', 'input', 'spec', 'definition', 'format']);
const PATH_TEST_KEYS = new Set(['providerId', 'ref', 'path', 'document', 'response', 'json', 'text', 'documentDefinition', 'format']);
const CAPABILITY_KEYS = new Set(['providerId', 'ref', 'document', 'input', 'spec', 'definition', 'format']);
const ENVELOPE_KEYS = new Set(['schemaVersion', 'version', 'definition']);
const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const PATH_RESPONSE_LIMITS: ParseLimits = {
  maxArrayItems: MAX_RESPONSE_ARRAY_ITEMS,
  maxDepth: MAX_RESPONSE_DEPTH,
  maxKeys: MAX_RESPONSE_KEYS,
  maxNodes: MAX_RESPONSE_NODES,
  maxStringLength: MAX_RESPONSE_JSON_BYTES,
  maxTotalStringLength: MAX_RESPONSE_JSON_BYTES,
};

type ProviderLookup = Pick<ProviderRepository, 'get'>;
type DefinitionRepository = Pick<
  ProviderAdapterDefinitionRepository,
  'create' | 'replace' | 'disable' | 'delete' | 'getCurrent' | 'getByRef'
> & {
  list?: (providerId: string) => readonly ProviderAdapterDefinitionRecord[];
};

export type CustomAdapterDocument =
  | string
  | Uint8Array
  | Readonly<Record<string, unknown>>;

export type CustomAdapterExportFormat = 'json' | 'yaml';
export type CustomAdapterManagementAction = 'read' | 'write';

/** Captured once by the server; request bodies never provide authorization. */
export interface AdapterAdminAuthorization {
  readonly adminEnabled: boolean;
  readonly assertAdmin?: (action: CustomAdapterManagementAction) => void;
}

export interface CustomAdapterOutboxPublisher {
  /** Flushes events emitted by a just-committed mutation. */
  readonly flush: () => void | Promise<void>;
}

export type CustomAdapterEndpointName =
  | 'submit'
  | 'poll'
  | 'cancel'
  | 'connection'
  | 'catalog';

export interface CustomAdapterServiceDependencies {
  readonly providers?: ProviderLookup;
  readonly providerRepository?: ProviderLookup;
  readonly adapterDefinitions?: DefinitionRepository;
  readonly definitions?: DefinitionRepository;
  readonly repositories?: {
    readonly providers?: ProviderLookup;
    readonly adapterDefinitions?: DefinitionRepository;
  };
  readonly authorization: AdapterAdminAuthorization;
  readonly outbox: CustomAdapterOutboxPublisher;
}

export type CustomAdapterServiceOptions = CustomAdapterServiceDependencies;

export interface CustomAdapterTarget {
  readonly providerId: string;
  readonly ref?: CustomAdapterRef;
}

export interface CustomAdapterImportRequest extends CustomAdapterTarget {
  /** Required for create/replace; the adapter id comes from the document. */
  readonly version?: string;
  readonly format?: DeclarativeDocumentFormat;
  readonly document?: CustomAdapterDocument;
  /** Aliases make the service usable by import callers without a transport DTO. */
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
}

export interface CustomAdapterValidateRequest {
  readonly providerId?: string;
  readonly format?: DeclarativeDocumentFormat;
  readonly document?: CustomAdapterDocument;
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
  readonly request?: GenerationRequest;
  readonly baseUrl?: string;
}

export interface CustomAdapterValidationResponse {
  readonly valid: true;
  readonly adapterId: string;
  readonly canonical: string;
  readonly spec: DeclarativeHttpSpec;
}

export interface CustomAdapterExportRequest extends CustomAdapterTarget {
  readonly format?: CustomAdapterExportFormat;
}

export interface CustomAdapterExportResponse {
  readonly format: CustomAdapterExportFormat;
  readonly content: string;
  readonly document: string;
  readonly ref: CustomAdapterRef;
}

export interface CustomAdapterExportEnvelope {
  readonly schemaVersion: 1;
  readonly version: string;
  readonly definition: DeclarativeHttpSpec;
}

export interface CustomAdapterPreviewContext {
  readonly baseUrl?: string;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly secretValues?: Readonly<Record<string, string>>;
  readonly inputs?: readonly ProviderInput[];
  readonly jobId?: string;
  readonly remoteJobId?: string;
}

export interface CustomAdapterPreviewRequest extends CustomAdapterTarget {
  readonly request?: GenerationRequest;
  readonly context?: CustomAdapterPreviewContext;
  readonly baseUrl?: string;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly secretValues?: Readonly<Record<string, string>>;
  readonly inputs?: readonly ProviderInput[];
  readonly endpoint?: CustomAdapterEndpointName;
  /** A draft definition may be previewed before it is persisted. */
  readonly document?: CustomAdapterDocument;
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
  readonly format?: DeclarativeDocumentFormat;
}

export interface CustomAdapterCompiledPreview extends RedactedRequestPreview {
  readonly url: string;
  readonly endpoint: CustomAdapterEndpointName;
}

export interface CustomAdapterCapabilityPreview {
  readonly capabilities: ProviderCapabilities;
}

export interface CustomAdapterCapabilityPreviewRequest extends CustomAdapterTarget {
  readonly document?: CustomAdapterDocument;
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
  readonly format?: DeclarativeDocumentFormat;
}

export interface CustomAdapterDryRunResponse {
  readonly network: false;
  readonly performed: false;
  readonly endpoint: CustomAdapterEndpointName;
  readonly request: CustomAdapterCompiledPreview;
  readonly preview: CustomAdapterCompiledPreview;
  readonly capabilities: ProviderCapabilities;
}

export interface CustomAdapterMockResponse {
  readonly status: number;
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly json?: unknown;
  readonly text?: string;
  readonly body?: unknown;
}

export interface CustomAdapterSimulateRequest extends CustomAdapterTarget {
  readonly endpoint?: CustomAdapterEndpointName;
  readonly phase?: 'submit' | 'poll' | 'cancel' | 'connection' | 'catalog';
  readonly response: CustomAdapterMockResponse;
  readonly expectedRemoteJobId?: string;
  readonly document?: CustomAdapterDocument;
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
  readonly format?: DeclarativeDocumentFormat;
}

export interface CustomAdapterPathTestRequest extends CustomAdapterTarget {
  readonly path: string;
  readonly document?: unknown;
  readonly response?: CustomAdapterMockResponse;
  readonly json?: unknown;
  readonly text?: string;
  readonly documentDefinition?: CustomAdapterDocument;
  readonly format?: DeclarativeDocumentFormat;
}

export interface CustomAdapterPathTestResponse {
  readonly path: string;
  readonly found: boolean;
  readonly value: unknown;
}

export type CustomAdapterServiceErrorCode =
  | 'invalid_request'
  | 'administrator_required'
  | 'invalid_format'
  | 'input_too_large'
  | 'invalid_json'
  | 'invalid_yaml'
  | 'unsafe_document'
  | 'schema_invalid'
  | 'invalid_definition'
  | 'invalid_reference'
  | 'digest_mismatch'
  | 'definition_too_large'
  | 'provider_not_found'
  | 'provider_type_mismatch'
  | 'provider_adapter_kind_mismatch'
  | 'already_exists'
  | 'not_found'
  | 'adapter_not_found'
  | 'referenced_jobs'
  | 'referenced_definitions'
  | 'tombstoned'
  | 'persisted_invalid'
  | 'invalid_base_url'
  | 'invalid_path'
  | 'invalid_header'
  | 'invalid_body'
  | 'invalid_input'
  | 'invalid_schema'
  | 'ambiguous_result'
  | 'invalid_response'
  | 'response_too_large'
  | 'unsupported_result'
  | 'outbox_unavailable'
  | 'outbox_failure'
  | 'storage_error';

/** Public management errors intentionally carry no cause/source or raw input. */
export class CustomAdapterServiceError extends Error {
  public override readonly name = 'CustomAdapterServiceError';
  public readonly statusCode: number;

  public constructor(
    public readonly code: CustomAdapterServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.statusCode = serviceErrorStatus(code);
  }
}

interface ParsedDefinition {
  readonly spec: DeclarativeHttpSpec;
  readonly canonical: string;
  readonly envelopeVersion?: string;
}

interface StoredTarget {
  readonly provider: ProviderStorageRecord;
  readonly record: ProviderAdapterDefinitionRecord;
}

type ServiceTemplateContext = ProviderContext & { readonly remoteJobId?: string };

function serviceError(
  code: CustomAdapterServiceErrorCode,
  message: string,
): CustomAdapterServiceError {
  return new CustomAdapterServiceError(code, message);
}

function isSizeDocumentError(error: DeclarativeSpecError): boolean {
  return error.code === 'input_too_large' ||
    (error.code === 'unsafe_document' && /too (?:many|deep|large)|oversized/u.test(error.message.toLowerCase()));
}

function documentErrorCode(error: DeclarativeSpecError): CustomAdapterServiceErrorCode {
  if (isSizeDocumentError(error)) return 'input_too_large';
  if (error.code === 'invalid_json' || error.code === 'invalid_yaml' || error.code === 'unsafe_document' || error.code === 'schema_invalid') return error.code;
  return 'storage_error';
}

function serviceErrorStatus(code: CustomAdapterServiceErrorCode): number {
  switch (code) {
    case 'administrator_required':
      return 403;
    case 'provider_not_found':
    case 'adapter_not_found':
    case 'not_found':
      return 404;
    case 'provider_type_mismatch':
    case 'provider_adapter_kind_mismatch':
    case 'already_exists':
    case 'referenced_jobs':
      return 409;
    case 'storage_error':
    case 'persisted_invalid':
    case 'outbox_unavailable':
    case 'outbox_failure':
      return 500;
    case 'input_too_large':
    case 'definition_too_large':
    case 'response_too_large':
      return 413;
    default:
      return 400;
  }
}

function publicAdminError(): CustomAdapterServiceError {
  return serviceError('administrator_required', 'Administrator authorization is required for adapter management.');
}

function assertOwnKeys(value: unknown, allowed: ReadonlySet<string>): void {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw serviceError('invalid_request', 'Custom adapter management request is invalid.');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
    return result;
  }
  return value;
}

function cloneRecord(record: ProviderAdapterDefinitionRecord): ProviderAdapterDefinitionRecord {
  return {
    ...record,
    ref: { ...record.ref },
    definition: record.definition === null
      ? null
      : cloneJson(record.definition) as Readonly<Record<string, unknown>>,
  };
}

function safeString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw serviceError('invalid_request', `${label} is required.`);
  }
  return value;
}

function inferFormat(value: string | Uint8Array): DeclarativeDocumentFormat {
  const text = typeof value === 'string'
    ? value
    : (() => {
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(value);
        } catch {
          throw serviceError('unsafe_document', 'Adapter document must be valid UTF-8.');
        }
      })();
  const first = text.trimStart()[0];
  return first === '{' || first === '[' ? 'json' : 'yaml';
}

function documentValue(input: {
  readonly document?: CustomAdapterDocument;
  readonly input?: CustomAdapterDocument;
  readonly spec?: CustomAdapterDocument;
  readonly definition?: CustomAdapterDocument;
}): CustomAdapterDocument {
  const value = input.document ?? input.input ?? input.spec ?? input.definition;
  if (value === undefined) throw serviceError('invalid_request', 'Adapter document is required.');
  return value;
}

function serializedObject(value: Readonly<Record<string, unknown>>): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('undefined');
    return serialized;
  } catch {
    throw serviceError('invalid_definition', 'Adapter document must be JSON-compatible.');
  }
}

function documentText(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (bytes > MAX_SPEC_BYTES) throw serviceError('input_too_large', 'Adapter document is too large.');
  try {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    if (Buffer.byteLength(text, 'utf8') !== bytes) throw new Error('invalid UTF-8');
    return text;
  } catch {
    throw serviceError('unsafe_document', 'Adapter document must be valid UTF-8.');
  }
}

function assertSafeYamlNodes(node: unknown, seen = new Set<object>()): void {
  if (node === null || typeof node !== 'object') return;
  if (isAlias(node)) throw serviceError('unsafe_document', 'YAML aliases are not allowed.');
  if (seen.has(node)) throw serviceError('unsafe_document', 'YAML document contains a cycle.');
  const candidate = node as { readonly tag?: unknown; readonly items?: readonly unknown[] };
  if (candidate.tag !== undefined) throw serviceError('unsafe_document', 'YAML tags are not allowed.');
  seen.add(node);
  if (isSeq(node)) {
    for (const item of candidate.items ?? []) assertSafeYamlNodes(item, seen);
  } else if (isMap(node)) {
    for (const pair of candidate.items ?? []) {
      const entry = pair as { readonly key?: unknown; readonly value?: unknown };
      assertSafeYamlNodes(entry.key, seen);
      assertSafeYamlNodes(entry.value, seen);
    }
  }
  seen.delete(node);
}

function parseBoundedManagementDocument(
  input: string | Uint8Array | Readonly<Record<string, unknown>>,
  requestedFormat?: DeclarativeDocumentFormat,
): unknown {
  if (typeof input === 'object' && !(input instanceof Uint8Array)) {
    try {
      assertBoundedJsonTree(input);
    } catch (error) {
      if (error instanceof DeclarativeSpecError) throw serviceError(documentErrorCode(error), 'Adapter document is invalid.');
      throw error;
    }
    return input;
  }
  if (requestedFormat !== undefined && requestedFormat !== 'json' && requestedFormat !== 'yaml') {
    throw serviceError('invalid_format', 'Adapter document format is invalid.');
  }
  const format = requestedFormat ?? inferFormat(input);
  const text = documentText(input);
  if (format === 'json') {
    try {
      const value = parseBoundedJsonDocument(text);
      assertBoundedJsonTree(value);
      return value;
    } catch (error) {
      if (error instanceof CustomAdapterServiceError) throw error;
      if (error instanceof DeclarativeSpecError) throw serviceError(documentErrorCode(error), 'Adapter document is invalid.');
      throw serviceError('invalid_json', 'Adapter document is invalid.');
    }
  }
  try {
    const document = parseYamlDocument(text, {
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: '1.2',
    });
    if (document.errors.length > 0) throw new Error('YAML errors');
    if (document.warnings.length > 0) throw serviceError('unsafe_document', 'Adapter YAML is unsafe.');
    const directiveTags = Object.keys(document.directives.tags ?? {});
    if (
      document.directives.docStart !== null ||
      document.directives.docEnd === true ||
      document.directives.yaml?.explicit === true ||
      directiveTags.some((tag) => tag !== '!!')
    ) {
      throw serviceError('unsafe_document', 'YAML directives are not allowed.');
    }
    assertSafeYamlNodes(document.contents);
    const value = document.toJS({ mapAsMap: false, maxAliasCount: 0 });
    assertBoundedJsonTree(value);
    return value;
  } catch (error) {
    if (error instanceof CustomAdapterServiceError) throw error;
    if (error instanceof DeclarativeSpecError) throw serviceError(documentErrorCode(error), 'Adapter document is invalid.');
    throw serviceError('invalid_yaml', 'Adapter document is invalid.');
  }
}

function envelopeVersion(value: Readonly<Record<string, unknown>>): string {
  if (value.schemaVersion !== 1 || typeof value.version !== 'string' || !ADAPTER_VERSION_PATTERN.test(value.version)) {
    throw serviceError('invalid_reference', 'Adapter export envelope is invalid.');
  }
  if (!Object.hasOwn(value, 'definition') || !isRecord(value.definition)) {
    throw serviceError('invalid_definition', 'Adapter export envelope definition is invalid.');
  }
  return value.version;
}

function envelopeKeysEqual(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value);
  return keys.length === ENVELOPE_KEYS.size && keys.every((key) => ENVELOPE_KEYS.has(key));
}

function parseDocument(
  input: CustomAdapterDocument,
  requestedFormat?: DeclarativeDocumentFormat,
): ParsedDefinition {
  const raw = parseBoundedManagementDocument(input, requestedFormat);
  let specSource: Readonly<Record<string, unknown>>;
  let version: string | undefined;
  if (isRecord(raw) && (Object.hasOwn(raw, 'version') || Object.hasOwn(raw, 'definition'))) {
    if (!envelopeKeysEqual(raw)) throw serviceError('invalid_definition', 'Adapter export envelope is invalid.');
    version = envelopeVersion(raw);
    specSource = raw.definition as Readonly<Record<string, unknown>>;
  } else if (isRecord(raw)) {
    specSource = raw;
  } else {
    throw serviceError('schema_invalid', 'Adapter document must be an object.');
  }
  const spec = parseDefinitionText(serializedObject(specSource), 'json');
  try {
    assertNoStaticCredentialLiterals(spec);
  } catch (error) {
    if (error instanceof ProviderAdapterDefinitionError) throw error;
    throw serviceError('invalid_definition', 'Adapter credential placement is invalid.');
  }
  const canonical = canonicalDeclarativeSpec(spec);
  assertEndpointSemantics(spec);
  return version === undefined ? { canonical, spec } : { canonical, envelopeVersion: version, spec };
}

function parseDefinitionText(
  input: string | Uint8Array,
  format: DeclarativeDocumentFormat,
): DeclarativeHttpSpec {
  try {
    return format === 'json' ? parseDeclarativeJson(input) : parseDeclarativeYaml(input);
  } catch (error) {
    if (error instanceof CustomAdapterServiceError) throw error;
    if (error instanceof Error && error.name === 'DeclarativeSpecError') {
      const code = (error as { readonly code?: unknown }).code;
      if (
        code === 'input_too_large' ||
        code === 'invalid_json' ||
        code === 'invalid_yaml' ||
        code === 'unsafe_document' ||
        code === 'schema_invalid'
      ) {
        throw serviceError(documentErrorCode(error as DeclarativeSpecError), 'Adapter document is invalid.');
      }
    }
    throw serviceError(format === 'json' ? 'invalid_json' : 'invalid_yaml', 'Adapter document is invalid.');
  }
}

function endpointEntries(spec: DeclarativeHttpSpec): readonly [CustomAdapterEndpointName, DeclarativeEndpoint][] {
  return (['submit', 'poll', 'cancel', 'connection', 'catalog'] as const)
    .flatMap((name) => spec[name] === undefined ? [] : [[name, spec[name]!] as [CustomAdapterEndpointName, DeclarativeEndpoint]]);
}

function assertEndpointSemantics(spec: DeclarativeHttpSpec): void {
  for (const [, endpoint] of endpointEntries(spec)) {
    const rawPath = endpoint.path;
    if (
      !rawPath.startsWith('/') ||
      rawPath.startsWith('//') ||
      rawPath.includes('\\') ||
      rawPath.includes('://') ||
      rawPath.includes('?') ||
      rawPath.includes('#') ||
      rawPath.includes('%')
    ) {
      throw serviceError('invalid_path', 'Adapter endpoint path is invalid.');
    }
    const segments = rawPath.split('/');
    if (segments.length > 33 || segments.some((segment) => segment === '.' || segment === '..')) {
      throw serviceError('invalid_path', 'Adapter endpoint path is invalid.');
    }
    for (const segment of segments.slice(1)) {
      if (segment.includes('{{') || segment.includes('}}')) continue;
      if (!/^[A-Za-z0-9._~-]*$/u.test(segment)) {
        throw serviceError('invalid_path', 'Adapter endpoint path is invalid.');
      }
    }
    if (
      endpoint.expectedStatus.some((status) => !Number.isInteger(status) || status < 100 || status > 599) ||
      new Set(endpoint.expectedStatus).size !== endpoint.expectedStatus.length
    ) {
      throw serviceError('invalid_response', 'Adapter endpoint status mapping is invalid.');
    }
    const extract = endpoint.extract;
    if (extract.resultUrlPath !== undefined && extract.resultBase64Path !== undefined) {
      throw serviceError('unsupported_result', 'Adapter endpoint result mapping is ambiguous.');
    }
  }
}

function digest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function normalizeRef(
  spec: DeclarativeHttpSpec,
  canonical: string,
  version: string | undefined,
  rawRef: CustomAdapterRef | undefined,
  documentVersion?: string,
): CustomAdapterRef {
  const parsedRef = rawRef === undefined ? undefined : CustomAdapterRefSchema.safeParse(rawRef);
  if (parsedRef !== undefined && !parsedRef.success) {
    throw serviceError('invalid_reference', 'Adapter reference is invalid.');
  }
  const selectedVersion = version ?? parsedRef?.data.version;
  if (selectedVersion === undefined) throw serviceError('invalid_reference', 'Adapter version is required.');
  if (documentVersion !== undefined && selectedVersion !== documentVersion) {
    throw serviceError('invalid_reference', 'Adapter export envelope version does not match the requested revision.');
  }
  const ref: CustomAdapterRef = {
    adapterId: spec.id,
    digest: digest(canonical),
    kind: DECLARATIVE_HTTP_KIND,
    version: selectedVersion,
  };
  if (parsedRef !== undefined) {
    if (parsedRef.data.kind !== DECLARATIVE_HTTP_KIND) {
      throw serviceError('provider_adapter_kind_mismatch', 'Adapter reference kind does not match custom HTTP.');
    }
    if (parsedRef.data.adapterId !== ref.adapterId || parsedRef.data.version !== ref.version) {
      throw serviceError('invalid_reference', 'Adapter reference does not match the document.');
    }
    if (parsedRef.data.digest !== ref.digest) throw serviceError('digest_mismatch', 'Adapter reference digest does not match the document.');
  }
  // Validate generated fields through the shared strict schema as the final boundary.
  const checked = CustomAdapterRefSchema.safeParse(ref);
  if (!checked.success) throw serviceError('invalid_reference', 'Adapter reference is invalid.');
  return checked.data;
}

function providerKind(provider: ProviderStorageRecord): typeof DECLARATIVE_HTTP_KIND | null {
  return provider.type === CUSTOM_HTTP_PROVIDER_TYPE ? DECLARATIVE_HTTP_KIND : null;
}

function redactString(value: string, sensitiveValues: readonly string[]): string {
  let output = value;
  for (const secret of sensitiveValues) {
    if (secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password|signature|authorization|auth|credential(?:s)?|idempotency[-_]?key|cookie|set-cookie)\s*[=:]\s*[^\s,;]+/giu, '[REDACTED]');
}

function redactValue(
  value: unknown,
  sensitiveValues: readonly string[],
  seen = new Set<object>(),
  key?: string,
): unknown {
  if (key !== undefined && key.toLowerCase() !== 'headers' && isCredentialLikeFieldName(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value, sensitiveValues);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return { byteLength: value.byteLength };
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => redactValue(item, sensitiveValues, seen));
    seen.delete(value);
    return result;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [childKey, child] of Object.entries(value)) result[childKey] = redactValue(child, sensitiveValues, seen, childKey);
  seen.delete(value);
  return result;
}

function redactPreview(
  preview: RedactedRequestPreview,
  endpoint: CustomAdapterEndpointName,
  url: string,
  sensitiveValues: readonly string[],
): CustomAdapterCompiledPreview {
  const result = redactValue({ ...preview, url }, sensitiveValues) as {
    url: string;
    method: RedactedRequestPreview['method'];
    relativePath: string;
    query: Readonly<Record<string, string>>;
    headers: Readonly<Record<string, string>>;
    body: RedactedBodyPreview;
  };
  return {
    ...result,
    endpoint,
  };
}

function endpointFor(spec: DeclarativeHttpSpec, name: CustomAdapterEndpointName): DeclarativeEndpoint {
  const endpoint = spec[name];
  if (endpoint === undefined) throw serviceError('invalid_request', `Adapter endpoint '${name}' is not configured.`);
  return endpoint;
}

function sampleValue(schema: unknown): unknown {
  if (!isRecord(schema)) return 'preview';
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  switch (schema.type) {
    case 'string': return typeof schema.minLength === 'number' && schema.minLength > 0 ? 'x'.repeat(schema.minLength) : (enumValues?.[0] ?? 'preview');
    case 'number': return schema.min ?? enumValues?.[0] ?? 1;
    case 'integer': return schema.min ?? enumValues?.[0] ?? 1;
    case 'boolean': return enumValues?.[0] ?? true;
    case 'object': {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(schema.properties ?? {})) result[key] = sampleValue(child);
      return result;
    }
    default: return 'preview';
  }
}

function endpointFileSelectors(endpoint: DeclarativeEndpoint): readonly { role: ProviderInput['role']; index: number }[] {
  if (endpoint.body?.type !== 'multipart') return [];
  return endpoint.body.files.map((file) => ({ role: file.input.role, index: file.input.index }));
}

function sampleInputs(spec: DeclarativeHttpSpec): readonly ProviderInput[] {
  const selectors = endpointEntries(spec).flatMap(([, endpoint]) => endpointFileSelectors(endpoint));
  const requiredRules = (spec.inputRules ?? [])
    .filter((rule) => rule.min > 0)
    .flatMap((rule) => Array.from({ length: rule.min }, (_, index) => ({ role: rule.role, index })));
  const seen = new Set<string>();
  const result: ProviderInput[] = [];
  for (const selector of [...selectors, ...requiredRules]) {
    const key = `${selector.role}:${selector.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = result.find((input) => input.role === 'source');
    result.push({
      assetId: `preview-${selector.role}-${selector.index}`,
      bytes: new Uint8Array([1, 2, 3, 4]),
      fileSize: 4,
      filename: `${selector.role}-${selector.index}.png`,
      height: 1,
      mimeType: 'image/png',
      parentAssetId: selector.role === 'mask' ? source?.assetId ?? null : null,
      role: selector.role,
      sha256: '0'.repeat(64),
      width: 1,
    });
  }
  const source = result.find((input) => input.role === 'source');
  for (const input of result) {
    if (input.role === 'mask' && input.parentAssetId === null && source !== undefined) {
      (input as { parentAssetId?: string | null }).parentAssetId = source.assetId;
    }
  }
  return result;
}

function sampleRequest(spec: DeclarativeHttpSpec, providerId: string): GenerationRequest {
  const model = spec.models[0]!;
  const operation = model.capabilities.operations.find((item) => spec.operations.includes(item)) ?? spec.operations[0]!;
  const requestSchema = projectDeclarativeModel(model).requestSchema;
  const extra = requestSchema?.properties === undefined
    ? undefined
    : Object.fromEntries(Object.entries(requestSchema.properties).map(([key, child]) => [key, sampleValue(child)]));
  const inputs = sampleInputs(spec);
  return GenerationRequestSchema.parse({
    ...(extra === undefined ? {} : { extra }),
    inputs: inputs.map(({ assetId, role }) => ({ assetId, role })),
    modelId: model.id,
    operation,
    prompt: 'Preview request',
    providerId,
  });
}

function secretContext(
  spec: DeclarativeHttpSpec,
  provided: Readonly<Record<string, string>> | undefined,
): { readonly values: Readonly<Record<string, string>>; readonly sensitive: readonly string[] } {
  const values: Record<string, string> = Object.create(null);
  const sensitive = new Set<string>();
  for (const [, endpoint] of endpointEntries(spec)) {
    const secretRef = endpoint.auth?.secretRef;
    if (secretRef === undefined) continue;
    const value = provided?.[secretRef];
    values[secretRef] = value === undefined || value.length === 0 ? '[CONFIGURED]' : value;
    if (value !== undefined && value.length > 0) sensitive.add(value);
  }
  for (const [name, value] of Object.entries(provided ?? {})) {
    if (typeof value === 'string') {
      values[name] ??= value.length > 0 ? value : '[CONFIGURED]';
      if (value.length > 0) sensitive.add(value);
    }
  }
  return { sensitive: [...sensitive], values };
}

function absoluteUrl(baseUrl: string, compiled: CompiledRequest): string {
  const base = assertDeclarativeBaseUrl(baseUrl);
  const basePath = base.pathname.replace(/\/+$/u, '');
  const output = new URL(`${base.origin}${basePath}${compiled.relativePath}`);
  for (const [name, value] of Object.entries(compiled.query)) output.searchParams.append(name, value);
  return output.toString();
}

function contextForPreview(
  spec: DeclarativeHttpSpec,
  providerId: string,
  input: CustomAdapterPreviewRequest,
  request: GenerationRequest,
  baseUrl: string,
): { readonly context: ServiceTemplateContext; readonly sensitive: readonly string[] } {
  const provided = input.secrets ?? input.secretValues ?? input.context?.secrets ?? input.context?.secretValues;
  const secrets = secretContext(spec, provided);
  const inputs = input.inputs ?? input.context?.inputs ?? sampleInputs(spec);
  return {
    context: {
      baseUrl,
      inputs,
      modelId: request.modelId,
      providerId,
      remoteJobId: input.context?.remoteJobId ?? 'preview-remote-job',
      secrets: secrets.values,
      ...(input.context?.jobId === undefined ? {} : { jobId: input.context.jobId }),
    },
    sensitive: secrets.sensitive,
  };
}

function normalizeGenerationRequest(providerId: string, request: GenerationRequest | undefined, spec: DeclarativeHttpSpec): GenerationRequest {
  const candidate = request ?? sampleRequest(spec, providerId);
  const parsed = GenerationRequestSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.providerId !== providerId) {
    throw serviceError('invalid_request', 'Generation preview request is invalid.');
  }
  return parsed.data;
}

function mapError(error: unknown): CustomAdapterServiceError {
  if (error instanceof CustomAdapterServiceError) return error;
  if (error instanceof ProviderAdapterDefinitionError) {
    if (error.code === 'disabled_revision') {
      return serviceError('storage_error', 'Adapter definition operation failed.');
    }
    const known: CustomAdapterServiceErrorCode[] = [
      'invalid_reference',
      'invalid_definition',
      'definition_too_large',
      'digest_mismatch',
      'provider_not_found',
      'already_exists',
      'not_found',
      'referenced_jobs',
      'referenced_definitions',
      'tombstoned',
      'persisted_invalid',
    ];
    return serviceError(known.includes(error.code) ? error.code : 'storage_error', 'Adapter definition operation failed.');
  }
  if (error instanceof DeclarativeCompileError) return serviceError(error.code, 'Declarative request is invalid.');
  if (error instanceof DeclarativeResponseError) return serviceError(error.code, 'Mock provider response is invalid.');
  if (error instanceof DeclarativeSpecError) {
    return serviceError(documentErrorCode(error), 'Adapter document is invalid.');
  }
  return serviceError('storage_error', 'Custom adapter operation failed.');
}

/**
 * Server-side management core for declarative HTTP revisions. It never owns
 * provider credentials and the dry-run path has no HTTP port at all.
 */
export class CustomAdapterService {
  private readonly providers: ProviderLookup;
  private readonly definitions: DefinitionRepository;
  private readonly adminEnabled: boolean;
  private readonly assertAdminCallback: ((action: CustomAdapterManagementAction) => void) | undefined;
  private readonly outbox: CustomAdapterOutboxPublisher;

  public constructor(dependencies: CustomAdapterServiceDependencies);
  public constructor(
    providers: ProviderLookup,
    adapterDefinitions: DefinitionRepository,
    authorization: AdapterAdminAuthorization,
    outbox: CustomAdapterOutboxPublisher,
  );
  public constructor(
    adapterDefinitions: DefinitionRepository,
    providers: ProviderLookup,
    authorization: AdapterAdminAuthorization,
    outbox: CustomAdapterOutboxPublisher,
  );
  public constructor(
    first: CustomAdapterServiceDependencies | ProviderLookup | DefinitionRepository,
    second?: DefinitionRepository | ProviderLookup,
    positionalAuthorization?: AdapterAdminAuthorization,
    positionalOutbox?: CustomAdapterOutboxPublisher,
  ) {
    if (second !== undefined) {
      if ('getCurrent' in first) {
        this.definitions = first as DefinitionRepository;
        this.providers = second as ProviderLookup;
      } else {
        this.providers = first as ProviderLookup;
        this.definitions = second as DefinitionRepository;
      }
      if (positionalAuthorization === undefined || positionalOutbox === undefined) {
        throw new TypeError('CustomAdapterService requires administrator authorization and an outbox publisher.');
      }
      this.adminEnabled = positionalAuthorization.adminEnabled === true;
      this.assertAdminCallback = positionalAuthorization.assertAdmin;
      this.outbox = positionalOutbox;
      return;
    }
    const dependencies = first as CustomAdapterServiceDependencies;
    const providers = dependencies.providers ?? dependencies.providerRepository ?? dependencies.repositories?.providers;
    const definitions = dependencies.adapterDefinitions ?? dependencies.definitions ?? dependencies.repositories?.adapterDefinitions;
    if (providers === undefined || definitions === undefined) {
      throw new TypeError('CustomAdapterService requires Provider and adapter-definition repositories.');
    }
    this.providers = providers;
    this.definitions = definitions;
    this.adminEnabled = dependencies.authorization.adminEnabled === true;
    this.assertAdminCallback = dependencies.authorization.assertAdmin;
    this.outbox = dependencies.outbox;
  }

  private assertAdmin(action: CustomAdapterManagementAction): void {
    if (!this.adminEnabled) throw publicAdminError();
    try {
      this.assertAdminCallback?.(action);
    } catch {
      throw publicAdminError();
    }
  }

  private async flushAfterMutation(): Promise<void> {
    try {
      await this.outbox.flush();
    } catch {
      throw serviceError('outbox_failure', 'Adapter change events could not be flushed.');
    }
  }

  public validate(input: CustomAdapterValidateRequest): CustomAdapterValidationResponse {
    this.assertAdmin('read');
    try {
      assertOwnKeys(input, VALIDATE_KEYS);
      const value = documentValue(input);
      const parsed = parseDocument(value, input.format);
      if (input.baseUrl !== undefined) assertDeclarativeBaseUrl(input.baseUrl);
      if (input.providerId !== undefined) this.assertProvider(input.providerId);
      if (input.request !== undefined) {
        const request = normalizeGenerationRequest(input.providerId ?? input.request.providerId, input.request, parsed.spec);
        const previewInput: CustomAdapterPreviewRequest = {
          providerId: request.providerId,
          request,
          baseUrl: input.baseUrl ?? 'https://preview.invalid',
          document: value,
          ...(input.format === undefined ? {} : { format: input.format }),
        };
        this.compilePreview(parsed.spec, previewInput, request, 'submit');
      }
      return { adapterId: parsed.spec.id, canonical: parsed.canonical, spec: parsed.spec, valid: true };
    } catch (error) {
      throw mapError(error);
    }
  }

  public async create(input: CustomAdapterImportRequest): Promise<ProviderAdapterDefinitionRecord>;
  public async create(providerId: string, input: Omit<CustomAdapterImportRequest, 'providerId'>): Promise<ProviderAdapterDefinitionRecord>;
  public async create(
    inputOrProviderId: CustomAdapterImportRequest | string,
    positionalInput?: Omit<CustomAdapterImportRequest, 'providerId'>,
  ): Promise<ProviderAdapterDefinitionRecord> {
    this.assertAdmin('write');
    return this.write(this.normalizeWriteInput(inputOrProviderId, positionalInput), 'create');
  }

  public async replace(input: CustomAdapterImportRequest): Promise<ProviderAdapterDefinitionRecord>;
  public async replace(providerId: string, input: Omit<CustomAdapterImportRequest, 'providerId'>): Promise<ProviderAdapterDefinitionRecord>;
  public async replace(
    inputOrProviderId: CustomAdapterImportRequest | string,
    positionalInput?: Omit<CustomAdapterImportRequest, 'providerId'>,
  ): Promise<ProviderAdapterDefinitionRecord> {
    this.assertAdmin('write');
    return this.write(this.normalizeWriteInput(inputOrProviderId, positionalInput), 'replace');
  }

  /** Import is an explicit alias for create to keep transport naming out of the core. */
  public async import(input: CustomAdapterImportRequest): Promise<ProviderAdapterDefinitionRecord> {
    this.assertAdmin('write');
    return this.write(this.normalizeWriteInput(input), 'create');
  }

  public getCurrent(target: CustomAdapterTarget | string): ProviderAdapterDefinitionRecord | null {
    this.assertAdmin('read');
    try {
      if (typeof target !== 'string') assertOwnKeys(target, TARGET_KEYS);
      const providerId = targetString(target);
      this.assertProvider(providerId);
      const current = this.definitions.getCurrent(providerId);
      this.assertRecordKind(current);
      return this.cloneNullable(current);
    } catch (error) {
      throw mapError(error);
    }
  }

  public current(target: CustomAdapterTarget | string): ProviderAdapterDefinitionRecord | null {
    this.assertAdmin('read');
    return this.getCurrent(target);
  }

  public get(target: CustomAdapterTarget): ProviderAdapterDefinitionRecord | null;
  public get(providerId: string, ref?: CustomAdapterRef): ProviderAdapterDefinitionRecord | null;
  public get(first: CustomAdapterTarget | string, second?: CustomAdapterRef): ProviderAdapterDefinitionRecord | null {
    this.assertAdmin('read');
    try {
      const target = typeof first === 'string'
        ? second === undefined ? { providerId: first } : { providerId: first, ref: second }
        : first;
      assertOwnKeys(target, TARGET_KEYS);
      const providerId = this.assertProvider(target.providerId).id;
      const ref = target.ref;
      if (ref === undefined) {
        const current = this.definitions.getCurrent(providerId);
        this.assertRecordKind(current);
        return this.cloneNullable(current);
      }
      this.assertRefKind(ref);
      return this.cloneNullable(this.definitions.getByRef(providerId, ref));
    } catch (error) {
      throw mapError(error);
    }
  }

  public getExact(providerId: string, ref: CustomAdapterRef): ProviderAdapterDefinitionRecord | null;
  public getExact(target: CustomAdapterTarget): ProviderAdapterDefinitionRecord | null;
  public getExact(first: string | CustomAdapterTarget, second?: CustomAdapterRef): ProviderAdapterDefinitionRecord | null {
    this.assertAdmin('read');
    if (typeof first === 'string') {
      return this.get(second === undefined ? { providerId: first } : { providerId: first, ref: second });
    }
    return this.get(first);
  }

  public list(target: CustomAdapterTarget | string): readonly ProviderAdapterDefinitionRecord[] {
    this.assertAdmin('read');
    try {
      if (typeof target !== 'string') assertOwnKeys(target, TARGET_KEYS);
      const providerId = targetString(target);
      this.assertProvider(providerId);
      if (this.definitions.list === undefined) {
        const current = this.definitions.getCurrent(providerId);
        this.assertRecordKind(current);
        return current === null ? [] : [cloneRecord(current)];
      }
      const records = this.definitions.list(providerId);
      for (const record of records) this.assertRecordKind(record);
      return records.map(cloneRecord);
    } catch (error) {
      throw mapError(error);
    }
  }

  public disable(target: CustomAdapterTarget | string): Promise<ProviderAdapterDefinitionRecord | null>;
  public disable(providerId: string, ref?: CustomAdapterRef): Promise<ProviderAdapterDefinitionRecord | null>;
  public async disable(first: CustomAdapterTarget | string, second?: CustomAdapterRef): Promise<ProviderAdapterDefinitionRecord | null> {
    this.assertAdmin('write');
    try {
      const target = typeof first === 'string'
        ? second === undefined ? first : { providerId: first, ref: second }
        : first;
      if (typeof target !== 'string') assertOwnKeys(target, TARGET_KEYS);
      const providerId = targetString(target);
      this.assertProvider(providerId);
      const ref = typeof target === 'string' ? undefined : target.ref;
      if (ref !== undefined) this.assertRefKind(ref);
      if (ref === undefined) {
        const current = this.definitions.getCurrent(providerId);
        this.assertRecordKind(current);
        if (current === null) return null;
      }
      const result = this.definitions.disable(providerId, ref);
      if (result === null) return null;
      this.assertRecordKind(result);
      await this.flushAfterMutation();
      return this.cloneNullable(result);
    } catch (error) {
      throw mapError(error);
    }
  }

  public delete(target: CustomAdapterTarget | string): Promise<boolean>;
  public delete(providerId: string, ref?: CustomAdapterRef): Promise<boolean>;
  public async delete(first: CustomAdapterTarget | string, second?: CustomAdapterRef): Promise<boolean> {
    this.assertAdmin('write');
    try {
      const target = typeof first === 'string'
        ? second === undefined ? first : { providerId: first, ref: second }
        : first;
      if (typeof target !== 'string') assertOwnKeys(target, TARGET_KEYS);
      const providerId = targetString(target);
      this.assertProvider(providerId);
      const ref = typeof target === 'string' ? undefined : target.ref;
      if (ref !== undefined) this.assertRefKind(ref);
      if (ref === undefined) {
        const current = this.definitions.getCurrent(providerId);
        this.assertRecordKind(current);
        if (current === null) return false;
      }
      const removed = this.definitions.delete(providerId, ref);
      if (removed) await this.flushAfterMutation();
      return removed;
    } catch (error) {
      throw mapError(error);
    }
  }

  public export(input: CustomAdapterExportRequest): CustomAdapterExportResponse {
    this.assertAdmin('read');
    try {
      assertOwnKeys(input, EXPORT_KEYS);
      const target = this.getStoredTarget(input);
      if (target.record.definition === null) throw serviceError('invalid_definition', 'Only declarative definitions can be exported.');
      const format = input.format ?? 'json';
      if (format !== 'json' && format !== 'yaml') throw serviceError('invalid_format', 'Export format is invalid.');
      const spec = parseDeclarativeJson(canonicalDeclarativeSpec(target.record.definition as unknown as DeclarativeHttpSpec));
      const envelope: CustomAdapterExportEnvelope = {
        definition: spec,
        schemaVersion: 1,
        version: target.record.ref.version,
      };
      const content = format === 'json' ? canonicalExportEnvelope(envelope) : deterministicYaml(envelope);
      return { content, document: content, format, ref: { ...target.record.ref } };
    } catch (error) {
      throw mapError(error);
    }
  }

  public exportDefinition(input: CustomAdapterExportRequest): CustomAdapterExportResponse {
    this.assertAdmin('read');
    return this.export(input);
  }

  public async capabilities(target: CustomAdapterCapabilityPreviewRequest | string): Promise<CustomAdapterCapabilityPreview> {
    this.assertAdmin('read');
    try {
      const targetObject = typeof target === 'string' ? { providerId: target } : target;
      assertOwnKeys(targetObject, CAPABILITY_KEYS);
      const draft = typeof target === 'string'
        ? undefined
        : target.document ?? target.input ?? target.spec ?? target.definition;
      const provider = this.assertProvider(targetObject.providerId);
      const spec = draft === undefined
        ? this.specFromRecord(this.getStoredTarget(targetObject).record)
        : parseDocument(draft, targetObject.format).spec;
      const adapter = new DeclarativeHttpAdapter(spec);
      const capabilities = await adapter.getCapabilities({ providerId: provider.id, secrets: {} });
      return { capabilities };
    } catch (error) {
      throw mapError(error);
    }
  }

  public async capabilityPreview(target: CustomAdapterCapabilityPreviewRequest | string): Promise<CustomAdapterCapabilityPreview> {
    this.assertAdmin('read');
    return this.capabilities(target);
  }

  public async preview(input: CustomAdapterPreviewRequest): Promise<CustomAdapterCompiledPreview & CustomAdapterCapabilityPreview> {
    this.assertAdmin('read');
    try {
      assertOwnKeys(input, PREVIEW_KEYS);
      const draft = input.document ?? input.input ?? input.spec ?? input.definition;
      const stored = draft === undefined ? this.getStoredTarget(input) : null;
      const provider = this.assertProvider(input.providerId);
      const parsed = draft === undefined
        ? { spec: this.specFromRecord(stored!.record), canonical: canonicalDeclarativeSpec(stored!.record.definition as unknown as DeclarativeHttpSpec) }
        : parseDocument(draft, input.format);
      const request = normalizeGenerationRequest(provider.id, input.request, parsed.spec);
      const endpoint = input.endpoint ?? 'submit';
      const compiled = this.compilePreview(parsed.spec, input, request, endpoint);
      const adapter = new DeclarativeHttpAdapter(parsed.spec);
      const capabilities = await adapter.getCapabilities({ providerId: provider.id, secrets: {} });
      return { ...compiled, capabilities };
    } catch (error) {
      throw mapError(error);
    }
  }

  public async dryRun(input: CustomAdapterPreviewRequest): Promise<CustomAdapterDryRunResponse> {
    this.assertAdmin('read');
    const result = await this.preview(input);
    return {
      capabilities: result.capabilities,
      endpoint: result.endpoint,
      network: false,
      performed: false,
      preview: result,
      request: result,
    };
  }

  public simulateResponse(input: CustomAdapterSimulateRequest): DeclarativeExtractedResponse {
    this.assertAdmin('read');
    try {
      assertOwnKeys(input, SIMULATE_KEYS);
      const draft = input.document ?? input.input ?? input.spec ?? input.definition;
      const stored = draft === undefined ? this.getStoredTarget(input) : null;
      this.assertProvider(input.providerId);
      const spec = draft === undefined
        ? this.specFromRecord(stored!.record)
        : parseDocument(draft, input.format).spec;
      const endpointName = input.endpoint ?? 'submit';
      const endpoint = endpointFor(spec, endpointName);
      const response = normalizeMockResponse(input.response);
      const phase = input.phase ?? endpointName;
      return sanitizeSimulatedFailure(
        extractDeclarativeResponse(endpoint, response, phase, [], input.expectedRemoteJobId),
        input.response,
      );
    } catch (error) {
      throw mapError(error);
    }
  }

  public testResponse(input: CustomAdapterSimulateRequest): DeclarativeExtractedResponse {
    this.assertAdmin('read');
    return this.simulateResponse(input);
  }

  public testPath(input: CustomAdapterPathTestRequest): CustomAdapterPathTestResponse {
    this.assertAdmin('read');
    try {
      assertOwnKeys(input, PATH_TEST_KEYS);
      this.assertProvider(input.providerId);
      if (
        typeof input.path !== 'string' ||
        input.path.length === 0 ||
        input.path.length > MAX_POINTER_LENGTH ||
        !input.path.startsWith('/')
      ) {
        throw serviceError('invalid_path', 'Response path is invalid.');
      }
      let document = input.document;
      if (document === undefined && input.response !== undefined) {
        const response = normalizeMockResponse(input.response);
        document = response.json !== undefined
          ? response.json
          : response.body !== undefined
            ? response.body
            : response.text;
      }
      if (document === undefined) document = input.json ?? input.text;
      if (document === undefined) throw serviceError('invalid_request', 'Path test document is required.');
      document = boundedPathDocument(document);
      const value = readJsonPointer(document, input.path);
      const key = finalPointerKey(input.path);
      return {
        found: value !== undefined,
        path: input.path,
        value: key !== undefined && isCredentialLikeFieldName(key) ? '[REDACTED]' : redactValue(value, []),
      };
    } catch (error) {
      throw mapError(error);
    }
  }

  public testResponsePath(input: CustomAdapterPathTestRequest): CustomAdapterPathTestResponse {
    this.assertAdmin('read');
    return this.testPath(input);
  }

  private async write(input: CustomAdapterImportRequest, mode: 'create' | 'replace'): Promise<ProviderAdapterDefinitionRecord> {
    try {
      assertOwnKeys(input, IMPORT_KEYS);
      const provider = this.assertProvider(input.providerId);
      if (providerKind(provider) !== DECLARATIVE_HTTP_KIND) {
        throw serviceError('provider_type_mismatch', 'Provider type does not accept declarative HTTP adapters.');
      }
      const parsed = parseDocument(documentValue(input), input.format);
      if (parsed.envelopeVersion !== undefined && input.version !== undefined && parsed.envelopeVersion !== input.version) {
        throw serviceError('invalid_reference', 'Adapter export envelope version does not match the requested revision.');
      }
      const ref = normalizeRef(
        parsed.spec,
        parsed.canonical,
        input.version ?? parsed.envelopeVersion,
        input.ref,
        parsed.envelopeVersion,
      );
      const record = mode === 'create'
        ? this.definitions.create(provider.id, { definition: parsed.spec, ref })
        : this.definitions.replace(provider.id, { definition: parsed.spec, ref });
      await this.flushAfterMutation();
      return cloneRecord(record);
    } catch (error) {
      throw mapError(error);
    }
  }

  private assertProvider(providerId: string): ProviderStorageRecord {
    const id = safeString(providerId, 'Provider id');
    const provider = this.providers.get(id);
    if (provider === null) throw serviceError('provider_not_found', 'Provider was not found.');
    if (provider.type !== CUSTOM_HTTP_PROVIDER_TYPE) throw serviceError('provider_type_mismatch', 'Provider type does not accept declarative HTTP adapters.');
    return provider;
  }

  private normalizeWriteInput(
    inputOrProviderId: CustomAdapterImportRequest | string,
    positionalInput?: Omit<CustomAdapterImportRequest, 'providerId'>,
  ): CustomAdapterImportRequest {
    if (typeof inputOrProviderId === 'string') {
      if (positionalInput === undefined || !isRecord(positionalInput)) {
        throw serviceError('invalid_request', 'Adapter management request is invalid.');
      }
      return { ...positionalInput, providerId: inputOrProviderId };
    }
    return inputOrProviderId;
  }

  private assertRefKind(ref: CustomAdapterRef): void {
    const parsed = CustomAdapterRefSchema.safeParse(ref);
    if (!parsed.success) throw serviceError('invalid_reference', 'Adapter reference is invalid.');
    if (parsed.data.kind !== DECLARATIVE_HTTP_KIND) throw serviceError('provider_adapter_kind_mismatch', 'Adapter reference kind does not match custom HTTP.');
  }

  private assertRecordKind(record: ProviderAdapterDefinitionRecord | null): void {
    if (record !== null && record.ref.kind !== DECLARATIVE_HTTP_KIND) {
      throw serviceError('provider_adapter_kind_mismatch', 'Adapter reference kind does not match custom HTTP.');
    }
  }

  private getStoredTarget(target: CustomAdapterTarget): StoredTarget {
    const provider = this.assertProvider(target.providerId);
    if (target.ref !== undefined) this.assertRefKind(target.ref);
    const record = target.ref === undefined
      ? this.definitions.getCurrent(provider.id)
      : this.definitions.getByRef(provider.id, target.ref);
    if (record === null) throw serviceError('adapter_not_found', 'Adapter revision was not found.');
    if (record.ref.kind !== DECLARATIVE_HTTP_KIND) throw serviceError('provider_adapter_kind_mismatch', 'Adapter reference kind does not match custom HTTP.');
    return { provider, record };
  }

  private specFromRecord(record: ProviderAdapterDefinitionRecord): DeclarativeHttpSpec {
    if (record.definition === null) throw serviceError('invalid_definition', 'Stored adapter definition is invalid.');
    try {
      return parseDeclarativeJson(canonicalDeclarativeSpec(record.definition as unknown as DeclarativeHttpSpec));
    } catch {
      throw serviceError('persisted_invalid', 'Stored adapter definition is invalid.');
    }
  }

  private cloneNullable(record: ProviderAdapterDefinitionRecord | null): ProviderAdapterDefinitionRecord | null {
    return record === null ? null : cloneRecord(record);
  }

  private compilePreview(
    spec: DeclarativeHttpSpec,
    input: CustomAdapterPreviewRequest,
    request: GenerationRequest,
    endpointName: CustomAdapterEndpointName,
  ): CustomAdapterCompiledPreview {
    const endpoint = endpointFor(spec, endpointName);
    const baseUrl = input.baseUrl ?? input.context?.baseUrl ?? this.providers.get(request.providerId)?.baseUrl;
    if (baseUrl === null || baseUrl === undefined) throw serviceError('invalid_base_url', 'Provider Base URL is required for preview.');
    const context = contextForPreview(spec, request.providerId, input, request, baseUrl);
    let preview: RedactedRequestPreview;
    let compiled: CompiledRequest;
    if (endpointName === 'submit') {
      preview = redactedRequestPreview(spec, request, context.context, endpoint);
      compiled = {
        ...preview,
        expectedStatus: endpoint.expectedStatus,
        extract: endpoint.extract,
        responseType: endpoint.responseType,
        body: preview.body as never,
      } as unknown as CompiledRequest;
    } else {
      const allowed = new Set(Object.keys(projectDeclarativeModel(spec.models.find((model) => model.id === request.modelId) ?? spec.models[0]!).requestSchema?.properties ?? {}));
      compiled = compileEndpoint(endpoint, request, context.context, {
        allowedExtraFields: allowed,
        mode: 'redacted',
      });
      preview = {
        body: redactValue(compiled.body, context.sensitive) as RedactedBodyPreview,
        headers: redactValue(compiled.headers, context.sensitive) as Readonly<Record<string, string>>,
        method: compiled.method,
        query: redactValue(compiled.query, context.sensitive) as Readonly<Record<string, string>>,
        relativePath: compiled.relativePath,
      };
    }
    const url = absoluteUrl(baseUrl, compiled);
    return redactPreview(preview, endpointName, url, context.sensitive);
  }
}

function targetString(target: CustomAdapterTarget | string): string {
  return typeof target === 'string' ? safeString(target, 'Provider id') : safeString(target.providerId, 'Provider id');
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (isRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = stableJson(value[key]);
    return result;
  }
  return value;
}

function canonicalExportEnvelope(envelope: CustomAdapterExportEnvelope): string {
  const output = JSON.stringify(stableJson(envelope));
  if (Buffer.byteLength(output, 'utf8') > MAX_SPEC_BYTES) throw serviceError('definition_too_large', 'Adapter export is too large.');
  return output;
}

function deterministicYaml(envelope: CustomAdapterExportEnvelope): string {
  const output = stringifyYaml(stableJson(envelope), {
    lineWidth: 0,
    sortMapEntries: true,
  });
  if (Buffer.byteLength(output, 'utf8') > MAX_SPEC_BYTES) throw serviceError('definition_too_large', 'Adapter export is too large.');
  return output;
}

function normalizeMockResponse(response: CustomAdapterMockResponse): DeclarativeResponse {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw serviceError('invalid_response', 'Mock response status is invalid.');
  }
  if (response.statusCode !== undefined && response.statusCode !== response.status) {
    throw serviceError('invalid_response', 'Mock response status is inconsistent.');
  }
  const headers = response.headers;
  if (headers !== undefined) {
    const entries = Object.entries(headers);
    if (entries.length > MAX_MOCK_RESPONSE_HEADERS) throw serviceError('response_too_large', 'Mock response headers are too large.');
    for (const [name, value] of entries) {
      if (name.length === 0 || name.length > MAX_MOCK_RESPONSE_HEADER_LENGTH || /[\r\n]/u.test(name)) throw serviceError('invalid_response', 'Mock response header is invalid.');
      for (const item of typeof value === 'string' ? [value] : value ?? []) {
        if (item !== undefined && (item.length > MAX_MOCK_RESPONSE_HEADER_LENGTH || /[\r\n]/u.test(item))) throw serviceError('invalid_response', 'Mock response header is invalid.');
      }
    }
  }
  return {
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(headers === undefined ? {} : { headers }),
    ...(response.json === undefined ? {} : { json: response.json }),
    ...(response.text === undefined ? {} : { text: response.text }),
    status: response.status,
  };
}

function collectResponseStrings(value: unknown, output = new Set<string>(), seen = new Set<object>()): ReadonlySet<string> {
  if (typeof value === 'string') {
    if (value.length > 0) output.add(value);
    return output;
  }
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectResponseStrings(child, output, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      output.add(key);
      collectResponseStrings(child, output, seen);
    }
  }
  seen.delete(value);
  return output;
}

function sanitizeSimulatedFailure(
  result: DeclarativeExtractedResponse,
  response: CustomAdapterMockResponse,
): DeclarativeExtractedResponse {
  if (result.state !== 'failed') return result;
  const sensitive = [...collectResponseStrings(response)];
  const candidateCode = redactString(result.error.code, sensitive);
  const code = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(candidateCode) && !candidateCode.includes('[REDACTED]')
    ? candidateCode
    : 'mock_response_error';
  return {
    state: 'failed',
    error: {
      code,
      kind: result.error.kind,
      message: 'Mock provider response failed.',
      retryable: result.error.retryable,
      ...(result.error.retryAfterMs === undefined ? {} : { retryAfterMs: result.error.retryAfterMs }),
      ...(result.error.statusCode === undefined ? {} : { statusCode: result.error.statusCode }),
    },
  };
}

function boundedPathDocument(value: unknown): unknown {
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
    if (bytes > MAX_RESPONSE_JSON_BYTES) throw serviceError('response_too_large', 'Path test document is too large.');
    let text: string;
    try {
      text = typeof value === 'string' ? value : new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      throw serviceError('invalid_response', 'Path test document is not valid UTF-8.');
    }
    try {
      const parsed = parseBoundedJsonDocument(text, PATH_RESPONSE_LIMITS);
      assertBoundedJsonTree(parsed, PATH_RESPONSE_LIMITS);
      return parsed;
    } catch (error) {
      if (error instanceof CustomAdapterServiceError) throw error;
      if (error instanceof DeclarativeSpecError) {
        const message = error.message.toLowerCase();
        if (error.code === 'input_too_large' || /too (?:many|deep|large)|oversized/u.test(message)) {
          throw serviceError('response_too_large', 'Path test document is too large.');
        }
      }
      throw serviceError('invalid_response', 'Path test document is invalid JSON.');
    }
  }
  try {
    assertBoundedJsonTree(value, PATH_RESPONSE_LIMITS);
    return value;
  } catch (error) {
    if (error instanceof DeclarativeSpecError) {
      const message = error.message.toLowerCase();
      if (/too (?:many|deep|large)|oversized/u.test(message)) throw serviceError('response_too_large', 'Path test document is too large.');
    }
    throw serviceError('invalid_response', 'Path test document is invalid JSON.');
  }
}

function finalPointerKey(pointer: string): string | undefined {
  const raw = pointer.slice(1).split('/').at(-1);
  return raw === undefined ? undefined : raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

export function digestDeclarativeDefinition(canonical: string): string {
  return digest(canonical);
}

export {
  CustomAdapterService as DeclarativeAdapterService,
  CustomAdapterService as DeclarativeHttpAdapterService,
  CustomAdapterService as CustomHttpAdapterService,
  CustomAdapterService as DeclarativeHttpManagementService,
};
