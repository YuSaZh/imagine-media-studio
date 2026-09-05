import { assertSafeCustomFields, isCredentialLikeMetadataKey, isStrictRestrictedRequestSchema, BoundedJsonValueSchema, TrustedAdapterManifestSchema, type BoundedJsonValue } from '@imagine/shared';

import { isAlias, isMap, isSeq, parseDocument as parseYamlDocument } from 'yaml';



/**
 * PR6 management UI types intentionally live beside the component. The
 * server API remains the owner of transport DTOs; this file only maps form
 * values to callback payloads and never performs a request itself.
 */

export type AdapterDocumentFormat = 'json' | 'yaml';


export type CustomAdapterMode = 'custom-http' | 'trusted-js';


export type AdapterWorkspaceStatus =
  | 'loading'
  | 'empty'
  | 'error'
  | 'success'
  | 'disabled'
  | 'admin-unavailable'
  | 'offline';



export interface CustomHttpDraft {
  readonly format: AdapterDocumentFormat;
  readonly document: string;
  readonly version: string;
  readonly baseUrl: string;
  readonly requestJson: string;
  readonly simulationStatus: string;
  readonly simulationJson: string;
  readonly path: string;
  readonly pathTestJson: string;
}



export interface TrustedJsDraft {
  readonly manifest: string;
  readonly providerId: string;
}



export interface AdapterRevisionRef {
  readonly kind: 'declarative-http' | 'trusted-javascript';
  readonly adapterId: string;
  readonly version: string;
  readonly digest: string;
}



export interface AdapterRevision extends AdapterRevisionRef {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly displayName?: string;
}



export interface CustomHttpPreviewBody {
  readonly type: 'none' | 'json' | 'form' | 'multipart';
  readonly value?: unknown;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly files?: readonly PreviewFileMetadata[];
}



export interface PreviewFileMetadata {
  readonly field: string;
  readonly filename: string;
  readonly contentType: string;
  readonly assetId: string;
  readonly byteLength: number;
}



export interface CustomHttpPreview {
  readonly method: string;
  readonly url: string;
  readonly relativePath?: string;
  readonly endpoint?: string;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: CustomHttpPreviewBody;
}



export interface TrustedManifestSummary {
  readonly schemaVersion?: number;
  readonly id?: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly sha256?: string;
  readonly capabilities?: unknown;
  readonly operations?: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly requiredSecrets: readonly string[];
  readonly resourceLimits: Readonly<Record<string, number>>;
}



export interface TrustedAdapterSummary {
  readonly adapterId: string;
  readonly version?: string;
  readonly displayName?: string;
  readonly ref?: AdapterRevisionRef;
  readonly manifest?: TrustedManifestSummary;
  readonly updatedAt?: string;
}



export interface CustomHttpDocumentPayload {
  readonly providerId?: string;
  readonly format: AdapterDocumentFormat;
  readonly document: string;
  readonly baseUrl?: string;
}



export interface CustomHttpRequestPayload extends CustomHttpDocumentPayload {
  readonly version?: string;
  readonly request?: unknown;
}



export interface CustomHttpSimulationPayload extends CustomHttpDocumentPayload {
  readonly version?: string;
  readonly response: { readonly status: number; readonly json: unknown };
}



/** Path tests inspect a response document, not an adapter definition. */
export interface CustomHttpPathTestPayload {
  readonly providerId?: string;
  readonly path: string;
  readonly json: BoundedJsonValue;
}



export interface TrustedJsInstallPayload {
  readonly manifest: TrustedManifestSummary;
  readonly manifestText: string;
  readonly providerId?: string;
  /** API-compatible alias for the selected source file. */
  readonly source: File;
  /** The source File is passed through without reading its content. */
  readonly sourceFile: File;
}



export interface TrustedJsBindPayload {
  readonly providerId: string;
  readonly ref?: AdapterRevisionRef;
}



export interface ImportedAdapterDocument {
  readonly document: string;
  readonly format: AdapterDocumentFormat;
  readonly version?: string;
}



export interface CustomAdapterWorkspaceActions {
  readonly onModeChange?: (mode: CustomAdapterMode) => void;
  readonly onCustomHttpChange?: (draft: CustomHttpDraft) => void;
  readonly onTrustedJsChange?: (draft: TrustedJsDraft) => void;
  readonly onImportDocument?: (file: File) => void | string | ImportedAdapterDocument | Promise<void | string | ImportedAdapterDocument>;
  readonly onValidate?: (payload: CustomHttpRequestPayload) => void | Promise<void>;
  readonly onSave?: (payload: CustomHttpRequestPayload) => void | Promise<void>;
  readonly onExport?: (payload: { readonly format: AdapterDocumentFormat; readonly ref?: AdapterRevisionRef }) => void | Promise<void>;
  readonly onPreview?: (payload: CustomHttpRequestPayload) => void | Promise<void>;
  readonly onDryRun?: (payload: CustomHttpRequestPayload) => void | Promise<void>;
  readonly onSimulate?: (payload: CustomHttpSimulationPayload) => void | Promise<void>;
  readonly onPathTest?: (payload: CustomHttpPathTestPayload) => void | Promise<void>;
  readonly onCapabilitiesPreview?: (payload: CustomHttpDocumentPayload) => void | Promise<void>;
  readonly onLoadMoreRevisions?: (cursor?: string | null) => void | Promise<void>;
  readonly onLoadMoreTrustedBindings?: (cursor?: string | null) => void | Promise<void>;
  readonly onLoadRevision?: (revision: AdapterRevisionRef) => ActionOutcome;
  readonly onDisable?: (revision?: AdapterRevisionRef) => ActionOutcome;
  readonly onDelete?: (revision?: AdapterRevisionRef) => ActionOutcome;
  readonly onManifestFileImport?: (file: File) => void | string | Promise<void | string>;
  readonly onSourceFileSelect?: (file: File) => void | Promise<void>;
  readonly onInstall?: (payload: TrustedJsInstallPayload) => void | Promise<void>;
  readonly onListTrusted?: () => void | Promise<void>;
  readonly onGetTrusted?: (adapterId: string) => void | Promise<void>;
  readonly onRemoveTrusted?: (adapterId: string) => ActionOutcome;
  readonly onBindProvider?: (payload: TrustedJsBindPayload) => void | Promise<void>;
  readonly onDisableProviderBinding?: (ref?: AdapterRevisionRef) => ActionOutcome;
  readonly onUnbindProvider?: (ref: AdapterRevisionRef) => ActionOutcome;
}



type ActionKey = keyof CustomAdapterWorkspaceActions;


type ActionHandler = (...args: unknown[]) => unknown | Promise<unknown>;


type ActionOutcome = void | boolean | Promise<void | boolean>;



export interface LatestImportSequence {
  readonly begin: () => number;
  readonly invalidate: () => void;
  readonly isLatest: (token: number) => boolean;
}



export type AdapterFileImportState = 'idle' | 'reading' | 'complete' | 'error';


export type AdapterFileImportOutcome =
  | { readonly state: 'complete' }
  | { readonly state: 'error'; readonly error: unknown }
  | { readonly state: 'stale' };



export function isFileImportSelectionDisabled(
  disabled: boolean,
  busy: boolean,
  state: AdapterFileImportState,
): boolean {
  return disabled || busy || state === 'reading';
}



export function adapterWorkspaceDisabledState(input: {
  readonly adminAvailable: boolean;
  readonly disabled: boolean;
  readonly importPending: boolean;
  readonly mode: CustomAdapterMode;
  readonly status: AdapterWorkspaceStatus;
}): { readonly localDisabled: boolean; readonly remoteDisabled: boolean } {
  const trustedBindingMayBeDisabled = input.mode === 'trusted-js' && input.status === 'disabled';
  return {
    localDisabled: input.disabled || input.status === 'loading' || (!trustedBindingMayBeDisabled && input.status === 'disabled'),
    remoteDisabled: input.importPending || input.disabled || !input.adminAvailable || input.status === 'loading' || input.status === 'error' || (!trustedBindingMayBeDisabled && input.status === 'disabled') || input.status === 'admin-unavailable' || input.status === 'offline',
  };
}



/** Coordinates asynchronous file reads so stale results cannot replace newer input. */
export function createLatestImportSequence(): LatestImportSequence {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    invalidate: () => { latest += 1; },
    isLatest: (token) => token === latest,
  };
}



export async function settleLatestImport<T>(
  sequence: LatestImportSequence,
  token: number,
  read: () => T | Promise<T>,
  apply: (value: T) => void,
): Promise<AdapterFileImportOutcome> {
  try {
    const value = await read();
    if (!sequence.isLatest(token)) return { state: 'stale' };
    apply(value);
    return { state: 'complete' };
  } catch (error) {
    return sequence.isLatest(token) ? { state: 'error', error } : { state: 'stale' };
  }
}



export interface CustomAdapterWorkspaceProps extends CustomAdapterWorkspaceActions {
  readonly actions?: CustomAdapterWorkspaceActions;
  readonly mode?: CustomAdapterMode;
  readonly modeLocked?: boolean;
  /** `kind` is accepted as a compatibility alias for callers using API names. */
  readonly kind?: CustomAdapterMode | 'declarative-http' | 'trusted-javascript';
  readonly state?: AdapterWorkspaceStatus;
  readonly status?: AdapterWorkspaceStatus;
  readonly statusMessage?: string;
  readonly disabled?: boolean;
  readonly online?: boolean;
  readonly adminAvailable?: boolean;
  readonly providerId?: string;
  readonly customHttp?: Partial<CustomHttpDraft>;
  readonly trustedJs?: Partial<TrustedJsDraft>;
  readonly revisions?: readonly AdapterRevision[];
  readonly revisionsCursor?: string | null;
  readonly preview?: CustomHttpPreview | null;
  readonly capabilityPreview?: unknown;
  readonly simulationResult?: unknown;
  readonly dryRunResult?: unknown;
  readonly pathTestResult?: unknown;
  readonly trustedAdapters?: readonly TrustedAdapterSummary[];
  readonly trustedBinding?: TrustedAdapterSummary | null;
  readonly trustedBindingDisabled?: boolean;
  readonly trustedBindingHistory?: readonly AdapterRevision[];
  readonly trustedBindingHistoryCursor?: string | null;
  readonly trustedManifestPreview?: TrustedManifestSummary | null;
  readonly trustedAdapterRef?: AdapterRevisionRef | null;
}



export const DEFAULT_CUSTOM_HTTP_DRAFT: CustomHttpDraft = {
  format: 'json',
  document: '{\n  "schemaVersion": 1,\n  "id": "custom-adapter",\n  "name": "Custom adapter",\n  "operations": ["image.generate"],\n  "models": [{\n    "id": "custom-image",\n    "displayName": "Custom image",\n    "capabilities": {\n      "operations": ["image.generate"],\n      "supportsBatchCount": false,\n      "maxBatchCount": 1\n    }\n  }],\n  "submit": {\n    "method": "POST",\n    "path": "/v1/images/generations",\n    "body": {\n      "type": "json",\n      "value": {\n        "model": "{{ request.modelId }}",\n        "prompt": "{{ request.prompt }}"\n      }\n    },\n    "extract": {\n      "resultUrlPath": "/data/url",\n      "resultType": "image"\n    }\n  }\n}',
  version: '1.0.0',
  baseUrl: '',
  requestJson: '{\n  "prompt": "A test prompt"\n}',
  simulationStatus: '200',
  simulationJson: '{\n  "status": "completed"\n}',
  path: '/status',
  pathTestJson: '{\n  "status": "completed"\n}',
};



export const DEFAULT_TRUSTED_JS_DRAFT: TrustedJsDraft = {
  manifest: '',
  providerId: '',
};



const FORBIDDEN_FIELD_NAMES = new Set([
  'adminenabled',
  'apikey',
  'secret',
  'secrets',
  'secretvalue',
  'secretvalues',
  'password',
  'token',
  'credential',
  'credentials',
  'privatekey',
]);


const DECLARATIVE_ENDPOINT_NAMES = new Set(['submit', 'poll', 'cancel', 'connection', 'catalog']);


const DANGEROUS_REFERENCE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);


const PREVIEW_REDACT_PATTERN = /(?:authorization|cookie|apikey|api[-_]?key|secret|password|token|credential|signature|private[-_]?key)/iu;


const ADAPTER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;


const STATIC_CREDENTIAL_HEADER = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:x[-_])?api[-_]?key|access[-_]?token|oauth[-_]?token|auth(?:[-_]?token)?|credential|signature|password|secret|token|x[-_]?(?:amz|goog|ms)[-_])/iu;


const CREDENTIAL_FIELD_NAME = /(?:^|[-_.])(?:token|key|api[-_.]?key|authorization|auth|cookie|password|secret|credential|credentials|signature|sig|access[-_.]?token|oauth[-_.]?token|idempotency[-_.]?key|headers?)(?:$|[-_.])/iu;


const CREDENTIAL_QUERY_TOKEN_PATTERN = /(?:^|[-_.])(?:token|key|api[-_.]?key|access[-_.]?token|auth|authorization|credential|credentials|signature|sig|secret|password|cookie|idempotency[-_.]?key|bearer)(?=$|[-_.])/iu;


const CREDENTIAL_QUERY_PREFIX_PATTERN = /^x[-_.]?(?:amz|goog|ms)(?:[-_.].+)?$/iu;


const OAUTH_QUERY_PREFIX_PATTERN = /^oauth(?:[-_.].*)?$/iu;


const SECRET_TEMPLATE_PATTERN = /\{\{\s*secret\.[^{}]+?\s*\}\}/u;


const STATIC_SECRET_PATTERN = /(?:Bearer\s+[A-Za-z0-9._-]{8,}|(?:sk|pk|ghp|xai|AIza)[-_A-Za-z0-9]{8,})/u;


export const STATUS_LABELS: Record<AdapterWorkspaceStatus, string> = {
  loading: 'Loading adapter workspace',
  empty: 'No adapter is configured',
  error: 'Adapter workspace error',
  success: 'Adapter workspace ready',
  disabled: 'Adapter is disabled',
  'admin-unavailable': 'Administrator access is unavailable',
  offline: 'Offline - adapter management is unavailable',
};



function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}



type SecurityPathSegment = string | number;


type CredentialContainer = 'body' | 'customFields' | 'files' | 'headers' | 'query' | 'requestSchema' | 'requestSchemaProperties';



function securityPathString(path: readonly SecurityPathSegment[]): string {
  return path.reduce<string>((output, segment) => typeof segment === 'number' ? `${output}[${segment}]` : `${output}.${segment}`, '$');
}



function isExportEnvelopeRoot(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 &&
    keys.every((key) => key === 'schemaVersion' || key === 'version' || key === 'definition') &&
    value.schemaVersion === 1 &&
    typeof value.version === 'string' &&
    isObject(value.definition);
}



function isAllowedSecretRefPath(path: readonly SecurityPathSegment[], envelope: boolean): boolean {
  const offset = envelope ? 1 : 0;
  return path.length === offset + 3 &&
    (!envelope || path[0] === 'definition') &&
    typeof path[offset] === 'string' &&
    DECLARATIVE_ENDPOINT_NAMES.has(path[offset] as string) &&
    path[offset + 1] === 'auth' &&
    path[offset + 2] === 'secretRef';
}



function isSafeSecretReference(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized.length > 0 &&
    normalized.length <= 128 &&
    !DANGEROUS_REFERENCE_NAMES.has(normalized);
}



function isCredentialLikeQueryName(value: string): boolean {
  const normalized = value.trim();
  return CREDENTIAL_QUERY_TOKEN_PATTERN.test(normalized) ||
    CREDENTIAL_QUERY_PREFIX_PATTERN.test(normalized) ||
    OAUTH_QUERY_PREFIX_PATTERN.test(normalized);
}



function isCredentialLikeFieldName(value: string): boolean {
  return CREDENTIAL_FIELD_NAME.test(value) || isCredentialLikeQueryName(value);
}



function normalizeFieldName(value: string): string {
  return value.replace(/[-_]/gu, '').toLowerCase();
}



function isForbiddenFieldName(value: string): boolean {
  const normalized = normalizeFieldName(value);
  if (normalized === 'requiredsecrets') return false;
  return FORBIDDEN_FIELD_NAMES.has(normalized);
}



function childCredentialContainer(key: string, container: CredentialContainer | undefined): CredentialContainer | undefined {
  if (key === 'body') return 'body';
  if (key === 'customFields') return 'customFields';
  if (key === 'files') return 'files';
  if (key === 'headers') return 'headers';
  if (key === 'query') return 'query';
  if (key === 'requestSchema') return 'requestSchema';
  if (container === 'requestSchema' && key === 'properties') return 'requestSchemaProperties';
  if (container === 'requestSchemaProperties') return 'requestSchema';
  return container;
}



function schemaChildContainer(
  container: CredentialContainer | undefined,
  key: string,
  child: unknown,
): CredentialContainer | 'reject' | undefined {
  const schemaProperty = container === 'requestSchemaProperties' ||
    (container === 'customFields' && isCredentialLikeMetadataKey(key));
  if (!schemaProperty) return undefined;
  return isStrictRestrictedRequestSchema(child, { maxKeys: MAX_SECURITY_KEYS }) ? 'requestSchema' : 'reject';
}



function forbiddenFieldPaths(
  value: unknown,
  path: string,
  pathSegments: readonly SecurityPathSegment[],
  envelope: boolean,
  container: CredentialContainer | undefined,
  seen: Set<object>,
): string[] {
  if (typeof value === 'string') return SECRET_TEMPLATE_PATTERN.test(value) ? [path] : [];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [`${path} (cycle)`];
  seen.add(value);
  const result: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      result.push(...forbiddenFieldPaths(item, `${path}[${index}]`, [...pathSegments, index], envelope, container, seen));
    });
  } else {
    Object.entries(value).forEach(([key, child]) => {
      const childPath = `${path}.${key}`;
      const childPathSegments = [...pathSegments, key];
      if (key === 'customFields') {
        try {
          assertSafeCustomFields(child, CUSTOM_FIELDS_SECURITY_OPTIONS);
        } catch {
          result.push(childPath);
          return;
        }
        return;
      }
      const schemaContainer = schemaChildContainer(container, key, child);
      if (schemaContainer !== undefined) {
        if (schemaContainer === 'reject') result.push(childPath);
        else result.push(...forbiddenFieldPaths(child, childPath, childPathSegments, envelope, schemaContainer, seen));
        return;
      }
      if (container === 'body' && isCredentialLikeFieldName(key)) {
        result.push(childPath);
        return;
      }
      if (container === 'headers' && STATIC_CREDENTIAL_HEADER.test(key)) {
        result.push(childPath);
        return;
      }
      if (container === 'query' && isCredentialLikeQueryName(key)) {
        result.push(childPath);
        return;
      }
      if (container === 'files' && key === 'field' && typeof child === 'string' && isCredentialLikeFieldName(child)) {
        result.push(childPath);
        return;
      }
      if (key === 'secretRef' && isAllowedSecretRefPath(childPathSegments, envelope)) {
        if (!isSafeSecretReference(child) || (typeof child === 'string' && SECRET_TEMPLATE_PATTERN.test(child))) result.push(childPath);
        return;
      }
      if (key === 'secretRef') {
        result.push(childPath);
        return;
      }
      if (isForbiddenFieldName(key)) {
        result.push(childPath);
        return;
      }
      const childContainer = childCredentialContainer(key, container);
      result.push(...forbiddenFieldPaths(child, childPath, childPathSegments, envelope, childContainer, seen));
    });
  }
  seen.delete(value);
  return result;
}



/** Returns forbidden browser/server boundary fields without exposing values. */
export function findForbiddenAdapterFields(value: unknown): readonly string[] {
  return forbiddenFieldPaths(value, '$', [], isExportEnvelopeRoot(value), undefined, new Set<object>());
}



export function hasForbiddenAdapterFields(value: unknown): boolean {
  return findForbiddenAdapterFields(value).length > 0;
}



export interface AdapterValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}



export interface AdapterValidationFailure {
  readonly ok: false;
  readonly error: string;
}



export type AdapterValidationResult<T> = AdapterValidationSuccess<T> | AdapterValidationFailure;



const MAX_SECURITY_DOCUMENT_BYTES = 128 * 1024;


const MAX_SECURITY_DEPTH = 12;


const MAX_SECURITY_NODES = 10_000;


const MAX_SECURITY_KEYS = 512;


const MAX_SECURITY_ARRAY_ITEMS = 128;


const MAX_SECURITY_STRING_LENGTH = 4_096;


const CUSTOM_FIELDS_SECURITY_OPTIONS = {
  isSecretTemplate: (value: string): boolean => SECRET_TEMPLATE_PATTERN.test(value),
  maxKeys: MAX_SECURITY_KEYS,
} as const;



function assertSafeYamlNodes(node: unknown, seen = new Set<object>()): void {
  if (node === null || typeof node !== 'object') return;
  if (isAlias(node)) throw new Error('YAML aliases are not allowed.');
  if (seen.has(node)) throw new Error('YAML document contains a cycle.');
  const candidate = node as { readonly tag?: unknown; readonly items?: readonly unknown[] };
  if (candidate.tag !== undefined) throw new Error('YAML tags are not allowed.');
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



function assertBoundedSecurityTree(value: unknown, depth = 0, state = { arrays: 0, keys: 0, nodes: 0, strings: 0 }, seen = new Set<object>()): void {
  state.nodes += 1;
  if (state.nodes > MAX_SECURITY_NODES || depth > MAX_SECURITY_DEPTH) throw new Error('Adapter document exceeds the browser safety bounds.');
  if (typeof value === 'string') {
    state.strings += value.length;
    if (value.length > MAX_SECURITY_STRING_LENGTH || state.strings > MAX_SECURITY_NODES * MAX_SECURITY_STRING_LENGTH) throw new Error('Adapter document contains oversized strings.');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Adapter document contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new Error('Adapter document contains a non-JSON value.');
  if (seen.has(value)) throw new Error('Adapter document contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      state.arrays += 1;
      if (value.length > MAX_SECURITY_ARRAY_ITEMS || state.arrays > MAX_SECURITY_ARRAY_ITEMS) throw new Error('Adapter document contains an oversized array.');
      value.forEach((item) => assertBoundedSecurityTree(item, depth + 1, state, seen));
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) throw new Error('Adapter document object is not plain.');
      const entries = Object.entries(value);
      state.keys += entries.length;
      if (state.keys > MAX_SECURITY_KEYS) throw new Error('Adapter document contains too many keys.');
      entries.forEach(([key, child]) => {
        if (key.length === 0 || key.length > MAX_SECURITY_STRING_LENGTH || DANGEROUS_REFERENCE_NAMES.has(key)) throw new Error('Adapter document contains an invalid key.');
        assertBoundedSecurityTree(child, depth + 1, state, seen);
      });
    }
  } finally {
    seen.delete(value);
  }
}



function parseYamlSecurityDocument(value: string): unknown {
  if (!value.trim()) throw new Error('Adapter document is required.');
  if (new TextEncoder().encode(value).byteLength > MAX_SECURITY_DOCUMENT_BYTES) throw new Error('Adapter document is too large.');
  let document: ReturnType<typeof parseYamlDocument>;
  try {
    document = parseYamlDocument(value, {
      merge: false,
      prettyErrors: false,
      resolveKnownTags: false,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch {
    throw new Error('Adapter YAML is invalid.');
  }
  if (document.errors.length > 0) throw new Error('Adapter YAML is invalid.');
  if (document.warnings.length > 0) throw new Error('Adapter YAML is unsafe.');
  const directives = document.directives;
  const directiveTags = Object.keys(directives?.tags ?? {});
  if (
    directives?.docStart === true ||
    directives?.docEnd === true ||
    directives?.yaml?.explicit === true ||
    directiveTags.some((tag) => tag !== '!!')
  ) {
    throw new Error('Adapter YAML directives are not allowed.');
  }
  assertSafeYamlNodes(document.contents);
  let parsed: unknown;
  try {
    parsed = document.toJS({ mapAsMap: false, maxAliasCount: 0 }) as unknown;
  } catch {
    throw new Error('Adapter YAML contains an unsupported alias or value.');
  }
  assertBoundedSecurityTree(parsed);
  return parsed;
}



function assertUniqueJsonKeys(value: string, label: string): void {
  let document: ReturnType<typeof parseYamlDocument>;
  try {
    document = parseYamlDocument(value, {
      prettyErrors: false,
      schema: 'json',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    });
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (document.errors.length > 0) throw new Error(`${label} must not contain duplicate object keys.`);
  if (document.warnings.length > 0) throw new Error(`${label} must be valid JSON.`);
  try {
    document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}



export function parseJsonText(value: string, label: string): unknown {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (new TextEncoder().encode(value).byteLength > MAX_SECURITY_DOCUMENT_BYTES) throw new Error(`${label} is too large.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  assertUniqueJsonKeys(value, label);
  assertBoundedSecurityTree(parsed);
  const forbidden = findForbiddenAdapterFields(parsed);
  if (forbidden.length > 0) throw new Error(`${label} contains server-only fields.`);
  return parsed;
}



export function validateCustomHttpDocument(format: AdapterDocumentFormat, document: string): AdapterValidationResult<string> {
  try {
    const parsed = format === 'json' ? parseJsonText(document, 'Adapter document') : parseYamlSecurityDocument(document);
    if (!isObject(parsed)) throw new Error('Adapter document must be an object.');
    assertSafeImportedValue(parsed);
    return { ok: true, value: document };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Adapter document is invalid.' };
  }
}



function assertSafeImportedValue(
  value: unknown,
  path = '$',
  container: CredentialContainer | undefined = undefined,
  seen = new Set<object>(),
  pathSegments: readonly SecurityPathSegment[] = [],
  envelope = pathSegments.length === 0 && isExportEnvelopeRoot(value),
): void {
  if (typeof value === 'string') {
    if (SECRET_TEMPLATE_PATTERN.test(value)) throw new Error(`Imported document contains a secret template at ${path}.`);
    if (STATIC_SECRET_PATTERN.test(value)) throw new Error(`Imported document contains a static credential at ${path}.`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('Imported document contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const childPathSegments = [...pathSegments, index];
        assertSafeImportedValue(item, securityPathString(childPathSegments), container, seen, childPathSegments, envelope);
      });
      return;
    }
    Object.entries(value).forEach(([key, child]) => {
      const childPathSegments = [...pathSegments, key];
      const childPath = securityPathString(childPathSegments);
      if (key === 'customFields') {
        assertSafeCustomFields(child, CUSTOM_FIELDS_SECURITY_OPTIONS);
        return;
      }
      const schemaContainer = schemaChildContainer(container, key, child);
      if (schemaContainer !== undefined) {
        if (schemaContainer === 'reject') {
          const message = container === 'customFields'
            ? 'Imported document contains a credential-like custom field.'
            : 'Imported document contains an invalid request schema.';
          throw new Error(`${message} at ${childPath}.`);
        }
        assertSafeImportedValue(child, childPath, schemaContainer, seen, childPathSegments, envelope);
        return;
      }
      if (container === 'body' && isCredentialLikeFieldName(key)) {
        throw new Error(`Imported document contains a credential-like body field at ${childPath}.`);
      }
      if (container === 'headers' && STATIC_CREDENTIAL_HEADER.test(key)) {
        throw new Error(`Imported document contains a credential header at ${childPath}.`);
      }
      if (container === 'query' && isCredentialLikeQueryName(key)) {
        throw new Error(`Imported document contains a credential-like query parameter at ${childPath}.`);
      }
      if (container === 'files' && key === 'field' && typeof child === 'string' && isCredentialLikeFieldName(child)) {
        throw new Error(`Imported document contains a credential-like multipart field at ${childPath}.`);
      }
      if (key === 'secretRef' && isAllowedSecretRefPath(childPathSegments, envelope)) {
        if (!isSafeSecretReference(child) || (typeof child === 'string' && SECRET_TEMPLATE_PATTERN.test(child))) {
          throw new Error(`Imported document contains an invalid secret reference at ${childPath}.`);
        }
        return;
      }
      if (key === 'secretRef') throw new Error(`Imported document contains a secret reference outside adapter authentication at ${childPath}.`);
      if (isForbiddenFieldName(key)) throw new Error(`Imported document contains a server-only field at ${childPath}.`);
      const childContainer = childCredentialContainer(key, container);
      assertSafeImportedValue(child, childPath, childContainer, seen, childPathSegments, envelope);
    });
  } finally {
    seen.delete(value);
  }
}



/** Rejects imported static credentials before they reach the draft DOM/state. */
export function validateAdapterImportSecurity(format: AdapterDocumentFormat, document: string): AdapterValidationResult<string> {
  try {
    const parsed = format === 'json' ? parseJsonText(document, 'Imported document') : parseYamlSecurityDocument(document);
    if (!isObject(parsed)) throw new Error('Imported document must be an object.');
    assertSafeImportedValue(parsed);
    return { ok: true, value: document };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Imported document contains unsafe credential fields.' };
  }
}



export function mapCustomHttpDraftToPayload(
  draft: Partial<CustomHttpDraft>,
  providerId?: string,
): CustomHttpRequestPayload {
  const normalized = { ...DEFAULT_CUSTOM_HTTP_DRAFT, ...draft };
  const version = normalized.version.trim();
  if (!ADAPTER_VERSION_PATTERN.test(version)) throw new Error('Adapter version must use letters, numbers, dots, plus, or hyphens.');
  const documentResult = validateCustomHttpDocument(normalized.format, normalized.document);
  if (!documentResult.ok) throw new Error(documentResult.error);
  const baseUrl = normalized.baseUrl.trim();
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('Base URL must be a valid HTTP or HTTPS URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('Base URL must use HTTP or HTTPS.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Base URL cannot contain credentials, query, or fragment.');
    }
  }
  const request = normalized.requestJson.trim() ? parseJsonText(normalized.requestJson, 'Request JSON') : undefined;
  return {
    ...(providerId?.trim() ? { providerId: providerId.trim() } : {}),
    format: normalized.format,
    document: normalized.document,
    version,
    ...(baseUrl ? { baseUrl } : {}),
    ...(request === undefined ? {} : { request }),
  };
}



/** Builds only the fields accepted by the path-test endpoint. */
export function mapCustomHttpPathTestToPayload(
  draft: Partial<CustomHttpDraft>,
  providerId?: string,
): CustomHttpPathTestPayload {
  const normalized = { ...DEFAULT_CUSTOM_HTTP_DRAFT, ...draft };
  const path = normalized.path;
  if (!path.startsWith('/') || path.includes('\\') || /~(?![01])/u.test(path)) {
    throw new Error('Path must be an RFC 6901 JSON Pointer.');
  }
  return {
    ...(providerId?.trim() ? { providerId: providerId.trim() } : {}),
    path,
    json: BoundedJsonValueSchema.parse(parseJsonText(normalized.pathTestJson, 'Path test JSON')),
  };
}



export function validateCustomHttpDraft(
  draft: Partial<CustomHttpDraft>,
  providerId?: string,
): AdapterValidationResult<CustomHttpRequestPayload> {
  try {
    return { ok: true, value: mapCustomHttpDraftToPayload(draft, providerId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Custom HTTP adapter is invalid.' };
  }
}



function redactValue(value: unknown, key?: string, seen = new Set<object>()): unknown {
  if (key !== undefined && (isForbiddenFieldName(key) || PREVIEW_REDACT_PATTERN.test(key))) return '[redacted]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[cycle]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, seen));
    const result: Record<string, unknown> = {};
    Object.entries(value).forEach(([childKey, child]) => {
      result[childKey] = redactValue(child, childKey, seen);
    });
    return result;
  } finally {
    seen.delete(value);
  }
}



/** Defensive projection for request previews received from any caller. */
export function redactCustomHttpPreview(preview: CustomHttpPreview): CustomHttpPreview {
  return {
    ...preview,
    url: redactPreviewUrl(preview.url),
    headers: (redactValue(preview.headers) ?? {}) as Readonly<Record<string, unknown>>,
    query: (redactValue(preview.query) ?? {}) as Readonly<Record<string, unknown>>,
    body: redactValue(preview.body) as CustomHttpPreviewBody,
  };
}



function redactPreviewUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (isForbiddenFieldName(key) || PREVIEW_REDACT_PATTERN.test(key)) parsed.searchParams.set(key, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}



function manifestSummaryFromValue(value: unknown): TrustedManifestSummary {
  if (!isObject(value)) throw new Error('Manifest must be a JSON object.');
  const forbidden = findForbiddenAdapterFields(value);
  if (forbidden.length > 0) throw new Error('Manifest contains server-only fields.');
  const hosts = Array.isArray(value.allowedHosts) ? value.allowedHosts.filter((item): item is string => typeof item === 'string') : [];
  const secrets = Array.isArray(value.requiredSecrets) ? value.requiredSecrets.filter((item): item is string => typeof item === 'string') : [];
  const operations = Array.isArray(value.operations) ? value.operations.filter((item): item is string => typeof item === 'string') : [];
  const limits = isObject(value.resourceLimits)
    ? Object.fromEntries(Object.entries(value.resourceLimits).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Readonly<Record<string, number>>
    : {};
  if (hosts.length === 0) throw new Error('Manifest allowedHosts is required.');
  if (!value.id || typeof value.id !== 'string') throw new Error('Manifest id is required.');
  if (!value.version || typeof value.version !== 'string') throw new Error('Manifest version is required.');
  if (operations.length === 0) throw new Error('Manifest operations are required.');
  if (Object.keys(limits).length === 0) throw new Error('Manifest resourceLimits are required.');
  return {
    ...(typeof value.schemaVersion === 'number' ? { schemaVersion: value.schemaVersion } : {}),
    id: value.id,
    version: value.version,
    ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
    ...(isObject(value.capabilities) ? { capabilities: value.capabilities } : {}),
    operations,
    allowedHosts: hosts,
    requiredSecrets: secrets,
    resourceLimits: limits,
  };
}



export function validateTrustedJsManifest(manifestText: string): AdapterValidationResult<TrustedManifestSummary> {
  try {
    const value = TrustedAdapterManifestSchema.parse(parseJsonText(manifestText, 'Manifest'));
    return { ok: true, value: manifestSummaryFromValue(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Manifest is invalid.' };
  }
}



export function mapTrustedJsDraftToPayload(
  draft: Partial<TrustedJsDraft>,
  sourceFile: File | null,
): Omit<TrustedJsInstallPayload, 'source' | 'sourceFile'> & { readonly source: File | null; readonly sourceFile: File | null } {
  const manifestText = (draft.manifest ?? '').trim();
  const result = validateTrustedJsManifest(manifestText);
  if (!result.ok) throw new Error(result.error);
  return {
    manifest: result.value,
    manifestText,
    ...(draft.providerId?.trim() ? { providerId: draft.providerId.trim() } : {}),
    source: sourceFile,
    sourceFile,
  };
}



export function formatAdapterExportName(revision: AdapterRevisionRef, format: AdapterDocumentFormat): string {
  const id = revision.adapterId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 63) || 'adapter';
  const version = revision.version.replace(/[^A-Za-z0-9._+-]/gu, '_').slice(0, 64) || 'revision';
  return `adapter-${id}-${version}.${format}`;
}



export function actionFromProps(props: CustomAdapterWorkspaceProps, key: ActionKey): ActionHandler | undefined {
  const nested = props.actions?.[key];
  const direct = props[key];
  return (nested ?? direct) as unknown as ActionHandler | undefined;
}



/** Keeps action feedback at one outer workspace boundary. */
export async function runWorkspaceAction(
  action: () => unknown | Promise<unknown>,
  label: string,
  onMessage: (message: string) => void,
): Promise<void> {
  try {
    const result = await action();
    onMessage(result === false ? 'Canceled.' : `${label} complete.`);
  } catch (error) {
    onMessage(error instanceof Error ? error.message : `${label} failed.`);
  }
}



/** Local feedback handles standalone workspaces; container feedback survives remounts. */
export function resolveWorkspaceStatusMessage(
  commandMessage: string | null | undefined,
  statusMessage: string | null | undefined,
  fallback: string,
): string {
  return commandMessage || statusMessage || fallback;
}



/** Applies an import as one draft transition so document metadata cannot lag. */
export function applyImportedAdapterDocument(
  draft: CustomHttpDraft,
  imported: ImportedAdapterDocument,
): CustomHttpDraft {
  return {
    ...draft,
    document: imported.document,
    format: imported.format,
    ...(imported.version === undefined ? {} : { version: imported.version }),
  };
}



/** Preserves other Trusted draft edits while replacing an imported manifest. */
export function applyImportedTrustedManifest(
  draft: TrustedJsDraft,
  manifest: string,
): TrustedJsDraft {
  return { ...draft, manifest };
}



function sameAdapterRevision(
  left: AdapterRevisionRef,
  right: AdapterRevisionRef,
): boolean {
  return left.kind === right.kind &&
    left.adapterId === right.adapterId &&
    left.version === right.version &&
    left.digest === right.digest;
}



/** Disabled history entries remain terminal and cannot be rebound from the UI. */
export function isAdapterRevisionDisabled(
  ref: AdapterRevisionRef | undefined,
  history: readonly AdapterRevision[],
): boolean {
  return ref !== undefined && history.some((revision) => revision.disabled === true && sameAdapterRevision(ref, revision));
}
