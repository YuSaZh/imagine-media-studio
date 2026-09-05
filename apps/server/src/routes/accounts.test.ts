import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockGenerationRequest } from '@imagine/testkit';
import { loadConfig } from '../config.js';
import { createServer, type ImagineServer } from '../server.js';
import { createDatabase } from '../database/client.js';

describe('account boundaries', () => {
  let server: ImagineServer;
  let root: string;
  afterEach(async () => { if (server) await server.app.close(); if (root) await rm(root, { recursive: true, force: true }); });
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'imagine-accounts-'));
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test' }), startRunner: false, logger: false });
  }
  async function login(username: string, password = 'admin') {
    const result = await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username, password } });
    expect(result.statusCode).toBe(200);
    return { cookie: String(result.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:80' };
  }
  it('isolates resources, input references, jobs, collections and settings in both directions', async () => {
    await setup();
    const admin = await login('admin');
    const asset = server.assets.create({ type: 'image', role: 'upload', filePath: 'media/private.png', mimeType: 'image/png', fileSize: 10, sha256: 'a'.repeat(64), width: 8, height: 8 });
    const oldJob = server.jobs.create(createMockGenerationRequest());
    const oldCollection = server.collections.create('Same project');
    expect((await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'alice', password: 'alice-password' } })).statusCode).toBe(201);
    const alice = await login('alice', 'alice-password');
    for (const path of ['assets', 'jobs', 'collections']) {
      const result = await server.app.inject({ url: `/internal/${path}`, headers: alice });
      expect(result.statusCode).toBe(200); expect(result.json().items).toEqual([]);
    }
    for (const path of [`assets/${asset.id}`, `assets/${asset.id}/content`, `assets/${asset.id}/thumbnail`, `jobs/${oldJob.id}`, `collections/${oldCollection.id}`]) {
      expect((await server.app.inject({ url: `/internal/${path}`, headers: alice })).statusCode).toBe(404);
      expect((await server.app.inject({ method: 'DELETE', url: `/internal/${path}`, headers: alice })).statusCode).toBe(404);
    }
    expect((await server.app.inject({ method: 'PATCH', url: `/internal/assets/${asset.id}`, headers: alice, payload: { favorite: true } })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: `/internal/jobs/${oldJob.id}/cancel`, headers: alice })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: `/internal/jobs/${oldJob.id}/retry`, headers: alice })).statusCode).toBe(404);
    const collectionResponse = await server.app.inject({ method: 'POST', url: '/internal/collections', headers: alice, payload: { name: 'Same project' } });
    expect(collectionResponse.statusCode).toBe(201);
    const collectionId = collectionResponse.json().collection.id as string;
    expect((await server.app.inject({ method: 'POST', url: `/internal/collections/${collectionId}/assets`, headers: alice, payload: { assetIds: [asset.id] } })).statusCode).toBe(404);
    const input = await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: alice, payload: createMockGenerationRequest({ operation: 'image.edit', inputs: [{ assetId: asset.id, role: 'source' }] }) });
    expect(input.statusCode).toBe(400); expect(input.json().error).toBe('asset_input_not_found');
    expect((await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: alice, payload: createMockGenerationRequest({ collectionId: oldCollection.id }) })).statusCode).toBe(400);
    const created = await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: alice, payload: createMockGenerationRequest({ count: 3, collectionId }) });
    expect(created.statusCode).toBe(202);
    expect(created.json().jobs).toHaveLength(3);
    for (const job of created.json().jobs) {
      expect(job.request.count).toBe(1);
      expect((await server.app.inject({ url: `/internal/jobs/${job.id}`, headers: admin })).statusCode).toBe(404);
    }
    await server.runner.start();
    await expect.poll(() => created.json().jobs.every((job: { id: string }) => server.jobs.get(job.id)?.status === 'completed'), { timeout: 10000 }).toBe(true);
    const aliceAssets = (await server.app.inject({ url: '/internal/assets', headers: alice })).json().items;
    expect(aliceAssets).toHaveLength(3);
    for (const output of aliceAssets) {
      expect((await server.app.inject({ url: output.contentUrl, headers: alice })).statusCode).toBe(200);
      expect((await server.app.inject({ url: output.contentUrl, headers: admin })).statusCode).toBe(404);
    }
    const setting = { values: { 'model.saved': { ratio: '3:4', resolution: '480p' } } };
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: alice, payload: setting })).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/internal/settings', headers: admin })).json().settings['model.saved']).toBeUndefined();
    expect((await server.app.inject({ url: '/internal/settings', headers: alice })).json().settings['model.saved']).toEqual(setting.values['model.saved']);
    for (const path of ['accounts', 'adapters', 'maintenance/integrity', 'providers/mock/adapter']) expect((await server.app.inject({ url: `/internal/${path}`, headers: alice })).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/providers/mock', headers: alice, payload: { enabled: false } })).statusCode).toBe(403);
    for (const url of ['/internal/%70roviders/mock', '/%69nternal/providers/mock']) expect((await server.app.inject({ method: 'PATCH', url, headers: alice, payload: { enabled: false } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: alice, payload: { values: { public_base_url: 'https://evil.example' } } })).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { public_base_url: 'http://plain.example' } } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { public_base_url: 'https://studio.example' } } })).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/internal/settings', headers: admin })).json().settings.public_base_url).toBe('https://studio.example');
  });
  it('persists changed credentials, revokes previous sessions and never resets credentials on restart', async () => {
    await setup(); const admin = await login('admin');
    const result = await server.app.inject({ method: 'PATCH', url: '/internal/account', headers: admin, payload: { currentPassword: 'admin', username: 'owner', password: 'new-password' } });
    expect(result.statusCode).toBe(200);
    expect((await server.app.inject({ url: '/internal/assets', headers: admin })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username: 'admin', password: 'admin' } })).statusCode).toBe(401);
    await server.app.close();
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test' }), startRunner: false, logger: false });
    await login('owner', 'new-password');
    expect((await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username: 'owner', password: 'admin' } })).statusCode).toBe(401);
  });
  it('migrates populated pre-account databases to the administrator without changing existing data', async () => {
    root = await mkdtemp(join(tmpdir(), 'imagine-account-migration-'));
    const legacy = join(root, 'legacy-migrations'); await mkdir(legacy);
    const source = new URL('../../migrations/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8')) as { version: number; migrations: Record<string, string> };
    delete manifest.migrations['0008_accounts.sql'];
    for (const name of Object.keys(manifest.migrations)) await copyFile(new URL(name, source), join(legacy, name));
    await writeFile(join(legacy, 'manifest.json'), JSON.stringify(manifest));
    const db = createDatabase(join(root, 'app.db'), legacy);
    const now = Date.now();
    db.sqlite.prepare('INSERT INTO assets(id,type,role,file_path,mime_type,file_size,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy-image', 'image', 'upload', 'media/legacy.png', 'image/png', 1, 'a'.repeat(64), now);
    db.sqlite.prepare('INSERT INTO collections(id,name,created_at,updated_at) VALUES (?,?,?,?)').run('legacy-project', 'Legacy project', now, now);
    db.sqlite.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)').run('ui.reduce_motion', '"always"', now);
    db.sqlite.close();
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'initial-secret' }), startRunner: false, logger: false });
    const owner = await login('owner', 'initial-secret');
    expect((await server.app.inject({ url: '/internal/assets', headers: owner })).json().items[0].id).toBe('legacy-image');
    expect((await server.app.inject({ url: '/internal/collections', headers: owner })).json().items[0].id).toBe('legacy-project');
    expect((await server.app.inject({ url: '/internal/settings', headers: owner })).json().settings['ui.reduce_motion']).toBe('always');
    expect((await server.app.inject({ url: '/internal/accounts', headers: owner })).json().users).toEqual([{ id: 'admin', username: 'owner', role: 'admin', enabled: true }]);
  });
  it('filters replayed and live events for each authenticated account', async () => {
    await setup(); const admin = await login('admin');
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'events-user', password: 'events-password' } });
    const user = await login('events-user', 'events-password');
    const privateProject = await server.app.inject({ method: 'POST', url: '/internal/collections', headers: admin, payload: { name: 'Private event' } });
    const privateId = privateProject.json().collection.id as string;
    const base = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${base}/internal/events`, { headers: { cookie: user.cookie }, signal: controller.signal });
      expect(response.status).toBe(200);
      const live = await server.app.inject({ method: 'POST', url: '/internal/collections', headers: admin, payload: { name: 'Private live event' } });
      const own = await server.app.inject({ method: 'POST', url: '/internal/collections', headers: user, payload: { name: 'Own event' } });
      const ownId = own.json().collection.id as string;
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes(ownId)) {
        const chunk = await reader.read(); if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain(ownId);
      expect(text).not.toContain(privateId);
      expect(text).not.toContain(live.json().collection.id);
      await reader.cancel();
    } finally { clearTimeout(timeout); controller.abort(); }
  });
});
