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
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', MOCK_PROVIDER_ENABLED: 'true' }), startRunner: false, logger: false });
  }
  async function login(username: string, password = 'admin') {
    const result = await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username, password } });
    expect(result.statusCode).toBe(200);
    return { cookie: String(result.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:80' };
  }
  it('publishes only validated administrator branding and persists it across restart', async () => {
    await setup();
    const admin = await login('admin');
    expect((await server.app.inject({ url: '/internal/branding' })).json()).toEqual({ name: 'Imagine.', logoUrl: '/icons/app-icon-192.png' });
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'brand-user', password: 'fixture-password' } });
    const user = await login('brand-user', 'fixture-password');
    const patch = (values: Record<string, unknown>, headers = admin) => server.app.inject({ method: 'PATCH', url: '/internal/settings', headers, payload: { values } });
    expect((await patch({ 'branding.name': 'Not allowed' }, user)).statusCode).toBe(403);
    expect((await patch({ 'branding.name': '  ' })).statusCode).toBe(400);
    expect((await patch({ 'branding.logo': 'data:image/svg+xml;base64,PHN2Zz4=' })).statusCode).toBe(400);
    expect((await patch({ 'branding.logo': 'data:image/png;base64,bm90LWFuLWltYWdl' })).statusCode).toBe(400);
    expect((await patch({ 'branding.name': 'Invalid update', 'branding.logo': `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64')}` })).statusCode).toBe(400);
    expect((await server.app.inject({ url: '/internal/branding' })).json().name).toBe('Imagine.');
    const png = await readFile(new URL('../../../web/public/icons/app-icon-192.png', import.meta.url));
    expect((await patch({ 'branding.name': '  My Studio  ', 'branding.logo': `data:image/png;base64,${png.toString('base64')}`, 'personal.private': 'not-public' })).statusCode).toBe(200);
    const branding = (await server.app.inject({ url: '/internal/branding' })).json();
    expect(Object.keys(branding).sort()).toEqual(['logoUrl', 'name']);
    expect(branding.name).toBe('My Studio');
    const image = await server.app.inject({ url: branding.logoUrl });
    expect(image.statusCode).toBe(200); expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await server.app.inject({ url: '/internal/settings', headers: user })).json().settings['branding.name']).toBe('My Studio');
    await server.app.close();
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', MOCK_PROVIDER_ENABLED: 'true' }), startRunner: false, logger: false });
    expect((await server.app.inject({ url: '/internal/branding' })).json().name).toBe('My Studio');
    expect((await patch({ 'branding.logo': '' })).statusCode).toBe(200);
    expect((await server.app.inject({ url: '/internal/branding' })).json().logoUrl).toBe('/icons/app-icon-192.png');
  });
  it('merges owned images and videos atomically and retains links across restart and soft deletion', async () => {
    await setup();
    const admin = await login('admin');
    const make = (name: string, type: 'image' | 'video' = 'image') => server.assets.create({ type, role: 'upload', filePath: `media/${name}`, mimeType: type === 'image' ? 'image/png' : 'video/mp4', fileSize: 10, sha256: name.repeat(64) });
    const first = make('a', 'video'), second = make('b', 'video'), third = make('c');
    const merge = (ids: string[], headers = admin) => server.app.inject({ method: 'POST', url: '/internal/assets/series', headers, payload: { assetIds: ids } });
    expect((await merge([first.id, first.id])).statusCode).toBe(400);
    expect((await merge([first.id, second.id, 'missing'])).statusCode).toBe(400);
    expect(server.assets.series(first.id)?.assets).toHaveLength(1);
    expect((await merge([first.id, second.id])).statusCode).toBe(204);
    expect((await merge([second.id, third.id])).statusCode).toBe(204);
    expect(server.assets.series(first.id)?.assets).toHaveLength(3);
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'series-user', password: 'password123' } });
    const other = await login('series-user', 'password123');
    expect((await merge([first.id, second.id], other)).statusCode).toBe(400);
    expect((await server.app.inject({ url: `/internal/assets/${first.id}/series`, headers: other })).statusCode).toBe(404);
    server.assets.softDelete(second.id);
    await server.app.close();
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', MOCK_PROVIDER_ENABLED: 'true' }), startRunner: false, logger: false });
    expect(server.assets.series(first.id)?.assets.map(asset => asset.id).sort()).toEqual([first.id, third.id].sort());
  });
  it('caches private previews while enforcing ownership before conditional responses', async () => {
    await setup();
    const admin = await login('admin');
    const path = 'media/thumbnails/cache-fixture.webp';
    await mkdir(join(root, 'media/thumbnails'), { recursive: true });
    await writeFile(join(root, path), 'private-thumbnail');
    const asset = server.assets.create({ type: 'image', role: 'upload', filePath: 'media/original.png', thumbnailPath: path, mimeType: 'image/png', fileSize: 10, sha256: 'a'.repeat(64) });
    const url = `/internal/assets/${asset.id}/thumbnail`;
    const first = await server.app.inject({ url, headers: admin });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('private, max-age=3600, must-revalidate');
    expect(first.headers.vary).toBe('Cookie, Authorization');
    const etag = String(first.headers.etag);
    for (const method of ['GET', 'HEAD'] as const) {
      const unchanged = await server.app.inject({ method, url, headers: { ...admin, 'if-none-match': etag } });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe('');
      expect(unchanged.headers['content-length']).toBeUndefined();
      expect(unchanged.headers['cache-control']).toContain('max-age=3600');
    }
    const unauthorized = await server.app.inject({ url, headers: { 'if-none-match': etag } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
    expect(unauthorized.headers['clear-site-data']).toBe('"cache"');
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'cache-user', password: 'cache-password' } });
    const other = await login('cache-user', 'cache-password');
    const forbidden = await server.app.inject({ url, headers: { ...other, 'if-none-match': etag } });
    expect(forbidden.statusCode).toBe(404);
    expect(forbidden.headers['cache-control']).toBe('no-store');
    await writeFile(join(root, path), 'repaired-private-thumbnail');
    const repaired = await server.app.inject({ url, headers: { ...admin, 'if-none-match': etag } });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.headers.etag).not.toBe(etag);
    expect(repaired.body).toBe('repaired-private-thumbnail');
    const deleted = await server.app.inject({ method: 'DELETE', url: `/internal/assets/${asset.id}`, headers: admin });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.headers['clear-site-data']).toBe('"cache"');
    const missing = await server.app.inject({ url, headers: { ...admin, 'if-none-match': String(repaired.headers.etag) } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });
  it('persists UUID editor settings across server restart and isolates accounts', async () => {
    await setup();
    const admin = await login('admin');
    const collection = (await server.app.inject({ method: 'POST', url: '/internal/collections', headers: admin, payload: { name: 'Editor settings project' } })).json().collection;
    const key = `generation.edit.${collection.id}.22222222-2222-4222-8222-222222222222`;
    const memory = { image: { selected: 'model-a', models: { 'model-a': { ratio: '1:1' }, 'model-b': { ratio: '3:4' } } }, video: { selected: 'video-model' } };
    expect((await server.app.inject({ method: 'PATCH', url: '/internal/settings', headers: admin, payload: { values: { [key]: memory } } })).statusCode).toBe(200);
    await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'settings-user', password: 'fixture-password' } });
    const other = await login('settings-user', 'fixture-password');
    expect((await server.app.inject({ url: '/internal/settings', headers: other })).json().settings[key]).toBeUndefined();
    await server.app.close();
    server = await createServer({ config: loadConfig({ DATA_DIR: root, NODE_ENV: 'test', MOCK_PROVIDER_ENABLED: 'true' }), startRunner: false, logger: false });
    expect((await server.app.inject({ url: '/internal/settings', headers: admin })).json().settings[key]).toEqual(memory);
  });

  it('shares the failed login budget between Basic and password login', async () => {
    await setup();
    for (let index = 0; index < 10; index++) {
      const result = index % 2 === 0
        ? await server.app.inject({ url: '/internal/account', headers: { authorization: `Basic ${Buffer.from('nobody:incorrect').toString('base64')}` } })
        : await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username: 'nobody', password: 'incorrect' } });
      expect(result.statusCode).toBe(401);
    }
    for (const url of ['/internal/account', '/internal/auth/status']) {
      const rejected = await server.app.inject({ url, headers: { authorization: `Basic ${Buffer.from('nobody:incorrect').toString('base64')}` } });
      expect(rejected.statusCode).toBe(429);
      expect(Number(rejected.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect((await server.app.inject({ method: 'POST', url: '/internal/auth/login', payload: { username: 'nobody', password: 'incorrect' } })).statusCode).toBe(429);
  });

  it('fans out the requested task count despite absent, disabled or locked model batch rules', async () => {
    await setup();
    const admin = await login('admin');
    for (const parameters of [[], [{ path: 'count', label: 'Count', type: 'number', enabled: false }], [{ path: 'count', label: 'Count', type: 'number', defaultValue: 1, min: 1, max: 1, locked: true }]]) {
      server.providers.saveManualModel({ providerId: 'mock', modelId: 'mock-image-v1', displayName: 'Single image', enabled: true, capabilities: { operations: ['image.generate'], supportsBatchCount: false, maxBatchCount: 1, parameters } });
      const created = await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: admin, payload: createMockGenerationRequest({ count: 3 }) });
      expect(created.statusCode).toBe(202);
      expect(created.json().jobs).toHaveLength(3);
      const series = await server.app.inject({ url: `/internal/jobs/${created.json().job.id}/series?groupConcurrentImages=true`, headers: admin });
      expect(series.statusCode).toBe(200);
      expect(series.json().jobs).toHaveLength(3);
      expect(series.json().assets).toEqual([]);
      expect((await server.app.inject({ url: '/internal/jobs/missing/series', headers: admin })).statusCode).toBe(404);
      for (const job of created.json().jobs) expect(server.jobs.get(job.id)?.request.count).toBe(1);
    }
    const rejected = await server.app.inject({ method: 'POST', url: '/internal/jobs', headers: admin, payload: createMockGenerationRequest({ count: 33 }) });
    expect(rejected.statusCode).toBe(400);
  });
  it('isolates resources, input references, jobs, collections and settings in both directions', async () => {
    await setup();
    const admin = await login('admin');
    const asset = server.assets.create({ type: 'image', role: 'upload', filePath: 'media/private.png', mimeType: 'image/png', fileSize: 10, sha256: 'a'.repeat(64), width: 8, height: 8 });
    const oldJob = server.jobs.create(createMockGenerationRequest());
    const oldCollection = server.collections.create('Same project');
    expect((await server.app.inject({ method: 'POST', url: '/internal/accounts', headers: admin, payload: { username: 'alice', password: 'alice-password' } })).statusCode).toBe(201);
    const alice = await login('alice', 'alice-password');
    expect((await server.app.inject({ method: 'PATCH', url: `/internal/collections/${oldCollection.id}`, headers: alice, payload: { isPrivate: true } })).statusCode).toBe(404);
    expect(server.collections.get(oldCollection.id)?.isPrivate).toBe(false);
    server.collections.addAssets(oldCollection.id, [asset.id]);
    expect((await server.app.inject({ method: 'DELETE', url: `/internal/collections/${oldCollection.id}?deleteAssets=true`, headers: alice })).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'POST', url: `/internal/collections/${oldCollection.id}/assets/move`, headers: alice, payload: { assetIds: [asset.id] } })).statusCode).toBe(404);
    expect(server.assets.get(asset.id)).not.toBeNull();

    for (const path of ['assets', 'jobs', 'collections']) {
      const result = await server.app.inject({ url: `/internal/${path}`, headers: alice });
      expect(result.statusCode).toBe(200); expect(result.json().items).toEqual([]);
    }
    for (const path of [`assets/${asset.id}`, `assets/${asset.id}/content`, `assets/${asset.id}/thumbnail`, `assets/${asset.id}/series`, `jobs/${oldJob.id}`, `jobs/${oldJob.id}/series?groupConcurrentImages=true`, `collections/${oldCollection.id}`]) {
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
    expect((await server.app.inject({ method: 'POST', url: `/internal/collections/${collectionId}/assets/move`, headers: alice, payload: { assetIds: [asset.id] } })).statusCode).toBe(404);
    expect(server.assets.collectionIdsForAsset(asset.id)).toEqual([oldCollection.id]);

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
    expect((await server.app.inject({ method: 'DELETE', url: '/internal/models/catalog-model', headers: alice })).statusCode).toBe(403);
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
    delete manifest.migrations['0009_video_sources.sql'];
    delete manifest.migrations['0010_collection_privacy.sql'];
    delete manifest.migrations['0011_generation_batches.sql'];
    delete manifest.migrations['0012_manual_series.sql'];
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
