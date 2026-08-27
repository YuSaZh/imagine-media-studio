import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearDerivedMediaRuntimeCache,
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
    method?: string;
    sameOrigin?: boolean;
  }> = {},
) {
  return {
    request: {
      headers: new Headers(options.headers),
      method: options.method ?? 'GET',
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

  it('builds a no-timeout NetworkFirst entry with a no-store network fetch', () => {
    const runtimeCaching = createDerivedMediaRuntimeCaching();

    expect(runtimeCaching).toMatchObject({
      handler: 'NetworkFirst',
      method: 'GET',
      options: {
        cacheName: DERIVED_MEDIA_CACHE_NAME,
        cacheableResponse: { statuses: [200] },
        fetchOptions: { cache: 'no-store' },
        plugins: [DERIVED_MEDIA_AUTH_FAILURE_PLUGIN],
      },
      urlPattern: isDerivedMediaRuntimeRequest,
    });
    expect(runtimeCaching.options).not.toHaveProperty('networkTimeoutSeconds');
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
