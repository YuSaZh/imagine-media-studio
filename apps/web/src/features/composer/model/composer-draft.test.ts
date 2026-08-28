import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  COMPOSER_DRAFT_AUTH_SIGNAL_VERSION,
  COMPOSER_DRAFT_AUTH_STORAGE_KEY,
  COMPOSER_DRAFT_MAX_PROMPT_LENGTH,
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_VERSION,
  clearComposerDrafts,
  clearStoredComposerDraft,
  createComposerDraftAuthSync,
  createComposerDraftPersistence,
  flushPromptDraft,
  parseComposerDraft,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraftBroadcastChannel,
  type ComposerDraftStorageEventTarget,
  type ComposerDraftStorage,
} from './composer-draft.js';

function createStorage(): ComposerDraftStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function createStorageEventTarget(): ComposerDraftStorageEventTarget & {
  dispatch: (event: { readonly key: string | null; readonly newValue: string | null }) => void;
} {
  const listeners = new Set<(event: { readonly key: string | null; readonly newValue: string | null }) => void>();
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    dispatch: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

function createBroadcastChannel(): ComposerDraftBroadcastChannel & {
  readonly posted: unknown[];
  emit: (message: unknown) => void;
} {
  let listener: ((event: { readonly data: unknown }) => void) | undefined;
  const posted: unknown[] = [];
  return {
    posted,
    addEventListener: (_type, nextListener) => {
      listener = nextListener;
    },
    removeEventListener: (_type, nextListener) => {
      if (listener === nextListener) listener = undefined;
    },
    postMessage: (message) => posted.push(message),
    emit: (message) => listener?.({ data: message }),
    close: () => {
      listener = undefined;
    },
  };
}

afterEach(() => {
  clearComposerDrafts();
  vi.useRealTimers();
});

describe('Composer prompt draft persistence', () => {
  it('stores only the versioned prompt after the debounce window', () => {
    vi.useFakeTimers();
    const storage = createStorage();
    const persistence = createComposerDraftPersistence({ storage });

    persistence.schedule({
      prompt: '  a plain text prompt  ',
      mode: 'video',
      modelId: 'secret-model-that-must-not-persist',
      inputs: [{ assetId: 'asset-1', role: 'reference' }],
    });
    expect(storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)).toBeUndefined();

    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS - 1);
    expect(storage.values.get(COMPOSER_DRAFT_STORAGE_KEY)).toBeUndefined();
    vi.advanceTimersByTime(1);

    expect(JSON.parse(storage.values.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '')).toEqual({
      version: COMPOSER_DRAFT_VERSION,
      draft: { prompt: '  a plain text prompt  ' },
    });
    persistence.dispose();
  });

  it('flushes synchronously and clear cancels a pending write', () => {
    vi.useFakeTimers();
    const storage = createStorage();
    const persistence = createComposerDraftPersistence({ storage });

    persistence.schedule('before update');
    flushPromptDraft();
    expect(readComposerDraft(storage)).toEqual({ prompt: 'before update' });

    persistence.schedule('must not survive clear');
    clearComposerDrafts();
    vi.runAllTimers();
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
    persistence.dispose();
  });

  it('hydrates valid text, rejects invalid versions, and removes corrupt storage', () => {
    const storage = createStorage();
    expect(writeComposerDraft('reload me', storage)).toBe(true);
    expect(readComposerDraft(storage)).toEqual({ prompt: 'reload me' });

    storage.values.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: COMPOSER_DRAFT_VERSION + 1, draft: { prompt: 'old' } }),
    );
    expect(readComposerDraft(storage)).toBeNull();
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);

    storage.values.set(COMPOSER_DRAFT_STORAGE_KEY, '{broken');
    expect(readComposerDraft(storage)).toBeNull();
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it('enforces the prompt length limit without truncating user text', () => {
    const storage = createStorage();
    const tooLong = 'x'.repeat(COMPOSER_DRAFT_MAX_PROMPT_LENGTH + 1);

    expect(parseComposerDraft({
      version: COMPOSER_DRAFT_VERSION,
      draft: { prompt: tooLong },
    })).toBeNull();
    expect(writeComposerDraft(tooLong, storage)).toBe(false);
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
  });

  it('removes an empty prompt from storage', () => {
    const storage = createStorage();
    expect(writeComposerDraft('present', storage)).toBe(true);
    clearStoredComposerDraft(storage);
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
    expect(writeComposerDraft('', storage)).toBe(true);
  });

  it('flushes a pending prompt on dispose without losing it to a deferred timer', () => {
    vi.useFakeTimers();
    const storage = createStorage();
    const persistence = createComposerDraftPersistence({ storage });

    persistence.schedule('keep during unmount');
    persistence.dispose();
    vi.runAllTimers();

    expect(readComposerDraft(storage)).toEqual({ prompt: 'keep during unmount' });
  });

  it('invalidates old-tab persistence on a remote storage signal and ignores the channel echo', () => {
    vi.useFakeTimers();
    const storage = createStorage();
    const events = createStorageEventTarget();
    const channel = createBroadcastChannel();
    const sync = createComposerDraftAuthSync({
      eventTarget: events,
      storage,
      broadcastChannel: channel,
      sourceId: 'tab-a',
    });
    const persistence = createComposerDraftPersistence({ storage });
    persistence.schedule('stale prompt');

    const signal = {
      version: COMPOSER_DRAFT_AUTH_SIGNAL_VERSION,
      id: 'auth-event-1',
      source: 'tab-b',
    };
    events.dispatch({
      key: COMPOSER_DRAFT_AUTH_STORAGE_KEY,
      newValue: JSON.stringify(signal),
    });
    channel.emit(signal);
    vi.runAllTimers();

    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
    persistence.schedule('old tab must stay invalidated');
    persistence.flush();
    expect(storage.values.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false);
    expect(channel.posted).toHaveLength(0);
    sync.dispose();
  });

  it('publishes an opaque auth signal through storage and BroadcastChannel without echoing it', () => {
    const storage = createStorage();
    const events = createStorageEventTarget();
    const channel = createBroadcastChannel();
    const sync = createComposerDraftAuthSync({
      eventTarget: events,
      storage,
      broadcastChannel: channel,
      sourceId: 'tab-a',
    });

    sync.notify();
    const [message] = channel.posted;
    expect(message).toMatchObject({
      version: COMPOSER_DRAFT_AUTH_SIGNAL_VERSION,
      source: 'tab-a',
    });
    expect(message).not.toHaveProperty('prompt');
    expect(storage.values.has(COMPOSER_DRAFT_AUTH_STORAGE_KEY)).toBe(false);

    channel.emit(message);
    expect(channel.posted).toHaveLength(1);
    sync.dispose();
  });
});
