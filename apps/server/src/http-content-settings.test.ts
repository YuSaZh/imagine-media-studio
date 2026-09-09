import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalDeclarativeSpec, parseDeclarativeJson } from './providers/custom-http/index.js';
import { loadConfig } from './config.js';
import { createServer, type ImagineServer } from './server.js';

// Executors return fixtures only; no paid calls or external network traffic.
describe('instance HTTP content setting', () => {
  let root: string;
  let server: ImagineServer;
  async function start(flags: Record<string, string> = {}) {
    root ??= await mkdtemp(join(tmpdir(), 'imagine-http-setting-'));
    server = await createServer({
      config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', ...flags }),
      logger: false, startRunner: false,
      providerHttpExecutor: async (_target, request) => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.method === 'GET' ? { data: [{ id: 'gpt-image-1' }] } : { data: [{ url: 'http://169.254.169.254/result.png' }] }) }),
    });
  }
  async function login(username = 'admin', password = 'admin') {
    const result = await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username, password } });
    expect(result.statusCode).toBe(200);
    return { cookie: String(result.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:80' };
  }
  afterEach(async () => { await server?.app.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it('restricts writes to admins, validates booleans, shares the value and preserves it across restarts', async () => {
    await start();
    let admin = await login();
    expect(server.settings.get('network.allow_http_content')?.value).toBe(true);
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'alice', password: 'alice-password' } });
    const alice = await login('alice', 'alice-password');
    for (const value of ['false', null, 1, {}]) {
      expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { 'network.allow_http_content': value } } })).statusCode).toBe(400);
    }
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: alice, payload: { values: { 'network.allow_http_content': false, 'ui.reduce_motion': 'always' } } })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/internal/settings', headers: alice })).json().settings['ui.reduce_motion']).toBeUndefined();
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { 'network.allow_http_content': false } } })).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/internal/settings', headers: alice })).json().settings['network.allow_http_content']).toBe(false);
    await server.app.close();
    await start();
    admin = await login();
    expect((await server.app.inject({ url: '/internal/settings', headers: admin })).json().settings['network.allow_http_content']).toBe(false);
  });

  it.each(['ALLOW_HTTP_MEDIA_DOWNLOADS', 'ALLOW_INSECURE_PROVIDER_HTTP'])('honors explicit legacy %s=false only on initialization', async flag => {
    await start({ [flag]: 'false' });
    expect(server.settings.get('network.allow_http_content')?.value).toBe(false);
    server.settings.upsertMany({ 'network.allow_http_content': true });
    await server.app.close();
    await start({ [flag]: 'false' });
    expect(server.settings.get('network.allow_http_content')?.value).toBe(true);
  });

  it('changes provider calls and media URL validation immediately while retaining metadata protection', async () => {
    await start();
    const admin = await login();
    const http = server.providers.create({ name: 'HTTP fixture', type: 'openai', baseUrl: 'http://8.8.8.8/v1', apiKey: 'fixture-key' });
    const https = server.providers.create({ name: 'HTTPS fixture', type: 'openai', baseUrl: 'https://8.8.8.8/v1', apiKey: 'fixture-key' });
    const custom = server.providers.create({ name: 'Custom HTTP fixture', type: 'custom-http-v1', baseUrl: 'http://8.8.8.8:8443', apiKey: 'fixture-key' });
    const definition = JSON.parse(await readFile(new URL('../../../fixtures/providers/custom-http/sync-image/adapter.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    definition.connection = { expectedStatus: [200], extract: {}, method: 'GET', path: '/health' };
    const canonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(definition)));
    server.adapterDefinitions.replace(custom.id, { definition, ref: { adapterId: 'sync-image', version: '1.0.1', kind: 'declarative-http', digest: createHash('sha256').update(canonical).digest('hex') } });
    await server.providers.refreshModels(https.id);
    await server.runner.start();
    for (const allowed of [true, false, true]) {
      expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { 'network.allow_http_content': allowed } } })).statusCode).toBe(200);
      expect((await server.providers.testConnection(http.id)).ok).toBe(allowed);
      expect((await server.providers.testConnection(custom.id)).ok).toBe(allowed);
      expect((await server.providers.testConnection(https.id)).ok).toBe(true);
      const created = await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: admin, payload: { providerId: https.id, modelId: 'gpt-image-1', operation: 'image.generate', prompt: 'HTTP policy fixture', inputs: [] } });
      expect(created.statusCode).toBe(202);
      const id = created.json().job.id as string;
      await expect.poll(() => server.jobs.get(id)?.status).toBe('rejected');
      const error = server.jobs.get(id)?.errorMessage;
      // Both paths remain blocked before any outbound media traffic; the reason
      // proves that toggling HTTP reaches the next independent address guard.
      expect(error).toContain(allowed ? 'cloud metadata' : 'must use HTTPS');
    }
  });
});
