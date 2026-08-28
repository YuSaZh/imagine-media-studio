import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerAuthRoutes } from './auth.js';
import { PasswordAuth } from '../security/password-auth.js';

const APP_SECRET = 'test-app-secret-with-at-least-32-characters';

describe('auth routes', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createAuthApp(password: string | null = 'test-password') {
    const app = Fastify({ logger: false });
    apps.push(app);
    void registerAuthRoutes(app, new PasswordAuth({ appSecret: APP_SECRET, password }));
    return app;
  }

  it('requires the strict login shape and keeps wrong passwords unauthorized', async () => {
    const app = createAuthApp();

    const extra = await app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'test-password', extra: true },
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: '' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'wrong' },
    });
    const valid = await app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'test-password' },
    });

    expect(extra.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(wrong.statusCode).toBe(401);
    expect(valid.statusCode).toBe(200);
  });

  it('accepts an empty logout request and rejects every non-empty body', async () => {
    const app = createAuthApp(null);

    const empty = await app.inject({ method: 'POST', url: '/internal/auth/logout' });
    const object = await app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      payload: {},
    });
    const scalar = await app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      payload: 'logout',
      headers: { 'content-type': 'text/plain' },
    });

    expect(empty.statusCode).toBe(204);
    expect(object.statusCode).toBe(400);
    expect(scalar.statusCode).toBe(400);
  });

  it('warns on potentially public hosts without exposing the host or server configuration', async () => {
    const app = createAuthApp(null);
    const localHosts = [
      'localhost',
      '127.0.0.2',
      '10.10.0.2',
      '172.16.4.2',
      '192.168.10.2',
      '[::1]',
      '[fd12:3456:789a::2]',
    ];
    const publicHosts = ['example.com', 'studio.local', '8.8.8.8'];

    for (const host of localHosts) {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/auth/status',
        headers: { host },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authenticated: true,
        publicAccessWarning: false,
        required: false,
      });
    }
    for (const host of publicHosts) {
      const response = await app.inject({
        method: 'GET',
        url: '/internal/auth/status',
        headers: { host },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        authenticated: true,
        publicAccessWarning: true,
        required: false,
      });
      expect(response.body).not.toContain(host);
    }
  });

  it('never reports a public access warning when an application password is configured', async () => {
    const app = createAuthApp('test-password');
    const response = await app.inject({
      method: 'GET',
      url: '/internal/auth/status',
      headers: { host: 'example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticated: false,
      publicAccessWarning: false,
      required: true,
    });
  });
});
