import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { internalClient } from '../../../api/internal-client.js';
import {
  clearAuthenticatedSessionMarker,
  isOfflineBootstrapActive,
  isNetworkAvailable,
  markOfflineBootstrapActive,
  OFFLINE_PUBLIC_BOOTSTRAP_KEY,
  rememberAuthenticatedSession,
} from '../../../pwa-offline-snapshot.js';
import {
  AuthPrompt,
  loadInitialAuthStatus,
  resetInitialStatusRequest,
  resolveInitialAuthStatus,
  subscribeToOnlineAuthRetry,
} from './auth-gate.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAuthenticatedSessionMarker();
  markOfflineBootstrapActive(false);
  resetInitialStatusRequest();
});

describe('AuthGate', () => {
  it('bypasses auth status without an internal request in visual fixture mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(loadInitialAuthStatus(true)).resolves.toEqual({
      authenticated: true,
      required: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown device when explicitly offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const getAuthStatus = vi.spyOn(internalClient, 'getAuthStatus');

    await expect(resolveInitialAuthStatus(false)).rejects.toThrow('unavailable while offline');
    expect(getAuthStatus).not.toHaveBeenCalled();
  });

  it('allows a previously authenticated device to bootstrap while explicitly offline', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: false });
    const getAuthStatus = vi.spyOn(internalClient, 'getAuthStatus');

    await expect(resolveInitialAuthStatus(false)).resolves.toEqual({
      offlineBootstrap: true,
      status: { authenticated: true, required: true },
    });
    expect(getAuthStatus).not.toHaveBeenCalled();
  });

  it('persists a public bootstrap only after an online required=false status', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => { storage.delete(key); },
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      authenticated: false,
      required: false,
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    await expect(resolveInitialAuthStatus(false)).resolves.toEqual({
      offlineBootstrap: false,
      status: { authenticated: false, required: false },
    });
    expect(storage.has(OFFLINE_PUBLIC_BOOTSTRAP_KEY)).toBe(true);

    vi.stubGlobal('navigator', { onLine: false });
    await expect(resolveInitialAuthStatus(false)).resolves.toEqual({
      offlineBootstrap: true,
      status: { authenticated: false, required: false },
    });
  });

  it('does not infer a public deployment before any online status response', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await expect(resolveInitialAuthStatus(false)).rejects.toThrow('unavailable while offline');
  });

  it('does not bootstrap on an auth response or cleanup error disguised as a generic Error', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(internalClient, 'getAuthStatus').mockRejectedValue(new Error('invalid auth response'));

    await expect(resolveInitialAuthStatus(false)).rejects.toThrow('invalid auth response');
    expect(isOfflineBootstrapActive()).toBe(false);
  });

  it('uses the marker after an auth status transport failure and recovers on online', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: true });
    const authStatus = { authenticated: true, required: true };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify(authStatus), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }));

    await expect(resolveInitialAuthStatus(false)).resolves.toMatchObject({ offlineBootstrap: true });
    expect(isOfflineBootstrapActive()).toBe(true);

    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    let recovered: Promise<unknown> | undefined;
    const unsubscribe = subscribeToOnlineAuthRetry(() => {
      recovered = resolveInitialAuthStatus(false);
    });
    windowTarget.dispatchEvent(new Event('online'));
    await expect(recovered).resolves.toMatchObject({
      offlineBootstrap: false,
      status: authStatus,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isNetworkAvailable()).toBe(true);
    expect(isOfflineBootstrapActive()).toBe(false);
    unsubscribe();
  });

  it('renders a compact branded password form with autofocus and errors', () => {
    const markup = renderToStaticMarkup(
      <AuthPrompt
        error="Password is incorrect."
        onPasswordChange={() => undefined}
        onSubmit={() => undefined}
        password=""
        pending={false}
      />,
    );
    expect(markup).toContain('Imagine Media Studio');
    expect(markup).toContain('Protected workspace');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('Password is incorrect.');
    expect(markup).not.toContain('marketing');
  });

  it('disables the login command while a request is pending', () => {
    const markup = renderToStaticMarkup(
      <AuthPrompt
        error={null}
        onPasswordChange={() => undefined}
        onSubmit={() => undefined}
        password="entered-password"
        pending
      />,
    );
    expect(markup).toContain('Unlocking');
    expect(markup).toMatch(/<button[^>]*disabled=""/);
  });
});
