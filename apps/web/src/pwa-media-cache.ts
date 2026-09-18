export const DERIVED_MEDIA_CACHE_NAME = 'imagine-derived-media-v2';
export const LEGACY_DERIVED_MEDIA_CACHE_NAME = 'imagine-derived-media-v1';

interface DerivedMediaRouteMatch {
  readonly request: Pick<Request, 'headers' | 'method'> & Partial<Pick<Request, 'cache'>>;
  readonly sameOrigin: boolean;
  readonly url: URL;
}

interface DerivedMediaCacheStorage {
  delete(cacheName: string): Promise<boolean>;
}

interface DerivedMediaCache {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  delete(request: Request | string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
}

interface DerivedMediaCacheAccess extends DerivedMediaCacheStorage {
  open(name: string): Promise<DerivedMediaCache>;
  has(name: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
}

interface DerivedMediaFetchSuccess {
  readonly response: Response;
}

interface MediaCacheState { generation?: string | undefined; marker?: string; }

function browserCacheStorage(): DerivedMediaCacheStorage | undefined {
  return (globalThis as typeof globalThis & { readonly caches?: DerivedMediaCacheStorage }).caches;
}

/**
 * Cookie-authenticated media is cacheable within the active browser session.
 * Session changes delete the whole cache; Cookie headers are not observable
 * enough in Service Workers to be an authorization boundary.
 */
export function isDerivedMediaRuntimeRequest({
  request,
  sameOrigin,
  url,
}: DerivedMediaRouteMatch): boolean {
  if (
    !sameOrigin ||
    request.method !== 'GET' ||
    request.cache === 'reload' || request.cache === 'no-store' || request.cache === 'no-cache' ||
    url.search !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  if (
    request.headers.has('authorization') ||
    request.headers.has('proxy-authorization') ||
    request.headers.has('range') || request.headers.has('if-none-match') || request.headers.has('if-modified-since')
  ) {
    return false;
  }
  return /^\/internal\/assets\/[^/]+\/(?:thumbnail|poster)$/u.test(url.pathname);
}

/** Serialized by Workbox, so every runtime dependency stays inside the hook. */
export const DERIVED_MEDIA_AUTH_FAILURE_PLUGIN = {
  requestWillFetch: async ({ request, state }: { request: Request; state?: MediaCacheState }): Promise<Request> => {
    if (!state) return request;
    try {
      const storage = (globalThis as typeof globalThis & { caches?: DerivedMediaCacheAccess }).caches;
      if (!storage) return request;
      state.marker = new URL('/__imagine_media_cache_generation__', request.url).href;
      const scope = globalThis as typeof globalThis & { __imagineMediaCacheGeneration?: Promise<string | undefined> };
      const markerUrl = state.marker;
      const generation = scope.__imagineMediaCacheGeneration ??= (async () => {
        const cache = await storage.open('imagine-derived-media-v2');
        let marker = await cache.match(markerUrl);
        if (!marker) {
          await cache.put(markerUrl, new Response(globalThis.crypto.randomUUID()));
          marker = await cache.match(markerUrl);
        }
        return marker?.text();
      })();
      try { state.generation = await generation; }
      finally {
        if (scope.__imagineMediaCacheGeneration === generation) delete scope.__imagineMediaCacheGeneration;
      }
    } catch { state.generation = undefined; }
    return request;
  },
  cacheWillUpdate: async ({ response, state }: { response: Response; state?: MediaCacheState }): Promise<Response | null> => {
    if (response.status !== 200 || !state?.marker || !state.generation) return null;
    try {
      // A response started before logout must not recreate the cleared cache
      // with data belonging to the previous account.
      const storage = (globalThis as typeof globalThis & { caches?: DerivedMediaCacheAccess }).caches;
      if (!storage || !await storage.has('imagine-derived-media-v2')) return null;
      const cache = await storage.open('imagine-derived-media-v2');
      const marker = await cache.match(state.marker);
      return await marker?.text() === state.generation ? response : null;
    } catch { return null; }
  },
  cacheDidUpdate: async ({ cacheName, request, state }: { cacheName: string; request: Request; state?: MediaCacheState }): Promise<void> => {
    if (!state?.marker || !state.generation) return;
    try {
      const storage = (globalThis as typeof globalThis & { caches?: DerivedMediaCacheAccess }).caches;
      if (!storage || !await storage.has(cacheName)) return;
      const cache = await storage.open(cacheName);
      const marker = await cache.match(state.marker);
      // Deletion may happen between cacheWillUpdate and the asynchronous put.
      if (await marker?.text() !== state.generation) await cache.delete(request);
    } catch { /* Cache cleanup must not prevent displaying a network response. */ }
  },
  fetchDidSucceed: async ({ response }: DerivedMediaFetchSuccess): Promise<Response> => {
    if (response.status === 401) {
      const cacheStorage = (
        globalThis as typeof globalThis & { readonly caches?: DerivedMediaCacheStorage }
      ).caches;
      if (cacheStorage !== undefined) {
        await Promise.allSettled([
          cacheStorage.delete('imagine-derived-media-v2'),
          cacheStorage.delete('imagine-derived-media-v1'),
        ]);
      }
    }
    return response;
  },
};

export function createDerivedMediaRuntimeCaching() {
  return {
    urlPattern: isDerivedMediaRuntimeRequest,
    handler: 'CacheFirst' as const,
    method: 'GET' as const,
    options: {
      cacheName: DERIVED_MEDIA_CACHE_NAME,
      plugins: [DERIVED_MEDIA_AUTH_FAILURE_PLUGIN],
      cacheableResponse: { statuses: [200] },
      expiration: {
        maxAgeSeconds: 7 * 24 * 60 * 60,
        maxEntries: 256,
      },
      fetchOptions: { cache: 'default' as const },
    },
  };
}

export async function clearDerivedMediaRuntimeCache(
  cacheStorage: DerivedMediaCacheStorage | undefined = browserCacheStorage(),
): Promise<boolean> {
  if (cacheStorage === undefined) return false;
  const deleted = await Promise.all([
    cacheStorage.delete(DERIVED_MEDIA_CACHE_NAME),
    cacheStorage.delete(LEGACY_DERIVED_MEDIA_CACHE_NAME),
  ]);
  return deleted.some(Boolean);
}

/** Remove deleted works without discarding the rest of the offline gallery. */
export async function clearDerivedMediaForAssets(assetIds: readonly string[]): Promise<void> {
  const storage = (globalThis as typeof globalThis & { caches?: DerivedMediaCacheAccess }).caches;
  if (!storage || !assetIds.length) return;
  const paths = new Set(assetIds.flatMap(id => ['thumbnail', 'poster'].map(variant => `/internal/assets/${encodeURIComponent(id)}/${variant}`)));
  const names = await storage.keys();
  await Promise.all(names.filter(name => name === DERIVED_MEDIA_CACHE_NAME || name === LEGACY_DERIVED_MEDIA_CACHE_NAME).map(async name => {
    const cache = await storage.open(name);
    const keys = await cache.keys();
    const marker = keys.find(request => new URL(request.url).pathname === '/__imagine_media_cache_generation__');
    if (marker) await cache.delete(marker);
    await Promise.all(keys.filter(request => paths.has(new URL(request.url).pathname)).map(request => cache.delete(request)));
  }));
}
