import {
  subscribeToAuthRequired,
  subscribeToAuthSessionChanged,
} from '../../../api/internal-client.js';

export const COMPOSER_DRAFT_STORAGE_KEY = 'imagine.composer-draft.v1';
export const COMPOSER_DRAFT_VERSION = 1 as const;
export const COMPOSER_DRAFT_DEBOUNCE_MS = 300;
export const COMPOSER_DRAFT_MAX_BYTES = 64 * 1024;
export const COMPOSER_DRAFT_MAX_PROMPT_LENGTH = 32_000;
export const COMPOSER_DRAFT_AUTH_STORAGE_KEY = 'imagine.composer-draft-auth.v1';
export const COMPOSER_DRAFT_AUTH_CHANNEL_NAME = 'imagine.composer-draft-auth.v1';
export const COMPOSER_DRAFT_AUTH_SIGNAL_VERSION = 1 as const;

export interface ComposerDraft {
  readonly prompt: string;
}

export interface ComposerDraftEnvelope {
  readonly version: typeof COMPOSER_DRAFT_VERSION;
  readonly draft: ComposerDraft;
}

export interface ComposerDraftStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

export interface ComposerDraftPersistence {
  schedule: (value: unknown) => void;
  flush: () => void;
  clear: () => void;
  /** Invalidate an instance at an auth boundary without flushing stale state. */
  invalidate: () => void;
  dispose: () => void;
}

export interface ComposerDraftTimerApi {
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
}

export interface ComposerDraftStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

export interface ComposerDraftStorageEventTarget {
  addEventListener: (
    type: 'storage',
    listener: (event: ComposerDraftStorageEvent) => void,
  ) => void;
  removeEventListener: (
    type: 'storage',
    listener: (event: ComposerDraftStorageEvent) => void,
  ) => void;
}

export interface ComposerDraftBroadcastChannel {
  addEventListener: (
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  removeEventListener: (
    type: 'message',
    listener: (event: { readonly data: unknown }) => void,
  ) => void;
  postMessage: (message: unknown) => void;
  close: () => void;
}

export interface ComposerDraftAuthSyncOptions {
  readonly eventTarget?: ComposerDraftStorageEventTarget;
  readonly storage?: ComposerDraftStorage;
  readonly broadcastChannel?: ComposerDraftBroadcastChannel;
  readonly createBroadcastChannel?:
    (name: string) => ComposerDraftBroadcastChannel | undefined;
  readonly sourceId?: string;
}

export interface ComposerDraftAuthSync {
  /** Invalidate this tab's drafts and notify other tabs. */
  notify: () => void;
  dispose: () => void;
}

function browserStorage(): ComposerDraftStorage | undefined {
  try {
    const storage = globalThis.localStorage;
    if (
      storage === undefined ||
      typeof storage.getItem !== 'function' ||
      typeof storage.removeItem !== 'function' ||
      typeof storage.setItem !== 'function'
    ) {
      return undefined;
    }
    return storage;
  } catch {
    return undefined;
  }
}

function browserStorageEventTarget(): ComposerDraftStorageEventTarget | undefined {
  if (typeof window === 'undefined') return undefined;
  return {
    addEventListener: (type, listener) => {
      window.addEventListener(type, listener as unknown as EventListener);
    },
    removeEventListener: (type, listener) => {
      window.removeEventListener(type, listener as unknown as EventListener);
    },
  };
}

function browserBroadcastChannel(name: string): ComposerDraftBroadcastChannel | undefined {
  if (typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') {
    return undefined;
  }
  try {
    const channel = new window.BroadcastChannel(name);
    return {
      addEventListener: (type, listener) => {
        channel.addEventListener(type, listener as unknown as EventListener);
      },
      removeEventListener: (type, listener) => {
        channel.removeEventListener(type, listener as unknown as EventListener);
      },
      postMessage: (message) => channel.postMessage(message),
      close: () => channel.close(),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validPrompt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > COMPOSER_DRAFT_MAX_PROMPT_LENGTH) {
    return null;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return null;
    if (code === 127) return null;
  }
  return value;
}

function promptFromValue(value: unknown): string | null {
  if (typeof value === 'string') return validPrompt(value);
  if (!isRecord(value)) return null;
  const candidate = isRecord(value.draft) ? value.draft.prompt : value.prompt;
  return validPrompt(candidate);
}

function serializedEnvelope(draft: ComposerDraft): string | null {
  try {
    const value = JSON.stringify({
      version: COMPOSER_DRAFT_VERSION,
      draft: { prompt: draft.prompt },
    } satisfies ComposerDraftEnvelope);
    return utf8ByteLength(value) <= COMPOSER_DRAFT_MAX_BYTES ? value : null;
  } catch {
    return null;
  }
}

export function sanitizeComposerDraft(value: unknown): ComposerDraft {
  return { prompt: promptFromValue(value) ?? '' };
}

export function parseComposerDraft(value: unknown): ComposerDraft | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== COMPOSER_DRAFT_VERSION ||
    !isRecord(parsed.draft)
  ) {
    return null;
  }
  const prompt = validPrompt(parsed.draft.prompt);
  return prompt === null ? null : { prompt };
}

export function readComposerDraft(
  storage: ComposerDraftStorage | undefined = browserStorage(),
): ComposerDraft | null {
  if (storage === undefined) return null;
  try {
    const raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
    if (raw === null) return null;
    const draft = parseComposerDraft(raw);
    if (draft === null) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeComposerDraft(
  value: unknown,
  storage: ComposerDraftStorage | undefined = browserStorage(),
): boolean {
  if (storage === undefined) return false;
  const prompt = promptFromValue(value);
  if (prompt === null) return false;
  const draft = { prompt };
  if (draft.prompt.length === 0) {
    clearStoredComposerDraft(storage);
    return true;
  }
  const serialized = serializedEnvelope(draft);
  if (serialized === null) return false;
  try {
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearStoredComposerDraft(
  storage: ComposerDraftStorage | undefined = browserStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable or quota-restricted; there is no durable data to recover here.
  }
}

const activePersistences = new Set<ComposerDraftPersistence>();

const defaultTimerApi: ComposerDraftTimerApi = {
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
};

export function createComposerDraftPersistence(options: Readonly<{
  debounceMs?: number;
  storage?: ComposerDraftStorage;
  timerApi?: ComposerDraftTimerApi;
}> = {}): ComposerDraftPersistence {
  const storage = options.storage ?? browserStorage();
  const timerApi = options.timerApi ?? defaultTimerApi;
  const debounceMs = options.debounceMs ?? COMPOSER_DRAFT_DEBOUNCE_MS;
  let pending: ComposerDraft | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer === undefined) return;
    timerApi.clearTimeout(timer);
    timer = undefined;
  };
  const persistence: ComposerDraftPersistence = {
    schedule: (value) => {
      if (disposed) return;
      const prompt = promptFromValue(value);
      if (prompt === null) return;
      pending = { prompt };
      cancelTimer();
      timer = timerApi.setTimeout(() => {
        timer = undefined;
        persistence.flush();
      }, debounceMs);
    },
    flush: () => {
      if (disposed) return;
      cancelTimer();
      if (pending === null) return;
      const next = pending;
      if (writeComposerDraft(next, storage)) pending = null;
    },
    clear: () => {
      if (disposed) return;
      cancelTimer();
      pending = null;
      clearStoredComposerDraft(storage);
    },
    invalidate: () => {
      if (disposed) return;
      cancelTimer();
      pending = null;
      clearStoredComposerDraft(storage);
      disposed = true;
      activePersistences.delete(persistence);
    },
    dispose: () => {
      if (disposed) return;
      persistence.flush();
      disposed = true;
      activePersistences.delete(persistence);
    },
  };
  activePersistences.add(persistence);
  return persistence;
}

/** Flush all mounted Composer drafts before a reload/update lifecycle boundary. */
export function flushPromptDraft(): void {
  for (const persistence of [...activePersistences]) persistence.flush();
}

/** Clear every active and browser-persisted draft when an auth session changes. */
export function clearComposerDrafts(): void {
  for (const persistence of [...activePersistences]) persistence.invalidate();
  clearStoredComposerDraft();
}

interface ComposerDraftAuthSignal {
  readonly version: typeof COMPOSER_DRAFT_AUTH_SIGNAL_VERSION;
  readonly id: string;
  readonly source: string;
}

let authSignalSequence = 0;

function createIdentifier(prefix: string): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // A locally unique fallback is sufficient for a payload-free invalidation signal.
  }
  authSignalSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${authSignalSequence.toString(36)}`;
}

function parseComposerDraftAuthSignal(value: unknown): ComposerDraftAuthSignal | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed) || parsed.version !== COMPOSER_DRAFT_AUTH_SIGNAL_VERSION) {
    return null;
  }
  const id = parsed.id;
  const source = parsed.source;
  if (
    typeof id !== 'string' || id.length === 0 || id.length > 256 ||
    typeof source !== 'string' || source.length === 0 || source.length > 256
  ) {
    return null;
  }
  return { version: COMPOSER_DRAFT_AUTH_SIGNAL_VERSION, id, source };
}

function rememberAuthSignal(seen: Set<string>, id: string): void {
  seen.add(id);
  if (seen.size <= 128) return;
  const oldest = seen.values().next().value;
  if (typeof oldest === 'string') seen.delete(oldest);
}

/**
 * Synchronizes auth-boundary draft invalidation across browser tabs. The
 * signal contains only an opaque id and source, never session or prompt data.
 */
export function createComposerDraftAuthSync(
  options: ComposerDraftAuthSyncOptions = {},
): ComposerDraftAuthSync {
  const sourceId = options.sourceId ?? createIdentifier('composer-tab');
  const storage = options.storage ?? browserStorage();
  const eventTarget = options.eventTarget ?? browserStorageEventTarget();
  const channel = options.broadcastChannel ??
    (options.createBroadcastChannel
      ? options.createBroadcastChannel(COMPOSER_DRAFT_AUTH_CHANNEL_NAME)
      : browserBroadcastChannel(COMPOSER_DRAFT_AUTH_CHANNEL_NAME));
  const seen = new Set<string>();
  let disposed = false;

  const receive = (value: unknown) => {
    if (disposed) return;
    const signal = parseComposerDraftAuthSignal(value);
    if (signal === null || signal.source === sourceId || seen.has(signal.id)) return;
    rememberAuthSignal(seen, signal.id);
    clearComposerDrafts();
  };
  const storageListener = (event: ComposerDraftStorageEvent) => {
    if (event.key === COMPOSER_DRAFT_AUTH_STORAGE_KEY) receive(event.newValue);
  };
  const channelListener = (event: { readonly data: unknown }) => receive(event.data);
  eventTarget?.addEventListener('storage', storageListener);
  channel?.addEventListener('message', channelListener);

  const publish = () => {
    if (disposed) return;
    const signal: ComposerDraftAuthSignal = {
      version: COMPOSER_DRAFT_AUTH_SIGNAL_VERSION,
      id: createIdentifier('composer-auth'),
      source: sourceId,
    };
    rememberAuthSignal(seen, signal.id);
    const serialized = JSON.stringify(signal);
    try {
      storage?.setItem(COMPOSER_DRAFT_AUTH_STORAGE_KEY, serialized);
      storage?.removeItem(COMPOSER_DRAFT_AUTH_STORAGE_KEY);
    } catch {
      // BroadcastChannel remains available when storage is blocked or quota-limited.
    }
    try {
      channel?.postMessage(signal);
    } catch {
      // A closed or unavailable channel must not affect the auth transition.
    }
  };
  const notify = () => {
    if (disposed) return;
    clearComposerDrafts();
    publish();
  };
  const unsubscribeAuthRequired = subscribeToAuthRequired(notify);
  const unsubscribeAuthSessionChanged = subscribeToAuthSessionChanged(notify);

  return {
    notify,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      eventTarget?.removeEventListener('storage', storageListener);
      channel?.removeEventListener('message', channelListener);
      try {
        channel?.close();
      } catch {
        // Closing an already closed channel is harmless.
      }
      unsubscribeAuthRequired();
      unsubscribeAuthSessionChanged();
      seen.clear();
    },
  };
}

function installLifecycleHandlers(): void {
  if (typeof window === 'undefined') return;
  const flush = () => flushPromptDraft();
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
}

installLifecycleHandlers();
void createComposerDraftAuthSync();
