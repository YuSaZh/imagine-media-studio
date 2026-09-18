import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearDerivedMediaRuntimeCache,
  clearDerivedMediaForAssets,
  createDerivedMediaRuntimeCaching,
  DERIVED_MEDIA_AUTH_FAILURE_PLUGIN,
  DERIVED_MEDIA_CACHE_NAME,
  isDerivedMediaRuntimeRequest,
  LEGACY_DERIVED_MEDIA_CACHE_NAME,
} from './pwa-media-cache.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function candidate(
  path: string,
  options: Readonly<{
    headers?: HeadersInit;
    cache?: RequestCache;
    method?: string;
    sameOrigin?: boolean;
  }> = {},
) {
  return {
    request: {
      headers: new Headers(options.headers),
      method: options.method ?? 'GET',
      ...(options.cache ? { cache: options.cache } : {}),
    },
    sameOrigin: options.sameOrigin ?? true,
    url: new URL(path, 'https://studio.example'),
  };
}

describe('PWA derived media cache policy', () => {
  it('accepts only same-origin GET thumbnails and Posters without sensitive request signals', () => {
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/image-1/thumbnail'))).toBe(true);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster'))).toBe(true);

    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', {
      headers: { Cookie: 'imagine_session=opaque-http-only-value' },
    }))).toBe(true);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', {
      headers: { Authorization: 'Basic opaque' },
    }))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', {
      headers: { 'Proxy-Authorization': 'Basic opaque' },
    }))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', {
      headers: { Range: 'bytes=0-7' },
    }))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster?revision=1'))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('https://user:password@studio.example/internal/assets/video-1/poster'))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', { method: 'POST' }))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/poster', { sameOrigin: false }))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/video-1/content'))).toBe(false);
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/providers/provider-1/models'))).toBe(false);
    for (const cache of ['reload', 'no-store', 'no-cache'] as const) {
      expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/image-1/thumbnail', { cache }))).toBe(false);
    }
    expect(isDerivedMediaRuntimeRequest(candidate('/internal/assets/image-1/thumbnail', { headers: { 'If-None-Match': '"etag"' } }))).toBe(false);
  });

  it('keeps the Workbox callbacks self-contained when generateSW serializes them', () => {
    const matcherSource = isDerivedMediaRuntimeRequest.toString();
    const authFailureSource = DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.fetchDidSucceed.toString();

    expect(matcherSource).toContain('thumbnail|poster');
    expect(matcherSource).not.toContain('DERIVED_MEDIA_');
    expect(authFailureSource).toContain('Promise.allSettled');
    expect(authFailureSource).toContain('imagine-derived-media-v2');
    expect(authFailureSource).toContain('imagine-derived-media-v1');
    expect(authFailureSource).not.toContain('DERIVED_MEDIA_');
  });

  it('reuses bounded cached previews and allows the HTTP cache on misses', () => {
    const runtimeCaching = createDerivedMediaRuntimeCaching();

    expect(runtimeCaching).toMatchObject({
      handler: 'CacheFirst',
      method: 'GET',
      options: {
        cacheName: DERIVED_MEDIA_CACHE_NAME,
        cacheableResponse: { statuses: [200] },
        fetchOptions: { cache: 'default' },
        expiration: { maxEntries: 256, maxAgeSeconds: 604800 },
        plugins: [DERIVED_MEDIA_AUTH_FAILURE_PLUGIN],
      },
      urlPattern: isDerivedMediaRuntimeRequest,
    });
    expect(runtimeCaching.options).not.toHaveProperty('networkTimeoutSeconds');
  });

  it('evicts only the deleted asset previews and leaves app caches untouched', async () => {
    const keys = ['gone/thumbnail', 'gone/poster', 'kept/thumbnail'].map(path => new Request(`https://studio.example/internal/assets/${path}`));
    const deleteEntry = vi.fn().mockResolvedValue(true);
    const open = vi.fn().mockResolvedValue({ keys: async () => keys, delete: deleteEntry });
    vi.stubGlobal('caches', { keys: async () => [DERIVED_MEDIA_CACHE_NAME, 'workbox-precache'], open });
    await clearDerivedMediaForAssets(['gone']);
    expect(open).toHaveBeenCalledExactlyOnceWith(DERIVED_MEDIA_CACHE_NAME);
    expect(deleteEntry.mock.calls.map(([request]) => request.url)).toEqual(keys.slice(0, 2).map(request => request.url));
  });

  it('does not repopulate a new session cache with a response started before logout', async () => {
    let entries = new Map<string, Response>();
    let exists = false;
    vi.stubGlobal('caches', {
      open: async () => { exists = true; return {
        match: async (key: string) => entries.get(key)?.clone(),
        put: async (key: string, value: Response) => { entries.set(key, value); },
      }; },
      has: async () => exists,
      delete: async () => { entries = new Map(); exists = false; return true; },
    });
    const oldState = {}, concurrentState = {}, newState = {};
    const request = new Request('https://studio.example/internal/assets/a/thumbnail');
    const response = new Response('image');
    await Promise.all([
      DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.requestWillFetch({ request, state: oldState }),
      DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.requestWillFetch({ request, state: concurrentState }),
    ]);
    await expect(DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheWillUpdate({ response, state: oldState })).resolves.toBe(response);
    await expect(DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheWillUpdate({ response, state: concurrentState })).resolves.toBe(response);
    await clearDerivedMediaRuntimeCache();
    await DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.requestWillFetch({ request, state: newState });
    await expect(DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheWillUpdate({ response, state: oldState })).resolves.toBeNull();
    await expect(DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheWillUpdate({ response, state: newState })).resolves.toBe(response);
  });

  it('removes a late cache write even when deletion follows write approval', async () => {
    const entries = new Map<string, Response>();
    const key = (request: Request | string) => typeof request === 'string' ? request : request.url;
    const cache = {
      match: async (request: Request | string) => entries.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => { entries.set(key(request), response); },
      delete: async (request: Request | string) => entries.delete(key(request)),
      keys: async () => [...entries.keys()].map(url => new Request(url)),
    };
    vi.stubGlobal('caches', { open: async () => cache, keys: async () => [DERIVED_MEDIA_CACHE_NAME], has: async () => true });
    const request = new Request('https://studio.example/internal/assets/gone/thumbnail');
    const retained = new Request('https://studio.example/internal/assets/kept/thumbnail');
    const state = {}, response = new Response('image');
    await cache.put(retained, response.clone());
    await DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.requestWillFetch({ request, state });
    await expect(DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheWillUpdate({ response, state })).resolves.toBe(response);
    await clearDerivedMediaForAssets(['gone']);
    await cache.put(request, response);
    await DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.cacheDidUpdate({ cacheName: DERIVED_MEDIA_CACHE_NAME, request, state });
    expect(await cache.match(request)).toBeUndefined();
    expect(await cache.match(retained)).toBeDefined();
  });

  it('returns a direct media 401 even when both cache deletions fail', async () => {
    const deleteCache = vi.fn().mockRejectedValue(new Error('cache deletion failed'));
    vi.stubGlobal('caches', { delete: deleteCache });
    const response = new Response(null, { status: 401 });

    await expect(
      DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.fetchDidSucceed({ response }),
    ).resolves.toBe(response);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenNthCalledWith(1, DERIVED_MEDIA_CACHE_NAME);
    expect(deleteCache).toHaveBeenNthCalledWith(2, LEGACY_DERIVED_MEDIA_CACHE_NAME);
  });

  it('does not touch media caches for a successful network response', async () => {
    const deleteCache = vi.fn();
    vi.stubGlobal('caches', { delete: deleteCache });
    const response = new Response('poster', { status: 200 });

    await expect(
      DERIVED_MEDIA_AUTH_FAILURE_PLUGIN.fetchDidSucceed({ response }),
    ).resolves.toBe(response);
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it('deletes v2 and legacy v1 together on an authentication transition', async () => {
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(clearDerivedMediaRuntimeCache({ delete: deleteCache })).resolves.toBe(true);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenNthCalledWith(1, DERIVED_MEDIA_CACHE_NAME);
    expect(deleteCache).toHaveBeenNthCalledWith(2, LEGACY_DERIVED_MEDIA_CACHE_NAME);
    await expect(clearDerivedMediaRuntimeCache(undefined)).resolves.toBe(false);
  });

  it('rejects lifecycle cleanup if either cache cannot be deleted', async () => {
    const cacheFailure = new Error('legacy cache deletion failed');
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(cacheFailure);

    await expect(clearDerivedMediaRuntimeCache({ delete: deleteCache })).rejects.toBe(cacheFailure);
    expect(deleteCache).toHaveBeenCalledTimes(2);
  });
});
