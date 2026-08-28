import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomAdapterRefSchema, TrustedAdapterManifestSchema } from '@imagine/shared';

import {
  internalClient,
  InternalApiError,
  subscribeToAuthRequired,
  subscribeToAuthSessionChanged,
} from './internal-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('internalClient', () => {
  it('publishes payload-free auth-required events for protected 401 responses only', async () => {
    const listener = vi.fn();
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    const unsubscribe = subscribeToAuthRequired(listener);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: 'authentication_required', message: 'sensitive response detail' }),
        { headers: { 'Content-Type': 'application/json' }, status: 401 },
      ),
    );

    try {
      await expect(internalClient.listAssets()).rejects.toBeInstanceOf(InternalApiError);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith();
      expect(deleteCache).toHaveBeenCalledTimes(2);
      expect(deleteCache).toHaveBeenNthCalledWith(1, 'imagine-derived-media-v2');
      expect(deleteCache).toHaveBeenNthCalledWith(2, 'imagine-derived-media-v1');

      listener.mockClear();
      await expect(internalClient.getAuthStatus()).rejects.toBeInstanceOf(InternalApiError);
      await expect(internalClient.login('wrong-password')).rejects.toBeInstanceOf(InternalApiError);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('checks status, logs in with same-origin credentials, and logs out', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: false, required: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, required: true }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(internalClient.getAuthStatus()).resolves.toEqual({
      authenticated: false,
      publicAccessWarning: false,
      required: true,
    });
    await expect(internalClient.login('local-password')).resolves.toEqual({
      authenticated: true,
      publicAccessWarning: false,
      required: true,
    });
    await expect(internalClient.logout()).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]).toEqual([
      '/internal/auth/status',
      expect.objectContaining({ credentials: 'same-origin' }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/internal/auth/login',
      expect.objectContaining({
        body: JSON.stringify({ password: 'local-password' }),
        credentials: 'same-origin',
        method: 'POST',
      }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      '/internal/auth/logout',
      expect.objectContaining({ credentials: 'same-origin', method: 'POST' }),
    ]);
    expect(deleteCache).toHaveBeenCalledTimes(10);
    for (let index = 0; index < 10; index += 2) {
      expect(deleteCache).toHaveBeenNthCalledWith(index + 1, 'imagine-derived-media-v2');
      expect(deleteCache).toHaveBeenNthCalledWith(index + 2, 'imagine-derived-media-v1');
    }
  });

  it('calls the maintenance integrity and database-only backup endpoints with empty inputs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        integrity: {
          foreignKeyCheck: { ok: true, truncated: false, violationCount: 0 },
          foreignKeysEnabled: true,
          integrityCheck: { errorCount: 0, ok: true, truncated: false },
          ok: true,
        },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        backup: {
          createdAt: '2026-08-29T00:00:00.000Z',
          id: 'backup-client-test',
          sha256: 'a'.repeat(64),
          size: 8192,
        },
      }), { headers: { 'Content-Type': 'application/json' }, status: 201 }));

    await expect(internalClient.getDatabaseIntegrity()).resolves.toMatchObject({
      integrity: { ok: true, foreignKeysEnabled: true },
    });
    await expect(internalClient.createDatabaseBackup()).resolves.toMatchObject({
      backup: { id: 'backup-client-test', size: 8192 },
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      '/internal/maintenance/integrity',
      expect.objectContaining({ credentials: 'same-origin' }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/internal/maintenance/backups',
      expect.objectContaining({ credentials: 'same-origin', method: 'POST' }),
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty('body');
  });

  it('fans remote login and logout boundaries out to auth/query observers', async () => {
    const storageValues = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => { storageValues.delete(key); },
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
    });
    vi.stubGlobal('window', new EventTarget());
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
        // No-op test transport.
      }
    }
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);

    const authRequired = vi.fn();
    const sessionChanged = vi.fn();
    const unsubscribeRequired = subscribeToAuthRequired(authRequired);
    const unsubscribeSession = subscribeToAuthSessionChanged(sessionChanged);
    const remote = new FakeBroadcastChannel('imagine-media-studio-session-v1');
    remote.postMessage({
      version: 1,
      change: 'login',
      source: 'remote',
      nonce: 'login-1',
      sessionScope: 'remote-session',
      mode: 'authenticated',
      generation: 2,
    });
    await vi.waitFor(() => expect(authRequired).toHaveBeenCalledWith('login'));
    expect(sessionChanged).toHaveBeenCalledWith('login');

    remote.postMessage({
      version: 1,
      change: 'logout',
      source: 'remote',
      nonce: 'logout-1',
      sessionScope: null,
      mode: null,
      generation: 3,
    });
    await vi.waitFor(() => expect(authRequired).toHaveBeenCalledTimes(2));
    expect(authRequired).toHaveBeenLastCalledWith();
    expect(sessionChanged).toHaveBeenCalledWith('logout');
    unsubscribeRequired();
    unsubscribeSession();
  });

  it('preserves derived media while the existing cookie session remains authenticated', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('caches', { delete: deleteCache });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, required: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(internalClient.getAuthStatus()).resolves.toEqual({
      authenticated: true,
      publicAccessWarning: false,
      required: true,
    });
    expect(deleteCache).not.toHaveBeenCalled();
  });

  it('does not change the server session when the old media cache cannot be cleared', async () => {
    const cacheFailure = new Error('cache storage unavailable');
    vi.stubGlobal('caches', { delete: vi.fn().mockRejectedValue(cacheFailure) });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(internalClient.login('local-password')).rejects.toBe(cacheFailure);
    await expect(internalClient.logout()).rejects.toBe(cacheFailure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failed post-login cleanup after the server creates the session', async () => {
    const postLoginFailure = new Error('post-login cache cleanup failed');
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(postLoginFailure)
      .mockResolvedValueOnce(false);
    vi.stubGlobal('caches', { delete: deleteCache });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: true, required: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(internalClient.login('local-password')).rejects.toBe(postLoginFailure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledTimes(4);
  });

  it('reports a failed post-logout cleanup after the server clears the session', async () => {
    const postLogoutFailure = new Error('post-logout cache cleanup failed');
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(postLogoutFailure)
      .mockResolvedValueOnce(false);
    vi.stubGlobal('caches', { delete: deleteCache });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await expect(internalClient.logout()).rejects.toBe(postLogoutFailure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledTimes(4);
  });

  it('keeps the protected 401 and publishes auth-required if cleanup fails', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToAuthRequired(listener);
    vi.stubGlobal('caches', { delete: vi.fn().mockRejectedValue(new Error('cache failure')) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'authentication_required' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 401,
      }),
    );

    try {
      await expect(internalClient.listAssets()).rejects.toMatchObject({ status: 401 });
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it('fails closed when unauthenticated status cannot clear prior-session media', async () => {
    const cacheFailure = new Error('status cache cleanup failed');
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(cacheFailure);
    vi.stubGlobal('caches', { delete: deleteCache });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ authenticated: false, required: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(internalClient.getAuthStatus()).rejects.toBe(cacheFailure);
    expect(deleteCache).toHaveBeenCalledTimes(2);
  });

  it('encodes query parameters and parses strict responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await expect(internalClient.listAssets({ favorite: true, limit: 25 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/internal/assets?favorite=true&limit=25',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('turns structured non-2xx responses into typed errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'asset_not_found', message: 'Missing asset.' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 404,
      }),
    );

    await expect(internalClient.getAsset('missing')).rejects.toEqual(
      new InternalApiError(404, 'asset_not_found', 'Missing asset.'),
    );
  });

  it('never adds a JSON content type to multipart uploads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          asset: {
            id: 'asset-1',
            jobId: null,
            parentAssetId: null,
            type: 'image',
            role: 'upload',
            contentUrl: '/internal/assets/asset-1/content',
            thumbnailUrl: null,
            posterUrl: null,
            originalFilename: 'fixture.png',
            mimeType: 'image/png',
            width: 1,
            height: 1,
            durationMs: null,
            fileSize: 1,
            sha256: 'a'.repeat(64),
            metadata: {},
            favorite: false,
            collectionIds: [],
            createdAt: '2026-08-25T00:00:00.000Z',
          },
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 201 },
      ),
    );

    const controller = new AbortController();
    await internalClient.uploadAsset(
      new File(['x'], 'fixture.png', { type: 'image/png' }),
      { parentAssetId: 'parent-asset', role: 'reference' },
      { signal: controller.signal },
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const headers = request?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).has('Content-Type')).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    expect(request?.signal).toBe(controller.signal);
    const body = request?.body as FormData;
    expect([...body.keys()]).toEqual(['parentAssetId', 'role', 'file']);
    expect(body.get('parentAssetId')).toBe('parent-asset');
    expect(body.get('role')).toBe('reference');
    expect(body.get('file')).toBeInstanceOf(File);
  });

  it('validates and sends manual model CRUD requests through the internal API', async () => {
    const model = {
      id: 'model-1',
      providerId: 'provider-1',
      modelId: 'image-v1',
      displayName: 'Image v1',
      capabilities: { operations: ['image.generate'] },
      capabilitySource: 'manual',
      enabled: true,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ model }), {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(internalClient.createModel({
      providerId: 'provider-1',
      modelId: 'image-v1',
      displayName: 'Image v1',
      capabilities: { operations: ['image.generate'] },
    })).resolves.toMatchObject({ model: { modelId: 'image-v1' } });
    await expect(internalClient.patchModel('model-1', { enabled: false })).resolves.toMatchObject({
      model: { id: 'model-1' },
    });
    await expect(internalClient.deleteModel('model-1')).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/internal/models');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      providerId: 'provider-1',
      capabilities: { operations: ['image.generate'] },
      enabled: true,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/internal/models/model-1');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/internal/models/model-1');
  });

  it('manages trusted adapters without exposing source in the response or query cache contract', async () => {
    const manifest = TrustedAdapterManifestSchema.parse({
      schemaVersion: 1,
      id: 'trusted-fixture',
      version: '1.0.0',
      displayName: 'Trusted Fixture',
      sha256: 'c'.repeat(64),
      operations: ['image.generate'],
      capabilities: {
        providerType: 'custom-js-v1',
        models: [{
          id: 'fixture-image',
          displayName: 'Fixture Image',
          capabilities: { operations: ['image.generate'] },
        }],
      },
      allowedHosts: ['api.example.invalid'],
      requiredSecrets: [],
      resourceLimits: {
        timeoutMs: 30_000,
        maxMessageBytes: 1_048_576,
        maxOutputBytes: 1_048_576,
        maxLogBytes: 262_144,
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    const ref = {
      kind: 'trusted-javascript' as const,
      adapterId: manifest.id,
      version: manifest.version,
      digest: manifest.sha256,
    };
    const trustedResponse = JSON.stringify({
      adapter: {
        manifest,
        ref,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      },
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [JSON.parse(trustedResponse).adapter] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(trustedResponse, {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(trustedResponse, {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }))
      .mockResolvedValueOnce(new Response(trustedResponse, {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const controller = new AbortController();
    const source = new File(['export function capabilities() {}'], 'adapter.mjs', { type: 'text/javascript' });

    await expect(internalClient.listTrustedAdapters()).resolves.toMatchObject({ items: [{ ref }] });
    await expect(internalClient.getTrustedAdapter(ref.adapterId)).resolves.toMatchObject({ adapter: { ref } });
    await expect(internalClient.installTrustedAdapter({ manifest, source, providerId: 'provider-1' }, { signal: controller.signal })).resolves.toMatchObject({ adapter: { ref } });
    await expect(internalClient.bindTrustedAdapter({ providerId: 'provider-1', ref })).resolves.toMatchObject({ adapter: { ref } });
    await expect(internalClient.removeTrustedAdapter(ref.adapterId)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/internal/adapters');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/internal/adapters/trusted-fixture');
    const installRequest = fetchMock.mock.calls[2]?.[1];
    expect(installRequest?.body).toBeInstanceOf(FormData);
    expect(installRequest?.signal).toBe(controller.signal);
    expect((installRequest?.headers as Headers).has('Content-Type')).toBe(false);
    const installBody = installRequest?.body as FormData;
    expect([...installBody.keys()]).toEqual(['manifest', 'source', 'providerId']);
    expect(installBody.get('manifest')).toBe(JSON.stringify(manifest));
    expect(installBody.get('source')).toBeInstanceOf(File);
    expect(installBody.get('providerId')).toBe('provider-1');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/internal/providers/provider-1/adapter/trusted-javascript');
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ ref });
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/internal/adapters/trusted-fixture');
  });

  it('uses exact custom revision queries, raw export metadata, and raw JSON/YAML PUT bodies', async () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-adapter',
      version: '2.0.0',
      digest: 'd'.repeat(64),
    };
    const definition = {
      providerId: 'provider/1',
      ref,
      definition: { id: ref.adapterId },
      isCurrent: true,
      disabled: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const envelope = { schemaVersion: 1 as const, version: ref.version, definition: { id: ref.adapterId } };
    const page = JSON.stringify({ items: [definition], nextCursor: null });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ definition }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(page, {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response('schemaVersion: 1\nversion: 2.0.0\ndefinition: {}\n', {
        headers: {
          'Content-Type': 'application/yaml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="adapter-custom-adapter-2.0.0.yaml"',
        },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ definition }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ definition }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ definition }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ definition }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }));
    const signal = new AbortController().signal;

    await expect(internalClient.getCustomAdapter('provider/1')).resolves.toMatchObject({ definition });
    await expect(internalClient.listCustomAdapterRevisions('provider/1', { ref, limit: 10, cursor: 'opaque cursor' })).resolves.toMatchObject({ items: [definition] });
    await expect(internalClient.exportCustomAdapter('provider/1', { ref, format: 'yaml' }, { signal })).resolves.toEqual({
      text: 'schemaVersion: 1\nversion: 2.0.0\ndefinition: {}\n',
      content: 'schemaVersion: 1\nversion: 2.0.0\ndefinition: {}\n',
      filename: 'adapter-custom-adapter-2.0.0.yaml',
      contentType: 'application/yaml; charset=utf-8',
    });
    await expect(internalClient.putCustomAdapter('provider/1', { document: envelope, format: 'json' })).resolves.toMatchObject({ definition });
    await expect(internalClient.putCustomAdapter('provider/1', {
      document: 'schemaVersion: 1\nversion: 2.0.0\ndefinition: {}\n',
      format: 'yaml',
      version: '2.0.0',
    })).resolves.toMatchObject({ definition });
    await expect(internalClient.putCustomAdapter('provider/1', {
      document: { id: ref.adapterId },
      format: 'json',
      version: '3.0.0',
    })).resolves.toMatchObject({ definition });
    await expect(internalClient.putCustomAdapter('provider/1', {
      document: JSON.stringify({ id: ref.adapterId }),
      format: 'json',
      version: '4.0.0',
    })).resolves.toMatchObject({ definition });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/internal/providers/provider%2F1/adapter');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/internal/providers/provider%2F1/adapter/revisions?kind=declarative-http&adapterId=custom-adapter&version=2.0.0&digest=${ref.digest}&limit=10&cursor=opaque+cursor`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/internal/providers/provider%2F1/adapter/export?kind=declarative-http&adapterId=custom-adapter&version=2.0.0&digest=${ref.digest}&format=yaml`);
    expect(fetchMock.mock.calls[2]?.[1]?.signal).toBe(signal);
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get('Content-Type')).toBe('application/json');
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(JSON.stringify(envelope));
    expect(new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get('Content-Type')).toBe('application/yaml; charset=utf-8');
    expect(fetchMock.mock.calls[4]?.[0]).toBe('/internal/providers/provider%2F1/adapter?version=2.0.0');
    expect(fetchMock.mock.calls[4]?.[1]?.body).toBe('schemaVersion: 1\nversion: 2.0.0\ndefinition: {}\n');
    expect(new Headers(fetchMock.mock.calls[5]?.[1]?.headers).get('Content-Type')).toBe('application/json');
    expect(fetchMock.mock.calls[5]?.[0]).toBe('/internal/providers/provider%2F1/adapter?version=3.0.0');
    expect(fetchMock.mock.calls[5]?.[1]?.body).toBe(JSON.stringify({ id: ref.adapterId }));
    expect(fetchMock.mock.calls[6]?.[0]).toBe('/internal/providers/provider%2F1/adapter?version=4.0.0');
    expect(fetchMock.mock.calls[6]?.[1]?.body).toBe(JSON.stringify({ id: ref.adapterId }));
  });

  it('requires bounded versions for raw documents and recognizes only strict YAML envelopes', async () => {
    const responseBody = JSON.stringify({ definition: {
        providerId: 'provider-1',
        ref: { kind: 'declarative-http', adapterId: 'raw', version: '1.0.0', digest: 'a'.repeat(64) },
        definition: { id: 'raw' },
        isCurrent: true,
        disabled: false,
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(responseBody, { headers: { 'Content-Type': 'application/json' }, status: 200 }),
    );
    const envelope = { schemaVersion: 1 as const, version: '1.0.0', definition: { id: 'raw' } };
    const exportedYaml = 'schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  id: raw\n';
    await expect(internalClient.putCustomAdapter('provider-1', envelope)).resolves.toBeTruthy();
    await expect(internalClient.putCustomAdapter('provider-1', { id: 'raw' })).rejects.toThrow('version');
    await expect(internalClient.putCustomAdapter('provider-1', '{"id":"raw"}', 'json')).rejects.toThrow('version');
    await expect(internalClient.putCustomAdapter('provider-1', exportedYaml, 'yaml')).resolves.toBeTruthy();
    await expect(internalClient.putCustomAdapter('provider-1', 'id: raw\n', 'yaml')).rejects.toThrow('version');
    const signal = new AbortController().signal;
    await expect(internalClient.putCustomAdapter(
      'provider-1',
      'id: raw\n',
      { format: 'yaml', version: '2.0.0' },
      { signal },
    )).resolves.toBeTruthy();
    await expect(internalClient.putCustomAdapter(
      'provider-1',
      exportedYaml,
      { format: 'yaml', version: '3.0.0' },
    )).rejects.toThrow('version');
    await expect(internalClient.putCustomAdapter(
      'provider-1',
      'document:\n  schemaVersion: 1\n  version: 2.0.0\n  definition:\n',
      'yaml',
    )).rejects.toThrow('version');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/internal/providers/provider-1/adapter');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/internal/providers/provider-1/adapter');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/internal/providers/provider-1/adapter?version=2.0.0');
    expect(fetchMock.mock.calls[2]?.[1]?.signal).toBe(signal);
  });

  it('strictly parses every custom tool response and rejects invalid input before fetch', async () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-adapter',
      version: '1.0.0',
      digest: 'e'.repeat(64),
    };
    const preview = {
      method: 'POST' as const,
      relativePath: '/v1/generate',
      query: {},
      headers: {},
      body: { type: 'none' as const },
      url: 'https://api.example.invalid/v1/generate',
      endpoint: 'submit' as const,
      capabilities: {
        providerType: 'custom-http-v1',
        models: [{ id: 'image', displayName: 'Image', capabilities: { operations: ['image.generate'] } }],
      },
    };
    const responses = [
      { valid: true, adapterId: ref.adapterId, canonical: '{}', spec: { id: ref.adapterId } },
      preview,
      {
        network: false,
        performed: false,
        endpoint: 'submit',
        request: { ...preview, capabilities: undefined },
        preview: { ...preview, capabilities: undefined },
        capabilities: preview.capabilities,
      },
      { state: 'pending', remoteJobId: 'remote-1', progress: 50 },
      { path: '/data/0/id', found: true, value: 'remote-1' },
      { capabilities: preview.capabilities },
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const next = responses.shift();
      return new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' }, status: 200 });
    });
    const request = {
      operation: 'image.generate' as const,
      providerId: 'provider-1',
      modelId: 'image',
      prompt: 'test',
      inputs: [],
    };

    await expect(internalClient.validateCustomAdapter('provider-1', { document: { schemaVersion: 1, version: '1.0.0', definition: { id: ref.adapterId } } })).resolves.toMatchObject({ valid: true });
    await expect(internalClient.previewCustomAdapter('provider-1', { request })).resolves.toMatchObject({ endpoint: 'submit' });
    await expect(internalClient.dryRunCustomAdapter('provider-1', { request })).resolves.toMatchObject({ network: false, performed: false });
    await expect(internalClient.simulateCustomAdapter('provider-1', { response: { status: 200, json: {} } })).resolves.toEqual({ state: 'pending', remoteJobId: 'remote-1', progress: 50 });
    await expect(internalClient.testCustomAdapterPath('provider-1', { path: '/data/0/id', json: { data: [{ id: 'remote-1' }] } })).resolves.toEqual({ path: '/data/0/id', found: true, value: 'remote-1' });
    await expect(internalClient.previewCustomAdapterCapabilities('provider-1')).resolves.toMatchObject({ capabilities: { providerType: 'custom-http-v1' } });

    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls[0]?.[0]).toBe('/internal/providers/provider-1/adapter/validate');
    expect(calls[1]?.[0]).toBe('/internal/providers/provider-1/adapter/preview');
    expect(calls[2]?.[0]).toBe('/internal/providers/provider-1/adapter/dry-run');
    expect(calls[3]?.[0]).toBe('/internal/providers/provider-1/adapter/simulate');
    expect(calls[4]?.[0]).toBe('/internal/providers/provider-1/adapter/path-test');
    expect(calls[5]?.[0]).toBe('/internal/providers/provider-1/adapter/capabilities-preview');
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ request });

    await expect(internalClient.testCustomAdapterPath('provider-1', { path: 'data', json: {} })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(CustomAdapterRefSchema.safeParse({ kind: 'declarative-http', adapterId: 'bad/id', version: '1.0.0', digest: 'f'.repeat(64) }).success).toBe(false);
  });

  it('turns raw non-2xx adapter export responses into InternalApiError and emits auth events', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToAuthRequired(listener);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', { headers: { 'Content-Type': 'text/plain' }, status: 401 }),
    );
    try {
      await expect(internalClient.exportCustomAdapter('provider-1')).rejects.toEqual(
        new InternalApiError(401, 'internal_api_error', 'Internal API request failed with status 401.'),
      );
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith();
      expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    } finally {
      unsubscribe();
    }
  });

  it('preserves structured administrator-required adapter errors from 403 responses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        error: 'administrator_required',
        message: 'Administrator authorization is required.',
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 403,
      }),
    );

    await expect(internalClient.validateCustomAdapter('provider-1', {
      document: {
        schemaVersion: 1,
        version: '1.0.0',
        definition: { id: 'custom-fixture' },
      },
    })).rejects.toEqual(new InternalApiError(
      403,
      'administrator_required',
      'Administrator authorization is required.',
    ));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('sends the complete custom adapter ref in the current-delete body', async () => {
    const ref = {
      kind: 'declarative-http' as const,
      adapterId: 'custom-delete',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(internalClient.deleteCustomAdapter('provider-1', ref)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/internal/providers/provider-1/adapter',
      expect.objectContaining({
        body: JSON.stringify({ ref }),
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
        method: 'DELETE',
      }),
    );

    await expect(internalClient.deleteCustomAdapter('provider-1', { ...ref, digest: 'invalid' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads exact trusted bindings, disables provider bindings, and unbinds without global removal', async () => {
    const manifest = TrustedAdapterManifestSchema.parse({
      schemaVersion: 1,
      id: 'trusted-binding',
      version: '1.0.0',
      displayName: 'Trusted Binding',
      sha256: 'f'.repeat(64),
      operations: ['image.generate'],
      capabilities: {
        providerType: 'custom-js-v1',
        models: [{ id: 'image', displayName: 'Image', capabilities: { operations: ['image.generate'] } }],
      },
      allowedHosts: ['api.example.invalid'],
      requiredSecrets: [],
      resourceLimits: {
        timeoutMs: 30_000,
        maxMessageBytes: 1_048_576,
        maxOutputBytes: 1_048_576,
        maxLogBytes: 262_144,
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    const ref = { kind: 'trusted-javascript' as const, adapterId: manifest.id, version: manifest.version, digest: manifest.sha256 };
    const adapter = { manifest, ref, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' };
    const binding = { providerId: 'provider-1', adapter, isCurrent: true, disabled: false, createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' };
    const response = JSON.stringify({ binding });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(response, { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(response, { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [binding], nextCursor: null }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(response, { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(internalClient.getTrustedBinding('provider-1')).resolves.toMatchObject({ binding });
    await expect(internalClient.getTrustedBinding('provider-1', ref)).resolves.toMatchObject({ binding });
    await expect(internalClient.listTrustedBindings('provider-1', { ref, limit: 20, cursor: 'next cursor' })).resolves.toMatchObject({ items: [binding] });
    await expect(internalClient.disableTrustedBinding('provider-1', ref)).resolves.toMatchObject({ binding });
    await expect(internalClient.unbindTrustedBinding('provider-1', ref)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/internal/providers/provider-1/adapter/trusted-javascript');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/internal/providers/provider-1/adapter/trusted-javascript?kind=trusted-javascript&adapterId=trusted-binding&version=1.0.0&digest=${ref.digest}`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/internal/providers/provider-1/adapter/trusted-javascript/revisions?kind=trusted-javascript&adapterId=trusted-binding&version=1.0.0&digest=${ref.digest}&limit=20&cursor=next+cursor`);
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/internal/providers/provider-1/adapter/trusted-javascript/disable');
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ ref });
    expect(fetchMock.mock.calls[4]?.[0]).toBe(`/internal/providers/provider-1/adapter/trusted-javascript?kind=trusted-javascript&adapterId=trusted-binding&version=1.0.0&digest=${ref.digest}`);
    expect(fetchMock.mock.calls[4]?.[1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[4]?.[0]).not.toContain('/internal/adapters/');
  });
});
