import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  internalClient,
  InternalApiError,
  subscribeToAuthRequired,
} from './internal-client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('internalClient', () => {
  it('publishes payload-free auth-required events for protected 401 responses only', async () => {
    const listener = vi.fn();
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

      listener.mockClear();
      await expect(internalClient.getAuthStatus()).rejects.toBeInstanceOf(InternalApiError);
      await expect(internalClient.login('wrong-password')).rejects.toBeInstanceOf(InternalApiError);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('checks status, logs in with same-origin credentials, and logs out', async () => {
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
      required: true,
    });
    await expect(internalClient.login('local-password')).resolves.toEqual({
      authenticated: true,
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

    await internalClient.uploadAsset(
      new File(['x'], 'fixture.png', { type: 'image/png' }),
      { parentAssetId: 'parent-asset', role: 'reference' },
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const headers = request?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).has('Content-Type')).toBe(false);
    expect(request?.body).toBeInstanceOf(FormData);
    const body = request?.body as FormData;
    expect([...body.keys()]).toEqual(['parentAssetId', 'role', 'file']);
    expect(body.get('parentAssetId')).toBe('parent-asset');
    expect(body.get('role')).toBe('reference');
    expect(body.get('file')).toBeInstanceOf(File);
  });
});
