import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAuthenticatedSessionMarker,
  OFFLINE_AUTH_MARKER_KEY,
  OFFLINE_AUTH_MARKER_VERSION,
  parseOfflineAuthMarker,
  isNetworkAvailable,
  rememberAuthenticatedSession,
  markNetworkAvailable,
  type OfflineStorage,
} from '../pwa-offline-snapshot.js';
import { internalClient, InternalApiError } from './internal-client.js';

function memoryStorage(): OfflineStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAuthenticatedSessionMarker();
  markNetworkAvailable();
});

describe('internal authentication bootstrap lifecycle', () => {
  it('clears the marker and both media cache generations after a protected 401', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    rememberAuthenticatedSession(Date.now(), storage);
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'authentication_required' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401,
      }),
    );

    await expect(internalClient.listAssets()).rejects.toEqual(
      new InternalApiError(401, 'authentication_required', 'Internal API request failed with status 401.'),
    );
    expect(storage.getItem(OFFLINE_AUTH_MARKER_KEY)).toBeNull();
    expect(deleteCache).toHaveBeenNthCalledWith(1, 'imagine-derived-media-v2');
    expect(deleteCache).toHaveBeenNthCalledWith(2, 'imagine-derived-media-v1');
  });

  it('clears the marker and media cache around logout', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    rememberAuthenticatedSession(Date.now(), storage);
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(internalClient.logout()).resolves.toBeUndefined();
    expect(storage.getItem(OFFLINE_AUTH_MARKER_KEY)).toBeNull();
    expect(deleteCache).toHaveBeenCalledTimes(4);
  });

  it('clears the old marker/cache before login and stores only a fresh schema marker', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    rememberAuthenticatedSession(Date.now() - 1_000, storage);
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, required: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(internalClient.login('local-password')).resolves.toEqual({
      authenticated: true,
      publicAccessWarning: false,
      required: true,
    });
    const marker = parseOfflineAuthMarker(storage.getItem(OFFLINE_AUTH_MARKER_KEY));
    expect(marker).toMatchObject({ version: OFFLINE_AUTH_MARKER_VERSION });
    expect(Object.keys(JSON.parse(storage.getItem(OFFLINE_AUTH_MARKER_KEY)!)).sort()).toEqual([
      'authenticatedAt',
      'generation',
      'mode',
      'sessionScope',
      'version',
    ]);
    expect(deleteCache).toHaveBeenCalledTimes(4);
  });

  it('blocks writes before fetch while explicitly offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(internalClient.patchSettings({ 'ui.reduce_motion': 'system' })).rejects.toMatchObject({
      name: 'OfflineWriteError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat an aborted fetch as a network outage', async () => {
    const abortError = new DOMException('Request aborted.', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    await expect(internalClient.getAuthStatus()).rejects.toBe(abortError);
    expect(isNetworkAvailable()).toBe(true);
  });
});
