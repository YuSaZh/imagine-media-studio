export const DERIVED_MEDIA_CACHE_NAME = 'imagine-derived-media-v2';
export const LEGACY_DERIVED_MEDIA_CACHE_NAME = 'imagine-derived-media-v1';

interface DerivedMediaRouteMatch {
  readonly request: Pick<Request, 'headers' | 'method'>;
  readonly sameOrigin: boolean;
  readonly url: URL;
}

interface DerivedMediaCacheStorage {
  delete(cacheName: string): Promise<boolean>;
}

interface DerivedMediaFetchSuccess {
  readonly response: Response;
}

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
    url.search !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return false;
  }
  if (
    request.headers.has('authorization') ||
    request.headers.has('proxy-authorization') ||
    request.headers.has('range')
  ) {
    return false;
  }
  return /^\/internal\/assets\/[^/]+\/(?:thumbnail|poster)$/u.test(url.pathname);
}

/** Serialized by Workbox, so every runtime dependency stays inside the hook. */
export const DERIVED_MEDIA_AUTH_FAILURE_PLUGIN = {
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
    handler: 'NetworkFirst' as const,
    method: 'GET' as const,
    options: {
      cacheName: DERIVED_MEDIA_CACHE_NAME,
      plugins: [DERIVED_MEDIA_AUTH_FAILURE_PLUGIN],
      cacheableResponse: { statuses: [200] },
      expiration: {
        maxAgeSeconds: 7 * 24 * 60 * 60,
        maxEntries: 100,
      },
      fetchOptions: { cache: 'no-store' as const },
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
