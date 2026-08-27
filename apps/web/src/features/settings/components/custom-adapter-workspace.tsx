import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  assertSafeCustomFields,
  isCredentialLikeMetadataKey,
  isStrictRestrictedRequestSchema,
  TrustedAdapterManifestSchema,
} from '@imagine/shared';
import { isAlias, isMap, isSeq, parseDocument as parseYamlDocument } from 'yaml';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileCode2,
  FileJson2,
  FileText,
  FolderOpen,
  Info,
  List,
  LoaderCircle,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

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

export interface CustomHttpPathTestPayload extends CustomHttpDocumentPayload {
  readonly version?: string;
  readonly path: string;
  readonly json: unknown;
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
type DraftUpdate<T> = T | ((current: T) => T);

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
const STATUS_LABELS: Record<AdapterWorkspaceStatus, string> = {
  loading: 'Loading adapter workspace',
  empty: 'No adapter is configured',
  error: 'Adapter workspace error',
  success: 'Adapter workspace ready',
  disabled: 'Adapter is disabled',
  'admin-unavailable': 'Administrator access is unavailable',
  offline: 'Offline - adapter management is unavailable',
};

const STATUS_ICONS: Record<AdapterWorkspaceStatus, ReactNode> = {
  loading: <LoaderCircle aria-hidden="true" size={16} />,
  empty: <Info aria-hidden="true" size={16} />,
  error: <CircleAlert aria-hidden="true" size={16} />,
  success: <Check aria-hidden="true" size={16} />,
  disabled: <X aria-hidden="true" size={16} />,
  'admin-unavailable': <ShieldCheck aria-hidden="true" size={16} />,
  offline: <CircleAlert aria-hidden="true" size={16} />,
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    width: '100%',
    maxWidth: 1_080,
    gap: 24,
    padding: '28px 0 72px',
    color: 'var(--color-text-primary)',
  },
  heading: {
    display: 'flex',
    flexWrap: 'wrap',
    minWidth: 0,
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  eyebrow: {
    margin: 0,
    color: 'var(--color-text-secondary)',
    fontSize: '0.68rem',
    fontWeight: 650,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  title: { margin: '5px 0 0', fontSize: '1.35rem', fontWeight: 650, lineHeight: 1.15 },
  subtitle: {
    maxWidth: 630,
    margin: '8px 0 0',
    color: 'var(--color-text-secondary)',
    fontSize: '0.74rem',
    lineHeight: 1.5,
  },
  status: {
    display: 'flex',
    minHeight: 44,
    alignItems: 'center',
    gap: 8,
    borderLeft: '3px solid var(--color-border-strong)',
    background: 'var(--color-surface-subtle)',
    padding: '8px 12px',
    color: 'var(--color-text-secondary)',
    fontSize: '0.72rem',
    lineHeight: 1.4,
  },
  statusError: { borderLeftColor: 'var(--color-danger)', color: 'var(--color-danger)' },
  statusWarning: { borderLeftColor: 'var(--color-warning)', color: '#8a4b00' },
  statusSuccess: { borderLeftColor: 'var(--color-success)', color: 'var(--color-success)' },
  segmented: {
    display: 'inline-flex',
    width: 'fit-content',
    maxWidth: '100%',
    alignItems: 'center',
    gap: 3,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-round)',
    background: 'var(--color-surface-subtle)',
    padding: 3,
  },
  segment: {
    display: 'inline-flex',
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    border: 0,
    borderRadius: 'var(--radius-round)',
    background: 'transparent',
    padding: '0 14px',
    color: 'var(--color-text-secondary)',
    fontSize: '0.74rem',
    fontWeight: 560,
  },
  segmentActive: {
    background: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    boxShadow: '0 1px 4px rgba(18, 19, 18, 0.12)',
    fontWeight: 650,
  },
  section: {
    display: 'grid',
    gap: 14,
    borderTop: '1px solid var(--color-border-subtle)',
    paddingTop: 16,
  },
  sectionHeading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  sectionTitle: { margin: 0, fontSize: '0.84rem', fontWeight: 650 },
  sectionHint: { margin: '3px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.68rem', lineHeight: 1.45 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))',
    gap: 20,
    alignItems: 'start',
  },
  field: { display: 'grid', minWidth: 0, gap: 7 },
  label: { color: 'var(--color-text-secondary)', fontSize: '0.68rem', fontWeight: 600 },
  helper: { color: 'var(--color-text-secondary)', fontSize: '0.65rem', lineHeight: 1.45 },
  input: {
    width: '100%',
    minWidth: 0,
    minHeight: 44,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface)',
    padding: '8px 10px',
    fontSize: '0.74rem',
  },
  select: {
    width: '100%',
    minWidth: 0,
    minHeight: 44,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface)',
    padding: '0 34px 0 10px',
    fontSize: '0.74rem',
  },
  document: {
    width: '100%',
    minHeight: 360,
    resize: 'vertical',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 5,
    background: '#191b1a',
    color: '#ecf2ee',
    padding: 14,
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    lineHeight: 1.55,
    tabSize: 2,
  },
  compactDocument: {
    width: '100%',
    minHeight: 130,
    resize: 'vertical',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface-subtle)',
    padding: 10,
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    lineHeight: 1.5,
  },
  commandBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  button: {
    display: 'inline-flex',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface)',
    padding: '0 12px',
    color: 'var(--color-text-primary)',
    fontSize: '0.7rem',
    fontWeight: 600,
    touchAction: 'manipulation',
  },
  primaryButton: {
    borderColor: 'var(--color-surface-strong)',
    background: 'var(--color-surface-strong)',
    color: 'var(--color-text-inverse)',
  },
  dangerButton: { color: 'var(--color-danger)', borderColor: '#edcfd1' },
  disabledButton: { cursor: 'not-allowed', opacity: 0.48 },
  iconButton: { width: 44, padding: 0 },
  fileButton: { position: 'relative', overflow: 'hidden' },
  hiddenFile: { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' },
  preview: {
    display: 'grid',
    gap: 10,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface)',
    padding: 14,
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(70px, 0.25fr) minmax(0, 1fr)',
    gap: '8px 14px',
    margin: 0,
    fontSize: '0.68rem',
  },
  previewTerm: { color: 'var(--color-text-secondary)', fontWeight: 600 },
  previewValue: { minWidth: 0, margin: 0, overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: '0.67rem', whiteSpace: 'pre-wrap' },
  codeBlock: {
    maxHeight: 240,
    overflow: 'auto',
    margin: 0,
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 5,
    background: 'var(--color-surface-subtle)',
    padding: 10,
    fontFamily: 'var(--font-mono)',
    fontSize: '0.68rem',
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  list: { display: 'grid', gap: 0, borderTop: '1px solid var(--color-border-subtle)' },
  listRow: {
    display: 'grid',
    minWidth: 0,
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, auto)',
    alignItems: 'center',
    gap: 12,
    borderBottom: '1px solid var(--color-border-subtle)',
    padding: '12px 0',
  },
  listCopy: { display: 'grid', minWidth: 0, gap: 3 },
  listPrimary: { overflowWrap: 'anywhere', fontSize: '0.72rem', fontWeight: 650 },
  listSecondary: { overflowWrap: 'anywhere', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '0.63rem' },
  listActions: { display: 'flex', minWidth: 0, maxWidth: '100%', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 5 },
  empty: {
    display: 'grid',
    minHeight: 96,
    placeItems: 'center start',
    border: '1px dashed var(--color-border-strong)',
    borderRadius: 5,
    padding: '14px 16px',
    color: 'var(--color-text-secondary)',
    fontSize: '0.7rem',
  },
  warning: {
    display: 'grid',
    gridTemplateColumns: '20px minmax(0, 1fr)',
    gap: 9,
    borderLeft: '3px solid var(--color-warning)',
    background: '#f9f0e4',
    padding: '11px 12px',
    color: '#8a4b00',
    fontSize: '0.7rem',
    lineHeight: 1.5,
  },
  metadata: { display: 'grid', gap: 10, margin: 0 },
  metadataRow: { display: 'grid', gridTemplateColumns: 'minmax(110px, 0.38fr) minmax(0, 1fr)', gap: 14, borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: 8, fontSize: '0.68rem' },
};

function mergeStyle(...values: Array<CSSProperties | undefined>): CSSProperties {
  return Object.assign({}, ...values);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[unserializable]';
  }
}

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

function parseJsonText(value: string, label: string): unknown {
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

function actionFromProps(props: CustomAdapterWorkspaceProps, key: ActionKey): ActionHandler | undefined {
  const nested = props.actions?.[key];
  const direct = props[key];
  return (nested ?? direct) as unknown as ActionHandler | undefined;
}

function isImportedAdapterDocument(value: unknown): value is ImportedAdapterDocument {
  return value !== null && typeof value === 'object' && 'document' in value && typeof value.document === 'string' && 'format' in value && (value.format === 'json' || value.format === 'yaml');
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

function statusTone(status: AdapterWorkspaceStatus): CSSProperties | undefined {
  if (status === 'error') return styles.statusError;
  if (status === 'success') return styles.statusSuccess;
  if (status === 'disabled' || status === 'admin-unavailable' || status === 'offline') return styles.statusWarning;
  return undefined;
}

function ActionButton({
  children,
  disabled,
  icon,
  label,
  onClick,
  tone = 'default',
}: {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
  readonly tone?: 'default' | 'primary' | 'danger';
}) {
  return (
    <button
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={mergeStyle(styles.button, tone === 'primary' ? styles.primaryButton : undefined, tone === 'danger' ? styles.dangerButton : undefined, disabled ? styles.disabledButton : undefined)}
      title={label}
      type="button"
    >
      {icon}
      {children ?? <span>{label}</span>}
    </button>
  );
}

function StatusBanner({ status, message }: { readonly status: AdapterWorkspaceStatus; readonly message: string }) {
  return (
    <div aria-live="polite" data-state={status} role="status" style={mergeStyle(styles.status, statusTone(status))}>
      {STATUS_ICONS[status]}
      <span>{message || STATUS_LABELS[status]}</span>
    </div>
  );
}

function Field({ children, hint, label }: { readonly children: ReactNode; readonly hint?: string; readonly label: string }) {
  return (
    <label style={styles.field}>
      <span style={styles.label}>{label}</span>
      {children}
      {hint && <small style={styles.helper}>{hint}</small>}
    </label>
  );
}

function PreviewValue({ value }: { readonly value: unknown }) {
  return <pre style={styles.previewValue}>{typeof value === 'string' ? value : safeJson(value)}</pre>;
}

function RedactedPreview({ preview }: { readonly preview: CustomHttpPreview | null | undefined }) {
  if (!preview) {
    return <div style={styles.empty}>Run Preview or Dry Run to inspect a redacted request.</div>;
  }
  const safePreview = redactCustomHttpPreview(preview);
  const files = safePreview.body.files ?? [];
  return (
    <div aria-label="Redacted request preview" style={styles.preview}>
      <dl style={styles.previewGrid}>
        <dt style={styles.previewTerm}>Method</dt><dd style={styles.previewValue}>{safePreview.method}</dd>
        <dt style={styles.previewTerm}>URL</dt><dd style={styles.previewValue}>{safePreview.url}</dd>
        {safePreview.relativePath && <><dt style={styles.previewTerm}>Path</dt><dd style={styles.previewValue}>{safePreview.relativePath}</dd></>}
        {safePreview.endpoint && <><dt style={styles.previewTerm}>Endpoint</dt><dd style={styles.previewValue}>{safePreview.endpoint}</dd></>}
        <dt style={styles.previewTerm}>Headers</dt><dd style={styles.previewValue}><PreviewValue value={safePreview.headers} /></dd>
        <dt style={styles.previewTerm}>Query</dt><dd style={styles.previewValue}><PreviewValue value={safePreview.query} /></dd>
        <dt style={styles.previewTerm}>Body</dt><dd style={styles.previewValue}><PreviewValue value={safePreview.body} /></dd>
      </dl>
      {files.length > 0 && (
        <div>
          <span style={styles.label}>File metadata</span>
          <pre style={styles.codeBlock}>{safeJson(files)}</pre>
        </div>
      )}
    </div>
  );
}

function RevisionList({
  busyAction,
  cursor,
  disabled,
  onDelete,
  onDisable,
  onExport,
  onLoad,
  onLoadMore,
  revisions,
}: {
  readonly busyAction: string | null;
  readonly cursor?: string | null;
  readonly disabled: boolean;
  readonly onDelete: (revision: AdapterRevisionRef) => void;
  readonly onDisable: (revision: AdapterRevisionRef) => void;
  readonly onExport: (revision: AdapterRevisionRef, format: AdapterDocumentFormat) => void;
  readonly onLoad: (revision: AdapterRevisionRef) => void;
  readonly onLoadMore: () => void;
  readonly revisions: readonly AdapterRevision[];
}) {
  return (
    <section aria-labelledby="adapter-revisions-heading" style={styles.section}>
      <div style={styles.sectionHeading}>
        <div>
          <h2 id="adapter-revisions-heading" style={styles.sectionTitle}>Revisions</h2>
          <p style={styles.sectionHint}>Immutable revisions can be loaded or exported exactly.</p>
        </div>
        {cursor && (
          <ActionButton
            disabled={disabled || busyAction !== null}
            icon={<ChevronDown aria-hidden="true" size={16} />}
            label="Load more revisions"
            onClick={onLoadMore}
          />
        )}
      </div>
      {revisions.length === 0 ? (
        <div style={styles.empty}>No saved revisions.</div>
      ) : (
        <div style={styles.list}>
          {revisions.map((revision) => {
            const key = `${revision.kind}:${revision.adapterId}:${revision.version}:${revision.digest}`;
            return (
              <div key={key} style={styles.listRow}>
                <div style={styles.listCopy}>
                  <strong style={styles.listPrimary}>{revision.displayName ?? revision.adapterId}{revision.current ? ' (current)' : ''}</strong>
                  <span style={styles.listSecondary}>{revision.version} / {revision.digest}</span>
                  {revision.disabled && <span style={styles.helper}>Disabled</span>}
                </div>
                <div style={styles.listActions}>
                  <ActionButton
                    disabled={disabled || busyAction !== null}
                    icon={<FileCode2 aria-hidden="true" size={15} />}
                    label={`Load revision ${revision.version}`}
                    onClick={() => onLoad(revision)}
                  />
                  <ActionButton
                    disabled={disabled || busyAction !== null}
                    icon={<Download aria-hidden="true" size={15} />}
                    label={`Export JSON revision ${revision.version}`}
                    onClick={() => onExport(revision, 'json')}
                  />
                  <ActionButton
                    disabled={disabled || busyAction !== null}
                    icon={<Download aria-hidden="true" size={15} />}
                    label={`Export YAML revision ${revision.version}`}
                    onClick={() => onExport(revision, 'yaml')}
                  />
                  <ActionButton
                    disabled={Boolean(disabled || busyAction !== null || revision.disabled)}
                    icon={<X aria-hidden="true" size={15} />}
                    label={`Disable revision ${revision.version}`}
                    onClick={() => onDisable(revision)}
                  />
                  <ActionButton
                    disabled={disabled || busyAction !== null}
                    icon={<Trash2 aria-hidden="true" size={15} />}
                    label={`Delete revision ${revision.version}`}
                    onClick={() => onDelete(revision)}
                    tone="danger"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CapabilityPreview({
  busyAction,
  disabled,
  onPreview,
  value,
}: {
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly onPreview: () => void;
  readonly value: unknown;
}) {
  return (
    <section aria-labelledby="adapter-capabilities-heading" style={styles.section}>
      <div style={styles.sectionHeading}>
        <div>
          <h2 id="adapter-capabilities-heading" style={styles.sectionTitle}>Capability preview</h2>
          <p style={styles.sectionHint}>Models and supported operations returned by the adapter schema.</p>
        </div>
        <ActionButton
          disabled={Boolean(disabled || busyAction !== null)}
          icon={busyAction === 'onCapabilitiesPreview' ? <LoaderCircle aria-hidden="true" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
          label="Preview capabilities"
          onClick={onPreview}
        />
      </div>
      {value === undefined ? <div style={styles.empty}>No capability preview yet.</div> : <pre style={styles.codeBlock}>{safeJson(value)}</pre>}
    </section>
  );
}

function CustomHttpEditor({
  actions,
  busyAction,
  disabled,
  draft,
  importSequence,
  onDraftChange,
  onImportSettled,
  onImportStarted,
  onRun,
  preview,
  providerId,
  remoteDisabled,
  simulationResult,
  dryRunResult,
  pathTestResult,
}: {
  readonly actions: CustomAdapterWorkspaceProps;
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly draft: CustomHttpDraft;
  readonly importSequence: LatestImportSequence;
  readonly onDraftChange: (update: DraftUpdate<CustomHttpDraft>) => void;
  readonly onImportSettled: () => void;
  readonly onImportStarted: () => void;
  readonly onRun: (key: ActionKey, payloadFactory: () => unknown, label: string) => void | Promise<void>;
  readonly preview?: CustomHttpPreview | null | undefined;
  readonly providerId?: string | undefined;
  readonly remoteDisabled: boolean;
  readonly simulationResult?: unknown | undefined;
  readonly dryRunResult?: unknown | undefined;
  readonly pathTestResult?: unknown | undefined;
}) {
  const importRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [importState, setImportState] = useState<AdapterFileImportState>('idle');
  const set = <K extends keyof CustomHttpDraft>(key: K, value: CustomHttpDraft[K]) => onDraftChange((current) => ({ ...current, [key]: value }));
  const handler = (key: ActionKey) => actionFromProps(actions, key);
  const runDocumentAction = (key: ActionKey, label: string) => {
    onRun(key, () => mapCustomHttpDraftToPayload(draft, providerId), label);
  };
  const handleDocumentImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) {
      const token = importSequence.begin();
      setFileError(null);
      setImportState('reading');
      onImportStarted();
      void settleLatestImport(importSequence, token, () => handler('onImportDocument')?.(file), (value) => {
        if (typeof value === 'string') {
          onDraftChange((current) => {
            const security = validateAdapterImportSecurity(current.format, value);
            if (!security.ok) throw new Error(security.error);
            return { ...current, document: value };
          });
        }
        else if (isImportedAdapterDocument(value)) {
          const security = validateAdapterImportSecurity(value.format, value.document);
          if (!security.ok) throw new Error(security.error);
          onDraftChange((current) => applyImportedAdapterDocument(current, value));
        }
      }).then((outcome) => {
        if (outcome.state === 'stale') return;
        setImportState(outcome.state);
        onImportSettled();
        if (outcome.state === 'error') {
          setFileError(outcome.error instanceof Error ? outcome.error.message : 'The adapter document could not be read.');
        }
      });
    }
    event.currentTarget.value = '';
  };
  const importSelectionDisabled = isFileImportSelectionDisabled(disabled, busyAction !== null, importState);
  const simulation = () => {
    const payload = mapCustomHttpDraftToPayload(draft, providerId);
    const status = Number(draft.simulationStatus);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error('Simulation status must be an HTTP status from 100 to 599.');
    const json = parseJsonText(draft.simulationJson, 'Simulation JSON');
    return { ...payload, response: { status, json } } satisfies CustomHttpSimulationPayload;
  };
  const pathTest = () => {
    const payload = mapCustomHttpDraftToPayload(draft, providerId);
    if (!draft.path.startsWith('/') || draft.path.includes('\\') || /~(?![01])/u.test(draft.path)) {
      throw new Error('Path must be an RFC 6901 JSON Pointer.');
    }
    return { ...payload, path: draft.path, json: parseJsonText(draft.pathTestJson, 'Path test JSON') } satisfies CustomHttpPathTestPayload;
  };
  return (
    <>
      <section aria-labelledby="custom-http-document-heading" style={styles.section}>
        <div style={styles.sectionHeading}>
          <div>
            <h2 id="custom-http-document-heading" style={styles.sectionTitle}>HTTP adapter document</h2>
            <p style={styles.sectionHint}>The server validates and bounds the declarative schema before it is saved.</p>
          </div>
          <div aria-label="Document format" role="group" style={styles.segmented}>
            {(['json', 'yaml'] as const).map((format) => (
              <button
                aria-pressed={draft.format === format}
                key={format}
                onClick={() => set('format', format)}
                style={mergeStyle(styles.segment, draft.format === format ? styles.segmentActive : undefined)}
                title={`Use ${format.toUpperCase()} format`}
                type="button"
              >
                {format === 'json' ? <FileJson2 aria-hidden="true" size={15} /> : <FileText aria-hidden="true" size={15} />}
                <span>{format.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
        <Field hint="Secret values and admin-only fields are rejected at the browser boundary." label="Adapter document">
          <textarea
            aria-label="Adapter document"
            data-testid="custom-http-document"
            disabled={disabled}
            onChange={(event) => set('document', event.target.value)}
            spellCheck={false}
            style={styles.document}
            value={draft.document}
          />
        </Field>
        <div style={styles.grid}>
          <Field label="Base URL" hint="Optional HTTP or HTTPS origin without credentials or query parameters.">
            <input aria-label="Base URL" disabled={disabled} onChange={(event) => set('baseUrl', event.target.value)} style={styles.input} value={draft.baseUrl} />
          </Field>
          <Field label="Adapter version" hint="Used when saving a raw spec; immutable revisions retain this value.">
            <input aria-label="Adapter version" disabled={disabled} onChange={(event) => set('version', event.target.value)} style={styles.input} value={draft.version} />
          </Field>
          <Field label="Import document">
            <div style={styles.commandBar}>
              <input accept=".json,.yaml,.yml,application/json,application/yaml" aria-label="Import JSON or YAML document" data-import-state={importState} disabled={importSelectionDisabled} onChange={handleDocumentImport} ref={importRef} style={styles.hiddenFile} type="file" />
              <ActionButton disabled={importSelectionDisabled} icon={<FolderOpen aria-hidden="true" size={16} />} label="Choose document file" onClick={() => importRef.current?.click()} />
            </div>
            <span aria-live="polite" data-import-state={importState} data-testid="custom-http-import-state" style={styles.helper}>
              {importState === 'reading' ? 'Reading adapter document.' : importState === 'complete' ? 'Adapter document import complete.' : importState === 'error' ? 'Adapter document import failed.' : ''}
            </span>
          </Field>
        </div>
        {fileError && <p aria-live="polite" role="alert" style={mergeStyle(styles.helper, styles.statusError)}>{fileError}</p>}
        <div style={styles.commandBar}>
          <ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={busyAction === 'onValidate' ? <LoaderCircle aria-hidden="true" className="is-spinning" size={16} /> : <Check aria-hidden="true" size={16} />} label="Validate" onClick={() => runDocumentAction('onValidate', 'Validate')} />
          <ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<Save aria-hidden="true" size={16} />} label="Save revision" onClick={() => runDocumentAction('onSave', 'Save')} tone="primary" />
          <ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<Upload aria-hidden="true" size={16} />} label="Export current JSON" onClick={() => onRun('onExport', () => ({ format: 'json' as const }), 'Export')} />
          <ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<Play aria-hidden="true" size={16} />} label="Dry run" onClick={() => runDocumentAction('onDryRun', 'Dry run')} />
        </div>
        {dryRunResult !== undefined && <section aria-label="Dry run result" data-network="false" style={styles.preview}><strong style={styles.label}>No network request performed</strong><pre style={styles.codeBlock}>{safeJson(dryRunResult)}</pre></section>}
      </section>

      <div style={styles.grid}>
        <section aria-labelledby="custom-http-request-heading" style={styles.section}>
          <div style={styles.sectionHeading}><h2 id="custom-http-request-heading" style={styles.sectionTitle}>Request JSON</h2></div>
          <Field hint="Used as the sample request for validation, preview, and dry run." label="Generation request">
            <textarea aria-label="Generation request JSON" disabled={disabled} onChange={(event) => set('requestJson', event.target.value)} spellCheck={false} style={styles.compactDocument} value={draft.requestJson} />
          </Field>
          <div style={styles.commandBar}><ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<RefreshCw aria-hidden="true" size={16} />} label="Preview request" onClick={() => onRun('onPreview', () => mapCustomHttpDraftToPayload(draft, providerId), 'Preview')} /></div>
        </section>
        <section aria-labelledby="custom-http-preview-heading" style={styles.section}>
          <div style={styles.sectionHeading}><h2 id="custom-http-preview-heading" style={styles.sectionTitle}>Redacted request preview</h2></div>
          <RedactedPreview preview={preview} />
        </section>
      </div>

      <div style={styles.grid}>
        <section aria-labelledby="custom-http-simulate-heading" style={styles.section}>
          <div style={styles.sectionHeading}><h2 id="custom-http-simulate-heading" style={styles.sectionTitle}>Simulate response</h2></div>
          <div style={styles.grid}>
            <Field label="HTTP status"><input aria-label="Simulation HTTP status" disabled={disabled} inputMode="numeric" onChange={(event) => set('simulationStatus', event.target.value)} style={styles.input} type="number" value={draft.simulationStatus} /></Field>
            <Field label="Response JSON"><textarea aria-label="Simulation response JSON" disabled={disabled} onChange={(event) => set('simulationJson', event.target.value)} spellCheck={false} style={styles.compactDocument} value={draft.simulationJson} /></Field>
          </div>
          <div style={styles.commandBar}><ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<Play aria-hidden="true" size={16} />} label="Simulate response" onClick={() => onRun('onSimulate', simulation, 'Simulate')} /></div>
          {simulationResult !== undefined && <pre aria-label="Simulation result" style={styles.codeBlock}>{safeJson(simulationResult)}</pre>}
        </section>
        <section aria-labelledby="custom-http-path-heading" style={styles.section}>
          <div style={styles.sectionHeading}><h2 id="custom-http-path-heading" style={styles.sectionTitle}>Path test</h2></div>
          <Field label="JSON Pointer" hint="Example: /data/request_id"><input aria-label="JSON Pointer path" disabled={disabled} onChange={(event) => set('path', event.target.value)} style={styles.input} value={draft.path} /></Field>
          <Field label="Response JSON"><textarea aria-label="Path test response JSON" disabled={disabled} onChange={(event) => set('pathTestJson', event.target.value)} spellCheck={false} style={styles.compactDocument} value={draft.pathTestJson} /></Field>
          <div style={styles.commandBar}><ActionButton disabled={Boolean(remoteDisabled || busyAction !== null)} icon={<Check aria-hidden="true" size={16} />} label="Test path" onClick={() => onRun('onPathTest', pathTest, 'Path test')} /></div>
          {pathTestResult !== undefined && <pre aria-label="Path test result" style={styles.codeBlock}>{safeJson(pathTestResult)}</pre>}
        </section>
      </div>
    </>
  );
}

function TrustedManifestMetadata({ manifest }: { readonly manifest: TrustedManifestSummary | null }) {
  if (!manifest) return <div style={styles.empty}>Manifest metadata appears after valid JSON is entered.</div>;
  return (
    <dl aria-label="Trusted manifest metadata" style={styles.metadata}>
      <div style={styles.metadataRow}><dt style={styles.previewTerm}>Allowed hosts</dt><dd style={styles.previewValue}>{manifest.allowedHosts.join(', ')}</dd></div>
      <div style={styles.metadataRow}><dt style={styles.previewTerm}>Required secrets</dt><dd style={styles.previewValue}>{manifest.requiredSecrets.length > 0 ? manifest.requiredSecrets.join(', ') : 'None declared'}</dd></div>
      <div style={styles.metadataRow}><dt style={styles.previewTerm}>Resource limits</dt><dd style={styles.previewValue}><PreviewValue value={manifest.resourceLimits} /></dd></div>
      {manifest.operations && <div style={styles.metadataRow}><dt style={styles.previewTerm}>Operations</dt><dd style={styles.previewValue}>{manifest.operations.join(', ')}</dd></div>}
    </dl>
  );
}

function TrustedJsEditor({
  actions,
  adminAvailable,
  busyAction,
  disabled,
  draft,
  importSequence,
  onDraftChange,
  onImportSettled,
  onImportStarted,
  onRunTrusted,
  providerId,
  remoteDisabled,
  trustedAdapterRef,
  trustedAdapters,
  trustedBinding,
  trustedBindingDisabled,
  trustedBindingHistory,
  trustedBindingHistoryCursor,
  trustedManifestPreview,
}: {
  readonly actions: CustomAdapterWorkspaceProps;
  readonly adminAvailable: boolean;
  readonly busyAction: string | null;
  readonly disabled: boolean;
  readonly draft: TrustedJsDraft;
  readonly importSequence: LatestImportSequence;
  readonly onDraftChange: (update: DraftUpdate<TrustedJsDraft>) => void;
  readonly onImportSettled: () => void;
  readonly onImportStarted: () => void;
  readonly onRunTrusted: (key: ActionKey, payloadFactory: (() => unknown) | undefined, label: string) => void | Promise<void>;
  readonly providerId?: string | undefined;
  readonly remoteDisabled: boolean;
  readonly trustedAdapterRef?: AdapterRevisionRef | null | undefined;
  readonly trustedAdapters: readonly TrustedAdapterSummary[];
  readonly trustedBinding?: TrustedAdapterSummary | null | undefined;
  readonly trustedBindingDisabled: boolean;
  readonly trustedBindingHistory: readonly AdapterRevision[];
  readonly trustedBindingHistoryCursor?: string | null | undefined;
  readonly trustedManifestPreview?: TrustedManifestSummary | null | undefined;
}) {
  const manifestFileRef = useRef<HTMLInputElement>(null);
  const sourceFileRef = useRef<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [manifestImportState, setManifestImportState] = useState<AdapterFileImportState>('idle');
  const [sourceSelected, setSourceSelected] = useState(false);
  const [selectedAdapterId, setSelectedAdapterId] = useState(trustedAdapterRef?.adapterId ?? trustedBinding?.ref?.adapterId ?? '');
  const set = <K extends keyof TrustedJsDraft>(key: K, value: TrustedJsDraft[K]) => onDraftChange((current) => ({ ...current, [key]: value }));
  const handler = (key: ActionKey) => actionFromProps(actions, key);
  const manifestResult = useMemo(() => validateTrustedJsManifest(draft.manifest), [draft.manifest]);
  const preview = trustedManifestPreview ?? (manifestResult.ok ? manifestResult.value : null);
  const handleManifestFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) {
      const token = importSequence.begin();
      setFileError(null);
      setManifestImportState('reading');
      onImportStarted();
      void settleLatestImport(importSequence, token, () => handler('onManifestFileImport')?.(file), (value) => {
        if (typeof value === 'string') {
          const validation = validateTrustedJsManifest(value);
          if (!validation.ok) throw new Error(validation.error);
          onDraftChange((current) => applyImportedTrustedManifest(current, value));
        }
      }).then((outcome) => {
        if (outcome.state === 'stale') return;
        setManifestImportState(outcome.state);
        onImportSettled();
        if (outcome.state === 'error') {
          setFileError(outcome.error instanceof Error ? outcome.error.message : 'The manifest file could not be read.');
        }
      });
    }
    event.currentTarget.value = '';
  };
  const handleSourceFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file) {
      sourceFileRef.current = file;
      setSourceSelected(true);
      void handler('onSourceFileSelect')?.(file);
    }
    // Keep the selected source out of the input DOM; the ref is only used for
    // the install callback and its bytes are never read by this component.
    event.currentTarget.value = '';
  };
  const install = () => {
    if (!manifestResult.ok) throw new Error(manifestResult.error);
    const sourceFile = sourceFileRef.current;
    if (!sourceFile) throw new Error('Trusted adapter source file is required.');
    return {
      manifest: manifestResult.value,
      manifestText: draft.manifest.trim(),
      ...(draft.providerId.trim() ? { providerId: draft.providerId.trim() } : {}),
      source: sourceFile,
      sourceFile,
    } satisfies TrustedJsInstallPayload;
  };
  const boundProviderId = draft.providerId.trim() || providerId?.trim() || '';
  const selectedRef = trustedAdapters.find((adapter) => adapter.adapterId === selectedAdapterId)?.ref ?? trustedAdapterRef ?? undefined;
  const selectedBindingIsDisabled = isAdapterRevisionDisabled(selectedRef, trustedBindingHistory);
  const manifestImportSelectionDisabled = isFileImportSelectionDisabled(disabled, busyAction !== null, manifestImportState);
  return (
    <>
      <div role="status" style={styles.warning}>
        <AlertTriangle aria-hidden="true" size={18} />
        <span>Trusted JavaScript runs as server-side code. It is not a sandbox for untrusted scripts; review source, hosts, secrets, and resource limits before installing.</span>
      </div>
      <section aria-labelledby="trusted-js-manifest-heading" style={styles.section}>
        <div style={styles.sectionHeading}>
          <div>
            <h2 id="trusted-js-manifest-heading" style={styles.sectionTitle}>Trusted JavaScript manifest</h2>
            <p style={styles.sectionHint}>Only the manifest text is displayed. Source bytes are never read into the document.</p>
          </div>
        </div>
        <Field hint="JSON manifest; the server verifies its digest against the source file." label="Manifest JSON">
          <textarea aria-label="Trusted JavaScript manifest JSON" data-testid="trusted-js-manifest" disabled={disabled} onChange={(event) => set('manifest', event.target.value)} spellCheck={false} style={styles.document} value={draft.manifest} />
        </Field>
        {!manifestResult.ok && draft.manifest.trim() && <p aria-live="polite" role="alert" style={mergeStyle(styles.helper, styles.statusError)}>{manifestResult.error}</p>}
        <div style={styles.grid}>
          <Field label="Import manifest file">
            <input accept="application/json,.json" aria-label="Import trusted JavaScript manifest file" data-import-state={manifestImportState} disabled={manifestImportSelectionDisabled} onChange={handleManifestFile} ref={manifestFileRef} style={styles.hiddenFile} type="file" />
            <ActionButton disabled={manifestImportSelectionDisabled} icon={<FolderOpen aria-hidden="true" size={16} />} label="Choose manifest file" onClick={() => manifestFileRef.current?.click()} />
            <span aria-live="polite" data-import-state={manifestImportState} data-testid="trusted-js-manifest-import-state" style={styles.helper}>
              {manifestImportState === 'reading' ? 'Reading trusted manifest.' : manifestImportState === 'complete' ? 'Trusted manifest import complete.' : manifestImportState === 'error' ? 'Trusted manifest import failed.' : ''}
            </span>
          </Field>
          <Field label="Source file" hint="JavaScript source is uploaded for installation and is never rendered here.">
            <input accept=".mjs,.js,text/javascript,application/javascript" aria-label="Trusted JavaScript source file" data-source-selected={sourceSelected} disabled={disabled} onChange={handleSourceFile} style={styles.input} type="file" />
            <small aria-live="polite" style={styles.helper}>{sourceSelected ? 'Source selected; contents stay outside the document.' : 'Select a source file before installing.'}</small>
          </Field>
          <Field label="Provider binding" hint="Optional; bind after choosing an installed adapter.">
            <input aria-label="Trusted adapter provider binding" disabled={disabled} onChange={(event) => set('providerId', event.target.value)} style={styles.input} value={draft.providerId} />
          </Field>
        </div>
        {fileError && <p aria-live="polite" role="alert" style={mergeStyle(styles.helper, styles.statusError)}>{fileError}</p>}
        <div style={styles.commandBar}>
          <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null || !sourceSelected)} icon={busyAction === 'onInstall' ? <LoaderCircle aria-hidden="true" size={16} /> : <ShieldCheck aria-hidden="true" size={16} />} label="Install trusted adapter" onClick={() => void onRunTrusted('onInstall', install, 'Install')} tone="primary" />
          <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<List aria-hidden="true" size={16} />} label="List installed adapters" onClick={() => void onRunTrusted('onListTrusted', undefined, 'List')} />
        </div>
      </section>

      <section aria-labelledby="trusted-js-metadata-heading" style={styles.section}>
        <div style={styles.sectionHeading}><h2 id="trusted-js-metadata-heading" style={styles.sectionTitle}>Manifest safety review</h2></div>
        <TrustedManifestMetadata manifest={preview} />
      </section>

      <section aria-labelledby="trusted-js-installed-heading" style={styles.section}>
        <div style={styles.sectionHeading}>
          <div><h2 id="trusted-js-installed-heading" style={styles.sectionTitle}>Installed adapters</h2><p style={styles.sectionHint}>Get or remove an installed trusted adapter by immutable id.</p></div>
          <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<RefreshCw aria-hidden="true" size={16} />} label="Refresh installed adapters" onClick={() => void onRunTrusted('onListTrusted', undefined, 'List')} />
        </div>
        <div style={styles.grid}>
          <Field label="Adapter id"><input aria-label="Trusted adapter id" onChange={(event) => setSelectedAdapterId(event.target.value)} style={styles.input} value={selectedAdapterId} /></Field>
          <div style={styles.commandBar}>
            <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null || !selectedAdapterId.trim())} icon={<FileCode2 aria-hidden="true" size={16} />} label="Get trusted adapter" onClick={() => void onRunTrusted('onGetTrusted', () => selectedAdapterId.trim(), 'Get')} />
          </div>
        </div>
        {trustedAdapters.length === 0 ? <div style={styles.empty}>No trusted adapters installed.</div> : <div style={styles.list}>
          {trustedAdapters.map((adapter) => (
            <div key={adapter.adapterId} style={styles.listRow}>
              <div style={styles.listCopy}><strong style={styles.listPrimary}>{adapter.displayName ?? adapter.adapterId}</strong><span style={styles.listSecondary}>{adapter.adapterId}{adapter.version ? ` / ${adapter.version}` : ''}</span></div>
              <div style={styles.listActions}>
                <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<FileCode2 aria-hidden="true" size={15} />} label={`Get trusted adapter ${adapter.adapterId}`} onClick={() => void onRunTrusted('onGetTrusted', () => adapter.adapterId, 'Get')} />
                <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<Trash2 aria-hidden="true" size={15} />} label={`Remove trusted adapter ${adapter.adapterId}`} onClick={() => void onRunTrusted('onRemoveTrusted', () => adapter.adapterId, 'Remove')} tone="danger" />
              </div>
            </div>
          ))}
        </div>}
      </section>

      <section aria-labelledby="trusted-js-history-heading" style={styles.section}>
        <div style={styles.sectionHeading}><div><h2 id="trusted-js-history-heading" style={styles.sectionTitle}>Binding history</h2><p style={styles.sectionHint}>Previously bound trusted adapter revisions remain addressable by digest.</p></div>{trustedBindingHistoryCursor && <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<ChevronDown aria-hidden="true" size={15} />} label="Load more binding history" onClick={() => void onRunTrusted('onLoadMoreTrustedBindings', () => trustedBindingHistoryCursor, 'Load more binding history')} />}</div>
        {trustedBindingHistory.length === 0 ? <div style={styles.empty}>No binding history.</div> : <div style={styles.list}>
          {trustedBindingHistory.map((revision) => (
            <div key={`${revision.adapterId}:${revision.version}:${revision.digest}`} style={styles.listRow}>
              <div style={styles.listCopy}><strong style={styles.listPrimary}>{revision.displayName ?? revision.adapterId}{revision.current ? ' (current)' : ''}</strong><span style={styles.listSecondary}>{revision.version} / {revision.digest}</span>{revision.disabled && <span style={styles.helper}>Disabled</span>}</div>
              <div style={styles.listActions}><ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null || isAdapterRevisionDisabled(revision, trustedBindingHistory) || !boundProviderId)} icon={<ShieldCheck aria-hidden="true" size={15} />} label={`Bind revision ${revision.version}`} onClick={() => void onRunTrusted('onBindProvider', () => ({ providerId: boundProviderId, ref: revision }), 'Bind')} /></div>
            </div>
          ))}
        </div>}
      </section>

      <section aria-labelledby="trusted-js-bind-heading" style={styles.section}>
        <div style={styles.sectionHeading}>
          <div><h2 id="trusted-js-bind-heading" style={styles.sectionTitle}>Provider binding</h2><p style={styles.sectionHint}>{trustedBinding ? `${trustedBindingDisabled ? 'Disabled binding' : 'Current binding'}: ${trustedBinding.displayName ?? trustedBinding.adapterId}` : 'No adapter is currently bound to this provider.'}</p></div>
          {trustedBinding && <div style={styles.commandBar}>
            <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null || trustedBindingDisabled)} icon={<X aria-hidden="true" size={15} />} label="Disable provider binding" onClick={() => void onRunTrusted('onDisableProviderBinding', () => trustedBinding.ref, 'Disable binding')} />
            {trustedBinding.ref && <ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null)} icon={<Trash2 aria-hidden="true" size={15} />} label="Unbind provider" onClick={() => void onRunTrusted('onUnbindProvider', () => trustedBinding.ref, 'Unbind')} tone="danger" />}
          </div>}
        </div>
        <div style={styles.grid}>
          <Field label="Installed adapter"><select aria-label="Installed trusted adapter" disabled={disabled || !adminAvailable} onChange={(event) => setSelectedAdapterId(event.target.value)} style={styles.select} value={selectedAdapterId}><option value="">Choose an adapter</option>{trustedAdapters.map((adapter) => <option key={adapter.adapterId} value={adapter.adapterId}>{adapter.displayName ?? adapter.adapterId}</option>)}</select></Field>
          <Field label="Provider id"><input aria-label="Provider id for trusted adapter" disabled={disabled || !adminAvailable} onChange={(event) => set('providerId', event.target.value)} style={styles.input} value={boundProviderId} /></Field>
        </div>
        <div style={styles.commandBar}><ActionButton disabled={Boolean(remoteDisabled || !adminAvailable || busyAction !== null || !boundProviderId || !selectedAdapterId || selectedBindingIsDisabled)} icon={<ShieldCheck aria-hidden="true" size={16} />} label="Bind adapter to provider" onClick={() => void onRunTrusted('onBindProvider', () => ({ providerId: boundProviderId, ...(selectedRef ? { ref: selectedRef } : {}) }), 'Bind')} /></div>
      </section>
    </>
  );
}

export function CustomAdapterWorkspace(props: CustomAdapterWorkspaceProps) {
  const {
    adminAvailable = true,
    capabilityPreview,
    customHttp,
    disabled = false,
    dryRunResult,
    kind,
    mode: controlledMode,
    modeLocked = false,
    online = true,
    pathTestResult,
    preview,
    providerId,
    revisions = [],
    revisionsCursor,
    simulationResult,
    state,
    status,
    statusMessage,
    trustedAdapterRef,
    trustedAdapters = [],
    trustedBinding,
    trustedBindingDisabled = false,
    trustedBindingHistory = [],
    trustedBindingHistoryCursor,
    trustedJs,
    trustedManifestPreview,
  } = props;
  const initialMode: CustomAdapterMode = controlledMode ?? (kind === 'trusted-js' || kind === 'trusted-javascript' ? 'trusted-js' : 'custom-http');
  const [localMode, setLocalMode] = useState<CustomAdapterMode>(initialMode);
  const mode = controlledMode ?? localMode;
  const [httpDraft, setHttpDraft] = useState<CustomHttpDraft>({ ...DEFAULT_CUSTOM_HTTP_DRAFT, ...customHttp });
  const [jsDraft, setJsDraft] = useState<TrustedJsDraft>({ ...DEFAULT_TRUSTED_JS_DRAFT, ...trustedJs });
  const httpDraftRef = useRef(httpDraft);
  const jsDraftRef = useRef(jsDraft);
  const importSequenceRef = useRef<LatestImportSequence>(createLatestImportSequence());
  const previousModeRef = useRef(mode);
  const [importPending, setImportPending] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const effectiveStatus: AdapterWorkspaceStatus = !online ? 'offline' : status ?? state ?? 'success';
  const { localDisabled, remoteDisabled } = adapterWorkspaceDisabledState({
    adminAvailable,
    disabled,
    importPending,
    mode,
    status: effectiveStatus,
  });
  const effectiveAdminAvailable = adminAvailable && effectiveStatus !== 'admin-unavailable';
  const handler = (key: ActionKey) => actionFromProps(props, key);
  useLayoutEffect(() => {
    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    importSequenceRef.current.invalidate();
    setImportPending(false);
  }, [mode]);
  useLayoutEffect(() => {
    const sequence = importSequenceRef.current;
    return () => sequence.invalidate();
  }, []);
  const setMode = (next: CustomAdapterMode) => {
    if (modeLocked) return;
    if (next !== mode) {
      previousModeRef.current = next;
      importSequenceRef.current.invalidate();
      setImportPending(false);
    }
    if (!controlledMode) setLocalMode(next);
    handler('onModeChange')?.(next);
  };
  const runAction = async (key: ActionKey, payloadFactory: () => unknown, label: string) => {
    if (remoteDisabled) return;
    const action = handler(key);
    if (action === undefined) return;
    setBusyAction(key);
    setCommandMessage(null);
    try {
      const payload = payloadFactory();
      const result = await action(payload as never);
      if (result === false) {
        setCommandMessage('Canceled.');
        return;
      }
      setCommandMessage(`${label} complete.`);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusyAction(null);
    }
  };
  const runTrusted = async (key: ActionKey, payloadFactory: (() => unknown) | undefined, label: string) => {
    if (remoteDisabled || !effectiveAdminAvailable) return;
    const action = handler(key);
    if (action === undefined) return;
    setBusyAction(key);
    setCommandMessage(null);
    try {
      const result = await action(payloadFactory ? payloadFactory() as never : undefined as never);
      if (result === false) {
        setCommandMessage('Canceled.');
        return;
      }
      setCommandMessage(`${label} complete.`);
    } catch (error) {
      setCommandMessage(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusyAction(null);
    }
  };
  const updateHttpDraft = (update: DraftUpdate<CustomHttpDraft>) => {
    const next = typeof update === 'function' ? update(httpDraftRef.current) : update;
    httpDraftRef.current = next;
    setHttpDraft(next);
    void handler('onCustomHttpChange')?.(next);
  };
  const updateTrustedDraft = (update: DraftUpdate<TrustedJsDraft>) => {
    const next = typeof update === 'function' ? update(jsDraftRef.current) : update;
    jsDraftRef.current = next;
    setJsDraft(next);
    void handler('onTrustedJsChange')?.(next);
  };
  const statusText = commandMessage || statusMessage || STATUS_LABELS[effectiveStatus];
  const statusModeLabel = mode === 'custom-http' ? 'Custom HTTP' : 'Trusted JavaScript';
  return (
    <main aria-busy={importPending} aria-label="Custom adapter workspace" data-import-pending={importPending} data-mode={mode} data-testid="custom-adapter-workspace" style={styles.root}>
      <header style={styles.heading}>
        <div>
          <p style={styles.eyebrow}>Provider adapters</p>
          <h1 style={styles.title}>{statusModeLabel}</h1>
          <p style={styles.subtitle}>Manage declarative HTTP revisions and administrator-installed trusted adapters.</p>
        </div>
        <StatusBanner message={statusText} status={effectiveStatus} />
      </header>
      {!modeLocked && <div aria-label="Adapter type" role="group" style={styles.segmented}>
        <button aria-pressed={mode === 'custom-http'} onClick={() => setMode('custom-http')} style={mergeStyle(styles.segment, mode === 'custom-http' ? styles.segmentActive : undefined)} title="Edit a declarative HTTP adapter" type="button"><FileCode2 aria-hidden="true" size={16} /><span>Custom HTTP</span></button>
        <button aria-pressed={mode === 'trusted-js'} onClick={() => setMode('trusted-js')} style={mergeStyle(styles.segment, mode === 'trusted-js' ? styles.segmentActive : undefined)} title="Manage a trusted server-side JavaScript adapter" type="button"><ShieldCheck aria-hidden="true" size={16} /><span>Trusted JS</span></button>
      </div>}
      {effectiveStatus === 'empty' && <div aria-live="polite" style={styles.empty}>Start with a document or manifest. Existing revisions remain unchanged until Save or Install is selected.</div>}
      {effectiveStatus === 'admin-unavailable' && <div aria-live="polite" style={styles.warning}><ShieldCheck aria-hidden="true" size={18} /><span>Administrator authorization is required for trusted adapter installation and lifecycle actions.</span></div>}
      {mode === 'custom-http' ? (
        <CustomHttpEditor actions={props} busyAction={busyAction} disabled={localDisabled} draft={httpDraft} dryRunResult={dryRunResult} importSequence={importSequenceRef.current} onDraftChange={updateHttpDraft} onImportSettled={() => setImportPending(false)} onImportStarted={() => setImportPending(true)} onRun={runAction} pathTestResult={pathTestResult} preview={preview ?? null} providerId={providerId ?? ''} remoteDisabled={remoteDisabled} simulationResult={simulationResult} />
      ) : (
        <TrustedJsEditor actions={props} adminAvailable={effectiveAdminAvailable} busyAction={busyAction} disabled={localDisabled} draft={jsDraft} importSequence={importSequenceRef.current} onDraftChange={updateTrustedDraft} onImportSettled={() => setImportPending(false)} onImportStarted={() => setImportPending(true)} onRunTrusted={runTrusted} providerId={providerId ?? ''} remoteDisabled={remoteDisabled} trustedAdapterRef={trustedAdapterRef ?? null} trustedAdapters={trustedAdapters} trustedBinding={trustedBinding ?? null} trustedBindingDisabled={trustedBindingDisabled} trustedBindingHistory={trustedBindingHistory} trustedBindingHistoryCursor={trustedBindingHistoryCursor ?? null} trustedManifestPreview={trustedManifestPreview ?? null} />
      )}
      {mode === 'custom-http' && <CapabilityPreview busyAction={busyAction} disabled={remoteDisabled} onPreview={() => void runAction('onCapabilitiesPreview', () => mapCustomHttpDraftToPayload(httpDraft, providerId), 'Capability preview')} value={capabilityPreview} />}
      {mode === 'custom-http' && (
        <RevisionList
          busyAction={busyAction}
          cursor={revisionsCursor ?? null}
          disabled={remoteDisabled}
          onDelete={(revision) => void runAction('onDelete', () => revision, 'Delete')}
          onDisable={(revision) => void runAction('onDisable', () => revision, 'Disable')}
          onExport={(revision, format) => void runAction('onExport', () => ({ ref: revision, format }), `Export ${format.toUpperCase()}`)}
          onLoad={(revision) => void runAction('onLoadRevision', () => revision, 'Load')}
          onLoadMore={() => void runAction('onLoadMoreRevisions', () => revisionsCursor, 'Load more')}
          revisions={revisions}
        />
      )}
      {mode === 'custom-http' && <section aria-label="Adapter command feedback" aria-live="polite" role="status" style={styles.helper}>{busyAction ? `Running ${busyAction.replace(/^on/u, '').replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`)}...` : commandMessage}</section>}
    </main>
  );
}
