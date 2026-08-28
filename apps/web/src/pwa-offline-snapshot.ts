import type { FixtureGalleryItem, FixtureJobStatus } from './features/gallery/model/types.js';

/**
 * Offline state is deliberately split from the service-worker media cache.
 * This module stores only small, user-visible metadata and an opaque session
 * marker; it never stores cookies, credentials, requests, or media bytes.
 */
export const OFFLINE_SNAPSHOT_VERSION = 1 as const;
export const OFFLINE_SNAPSHOT_DB_NAME = 'imagine-media-studio-offline-v1';
export const OFFLINE_SNAPSHOT_STORE_NAME = 'metadata';
export const OFFLINE_SNAPSHOT_KEY = 'recent-gallery';
export const OFFLINE_SNAPSHOT_MAX_ITEMS = 100;
export const OFFLINE_SNAPSHOT_MAX_JOBS = 100;
/** The metadata snapshot must stay bounded as one serialized UTF-8 value. */
export const OFFLINE_SNAPSHOT_MAX_BYTES = 512 * 1024;
export const OFFLINE_SNAPSHOT_MAX_SERIALIZED_BYTES = OFFLINE_SNAPSHOT_MAX_BYTES;
export const OFFLINE_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OFFLINE_AUTH_MARKER_KEY = 'imagine-authenticated-session-v1';
export const OFFLINE_AUTH_MARKER_VERSION = 1 as const;
export const OFFLINE_AUTH_MARKER_TTL_MS = OFFLINE_SNAPSHOT_TTL_MS;
export const OFFLINE_PUBLIC_BOOTSTRAP_KEY = 'imagine-public-offline-bootstrap-v1';
export const OFFLINE_PUBLIC_BOOTSTRAP_VERSION = 1 as const;
export const OFFLINE_PUBLIC_BOOTSTRAP_TTL_MS = OFFLINE_SNAPSHOT_TTL_MS;
export const OFFLINE_SESSION_SYNC_KEY = 'imagine-media-studio-session-sync-v1';
export const OFFLINE_SESSION_SYNC_CHANNEL = 'imagine-media-studio-session-v1';
export const OFFLINE_PLACEHOLDER_PATH = '/icons/app-icon-512.png';
export const OFFLINE_SESSION_SCOPE_MAX_LENGTH = 128;

export type OfflineStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

export interface OfflineGalleryItemMetadata {
  readonly id: string;
  readonly jobId: string;
  readonly kind: 'image' | 'video';
  readonly prompt: string;
  readonly alt: string;
  readonly createdAt: string;
  readonly status: FixtureJobStatus;
  readonly stage: string;
  readonly progress: number | null;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly saved: boolean;
  readonly folderIds: readonly string[];
  readonly providerId: string;
  readonly modelId: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: string;
  readonly referenceCount: number;
  readonly batchCount: number;
  readonly previewPath: string;
  readonly sourcePath: string | null;
  readonly posterPath: string | null;
  readonly durationSeconds: number | null;
  readonly persistedAsset: boolean;
}

export interface OfflineJobMetadata {
  readonly id: string;
  readonly prompt: string;
  readonly status: FixtureJobStatus;
  readonly stage: string;
  readonly progress: number | null;
  readonly error: OfflineGalleryItemMetadata['error'];
  readonly providerId: string;
  readonly modelId: string;
  readonly outputCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OfflineMetadataSnapshot {
  readonly version: typeof OFFLINE_SNAPSHOT_VERSION;
  readonly savedAt: number;
  readonly sequence: number;
  readonly sessionScope: string;
  readonly mode: OfflineBootstrapMode;
  readonly generation: number;
  readonly items: readonly OfflineGalleryItemMetadata[];
  readonly jobs: readonly OfflineJobMetadata[];
}

export interface OfflineAuthMarker {
  readonly version: typeof OFFLINE_AUTH_MARKER_VERSION;
  readonly mode: 'authenticated';
  readonly authenticatedAt: number;
  readonly sessionScope: string;
  readonly generation: number;
}

export interface OfflinePublicBootstrapMarker {
  readonly version: typeof OFFLINE_PUBLIC_BOOTSTRAP_VERSION;
  readonly mode: 'public';
  readonly bootstrappedAt: number;
  readonly sessionScope: string;
  readonly generation: number;
}

export type OfflineBootstrapMode = 'authenticated' | 'public';
export type OfflineSessionChange = 'login' | 'logout' | 'unauthorized';

interface IndexedDbGlobal {
  readonly indexedDB?: IDBFactory;
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}

interface BroadcastChannelGlobal {
  new (name: string): BroadcastChannelLike;
}

interface SessionSyncMessage {
  readonly version: 1;
  readonly change: OfflineSessionChange;
  readonly source: string;
  readonly nonce: string;
  readonly sessionScope: string | null;
  readonly mode: OfflineBootstrapMode | null;
  readonly generation: number;
}

const JOB_STATUSES = new Set<FixtureJobStatus>([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

function isJobStatus(value: unknown): value is FixtureJobStatus {
  return typeof value === 'string' && JOB_STATUSES.has(value as FixtureJobStatus);
}

const ITEM_KEYS = [
  'id',
  'jobId',
  'kind',
  'prompt',
  'alt',
  'createdAt',
  'status',
  'stage',
  'progress',
  'error',
  'saved',
  'folderIds',
  'providerId',
  'modelId',
  'width',
  'height',
  'aspectRatio',
  'referenceCount',
  'batchCount',
  'previewPath',
  'sourcePath',
  'posterPath',
  'durationSeconds',
  'persistedAsset',
] as const;

const JOB_KEYS = [
  'id',
  'prompt',
  'status',
  'stage',
  'progress',
  'error',
  'providerId',
  'modelId',
  'outputCount',
  'createdAt',
  'updatedAt',
] as const;

const SNAPSHOT_KEYS = [
  'version',
  'savedAt',
  'sequence',
  'sessionScope',
  'mode',
  'generation',
  'items',
  'jobs',
] as const;

let volatileSnapshot: OfflineMetadataSnapshot | null = null;
let volatileSnapshotMemoryOnly = false;
let volatileAuthMarker: OfflineAuthMarker | null = null;
let volatilePublicBootstrapMarker: OfflinePublicBootstrapMarker | null = null;
let volatileAuthMarkerMemoryOnly = false;
let volatilePublicBootstrapMemoryOnly = false;
let volatileSessionScope: string | null = null;
let volatileSessionMode: OfflineBootstrapMode | null = null;
let lastSnapshotSavedAt = 0;
let lastSnapshotSequence = 0;
let pendingOfflineCleanup: Promise<void> | null = null;
let pendingOfflineSnapshotClear: Promise<void> | null = null;
let offlineSnapshotWritesAllowed = true;
let offlineSessionGeneration = 0;
let offlineSnapshotEpoch = 0;
let networkFailure = false;
let offlineBootstrapActive = false;
const networkListeners = new Set<() => void>();
const networkFailureErrors = new WeakSet<object>();
const failedStorageObjects = new WeakSet<object>();

type StorageMode = 'available' | 'memory-only' | 'blocked';

let sessionSyncChannel: BroadcastChannelLike | null = null;
let sessionSyncTarget: {
  addEventListener(type: 'storage', listener: (event: unknown) => void): void;
  removeEventListener(type: 'storage', listener: (event: unknown) => void): void;
} | null = null;
let sessionSyncStorageHandler: ((event: unknown) => void) | null = null;
const sessionSyncListeners = new Set<(change: OfflineSessionChange) => void>();
const seenSessionSyncMessages = new Set<string>();
const sessionSyncRealm = Math.random().toString(36).slice(2);

function storageAccess(storage?: OfflineStorage): { readonly storage?: OfflineStorage; readonly mode: StorageMode } {
  if (storage !== undefined) return { storage, mode: 'available' };
  try {
    const candidate = globalThis.localStorage;
    if (candidate === undefined) {
      return { mode: 'memory-only' };
    }
    if (
      typeof candidate.getItem === 'function' &&
      typeof candidate.removeItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return { storage: candidate, mode: 'available' };
    }
  } catch {
    return { mode: 'blocked' };
  }
  return { mode: 'blocked' };
}

function markStorageFailure(storage: OfflineStorage): void {
  failedStorageObjects.add(storage);
}

function clearStorageFailure(storage: OfflineStorage): void {
  failedStorageObjects.delete(storage);
}

function browserStorage(): OfflineStorage | undefined {
  return storageAccess().storage;
}

function indexedDbFactory(): IDBFactory | undefined {
  const candidate = globalThis as typeof globalThis & IndexedDbGlobal;
  return candidate.indexedDB;
}

function randomNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function randomSessionScope(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && safeId(uuid)) return uuid;
  } catch {
    // A locally unique opaque scope is sufficient when Web Crypto is absent.
  }
  return `session-${randomNonce()}`;
}

function isSessionSyncMessage(value: unknown): value is SessionSyncMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const validMode = candidate.mode === null || candidate.mode === 'authenticated' || candidate.mode === 'public';
  const validScope = candidate.sessionScope === null || safeId(candidate.sessionScope);
  return candidate.version === 1 &&
    (candidate.change === 'login' || candidate.change === 'logout' || candidate.change === 'unauthorized') &&
    safeId(candidate.source) && safeId(candidate.nonce) &&
    finiteSequence(candidate.generation) && validMode && validScope &&
    ((candidate.mode === null && candidate.sessionScope === null) ||
      (candidate.mode !== null && candidate.sessionScope !== null));
}

function notifySessionSyncListeners(change: OfflineSessionChange): void {
  for (const listener of sessionSyncListeners) listener(change);
}

function clearVolatileOfflineState(generation?: number): void {
  volatileSnapshot = null;
  volatileSnapshotMemoryOnly = false;
  volatileAuthMarker = null;
  volatilePublicBootstrapMarker = null;
  volatileAuthMarkerMemoryOnly = false;
  volatilePublicBootstrapMemoryOnly = false;
  volatileSessionScope = null;
  volatileSessionMode = null;
  offlineBootstrapActive = false;
  offlineSnapshotWritesAllowed = false;
  offlineSessionGeneration = Math.max(nextGeneration(), generation ?? 0);
  offlineSnapshotEpoch += 1;
}

function sessionSyncWindow(): {
  addEventListener(type: 'storage', listener: (event: unknown) => void): void;
  removeEventListener(type: 'storage', listener: (event: unknown) => void): void;
} | null {
  const candidate = (globalThis as typeof globalThis & {
    readonly window?: {
      addEventListener?: (type: 'storage', listener: (event: unknown) => void) => void;
      removeEventListener?: (type: 'storage', listener: (event: unknown) => void) => void;
    };
  }).window;
  if (
    candidate !== undefined &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  ) {
    return {
      addEventListener: candidate.addEventListener.bind(candidate),
      removeEventListener: candidate.removeEventListener.bind(candidate),
    };
  }
  const globalTarget = globalThis as typeof globalThis & {
    addEventListener?: (type: 'storage', listener: (event: unknown) => void) => void;
    removeEventListener?: (type: 'storage', listener: (event: unknown) => void) => void;
  };
  if (typeof globalTarget.addEventListener !== 'function' || typeof globalTarget.removeEventListener !== 'function') {
    return null;
  }
  return {
    addEventListener: globalTarget.addEventListener.bind(globalTarget),
    removeEventListener: globalTarget.removeEventListener.bind(globalTarget),
  };
}

function receiveSessionSyncMessage(value: unknown): void {
  if (!isSessionSyncMessage(value) || value.source === sessionSyncRealm || seenSessionSyncMessages.has(value.nonce)) return;
  seenSessionSyncMessages.add(value.nonce);
  if (seenSessionSyncMessages.size > 128) {
    const first = seenSessionSyncMessages.values().next().value;
    if (typeof first === 'string') seenSessionSyncMessages.delete(first);
  }
  // Clear the in-memory copy before awaiting IndexedDB, so a stale tab cannot
  // render its old Gallery while persistent cleanup is still in flight.
  clearVolatileOfflineState(value.generation);
  const previousCleanup = pendingOfflineCleanup ?? Promise.resolve();
  const cleanup = previousCleanup.then(() => clearOfflineBootstrapState({
    broadcast: false,
    awaitPending: false,
  }));
  const pending = cleanup.then(() => undefined, () => undefined);
  pendingOfflineCleanup = pending;
  void pending.finally(() => {
    if (pendingOfflineCleanup === pending) pendingOfflineCleanup = null;
    notifySessionSyncListeners(value.change);
  });
}

function initializeSessionSync(): void {
  const target = sessionSyncWindow();
  if (sessionSyncTarget === null && target !== null) {
    sessionSyncTarget = target;
    sessionSyncStorageHandler = (event: unknown) => {
      if (event === null || typeof event !== 'object') return;
      const candidate = event as { readonly key?: unknown; readonly newValue?: unknown };
      if (candidate.key !== OFFLINE_SESSION_SYNC_KEY || typeof candidate.newValue !== 'string') return;
      try {
        receiveSessionSyncMessage(JSON.parse(candidate.newValue) as unknown);
      } catch {
        // Malformed cross-tab signals are ignored; no state is trusted from them.
      }
    };
    sessionSyncTarget.addEventListener('storage', sessionSyncStorageHandler);
  }
  if (sessionSyncChannel === null && sessionSyncTarget !== null) {
    try {
      const constructor = (globalThis as typeof globalThis & { readonly BroadcastChannel?: BroadcastChannelGlobal }).BroadcastChannel;
      if (constructor !== undefined) {
        const channel = new constructor(OFFLINE_SESSION_SYNC_CHANNEL);
        const handleMessage = (event: { readonly data: unknown }) => receiveSessionSyncMessage(event.data);
        channel.addEventListener('message', handleMessage);
        sessionSyncChannel = channel;
      }
    } catch {
      sessionSyncChannel = null;
    }
  }
}

export function initializeOfflineSessionSync(): void {
  initializeSessionSync();
}

export function subscribeToOfflineSessionChange(
  listener: (change: OfflineSessionChange) => void,
): () => void {
  initializeSessionSync();
  sessionSyncListeners.add(listener);
  return () => sessionSyncListeners.delete(listener);
}

/** Broadcasts a session boundary without including identity, cookies, or secrets. */
export function broadcastOfflineSessionChange(change: OfflineSessionChange): void {
  initializeSessionSync();
  const message: SessionSyncMessage = {
    version: 1,
    change,
    source: sessionSyncRealm,
    nonce: randomNonce(),
    sessionScope: volatileSessionScope,
    mode: volatileSessionMode,
    generation: offlineSessionGeneration,
  };
  seenSessionSyncMessages.add(message.nonce);
  try {
    sessionSyncChannel?.postMessage(message);
  } catch {
    // Storage is the fallback transport when BroadcastChannel is unavailable.
  }
  const storage = storageAccess().storage;
  if (storage !== undefined) {
    try {
      storage.setItem(OFFLINE_SESSION_SYNC_KEY, JSON.stringify(message));
    } catch {
      // A blocked storage implementation does not compromise local cleanup.
      markStorageFailure(storage);
    }
  }
}

function notifyNetworkListeners(): void {
  for (const listener of networkListeners) listener();
}

export function subscribeToNetworkState(listener: () => void): () => void {
  networkListeners.add(listener);
  return () => networkListeners.delete(listener);
}

export function isBrowserExplicitlyOffline(): boolean {
  try {
    return globalThis.navigator?.onLine === false;
  } catch {
    return false;
  }
}

export function isNetworkAvailable(): boolean {
  return !isBrowserExplicitlyOffline() && !networkFailure;
}

export function markNetworkAvailable(): void {
  if (!networkFailure) return;
  networkFailure = false;
  notifyNetworkListeners();
}

export function markNetworkFailure(): void {
  if (networkFailure) return;
  networkFailure = true;
  notifyNetworkListeners();
}

export function markBrowserOffline(): void {
  notifyNetworkListeners();
}

export function markOfflineBootstrapActive(active: boolean): void {
  if (offlineBootstrapActive === active) return;
  offlineBootstrapActive = active;
  notifyNetworkListeners();
}

export function isOfflineBootstrapActive(): boolean {
  return offlineBootstrapActive;
}

/** Records a fetch failure while preserving the original error for callers. */
export function markNetworkFailureError(error: unknown): void {
  if (error !== null && typeof error === 'object') networkFailureErrors.add(error);
}

/** Only transport failures may unlock the offline bootstrap. */
export function isNetworkFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { readonly status?: unknown; readonly name?: unknown };
  if (typeof candidate.status === 'number') return false;
  if (candidate.name === 'AbortError') return false;
  return networkFailureErrors.has(error) || candidate.name === 'NetworkError';
}

export function isOfflineWriteBlocked(): boolean {
  return !isNetworkAvailable();
}

export class OfflineWriteError extends Error {
  public override readonly name = 'OfflineWriteError';

  public constructor() {
    super('Write operations are unavailable while the application is offline.');
  }
}

export function assertOnlineForWrite(): void {
  if (isOfflineWriteBlocked()) throw new OfflineWriteError();
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function serializedByteLength(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  try {
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    // TextEncoder is part of the browser baseline; retain a conservative
    // fallback for test realms that do not provide it.
    return encodeURIComponent(serialized).replace(/%[0-9A-F]{2}/gu, 'x').length;
  }
}

export function offlineMetadataSnapshotByteLength(snapshot: OfflineMetadataSnapshot): number {
  return serializedByteLength(snapshot);
}

function snapshotVersionIsNewer(
  candidate: Pick<OfflineMetadataSnapshot, 'savedAt' | 'sequence'>,
  existing: Pick<OfflineMetadataSnapshot, 'savedAt' | 'sequence'> | null,
): boolean {
  if (existing === null) return true;
  return candidate.savedAt > existing.savedAt ||
    (candidate.savedAt === existing.savedAt && candidate.sequence > existing.sequence);
}

function safeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
}

const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z\d+.-]{1,31}:\/\/[^\s<>"']+/iu;
const CREDENTIAL_LIKE_PATTERN = /\b(?:bearer|basic)\s+[^\s,;]+|(?:api[-_.]?key|access[-_.]?token|oauth[-_.]?token|authorization|token|secret|password|cookie|set[-_.]?cookie|credential(?:s)?|signature|sig|auth(?:[-_.]?token)?)\s*[:=]\s*[^\s,;]+/iu;

function containsUnsafeOfflineText(value: string): boolean {
  return ABSOLUTE_URL_PATTERN.test(value) || CREDENTIAL_LIKE_PATTERN.test(value);
}

function safeUserPrompt(value: unknown): value is string {
  return safeText(value, 4096);
}

function safeNonUserText(value: unknown, maxLength: number): value is string {
  return safeText(value, maxLength) && !containsUnsafeOfflineText(value);
}

function sanitizeNonUserText(value: unknown, maxLength: number, fallback: string): string {
  if (!safeText(value, maxLength)) return fallback;
  if (!containsUnsafeOfflineText(value)) return value;
  return fallback;
}

function safeId(value: unknown): value is string {
  return safeText(value, 255) && value.length > 0 &&
    !value.includes('@') && !value.includes('?') && !value.includes('#') &&
    !containsUnsafeOfflineText(value);
}

function validIsoDate(value: unknown): value is string {
  return safeText(value, 64) && Number.isFinite(Date.parse(value));
}

function safeSessionScope(value: unknown): value is string {
  return safeText(value, OFFLINE_SESSION_SCOPE_MAX_LENGTH) && value.length > 0 &&
    !containsUnsafeOfflineText(value);
}

function nextGeneration(): number {
  return offlineSessionGeneration >= Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : offlineSessionGeneration + 1;
}

function generationAfter(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeMediaPath(value: unknown, fallback: string): string {
  if (!safeText(value, 2048) || value.length === 0 || !value.startsWith('/') || value.startsWith('//')) {
    return fallback;
  }
  try {
    const parsed = new URL(value, 'https://offline.invalid');
    if (parsed.origin !== 'https://offline.invalid' || parsed.username || parsed.password) return fallback;
    const path = parsed.pathname;
    if (
      path === OFFLINE_PLACEHOLDER_PATH ||
      /^\/internal\/assets\/[^/]+\/(?:thumbnail|poster)$/u.test(path)
    ) return path;
  } catch {
    // Invalid URLs become the static placeholder.
  }
  return fallback;
}

function safeNullableMediaPath(value: unknown): string | null {
  if (value === null) return null;
  const path = safeMediaPath(value, '');
  return path.length > 0 ? path : null;
}

function safeError(value: unknown): OfflineGalleryItemMetadata['error'] | null {
  if (value === null) return null;
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!hasOnlyKeys(value, ['code', 'message', 'retryable'])) return null;
  const candidate = value as Record<string, unknown>;
  if (!safeNonUserText(candidate.code, 255) || !safeNonUserText(candidate.message, 2048) || typeof candidate.retryable !== 'boolean') {
    return null;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    retryable: candidate.retryable,
  };
}

function safeFolderIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => safeId(item)))].slice(0, 100);
}

function safeNullableNumber(value: unknown): number | null {
  return value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
}

function parseItem(value: unknown): OfflineGalleryItemMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, ITEM_KEYS)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const status = isJobStatus(candidate.status) ? candidate.status : null;
  if (
    !safeId(candidate.id) ||
    !safeId(candidate.jobId) ||
    (candidate.kind !== 'image' && candidate.kind !== 'video') ||
    !safeUserPrompt(candidate.prompt) ||
    !safeNonUserText(candidate.alt, 512) ||
    !validIsoDate(candidate.createdAt) ||
    status === null ||
    !safeNonUserText(candidate.stage, 512) ||
    (candidate.progress !== null && (typeof candidate.progress !== 'number' || !Number.isFinite(candidate.progress))) ||
    typeof candidate.saved !== 'boolean' ||
    !safeId(candidate.providerId) ||
    !safeId(candidate.modelId) ||
    typeof candidate.width !== 'number' || !Number.isSafeInteger(candidate.width) || candidate.width <= 0 ||
    typeof candidate.height !== 'number' || !Number.isSafeInteger(candidate.height) || candidate.height <= 0 ||
    !safeText(candidate.aspectRatio, 64) ||
    typeof candidate.referenceCount !== 'number' || !Number.isSafeInteger(candidate.referenceCount) || candidate.referenceCount < 0 ||
    typeof candidate.batchCount !== 'number' || !Number.isSafeInteger(candidate.batchCount) || candidate.batchCount < 1 ||
    typeof candidate.previewPath !== 'string' ||
    (candidate.sourcePath !== null && typeof candidate.sourcePath !== 'string') ||
    (candidate.posterPath !== null && typeof candidate.posterPath !== 'string') ||
    (candidate.durationSeconds !== null && (typeof candidate.durationSeconds !== 'number' || !Number.isFinite(candidate.durationSeconds))) ||
    typeof candidate.persistedAsset !== 'boolean'
  ) return null;
  const error = safeError(candidate.error);
  if (candidate.error !== null && candidate.error !== undefined && error === null) return null;
  return {
    id: candidate.id,
    jobId: candidate.jobId,
    kind: candidate.kind,
    prompt: candidate.prompt,
    alt: candidate.alt,
    createdAt: candidate.createdAt,
    status,
    stage: candidate.stage,
    progress: candidate.progress === null ? null : Number(candidate.progress),
    error,
    saved: candidate.saved,
    folderIds: safeFolderIds(candidate.folderIds),
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    width: candidate.width,
    height: candidate.height,
    aspectRatio: candidate.aspectRatio,
    referenceCount: candidate.referenceCount,
    batchCount: candidate.batchCount,
    previewPath: safeMediaPath(candidate.previewPath, OFFLINE_PLACEHOLDER_PATH),
    sourcePath: candidate.sourcePath === null
      ? null
      : safeNullableMediaPath(candidate.sourcePath),
    posterPath: candidate.posterPath === null
      ? null
      : safeNullableMediaPath(candidate.posterPath),
    durationSeconds: candidate.durationSeconds === null ? null : Number(candidate.durationSeconds),
    persistedAsset: candidate.persistedAsset,
  };
}

function parseJob(value: unknown): OfflineJobMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, JOB_KEYS)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const status = isJobStatus(candidate.status) ? candidate.status : null;
  if (
    !safeId(candidate.id) ||
    !safeUserPrompt(candidate.prompt) ||
    status === null ||
    !safeNonUserText(candidate.stage, 512) ||
    (candidate.progress !== null && (typeof candidate.progress !== 'number' || !Number.isFinite(candidate.progress))) ||
    !safeId(candidate.providerId) ||
    !safeId(candidate.modelId) ||
    typeof candidate.outputCount !== 'number' || !Number.isSafeInteger(candidate.outputCount) || candidate.outputCount < 0 ||
    !validIsoDate(candidate.createdAt) ||
    !validIsoDate(candidate.updatedAt)
  ) return null;
  const error = safeError(candidate.error);
  if (candidate.error !== null && candidate.error !== undefined && error === null) return null;
  return {
    id: candidate.id,
    prompt: candidate.prompt,
    status,
    stage: candidate.stage,
    progress: candidate.progress === null ? null : Number(candidate.progress),
    error,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    outputCount: candidate.outputCount,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

export function parseOfflineMetadataSnapshot(value: unknown): OfflineMetadataSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasOnlyKeys(value, SNAPSHOT_KEYS)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== OFFLINE_SNAPSHOT_VERSION ||
    !finiteTimestamp(candidate.savedAt) ||
    !finiteSequence(candidate.sequence) ||
    !safeId(candidate.sessionScope) ||
    (candidate.mode !== 'authenticated' && candidate.mode !== 'public') ||
    !finiteSequence(candidate.generation) ||
    !Array.isArray(candidate.items) || candidate.items.length > OFFLINE_SNAPSHOT_MAX_ITEMS ||
    !Array.isArray(candidate.jobs) || candidate.jobs.length > OFFLINE_SNAPSHOT_MAX_JOBS
  ) return null;
  const items = candidate.items.map(parseItem);
  const jobs = candidate.jobs.map(parseJob);
  if (items.some((item) => item === null) || jobs.some((job) => job === null)) return null;
  const parsed: OfflineMetadataSnapshot = {
    version: OFFLINE_SNAPSHOT_VERSION,
    savedAt: candidate.savedAt,
    sequence: candidate.sequence,
    sessionScope: candidate.sessionScope,
    mode: candidate.mode,
    generation: candidate.generation,
    items: items as OfflineGalleryItemMetadata[],
    jobs: jobs as OfflineJobMetadata[],
  };
  return serializedByteLength(parsed) <= OFFLINE_SNAPSHOT_MAX_BYTES ? parsed : null;
}

function sortNewest<T extends { readonly createdAt: string; readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

function itemMetadata(item: FixtureGalleryItem): OfflineGalleryItemMetadata {
  const sourcePath = item.kind === 'image'
    ? safeMediaPath(item.sourcePath, OFFLINE_PLACEHOLDER_PATH)
    : null;
  return {
    id: safeId(item.id) ? item.id : `offline-${Math.random().toString(36).slice(2)}`,
    jobId: safeId(item.jobId) ? item.jobId : 'offline-job',
    kind: item.kind,
    prompt: safeUserPrompt(item.prompt) ? item.prompt : '',
    alt: sanitizeNonUserText(item.alt, 512, `Generated ${item.kind}`),
    createdAt: validIsoDate(item.createdAt) ? item.createdAt : new Date(0).toISOString(),
    status: JOB_STATUSES.has(item.status) ? item.status : 'completed',
    stage: sanitizeNonUserText(item.stage, 512, 'Ready'),
    progress: item.progress === null ? null : safeNullableNumber(item.progress),
    error: item.error === null ? null : safeError(item.error),
    saved: item.saved,
    folderIds: safeFolderIds(item.folderIds),
    providerId: safeId(item.providerId) ? item.providerId : 'unknown',
    modelId: safeId(item.modelId) ? item.modelId : 'unknown',
    width: Number.isSafeInteger(item.width) && item.width > 0 ? item.width : 1,
    height: Number.isSafeInteger(item.height) && item.height > 0 ? item.height : 1,
    aspectRatio: safeText(item.aspectRatio, 64) ? item.aspectRatio : '1:1',
    referenceCount: Number.isSafeInteger(item.referenceCount) && item.referenceCount >= 0 ? item.referenceCount : 0,
    batchCount: Number.isSafeInteger(item.batchCount) && item.batchCount > 0 ? item.batchCount : 1,
    previewPath: safeMediaPath(item.previewPath, OFFLINE_PLACEHOLDER_PATH),
    sourcePath,
    posterPath: item.kind === 'video' ? safeNullableMediaPath(item.posterPath) : null,
    durationSeconds: item.durationSeconds === null ? null : safeNullableNumber(item.durationSeconds),
    persistedAsset: item.persistedAsset,
  };
}

function jobMetadata(items: readonly OfflineGalleryItemMetadata[]): readonly OfflineJobMetadata[] {
  const jobs = new Map<string, OfflineJobMetadata>();
  for (const item of items) {
    const existing = jobs.get(item.jobId);
    if (existing !== undefined) {
      if (item.createdAt > existing.createdAt) {
        jobs.set(item.jobId, { ...existing, createdAt: item.createdAt });
      }
      continue;
    }
    jobs.set(item.jobId, {
      id: item.jobId,
      prompt: item.prompt,
      status: item.status,
      stage: item.stage,
      progress: item.progress,
      error: item.error,
      providerId: item.providerId,
      modelId: item.modelId,
      outputCount: item.batchCount,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    });
  }
  return sortNewest([...jobs.values()]).slice(0, OFFLINE_SNAPSHOT_MAX_JOBS);
}

export function createOfflineMetadataSnapshot(
  items: readonly FixtureGalleryItem[],
  savedAt = Date.now(),
): OfflineMetadataSnapshot {
  const metadata = sortNewest(items.map(itemMetadata)).slice(0, OFFLINE_SNAPSHOT_MAX_ITEMS);
  const now = Date.now();
  const clockNow = finiteTimestamp(now) ? now : 0;
  const requestedSavedAt = finiteTimestamp(savedAt) ? Math.min(savedAt, clockNow) : clockNow;
  const monotonicBase = Math.min(lastSnapshotSavedAt, clockNow);
  const normalizedSavedAt = Math.min(clockNow, Math.max(requestedSavedAt, monotonicBase + 1));
  const sequence = lastSnapshotSequence >= Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : Math.max(lastSnapshotSequence + 1, 1);
  const marker = offlineSnapshotWritesAllowed && finiteTimestamp(clockNow)
    ? readCurrentSessionMarker(clockNow, undefined)
    : null;
  lastSnapshotSavedAt = normalizedSavedAt;
  lastSnapshotSequence = sequence;
  return {
    version: OFFLINE_SNAPSHOT_VERSION,
    savedAt: normalizedSavedAt,
    sequence,
    sessionScope: marker?.sessionScope ?? volatileSessionScope ?? randomSessionScope(),
    mode: marker?.mode ?? volatileSessionMode ?? 'authenticated',
    generation: marker?.generation ?? offlineSessionGeneration,
    items: metadata,
    jobs: jobMetadata(metadata),
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(OFFLINE_SNAPSHOT_DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        request.result.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Offline snapshot database could not open.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readIndexedSnapshot(factory: IDBFactory): Promise<unknown | undefined> {
  const database = await openDatabase(factory);
  try {
    return await new Promise<unknown | undefined>((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readonly');
      const request = transaction.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).get(OFFLINE_SNAPSHOT_KEY);
      request.onerror = () => reject(request.error ?? new Error('Offline snapshot could not be read.'));
      request.onsuccess = () => resolve(request.result as unknown);
    });
  } finally {
    database.close();
  }
}

function sameSnapshotIdentity(
  left: Pick<OfflineMetadataSnapshot, 'sessionScope' | 'mode' | 'generation'>,
  right: Pick<OfflineMetadataSnapshot, 'sessionScope' | 'mode' | 'generation'>,
): boolean {
  return left.sessionScope === right.sessionScope &&
    left.mode === right.mode &&
    left.generation === right.generation;
}

function isSnapshotWriteCurrent(
  snapshot: OfflineMetadataSnapshot,
  generation: number,
  epoch: number,
): boolean {
  if (
    !offlineSnapshotWritesAllowed ||
    offlineSessionGeneration !== generation ||
    offlineSnapshotEpoch !== epoch ||
    volatileSessionScope !== snapshot.sessionScope ||
    volatileSessionMode !== snapshot.mode
  ) return false;
  const marker = readCurrentSessionMarker(Date.now(), undefined);
  return marker !== null && marker.generation === generation && sameSnapshotIdentity(snapshot, marker);
}

async function writeIndexedSnapshot(
  factory: IDBFactory,
  snapshot: OfflineMetadataSnapshot,
  generation: number,
  epoch: number,
): Promise<boolean> {
  const database = await openDatabase(factory);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      let accepted = false;
      transaction.oncomplete = () => resolve(accepted);
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline snapshot could not be written.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot write was aborted.'));
      const objectStore = transaction.objectStore(OFFLINE_SNAPSHOT_STORE_NAME);
      const readRequest = objectStore.get(OFFLINE_SNAPSHOT_KEY);
      readRequest.onerror = () => reject(readRequest.error ?? new Error('Offline snapshot could not be compared.'));
      readRequest.onsuccess = () => {
        if (!isSnapshotWriteCurrent(snapshot, generation, epoch)) return;
        const existing = parseOfflineMetadataSnapshot(readRequest.result as unknown);
        if (existing !== null && !sameSnapshotIdentity(snapshot, existing)) {
          accepted = true;
          objectStore.put(snapshot, OFFLINE_SNAPSHOT_KEY);
          return;
        }
        if (!snapshotVersionIsNewer(snapshot, existing)) return;
        accepted = true;
        objectStore.put(snapshot, OFFLINE_SNAPSHOT_KEY);
      };
    });
  } finally {
    database.close();
  }
}

async function clearIndexedSnapshot(
  factory: IDBFactory,
  epoch: number,
  expectedIdentity?: Pick<OfflineMetadataSnapshot, 'sessionScope' | 'mode' | 'generation'>,
): Promise<boolean> {
  const database = await openDatabase(factory);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      let removed = false;
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline snapshot could not clear.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot clear was aborted.'));
      if (offlineSnapshotEpoch !== epoch) {
        return;
      }
      const objectStore = transaction.objectStore(OFFLINE_SNAPSHOT_STORE_NAME);
      const request = expectedIdentity === undefined
        ? objectStore.delete(OFFLINE_SNAPSHOT_KEY)
        : objectStore.get(OFFLINE_SNAPSHOT_KEY);
      if (expectedIdentity !== undefined) {
        request.onsuccess = () => {
          const current = parseOfflineMetadataSnapshot(request.result as unknown);
          if (
            current !== null &&
            (!sameSnapshotIdentity(current, expectedIdentity) || current.generation > expectedIdentity.generation)
          ) return;
          const deleteRequest = objectStore.delete(OFFLINE_SNAPSHOT_KEY);
          deleteRequest.onsuccess = () => { removed = true; };
        };
        return;
      }
      request.onsuccess = () => {
        removed = request.result === undefined;
      };
    });
  } finally {
    database.close();
  }
}

type SnapshotSource = 'indexeddb' | 'localStorage' | 'memory';

interface RawSnapshotCandidate {
  readonly source: SnapshotSource;
  readonly raw: unknown;
  readonly storage?: OfflineStorage;
  readonly factory?: IDBFactory;
  readonly serialized?: string;
}

async function readRawSnapshotCandidates(): Promise<readonly RawSnapshotCandidate[]> {
  if (pendingOfflineCleanup !== null) await pendingOfflineCleanup;
  if (pendingOfflineSnapshotClear !== null) await pendingOfflineSnapshotClear;
  const candidates: RawSnapshotCandidate[] = [];
  const factory = indexedDbFactory();
  if (factory !== undefined) {
    try {
      const value = await readIndexedSnapshot(factory);
      if (value !== undefined) candidates.push({ source: 'indexeddb', raw: value, factory });
    } catch {
      // Continue to localStorage/memory fallback when IndexedDB is unavailable.
    }
  }
  const storageAccessResult = storageAccess();
  if (storageAccessResult.storage !== undefined) {
    if (!failedStorageObjects.has(storageAccessResult.storage)) {
      try {
        const serialized = storageAccessResult.storage.getItem(OFFLINE_SNAPSHOT_KEY);
        if (serialized !== null) {
          let raw: unknown;
          if (serializedByteLength(serialized) > OFFLINE_SNAPSHOT_MAX_BYTES) {
            raw = undefined;
          } else {
            try {
              raw = JSON.parse(serialized) as unknown;
            } catch {
              raw = undefined;
            }
          }
          candidates.push({
            source: 'localStorage',
            raw,
            storage: storageAccessResult.storage,
            serialized,
          });
        }
      } catch {
        // A storage read error is fail-closed; an old volatile copy is not safe.
        markStorageFailure(storageAccessResult.storage);
      }
    }
  }
  if (candidates.length === 0 && storageAccessResult.mode === 'memory-only' && volatileSnapshotMemoryOnly && volatileSnapshot !== null) {
    candidates.push({ source: 'memory', raw: volatileSnapshot });
  }
  return candidates;
}

function sameSnapshotVersion(
  left: Pick<OfflineMetadataSnapshot, 'savedAt' | 'sequence'>,
  right: Pick<OfflineMetadataSnapshot, 'savedAt' | 'sequence'>,
): boolean {
  return left.savedAt === right.savedAt && left.sequence === right.sequence;
}

function shouldDeleteRawSnapshot(
  raw: unknown,
  expected: OfflineMetadataSnapshot | null,
): boolean {
  const parsed = parseOfflineMetadataSnapshot(raw);
  if (expected === null) return parsed === null;
  return parsed !== null && sameSnapshotIdentity(parsed, expected) && sameSnapshotVersion(parsed, expected);
}

async function deleteIndexedSnapshotIf(
  factory: IDBFactory,
  epoch: number,
  expected: OfflineMetadataSnapshot | null,
): Promise<boolean> {
  const database = await openDatabase(factory);
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      let removed = false;
      transaction.oncomplete = () => resolve(removed);
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline snapshot could not clear.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline snapshot clear was aborted.'));
      const objectStore = transaction.objectStore(OFFLINE_SNAPSHOT_STORE_NAME);
      const request = objectStore.get(OFFLINE_SNAPSHOT_KEY);
      request.onerror = () => reject(request.error ?? new Error('Offline snapshot could not compare for clear.'));
      request.onsuccess = () => {
        if (offlineSnapshotEpoch !== epoch || !shouldDeleteRawSnapshot(request.result as unknown, expected)) return;
        const deleteRequest = objectStore.delete(OFFLINE_SNAPSHOT_KEY);
        deleteRequest.onsuccess = () => { removed = true; };
      };
    });
  } finally {
    database.close();
  }
}

function deleteLocalSnapshotIf(
  storage: OfflineStorage,
  expected: OfflineMetadataSnapshot | null,
): boolean {
  if (failedStorageObjects.has(storage)) return false;
  try {
    const serialized = storage.getItem(OFFLINE_SNAPSHOT_KEY);
    if (serialized === null) return false;
    let raw: unknown;
    try {
      raw = serializedByteLength(serialized) > OFFLINE_SNAPSHOT_MAX_BYTES
        ? undefined
        : JSON.parse(serialized) as unknown;
    } catch {
      raw = undefined;
    }
    if (!shouldDeleteRawSnapshot(raw, expected)) return false;
    storage.removeItem(OFFLINE_SNAPSHOT_KEY);
    return true;
  } catch {
    markStorageFailure(storage);
    return false;
  }
}

async function cleanupSnapshotCandidate(
  candidate: RawSnapshotCandidate,
  parsed: OfflineMetadataSnapshot | null,
  epoch: number,
): Promise<void> {
  if (candidate.source === 'indexeddb' && candidate.factory !== undefined) {
    try {
      await deleteIndexedSnapshotIf(candidate.factory, epoch, parsed);
    } catch {
      // Cleanup is best effort; the session scope still prevents stale reads.
    }
    return;
  }
  if (candidate.source === 'localStorage' && candidate.storage !== undefined) {
    deleteLocalSnapshotIf(candidate.storage, parsed);
    return;
  }
  if (candidate.source === 'memory' && offlineSnapshotEpoch === epoch && volatileSnapshot === parsed) {
    volatileSnapshot = null;
    volatileSnapshotMemoryOnly = false;
  }
}

function writeLocalStorageSnapshot(
  storage: OfflineStorage,
  snapshot: OfflineMetadataSnapshot,
  generation: number,
  epoch: number,
): boolean {
  if (failedStorageObjects.has(storage) || !isSnapshotWriteCurrent(snapshot, generation, epoch)) return false;
  try {
    const serialized = storage.getItem(OFFLINE_SNAPSHOT_KEY);
    let existing: OfflineMetadataSnapshot | null = null;
    if (serialized !== null && serializedByteLength(serialized) <= OFFLINE_SNAPSHOT_MAX_BYTES) {
      try {
        existing = parseOfflineMetadataSnapshot(JSON.parse(serialized) as unknown);
      } catch {
        existing = null;
      }
    }
    if (existing !== null && sameSnapshotIdentity(existing, snapshot) && !snapshotVersionIsNewer(snapshot, existing)) {
      return false;
    }
    if (!isSnapshotWriteCurrent(snapshot, generation, epoch)) return false;
    storage.setItem(OFFLINE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    clearStorageFailure(storage);
    return true;
  } catch {
    markStorageFailure(storage);
    return false;
  }
}

export async function readOfflineMetadataSnapshot(
  now = Date.now(),
): Promise<OfflineMetadataSnapshot | null> {
  if (!finiteTimestamp(now) || !offlineSnapshotWritesAllowed) return null;
  const epoch = offlineSnapshotEpoch;
  const marker = readCurrentSessionMarker(now, undefined);
  if (marker === null) return null;
  const candidates = await readRawSnapshotCandidates();
  if (offlineSnapshotEpoch !== epoch) return null;
  const currentMarker = readCurrentSessionMarker(now, undefined);
  if (currentMarker === null || !sameSnapshotIdentity(marker, currentMarker)) return null;

  const parsedCandidates = candidates.map((candidate) => ({
    candidate,
    parsed: parseOfflineMetadataSnapshot(candidate.raw),
  }));
  const validCandidates = parsedCandidates.filter(({ parsed }) =>
    parsed !== null &&
    sameSnapshotIdentity(parsed, marker) &&
    parsed.savedAt <= now &&
    now - parsed.savedAt <= OFFLINE_SNAPSHOT_TTL_MS,
  ) as Array<{ readonly candidate: RawSnapshotCandidate; readonly parsed: OfflineMetadataSnapshot }>;
  const winner = validCandidates.reduce<{ readonly candidate: RawSnapshotCandidate; readonly parsed: OfflineMetadataSnapshot } | null>(
    (current, next) => current === null || snapshotVersionIsNewer(next.parsed, current.parsed) ? next : current,
    null,
  );

  await Promise.all(parsedCandidates.map(({ candidate, parsed }) => {
    if (winner !== null && candidate === winner.candidate) return Promise.resolve();
    return cleanupSnapshotCandidate(candidate, parsed, epoch);
  }));
  if (offlineSnapshotEpoch !== epoch || winner === null) return null;
  lastSnapshotSavedAt = Math.min(now, Math.max(lastSnapshotSavedAt, winner.parsed.savedAt));
  lastSnapshotSequence = Math.max(lastSnapshotSequence, winner.parsed.sequence);
  return winner.parsed;
}

export async function writeOfflineMetadataSnapshot(
  snapshot: OfflineMetadataSnapshot,
): Promise<void> {
  if (!offlineSnapshotWritesAllowed) return;
  if (pendingOfflineSnapshotClear !== null) await pendingOfflineSnapshotClear;
  const generation = offlineSessionGeneration;
  const epoch = offlineSnapshotEpoch;
  const now = Date.now();
  if (offlineMetadataSnapshotByteLength(snapshot) > OFFLINE_SNAPSHOT_MAX_BYTES) {
    throw new TypeError('Offline metadata snapshot exceeds its serialized byte limit.');
  }
  const parsed = parseOfflineMetadataSnapshot(snapshot);
  if (
    parsed === null ||
    !finiteTimestamp(now) ||
    parsed.savedAt > now
  ) throw new TypeError('Offline metadata snapshot does not match its schema.');
  const marker = readCurrentSessionMarker(now, undefined);
  if (marker === null || !sameSnapshotIdentity(parsed, marker) || !isSnapshotWriteCurrent(parsed, generation, epoch)) return;

  let winner = parsed;
  const existingCandidates = await readRawSnapshotCandidates();
  if (!isSnapshotWriteCurrent(parsed, generation, epoch)) return;
  for (const candidate of existingCandidates) {
    const existing = parseOfflineMetadataSnapshot(candidate.raw);
    if (
      existing !== null &&
      sameSnapshotIdentity(existing, marker) &&
      snapshotVersionIsNewer(existing, winner)
    ) winner = existing;
  }

  let persisted = false;
  let memoryOnly = false;
  const factory = indexedDbFactory();
  if (factory !== undefined) {
    try {
      persisted = (await writeIndexedSnapshot(factory, winner, generation, epoch)) || persisted;
    } catch {
      // localStorage remains an explicit fallback when IndexedDB is unavailable.
    }
  }
  const storageAccessResult = storageAccess();
  if (storageAccessResult.storage !== undefined) {
    persisted = writeLocalStorageSnapshot(
      storageAccessResult.storage,
      winner,
      generation,
      epoch,
    ) || persisted;
  } else if (storageAccessResult.mode === 'memory-only' && isSnapshotWriteCurrent(winner, generation, epoch)) {
    volatileSnapshot = winner;
    volatileSnapshotMemoryOnly = true;
    memoryOnly = true;
    persisted = true;
  }
  if (persisted && isSnapshotWriteCurrent(winner, generation, epoch)) {
    volatileSnapshot = winner;
    volatileSnapshotMemoryOnly = memoryOnly;
    lastSnapshotSavedAt = Math.min(now, Math.max(lastSnapshotSavedAt, winner.savedAt));
    lastSnapshotSequence = Math.max(lastSnapshotSequence, winner.sequence);
  }
}

export async function saveOfflineGallerySnapshot(
  items: readonly FixtureGalleryItem[],
  savedAt = Date.now(),
): Promise<OfflineMetadataSnapshot> {
  const snapshot = createOfflineMetadataSnapshot(items, savedAt);
  await writeOfflineMetadataSnapshot(snapshot);
  return snapshot;
}

function clearLocalSnapshot(
  storage: OfflineStorage,
  expectedIdentity?: Pick<OfflineMetadataSnapshot, 'sessionScope' | 'mode' | 'generation'>,
): boolean {
  if (failedStorageObjects.has(storage)) return false;
  try {
    const serialized = storage.getItem(OFFLINE_SNAPSHOT_KEY);
    if (serialized === null) return false;
    let raw: unknown;
    try {
      raw = serializedByteLength(serialized) > OFFLINE_SNAPSHOT_MAX_BYTES
        ? undefined
        : JSON.parse(serialized) as unknown;
    } catch {
      raw = undefined;
    }
    const current = parseOfflineMetadataSnapshot(raw);
    if (
      expectedIdentity !== undefined &&
      current !== null &&
      (!sameSnapshotIdentity(current, expectedIdentity) || current.generation > expectedIdentity.generation)
    ) return false;
    storage.removeItem(OFFLINE_SNAPSHOT_KEY);
    return true;
  } catch {
    markStorageFailure(storage);
    return false;
  }
}

export async function clearOfflineMetadataSnapshot(
  expectedIdentity?: Pick<OfflineMetadataSnapshot, 'sessionScope' | 'mode' | 'generation'>,
): Promise<boolean> {
  const epoch = ++offlineSnapshotEpoch;
  const volatileChanged = volatileSnapshot !== null;
  volatileSnapshot = null;
  volatileSnapshotMemoryOnly = false;
  const previousClear = pendingOfflineSnapshotClear;
  const operation = (previousClear ?? Promise.resolve()).then(async () => {
    if (offlineSnapshotEpoch !== epoch) return volatileChanged;
    let changed = volatileChanged;
    const factory = indexedDbFactory();
    if (factory !== undefined) {
      try {
        changed = (await clearIndexedSnapshot(factory, epoch, expectedIdentity)) || changed;
      } catch {
        // Try local storage even if IndexedDB is broken.
      }
    }
    if (offlineSnapshotEpoch !== epoch) return changed;
    const storage = browserStorage();
    if (storage !== undefined && !failedStorageObjects.has(storage)) {
      changed = clearLocalSnapshot(storage, expectedIdentity) || changed;
    }
    return changed;
  });
  const pending = operation.then(() => undefined, () => undefined);
  pendingOfflineSnapshotClear = pending;
  try {
    return await operation;
  } finally {
    if (pendingOfflineSnapshotClear === pending) pendingOfflineSnapshotClear = null;
  }
}

export function parseOfflineAuthMarker(
  value: unknown,
  now = Date.now(),
): OfflineAuthMarker | null {
  if (typeof value !== 'string' || !finiteTimestamp(now)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !hasOnlyKeys(parsed, ['version', 'mode', 'authenticatedAt', 'sessionScope', 'generation'])
    ) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== OFFLINE_AUTH_MARKER_VERSION ||
      candidate.mode !== 'authenticated' ||
      !finiteTimestamp(candidate.authenticatedAt) ||
      !safeSessionScope(candidate.sessionScope) ||
      !finiteSequence(candidate.generation) ||
      candidate.authenticatedAt > now ||
      now - candidate.authenticatedAt > OFFLINE_AUTH_MARKER_TTL_MS
    ) return null;
    return {
      version: OFFLINE_AUTH_MARKER_VERSION,
      mode: 'authenticated',
      authenticatedAt: candidate.authenticatedAt,
      sessionScope: candidate.sessionScope,
      generation: candidate.generation,
    };
  } catch {
    return null;
  }
}

export function parseOfflinePublicBootstrapMarker(
  value: unknown,
  now = Date.now(),
): OfflinePublicBootstrapMarker | null {
  if (typeof value !== 'string' || !finiteTimestamp(now)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !hasOnlyKeys(parsed, ['version', 'mode', 'bootstrappedAt', 'sessionScope', 'generation'])
    ) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.version !== OFFLINE_PUBLIC_BOOTSTRAP_VERSION ||
      candidate.mode !== 'public' ||
      !finiteTimestamp(candidate.bootstrappedAt) ||
      !safeSessionScope(candidate.sessionScope) ||
      !finiteSequence(candidate.generation) ||
      candidate.bootstrappedAt > now ||
      now - candidate.bootstrappedAt > OFFLINE_PUBLIC_BOOTSTRAP_TTL_MS
    ) return null;
    return {
      version: OFFLINE_PUBLIC_BOOTSTRAP_VERSION,
      mode: 'public',
      bootstrappedAt: candidate.bootstrappedAt,
      sessionScope: candidate.sessionScope,
      generation: candidate.generation,
    };
  } catch {
    return null;
  }
}

type OfflineSessionMarker = OfflineAuthMarker | OfflinePublicBootstrapMarker;

function markerTime(marker: OfflineSessionMarker): number {
  return marker.mode === 'authenticated' ? marker.authenticatedAt : marker.bootstrappedAt;
}

function selectSessionMarker(
  authenticated: OfflineAuthMarker | null,
  publicMarker: OfflinePublicBootstrapMarker | null,
): OfflineSessionMarker | null {
  if (authenticated === null) return publicMarker;
  if (publicMarker === null) return authenticated;
  if (authenticated.generation > publicMarker.generation) return authenticated;
  if (publicMarker.generation > authenticated.generation) return publicMarker;
  if (authenticated.sessionScope !== publicMarker.sessionScope) return null;
  return markerTime(authenticated) >= markerTime(publicMarker) ? authenticated : publicMarker;
}

function readMarkerValue(
  key: string,
  now: number,
  storage: OfflineStorage,
  parse: (value: unknown, timestamp: number) => OfflineSessionMarker | null,
): OfflineSessionMarker | null {
  const raw = storage.getItem(key);
  const parsed = parse(raw, now);
  if (raw !== null && parsed === null) {
    try {
      storage.removeItem(key);
    } catch {
      markStorageFailure(storage);
    }
  }
  return parsed;
}

function readCurrentSessionMarker(
  now: number,
  storage: OfflineStorage | undefined,
): OfflineSessionMarker | null {
  const access = storageAccess(storage);
  if (access.storage !== undefined) {
    if (failedStorageObjects.has(access.storage)) return null;
    try {
      const authenticated = readMarkerValue(OFFLINE_AUTH_MARKER_KEY, now, access.storage, parseOfflineAuthMarker);
      const publicMarker = readMarkerValue(OFFLINE_PUBLIC_BOOTSTRAP_KEY, now, access.storage, parseOfflinePublicBootstrapMarker);
      if (failedStorageObjects.has(access.storage)) return null;
      const selected = selectSessionMarker(
        authenticated && authenticated.mode === 'authenticated' ? authenticated : null,
        publicMarker && publicMarker.mode === 'public' ? publicMarker : null,
      );
      if (selected !== null && offlineSnapshotWritesAllowed) {
        offlineSessionGeneration = Math.max(offlineSessionGeneration, selected.generation);
        volatileSessionScope = selected.sessionScope;
        volatileSessionMode = selected.mode;
      }
      return selected;
    } catch {
      // A marker read failure is explicitly fail-closed.
      markStorageFailure(access.storage);
      return null;
    }
  }
  if (access.mode !== 'memory-only') return null;
  const selected = selectSessionMarker(
    volatileAuthMarkerMemoryOnly ? volatileAuthMarker : null,
    volatilePublicBootstrapMemoryOnly ? volatilePublicBootstrapMarker : null,
  );
  if (selected !== null && finiteTimestamp(now)) {
    if (selected.mode === 'authenticated' &&
      (selected.authenticatedAt > now || now - selected.authenticatedAt > OFFLINE_AUTH_MARKER_TTL_MS)) return null;
    if (selected.mode === 'public' &&
      (selected.bootstrappedAt > now || now - selected.bootstrappedAt > OFFLINE_PUBLIC_BOOTSTRAP_TTL_MS)) return null;
  }
  return selected;
}

function removeMarker(key: string, storage: OfflineStorage | undefined): void {
  const access = storageAccess(storage);
  if (access.storage === undefined) return;
  try {
    access.storage.removeItem(key);
  } catch {
    // Blocked storage is already treated as empty on the next check.
    markStorageFailure(access.storage);
  }
}

function clearPersistentMarkerPair(storage: OfflineStorage): void {
  for (const key of [OFFLINE_AUTH_MARKER_KEY, OFFLINE_PUBLIC_BOOTSTRAP_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      markStorageFailure(storage);
    }
  }
}

export function rememberAuthenticatedSession(
  authenticatedAt = Date.now(),
  storage: OfflineStorage | undefined = browserStorage(),
): void {
  if (!finiteTimestamp(authenticatedAt)) return;
  const now = Date.now();
  const existing = offlineSnapshotWritesAllowed && finiteTimestamp(now)
    ? readCurrentSessionMarker(now, storage)
    : null;
  const reuseScope = existing?.mode === 'authenticated' ? existing.sessionScope : null;
  const generation = reuseScope === null
    ? Math.max(nextGeneration(), existing === null ? 0 : generationAfter(existing.generation))
    : Math.max(offlineSessionGeneration, existing?.generation ?? 0);
  const marker: OfflineAuthMarker = {
    version: OFFLINE_AUTH_MARKER_VERSION,
    mode: 'authenticated',
    authenticatedAt: Math.min(authenticatedAt, finiteTimestamp(now) ? now : authenticatedAt),
    sessionScope: reuseScope ?? randomSessionScope(),
    generation,
  };
  const access = storageAccess(storage);
  if (access.storage === undefined) {
    if (access.mode !== 'memory-only') {
      volatileAuthMarker = null;
      volatileAuthMarkerMemoryOnly = false;
      volatileSessionScope = null;
      volatileSessionMode = null;
      offlineSnapshotWritesAllowed = false;
      return;
    }
    volatileAuthMarker = marker;
    volatileAuthMarkerMemoryOnly = true;
    volatilePublicBootstrapMarker = null;
    volatilePublicBootstrapMemoryOnly = false;
    volatileSessionScope = marker.sessionScope;
    volatileSessionMode = marker.mode;
    offlineSessionGeneration = marker.generation;
    offlineSnapshotWritesAllowed = true;
    return;
  }
  try {
    access.storage.setItem(OFFLINE_AUTH_MARKER_KEY, JSON.stringify(marker));
    access.storage.removeItem(OFFLINE_PUBLIC_BOOTSTRAP_KEY);
    volatileAuthMarker = marker;
    volatileAuthMarkerMemoryOnly = false;
    volatilePublicBootstrapMarker = null;
    volatilePublicBootstrapMemoryOnly = false;
    volatileSessionScope = marker.sessionScope;
    volatileSessionMode = marker.mode;
    offlineSessionGeneration = marker.generation;
    offlineSnapshotWritesAllowed = true;
    clearStorageFailure(access.storage);
  } catch {
    // A storage write error cannot be converted into an offline credential.
    markStorageFailure(access.storage);
    clearPersistentMarkerPair(access.storage);
    volatileAuthMarker = null;
    volatileAuthMarkerMemoryOnly = false;
    volatilePublicBootstrapMarker = null;
    volatilePublicBootstrapMemoryOnly = false;
    volatileSessionScope = null;
    volatileSessionMode = null;
    offlineSnapshotWritesAllowed = false;
  }
}

export function hasAuthenticatedSessionMarker(
  now = Date.now(),
  storage: OfflineStorage | undefined = browserStorage(),
): boolean {
  return readCurrentSessionMarker(now, storage)?.mode === 'authenticated';
}

export function clearAuthenticatedSessionMarker(
  storage: OfflineStorage | undefined = browserStorage(),
): void {
  volatileAuthMarker = null;
  volatileAuthMarkerMemoryOnly = false;
  if (volatileSessionMode === 'authenticated') {
    volatileSessionScope = null;
    volatileSessionMode = null;
  }
  removeMarker(OFFLINE_AUTH_MARKER_KEY, storage);
}

export function rememberPublicOfflineBootstrap(
  bootstrappedAt = Date.now(),
  storage: OfflineStorage | undefined = browserStorage(),
): void {
  if (!finiteTimestamp(bootstrappedAt)) return;
  const now = Date.now();
  const existing = offlineSnapshotWritesAllowed && finiteTimestamp(now)
    ? readCurrentSessionMarker(now, storage)
    : null;
  const reuseScope = existing?.mode === 'public' ? existing.sessionScope : null;
  const generation = reuseScope === null
    ? Math.max(nextGeneration(), existing === null ? 0 : generationAfter(existing.generation))
    : Math.max(offlineSessionGeneration, existing?.generation ?? 0);
  const marker: OfflinePublicBootstrapMarker = {
    version: OFFLINE_PUBLIC_BOOTSTRAP_VERSION,
    mode: 'public',
    bootstrappedAt: Math.min(bootstrappedAt, finiteTimestamp(now) ? now : bootstrappedAt),
    sessionScope: reuseScope ?? randomSessionScope(),
    generation,
  };
  const access = storageAccess(storage);
  if (access.storage === undefined) {
    if (access.mode !== 'memory-only') {
      volatilePublicBootstrapMarker = null;
      volatilePublicBootstrapMemoryOnly = false;
      volatileSessionScope = null;
      volatileSessionMode = null;
      offlineSnapshotWritesAllowed = false;
      return;
    }
    volatilePublicBootstrapMarker = marker;
    volatilePublicBootstrapMemoryOnly = true;
    volatileAuthMarker = null;
    volatileAuthMarkerMemoryOnly = false;
    volatileSessionScope = marker.sessionScope;
    volatileSessionMode = marker.mode;
    offlineSessionGeneration = marker.generation;
    offlineSnapshotWritesAllowed = true;
    return;
  }
  try {
    access.storage.setItem(OFFLINE_PUBLIC_BOOTSTRAP_KEY, JSON.stringify(marker));
    access.storage.removeItem(OFFLINE_AUTH_MARKER_KEY);
    volatilePublicBootstrapMarker = marker;
    volatilePublicBootstrapMemoryOnly = false;
    volatileAuthMarker = null;
    volatileAuthMarkerMemoryOnly = false;
    volatileSessionScope = marker.sessionScope;
    volatileSessionMode = marker.mode;
    offlineSessionGeneration = marker.generation;
    offlineSnapshotWritesAllowed = true;
    clearStorageFailure(access.storage);
  } catch {
    markStorageFailure(access.storage);
    clearPersistentMarkerPair(access.storage);
    volatilePublicBootstrapMarker = null;
    volatilePublicBootstrapMemoryOnly = false;
    volatileAuthMarker = null;
    volatileAuthMarkerMemoryOnly = false;
    volatileSessionScope = null;
    volatileSessionMode = null;
    offlineSnapshotWritesAllowed = false;
  }
}

export function hasPublicOfflineBootstrapMarker(
  now = Date.now(),
  storage: OfflineStorage | undefined = browserStorage(),
): boolean {
  return readCurrentSessionMarker(now, storage)?.mode === 'public';
}

export function clearPublicOfflineBootstrapMarker(
  storage: OfflineStorage | undefined = browserStorage(),
): void {
  volatilePublicBootstrapMarker = null;
  volatilePublicBootstrapMemoryOnly = false;
  if (volatileSessionMode === 'public') {
    volatileSessionScope = null;
    volatileSessionMode = null;
  }
  removeMarker(OFFLINE_PUBLIC_BOOTSTRAP_KEY, storage);
}

export function offlineBootstrapMode(
  now = Date.now(),
  storage: OfflineStorage | undefined = browserStorage(),
): OfflineBootstrapMode | null {
  return readCurrentSessionMarker(now, storage)?.mode ?? null;
}

export async function clearOfflineBootstrapState(options: {
  readonly broadcast?: boolean;
  readonly change?: OfflineSessionChange;
  readonly awaitPending?: boolean;
} = {}): Promise<boolean> {
  const previousCleanup = options.awaitPending === false ? null : pendingOfflineCleanup;
  const currentMarker = readCurrentSessionMarker(Date.now(), undefined);
  const markerWasPresent = volatileAuthMarker !== null || volatilePublicBootstrapMarker !== null ||
    currentMarker !== null;
  clearVolatileOfflineState();
  // Invalidate synchronously before broadcasting or awaiting persistent cleanup.
  if (options.broadcast) broadcastOfflineSessionChange(options.change ?? 'logout');
  if (previousCleanup !== null) await previousCleanup;
  clearAuthenticatedSessionMarker();
  clearPublicOfflineBootstrapMarker();
  const snapshotWasPresent = await clearOfflineMetadataSnapshot(currentMarker ?? undefined);
  markOfflineBootstrapActive(false);
  return markerWasPresent || snapshotWasPresent;
}

export function toOfflineGalleryItem(metadata: OfflineGalleryItemMetadata): FixtureGalleryItem {
  const common = {
    id: metadata.id,
    jobId: metadata.jobId,
    prompt: metadata.prompt,
    alt: metadata.alt,
    createdAt: metadata.createdAt,
    status: metadata.status,
    stage: metadata.stage,
    progress: metadata.progress,
    error: metadata.error,
    saved: metadata.saved,
    folderIds: metadata.folderIds,
    providerId: metadata.providerId,
    modelId: metadata.modelId,
    width: metadata.width,
    height: metadata.height,
    aspectRatio: metadata.aspectRatio,
    referenceCount: metadata.referenceCount,
    batchCount: metadata.batchCount,
    previewPath: metadata.previewPath,
    inputDescriptor: null,
    persistedAsset: metadata.persistedAsset,
  };
  return metadata.kind === 'image'
    ? {
        ...common,
        kind: 'image',
        sourcePath: metadata.sourcePath ?? OFFLINE_PLACEHOLDER_PATH,
        posterPath: null,
        durationSeconds: null,
      }
    : {
        ...common,
        kind: 'video',
        sourcePath: metadata.sourcePath,
        posterPath: metadata.posterPath ?? OFFLINE_PLACEHOLDER_PATH,
        durationSeconds: metadata.durationSeconds ?? 0,
      };
}

export async function loadOfflineGallerySnapshot(
  now = Date.now(),
): Promise<readonly FixtureGalleryItem[] | null> {
  const snapshot = await readOfflineMetadataSnapshot(now);
  if (snapshot === null) return null;
  return snapshot.items.map(toOfflineGalleryItem);
}
