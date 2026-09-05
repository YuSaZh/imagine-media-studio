import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';

describe('HTTPS reverse proxy authentication', () => {
  it.each([0, 1])('trusts forwarded HTTPS only with %s configured hop', async hops => {
    const root = await mkdtemp(join(tmpdir(), 'imagine-proxy-auth-'));
    const server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', ADMIN_PASSWORD: 'proxy-test-password', TRUST_PROXY_HOPS: String(hops) }), startRunner: false, logger: false, migrationsDirectory: fileURLToPath(new URL('../../migrations', import.meta.url)) });
    try {
      const response = await server.app.inject({ method: 'POST', url: '/internal/auth/login', headers: { host: 'studio.example', origin: 'https://studio.example', 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }, payload: { username: 'admin', password: 'proxy-test-password' } });
      expect(response.statusCode).toBe(hops ? 200 : 403);
      if (hops) expect(response.headers['set-cookie']).toContain('Secure');
      const denied = await server.app.inject({ method: 'POST', url: '/internal/auth/login', headers: { host: 'studio.example', origin: 'https://other.example', 'x-forwarded-proto': 'https' }, payload: { username: 'admin', password: 'proxy-test-password' } });
      expect(denied.statusCode).toBe(403);
    } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
