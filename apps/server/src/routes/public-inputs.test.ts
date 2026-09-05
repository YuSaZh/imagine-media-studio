import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createServer } from '../server.js';
import { PublicInputLinks } from '../security/public-input-links.js';
import { ProviderInputLoader } from '../providers/provider-input-loader.js';

describe('public provider input delivery', () => {
  it('delivers only signed image inputs, preserves private API auth, and rejects expired or deleted images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagine-public-input-test-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root, PUBLIC_BASE_URL: 'https://studio.example', ADMIN_PASSWORD: 'test-input-password' });
    const server = await createServer({ config, logger: false, startRunner: false, migrationsDirectory: fileURLToPath(new URL('../../migrations', import.meta.url)) });
    try {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const headers = { authorization: `Basic ${Buffer.from('admin:test-input-password').toString('base64')}` };
      const payload = Buffer.concat([Buffer.from('--input-boundary\r\nContent-Disposition: form-data; name="file"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n'), png, Buffer.from('\r\n--input-boundary--\r\n')]);
      const upload = await server.app.inject({ method: 'POST', url: '/internal/assets/upload', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=input-boundary' }, payload });
      expect(upload.statusCode).toBe(201);
      const asset = server.assets.get(upload.json().asset.id)!;
      const links = new PublicInputLinks(config.appSecret, config.publicBaseUrl!);
      const loader = new ProviderInputLoader({ assets: server.assets, dataRoot: root, maxBytesPerFile: 1024, maxTotalBytes: 1024, publicLinks: links });
      const inputs = await loader.load({ operation: 'video.image_to_video', providerId: 'xai', modelId: 'video', prompt: 'test', inputs: [{ assetId: asset.id, role: 'first_frame' }] });
      const path = new URL(inputs[0]!.publicUrl!).pathname;
      const image = await server.app.inject({ method: 'GET', url: path });
      expect(image.statusCode).toBe(200);
      expect(image.rawPayload).toEqual(png);
      expect(image.headers['cache-control']).toContain('no-store');
      expect(image.headers['referrer-policy']).toBe('no-referrer');
      expect((await server.app.inject({ method: 'HEAD', url: path })).body).toBe('');
      expect((await server.app.inject({ method: 'GET', url: `/internal/assets/${asset.id}/content` })).statusCode).toBe(401);
      expect((await server.app.inject({ method: 'GET', url: path.slice(0, -1) + (path.endsWith('a') ? 'b' : 'a') })).statusCode).toBe(404);
      const expired = new URL(new PublicInputLinks(config.appSecret, config.publicBaseUrl!, () => Date.now() - 901_000).create(asset)).pathname;
      expect((await server.app.inject({ method: 'GET', url: expired })).statusCode).toBe(404);
      expect((await server.app.inject({ method: 'DELETE', url: `/internal/assets/${asset.id}`, headers })).statusCode).toBe(204);
      expect((await server.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
