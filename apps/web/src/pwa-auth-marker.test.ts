import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthenticatedSessionMarker,
  clearOfflineMetadataSnapshot,
  clearPublicOfflineBootstrapMarker,
  createOfflineMetadataSnapshot,
  loadOfflineGallerySnapshot,
  offlineMetadataSnapshotByteLength,
  parseOfflineMetadataSnapshot,
  parseOfflinePublicBootstrapMarker,
  rememberPublicOfflineBootstrap,
  hasAuthenticatedSessionMarker,
  OFFLINE_AUTH_MARKER_KEY,
  OFFLINE_AUTH_MARKER_TTL_MS,
  OFFLINE_AUTH_MARKER_VERSION,
  OFFLINE_PUBLIC_BOOTSTRAP_KEY,
  OFFLINE_SNAPSHOT_KEY,
  OFFLINE_SNAPSHOT_MAX_BYTES,
  offlineBootstrapMode,
  parseOfflineAuthMarker,
  rememberAuthenticatedSession,
  subscribeToOfflineSessionChange,
  type OfflineSessionChange,
  type OfflineStorage,
  writeOfflineMetadataSnapshot,
} from './pwa-offline-snapshot.js';

function memoryStorage(initial: Record<string, string> = {}): OfflineStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

class DeferredIdbRequest {
  public result: unknown = undefined;
  public readonly error: Error | null = null;
  public onsuccess: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  public resolve(result: unknown): void {
    this.result = result;
    this.onsuccess?.();
  }
}

class FakeIdbObjectStore {
  public constructor(private readonly database: FakeIndexedDb) {}

  public get(_key: string): DeferredIdbRequest {
    const request = new DeferredIdbRequest();
    this.database.getRequests.push(request);
    return request;
  }

  public put(value: unknown, _key: string): void {
    this.database.value = value;
  }

  public delete(_key: string): DeferredIdbRequest {
    const request = new DeferredIdbRequest();
    this.database.deleteRequests.push(request);
    return request;
  }
}

class FakeIdbTransaction {
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  private readonly objectStoreValue: FakeIdbObjectStore;

  public constructor(database: FakeIndexedDb) {
    this.objectStoreValue = new FakeIdbObjectStore(database);
  }

  public objectStore(_name: string): FakeIdbObjectStore {
    return this.objectStoreValue;
  }

  public complete(): void {
    this.oncomplete?.();
  }
}

class FakeIdbDatabase {
  public created = false;
  public readonly objectStoreNames = {
    contains: (_name: string) => this.created,
  };

  public constructor(private readonly owner: FakeIndexedDb) {}

  public createObjectStore(_name: string): FakeIdbObjectStore {
    this.created = true;
    return new FakeIdbObjectStore(this.owner);
  }

  public transaction(_name: string, _mode: 'readonly' | 'readwrite'): FakeIdbTransaction {
    const transaction = new FakeIdbTransaction(this.owner);
    this.owner.transactions.push(transaction);
    return transaction;
  }

  public close(): void {
    // The fake keeps one in-memory database for the test lifetime.
  }
}

class FakeIdbOpenRequest {
  public readonly result: FakeIdbDatabase;
  public readonly error: Error | null = null;
  public onupgradeneeded: (() => void) | null = null;
  public onsuccess: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  public constructor(database: FakeIdbDatabase) {
    this.result = database;
  }
}

class FakeIndexedDb {
  public readonly getRequests: DeferredIdbRequest[] = [];
  public readonly deleteRequests: DeferredIdbRequest[] = [];
  public readonly transactions: FakeIdbTransaction[] = [];
  public value: unknown = undefined;
  private readonly database = new FakeIdbDatabase(this);

  public open(_name: string, _version?: number): FakeIdbOpenRequest {
    const request = new FakeIdbOpenRequest(this.database);
    queueMicrotask(() => {
      if (!this.database.created) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }

  public resolveGet(): void {
    const request = this.getRequests.shift();
    if (!request) throw new Error('Expected an IndexedDB get request.');
    request.resolve(this.value);
  }

  public resolveDelete(): void {
    const request = this.deleteRequests.shift();
    if (!request) throw new Error('Expected an IndexedDB delete request.');
    this.value = undefined;
    request.resolve(undefined);
  }
}

async function flushMicrotasks(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAuthenticatedSessionMarker();
  clearPublicOfflineBootstrapMarker();
});

describe('offline authentication marker', () => {
  it('accepts only the versioned timestamp schema and rejects identity or secret fields', () => {
    const now = 1_000_000;
    const valid = {
      version: OFFLINE_AUTH_MARKER_VERSION,
      mode: 'authenticated' as const,
      authenticatedAt: now,
      sessionScope: 'scope-auth-1',
      generation: 1,
    };

    expect(parseOfflineAuthMarker(JSON.stringify(valid), now)).toEqual(valid);
    expect(Object.keys(valid).sort()).toEqual(['authenticatedAt', 'generation', 'mode', 'sessionScope', 'version']);
    expect(parseOfflineAuthMarker(JSON.stringify({ ...valid, userId: 'user-1' }), now)).toBeNull();
    expect(parseOfflineAuthMarker(JSON.stringify({ ...valid, secret: 'password' }), now)).toBeNull();
    expect(parseOfflineAuthMarker(JSON.stringify({ ...valid, version: 2 }), now)).toBeNull();
    expect(parseOfflineAuthMarker(JSON.stringify({ ...valid, authenticatedAt: now + 1 }), now)).toBeNull();
    expect(parseOfflineAuthMarker(JSON.stringify({ ...valid, authenticatedAt: now - OFFLINE_AUTH_MARKER_TTL_MS - 1 }), now)).toBeNull();
    expect(parseOfflineAuthMarker('{"version":1', now)).toBeNull();
  });

  it('persists and validates a device-local marker without storing credentials', () => {
    const now = 2_000_000;
    const storage = memoryStorage();

    rememberAuthenticatedSession(now, storage);

    const raw = storage.getItem(OFFLINE_AUTH_MARKER_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({
      version: OFFLINE_AUTH_MARKER_VERSION,
      mode: 'authenticated',
      authenticatedAt: now,
      sessionScope: expect.any(String),
      generation: expect.any(Number),
    });
    expect(hasAuthenticatedSessionMarker(now, storage)).toBe(true);
    expect(hasAuthenticatedSessionMarker(now, memoryStorage())).toBe(false);

    clearAuthenticatedSessionMarker(storage);
    expect(storage.getItem(OFFLINE_AUTH_MARKER_KEY)).toBeNull();
    expect(hasAuthenticatedSessionMarker(now, storage)).toBe(false);
  });

  it('fails closed when marker storage reads throw, even if a volatile marker exists', () => {
    const now = 3_000_000;
    rememberAuthenticatedSession(now);
    const throwingStorage: OfflineStorage = {
      getItem: () => { throw new Error('storage read failed'); },
      removeItem: () => undefined,
      setItem: () => undefined,
    };

    expect(hasAuthenticatedSessionMarker(now, throwingStorage)).toBe(false);
    expect(hasAuthenticatedSessionMarker(now)).toBe(true);

    rememberAuthenticatedSession(now, throwingStorage);
    expect(hasAuthenticatedSessionMarker(now, throwingStorage)).toBe(false);
  });

  it('keeps public bootstrap distinct from an authenticated marker', () => {
    const now = 4_000_000;
    const storage = memoryStorage();

    rememberPublicOfflineBootstrap(now, storage);

    expect(JSON.parse(storage.getItem(OFFLINE_PUBLIC_BOOTSTRAP_KEY)!)).toMatchObject({
      version: 1,
      mode: 'public',
      bootstrappedAt: now,
      sessionScope: expect.any(String),
      generation: expect.any(Number),
    });
    expect(parseOfflinePublicBootstrapMarker(storage.getItem(OFFLINE_PUBLIC_BOOTSTRAP_KEY), now)).toMatchObject({
      version: 1,
      mode: 'public',
      bootstrappedAt: now,
      sessionScope: expect.any(String),
      generation: expect.any(Number),
    });
    expect(hasAuthenticatedSessionMarker(now, storage)).toBe(false);
    clearAuthenticatedSessionMarker(storage);
    expect(storage.getItem(OFFLINE_PUBLIC_BOOTSTRAP_KEY)).not.toBeNull();
  });

  it('fails closed across marker write failures instead of retaining the other volatile mode', async () => {
    const now = 4_500_000;
    const failingStorage: OfflineStorage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => { throw new Error('storage write failed'); },
    };

    rememberAuthenticatedSession(now);
    rememberPublicOfflineBootstrap(now, failingStorage);
    expect(offlineBootstrapMode(now)).toBeNull();

    rememberPublicOfflineBootstrap(now);
    rememberAuthenticatedSession(now, failingStorage);
    expect(offlineBootstrapMode(now)).toBeNull();

    vi.stubGlobal('localStorage', undefined);
    rememberAuthenticatedSession(now);
    await writeOfflineMetadataSnapshot(createOfflineMetadataSnapshot([], now));
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage read failed'); },
      removeItem: () => undefined,
      setItem: () => undefined,
    } satisfies OfflineStorage);
    await expect(loadOfflineGallerySnapshot(now)).resolves.toBeNull();
  });

  it('synchronizes a remote session boundary, clears old snapshot state, and does not echo it', async () => {
    const storage = memoryStorage({
      [OFFLINE_SNAPSHOT_KEY]: JSON.stringify({
        version: 1,
        savedAt: 4_000_000,
        sequence: 1,
        items: [],
        jobs: [],
      }),
    });
    vi.stubGlobal('localStorage', storage);
    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);

    class FakeBroadcastChannel {
      static readonly instances: FakeBroadcastChannel[] = [];
      readonly listeners = new Set<(event: { readonly data: unknown }) => void>();

      public constructor(_name: string) {
        FakeBroadcastChannel.instances.push(this);
      }

      public postMessage(message: unknown): void {
        for (const instance of FakeBroadcastChannel.instances) {
          if (instance === this) continue;
          for (const listener of instance.listeners) listener({ data: message });
        }
      }

      public addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
        this.listeners.add(listener);
      }

      public removeEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
        this.listeners.delete(listener);
      }

      public close(): void {
        // Test transport has no lifecycle beyond the realm.
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);

    const changes: OfflineSessionChange[] = [];
    const unsubscribe = subscribeToOfflineSessionChange((change) => changes.push(change));
    rememberAuthenticatedSession(4_000_000, storage);
    const remote = new FakeBroadcastChannel('imagine-media-studio-session-v1');
    remote.postMessage({
      version: 1,
      change: 'logout',
      source: 'other-realm',
      nonce: 'remote-logout',
      sessionScope: null,
      mode: null,
      generation: 99,
    });

    await vi.waitFor(() => expect(changes).toEqual(['logout']));
    expect(storage.getItem(OFFLINE_AUTH_MARKER_KEY)).toBeNull();
    await expect(loadOfflineGallerySnapshot(4_000_000)).resolves.toBeNull();

    const localBroadcast = FakeBroadcastChannel.instances[0];
    expect(localBroadcast).toBeDefined();
    unsubscribe();
  });

  it('uses a monotonic sequence and rejects oversized serialized snapshots', async () => {
    const raceStorage = memoryStorage();
    vi.stubGlobal('localStorage', raceStorage);
    rememberAuthenticatedSession(Date.now(), raceStorage);
    const first = createOfflineMetadataSnapshot([], Date.now());
    const second = createOfflineMetadataSnapshot([], first.savedAt);
    expect(second.savedAt).toBeGreaterThanOrEqual(first.savedAt);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(offlineMetadataSnapshotByteLength(first)).toBeLessThanOrEqual(OFFLINE_SNAPSHOT_MAX_BYTES);

    await writeOfflineMetadataSnapshot(second);
    await writeOfflineMetadataSnapshot(first);
    expect(JSON.parse(raceStorage.getItem(OFFLINE_SNAPSHOT_KEY)!)).toMatchObject({
      savedAt: second.savedAt,
      sequence: second.sequence,
    });

    const oversized = {
      ...second,
      items: [],
      jobs: [],
    };
    const oversizedItem = {
      id: 'asset-1',
      jobId: 'job-1',
      kind: 'image' as const,
      prompt: 'x'.repeat(4096),
      alt: 'x',
      createdAt: new Date().toISOString(),
      status: 'completed' as const,
      stage: 'Ready',
      progress: null,
      error: null,
      saved: false,
      folderIds: [],
      providerId: 'provider',
      modelId: 'model',
      width: 1,
      height: 1,
      aspectRatio: '1:1',
      referenceCount: 0,
      batchCount: 1,
      previewPath: '/icons/app-icon-512.png',
      sourcePath: null,
      posterPath: null,
      durationSeconds: null,
      persistedAsset: false,
    };
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const veryLarge = {
      ...oversized,
      items: Array.from({ length: 100 }, (_, index) => ({ ...oversizedItem, id: `asset-${index}` })),
      jobs: Array.from({ length: 100 }, (_, index) => ({
        id: `job-${index}`,
        prompt: 'x'.repeat(4096),
        status: 'completed' as const,
        stage: 'Ready',
        progress: null,
        error: null,
        providerId: 'provider',
        modelId: 'model',
        outputCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    };
    expect(offlineMetadataSnapshotByteLength(veryLarge)).toBeGreaterThan(OFFLINE_SNAPSHOT_MAX_BYTES);
    await expect(writeOfflineMetadataSnapshot(veryLarge)).rejects.toThrow('byte limit');
    expect(storage.getItem(OFFLINE_SNAPSHOT_KEY)).toBeNull();
  });

  it('rejects URL-shaped or credential-like Provider and model IDs in items and jobs', () => {
    const now = 7_000_000;
    const snapshot = {
      version: 1 as const,
      savedAt: now,
      sequence: 1,
      sessionScope: 'scope-ids',
      mode: 'authenticated' as const,
      generation: 1,
      items: [{
        id: 'asset-1',
        jobId: 'job-1',
        kind: 'image' as const,
        prompt: 'prompt',
        alt: 'Generated image',
        createdAt: new Date(now).toISOString(),
        status: 'completed' as const,
        stage: 'Ready',
        progress: null,
        error: null,
        saved: false,
        folderIds: [],
        providerId: 'provider-1',
        modelId: 'model-1',
        width: 1,
        height: 1,
        aspectRatio: '1:1',
        referenceCount: 0,
        batchCount: 1,
        previewPath: '/icons/app-icon-512.png',
        sourcePath: null,
        posterPath: null,
        durationSeconds: null,
        persistedAsset: false,
      }],
      jobs: [{
        id: 'job-1',
        prompt: 'prompt',
        status: 'completed' as const,
        stage: 'Ready',
        progress: null,
        error: null,
        providerId: 'provider-1',
        modelId: 'model-1',
        outputCount: 1,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      }],
    };
    const unsafeIds = [
      'https://provider.example/models',
      'user:password@example',
      'model-1?version=2',
    ];

    for (const unsafeId of unsafeIds) {
      expect(parseOfflineMetadataSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], providerId: unsafeId }],
      })).toBeNull();
      expect(parseOfflineMetadataSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], modelId: unsafeId }],
      })).toBeNull();
      expect(parseOfflineMetadataSnapshot({
        ...snapshot,
        jobs: [{ ...snapshot.jobs[0], providerId: unsafeId }],
      })).toBeNull();
      expect(parseOfflineMetadataSnapshot({
        ...snapshot,
        jobs: [{ ...snapshot.jobs[0], modelId: unsafeId }],
      })).toBeNull();
    }
  });

  it('invalidates in-flight snapshot reads and writes when clear advances the epoch', async () => {
    const indexedDb = new FakeIndexedDb();
    const now = Date.now();
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('indexedDB', indexedDb as unknown as IDBFactory);
    rememberAuthenticatedSession(now);
    const snapshot = createOfflineMetadataSnapshot([], now);

    const writePromise = writeOfflineMetadataSnapshot(snapshot);
    await flushMicrotasks();
    expect(indexedDb.getRequests).toHaveLength(1);

    const clearAfterWrite = clearOfflineMetadataSnapshot();
    await flushMicrotasks();
    expect(indexedDb.deleteRequests).toHaveLength(1);
    indexedDb.resolveGet();
    indexedDb.resolveDelete();
    indexedDb.transactions[0]?.complete();
    indexedDb.transactions[1]?.complete();
    await expect(writePromise).resolves.toBeUndefined();
    await expect(clearAfterWrite).resolves.toBe(true);
    expect(indexedDb.value).toBeUndefined();

    indexedDb.value = snapshot;
    const readPromise = loadOfflineGallerySnapshot(now);
    await flushMicrotasks();
    expect(indexedDb.getRequests).toHaveLength(1);

    const clearAfterRead = clearOfflineMetadataSnapshot();
    await flushMicrotasks();
    expect(indexedDb.deleteRequests).toHaveLength(1);
    indexedDb.resolveGet();
    indexedDb.resolveDelete();
    indexedDb.transactions[2]?.complete();
    indexedDb.transactions[3]?.complete();
    await expect(readPromise).resolves.toBeNull();
    await expect(clearAfterRead).resolves.toBe(true);
    expect(indexedDb.value).toBeUndefined();
  });
});
