import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from './config.js';
import { createServer, type ImagineServer } from './server.js';

const temporaryDirectories: string[] = [];
const servers: ImagineServer[] = [];
const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function multipartUpload(
  fields: Readonly<Record<string, string>>,
  filename: string,
  mimeType: string,
  content: Buffer,
  fieldsAfterFile = false,
) {
  const boundary = '----imagine-media-studio-test-boundary';
  const chunks: Buffer[] = [];
  const appendFields = () => {
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
    }
  };
  if (!fieldsAfterFile) appendFields();
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    content,
    Buffer.from('\r\n'),
  );
  if (fieldsAfterFile) appendFields();
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createTestServer(
  startRunner = true,
  mockProviderEnabled = true,
  withWebDist = false,
  appPassword: string | null = null,
): Promise<ImagineServer> {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-server-test-'));
  temporaryDirectories.push(dataDir);
  const webDistDir = resolve(dataDir, 'web-dist');
  if (withWebDist) {
    await mkdir(webDistDir);
    await writeFile(webDistDir + '/index.html', '<h1>Static App Shell fixture</h1>');
  }
  const config: AppConfig = {
    allowHttpMediaDownloads: false,
    allowPrivateNetworkAccess: false,
    appPort: 3030,
    appPassword,
    appSecret: 'test-app-secret-with-at-least-32-characters',
    dataDir,
    logLevel: 'silent',
    maxImageUploadBytes: 32 * 1024 * 1024,
    maxRemoteImageBytes: 64 * 1024 * 1024,
    maxRemoteVideoBytes: 1024 * 1024 * 1024,
    maxVideoUploadBytes: 512 * 1024 * 1024,
    mediaProcessTimeoutMs: 30_000,
    mockProviderEnabled,
    nodeEnvironment: 'test',
    webDistDir: withWebDist ? webDistDir : resolve(dataDir, 'missing-web-dist'),
  };
  const server = await createServer({
    config,
    logger: false,
    migrationsDirectory,
    startRunner,
  });
  servers.push(server);
  return server;
}

async function reopenTestServer(dataDir: string): Promise<ImagineServer> {
  const server = await createServer({
    config: {
      allowHttpMediaDownloads: false,
      allowPrivateNetworkAccess: false,
      appPort: 3030,
      appPassword: null,
      appSecret: 'test-app-secret-with-at-least-32-characters',
      dataDir,
      logLevel: 'silent',
      maxImageUploadBytes: 32 * 1024 * 1024,
      maxRemoteImageBytes: 64 * 1024 * 1024,
      maxRemoteVideoBytes: 1024 * 1024 * 1024,
      maxVideoUploadBytes: 512 * 1024 * 1024,
      mediaProcessTimeoutMs: 30_000,
      mockProviderEnabled: true,
      nodeEnvironment: 'test',
      webDistDir: resolve(dataDir, 'missing-web-dist'),
    },
    logger: false,
    migrationsDirectory,
  });
  servers.push(server);
  return server;
}

describe('Imagine server PR 0 skeleton', () => {
  it('reports health without listening on a host port', async () => {
    const { app } = await createTestServer();
    const response = await app.inject({ method: 'GET', url: '/internal/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('persists a Mock Job and its generated media', async () => {
    const server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest(),
    });
    const jobId = response.json<{ job: { id: string } }>().job.id;

    await server.runner.waitForIdle();
    expect(response.statusCode).toBe(202);
    expect(server.jobs.get(jobId)?.status).toBe('completed');
    expect(server.assets.countForJob(jobId)).toBe(1);

    const asset = server.assets.page({ jobId }).items[0];
    if (!asset) throw new Error('Expected the completed Job to persist an Asset.');
    const media = await readFile(resolve(temporaryDirectories.at(-1)!, asset.filePath));
    expect(media.byteLength).toBeGreaterThan(0);
  });

  it('validates durable edit inputs, hides masks by default, and links the result parent', async () => {
    const server = await createTestServer();
    const source = server.assets.create({
      type: 'image',
      role: 'upload',
      filePath: 'media/uploads/edit-source.png',
      originalFilename: 'edit-source.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      fileSize: VALID_PNG.byteLength,
      sha256: '2'.repeat(64),
    });
    const mask = server.assets.create({
      type: 'image',
      role: 'mask',
      parentAssetId: source.id,
      filePath: 'media/masks/edit-mask.png',
      originalFilename: 'edit-mask.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      fileSize: VALID_PNG.byteLength,
      sha256: '3'.repeat(64),
    });
    const rejected = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest({
        operation: 'image.edit',
        inputs: [{ assetId: mask.id, role: 'mask' }],
      }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toBe('source_input_required');

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest({
        operation: 'image.edit',
        inputs: [
          { assetId: source.id, role: 'source' },
          { assetId: mask.id, role: 'mask' },
        ],
      }),
    });
    expect(accepted.statusCode).toBe(202);
    const jobId = accepted.json<{ job: { id: string } }>().job.id;
    await server.runner.waitForIdle();
    expect(server.assets.page({ jobId }).items[0]?.parentAssetId).toBe(source.id);

    const defaultAssets = await server.app.inject({ method: 'GET', url: '/internal/assets' });
    expect(defaultAssets.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
      .not.toContain(mask.id);
    const masks = await server.app.inject({ method: 'GET', url: '/internal/assets?role=mask' });
    expect(masks.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id))
      .toContain(mask.id);
  });

  it('recovers a claimed Mock Job when a new runner starts', async () => {
    const first = await createTestServer(false);
    const queued = first.jobs.create(createMockGenerationRequest({ prompt: 'Recover me' }));
    expect(first.jobs.claimQueued(queued.id)?.status).toBe('submitting');
    const dataDir = temporaryDirectories.at(-1)!;
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await reopenTestServer(dataDir);

    await second.runner.waitForIdle();
    expect(second.jobs.get(queued.id)?.status).toBe('completed');
    expect(second.assets.countForJob(queued.id)).toBe(1);
  });

  it('recovers a queued Mock Job when a new runner starts', async () => {
    const first = await createTestServer(false);
    const queued = first.jobs.create(
      createMockGenerationRequest({ prompt: 'Resume queued after restart' }),
    );
    const dataDir = temporaryDirectories.at(-1)!;
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await reopenTestServer(dataDir);

    await second.runner.waitForIdle();
    expect(second.jobs.get(queued.id)?.status).toBe('completed');
    expect(second.assets.countForJob(queued.id)).toBe(1);
  });

  it('rejects unsupported Mock options before creating a job', async () => {
    const server = await createTestServer();
    const response = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest({ width: 1024 }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe('mock_validation_error');
    expect(server.jobs.list()).toHaveLength(0);
  });

  it('does not recover or accept jobs when the Mock Provider is disabled', async () => {
    const server = await createTestServer(true, false);
    const queued = server.jobs.create(createMockGenerationRequest({ prompt: 'Remain queued' }));
    const response = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest(),
    });

    await server.runner.waitForIdle();
    expect(response.statusCode).toBe(503);
    expect(server.jobs.get(queued.id)?.status).toBe('queued');
  });

  it('keeps the exact internal namespace out of the SPA fallback', async () => {
    const server = await createTestServer(true, true, true);
    const internal = await server.app.inject({
      method: 'GET',
      url: '/internal',
      headers: { accept: 'text/html' },
    });
    const spa = await server.app.inject({
      method: 'GET',
      url: '/imagine',
      headers: { accept: 'text/html' },
    });

    expect(internal.statusCode).toBe(404);
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('Static App Shell fixture');
  });

  it('serves the complete PR 2 media and collection workflow without listening', async () => {
    const server = await createTestServer();
    const upload = multipartUpload({ role: 'upload' }, 'pixel.png', 'image/png', VALID_PNG);
    const uploaded = await server.app.inject({
      method: 'POST',
      url: '/internal/assets/upload',
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const asset = uploaded.json<{ asset: { id: string; contentUrl: string; thumbnailUrl: string } }>().asset;
    expect(asset.thumbnailUrl).toContain(`/internal/assets/${asset.id}/thumbnail`);

    const head = await server.app.inject({ method: 'HEAD', url: asset.contentUrl });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(VALID_PNG.byteLength));
    expect(head.body).toBe('');
    const partial = await server.app.inject({
      method: 'GET',
      url: asset.contentUrl,
      headers: { range: 'bytes=0-7' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload).toEqual(VALID_PNG.subarray(0, 8));
    expect(partial.headers['content-range']).toBe(`bytes 0-7/${VALID_PNG.byteLength}`);

    const favorite = await server.app.inject({
      method: 'PATCH',
      url: `/internal/assets/${asset.id}`,
      payload: { favorite: true },
    });
    expect(favorite.statusCode).toBe(200);
    expect(favorite.json<{ asset: { favorite: boolean } }>().asset.favorite).toBe(true);

    const createdCollection = await server.app.inject({
      method: 'POST',
      url: '/internal/collections',
      payload: { name: 'Acceptance' },
    });
    const collectionId = createdCollection.json<{ collection: { id: string } }>().collection.id;
    const added = await server.app.inject({
      method: 'POST',
      url: `/internal/collections/${collectionId}/assets`,
      payload: { assetIds: [asset.id] },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json<{ added: number }>().added).toBe(1);
    const filtered = await server.app.inject({
      method: 'GET',
      url: `/internal/assets?collectionId=${collectionId}`,
    });
    expect(filtered.json<{ items: Array<{ id: string; collectionIds: string[] }> }>().items)
      .toEqual([expect.objectContaining({ id: asset.id, collectionIds: [collectionId] })]);

    const lateFields = multipartUpload(
      { role: 'reference' },
      'late-fields.png',
      'image/png',
      VALID_PNG,
      true,
    );
    const lateUpload = await server.app.inject({
      method: 'POST',
      url: '/internal/assets/upload',
      headers: { 'content-type': lateFields.contentType },
      payload: lateFields.body,
    });
    expect(lateUpload.statusCode).toBe(201);
    expect(lateUpload.json<{ asset: { role: string } }>().asset.role).toBe('reference');
  });

  it('persists safe settings and exposes Provider configuration without secrets', async () => {
    const server = await createTestServer();
    const settings = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      payload: { values: { 'gallery.initial_filter': 'image', 'composer.clear_prompt': true } },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({
      settings: { 'composer.clear_prompt': true, 'gallery.initial_filter': 'image' },
    });
    const rejectedSecret = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      payload: { values: { 'provider.api-key': 'must-not-be-stored-here' } },
    });
    expect(rejectedSecret.statusCode).toBe(400);

    const providers = await server.app.inject({ method: 'GET', url: '/internal/providers' });
    const mock = providers.json<{ items: Array<Record<string, unknown>> }>().items[0];
    expect(mock).toMatchObject({ id: 'mock', type: 'mock', hasApiKey: false });
    expect(JSON.stringify(mock)).not.toContain('Ciphertext');
    const models = await server.app.inject({ method: 'GET', url: '/internal/models' });
    expect(models.json<{ items: Array<{ modelId: string }> }>().items).toEqual([
      expect.objectContaining({ modelId: 'mock-image-v1' }),
    ]);
    const connection = await server.app.inject({
      method: 'POST',
      url: '/internal/providers/mock/test',
      payload: {},
    });
    expect(connection.json()).toMatchObject({ ok: true });
  });

  it('rejects cross-origin writes while allowing same-origin and non-browser clients', async () => {
    const server = await createTestServer();
    const denied = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      headers: { host: 'studio.local', origin: 'https://attacker.invalid' },
      payload: { values: { mode: 'image' } },
    });
    const allowed = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      headers: { host: 'studio.local', origin: 'https://studio.local' },
      payload: { values: { mode: 'image' } },
    });
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
  });

  it('maps unique-name conflicts and missing Job mutations to stable responses', async () => {
    const server = await createTestServer();
    const first = await server.app.inject({
      method: 'POST',
      url: '/internal/collections',
      payload: { name: 'Duplicate' },
    });
    const duplicate = await server.app.inject({
      method: 'POST',
      url: '/internal/collections',
      payload: { name: 'duplicate' },
    });
    const providerConflict = await server.app.inject({
      method: 'POST',
      url: '/internal/providers',
      payload: { name: 'Mock Provider', type: 'mock', config: {} },
    });
    const missingRetry = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs/missing/retry',
      payload: {},
    });
    const missingDelete = await server.app.inject({
      method: 'DELETE',
      url: '/internal/jobs/missing',
    });

    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'collection_name_conflict' });
    expect(providerConflict.statusCode).toBe(409);
    expect(missingRetry.statusCode).toBe(404);
    expect(missingDelete.statusCode).toBe(404);
  });

  it('enforces an optional application password with a signed session cookie', async () => {
    const server = await createTestServer(true, true, false, 'test-password');
    const health = await server.app.inject({ method: 'GET', url: '/internal/health' });
    const denied = await server.app.inject({ method: 'GET', url: '/internal/settings' });
    const status = await server.app.inject({ method: 'GET', url: '/internal/auth/status' });
    const wrong = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'wrong' },
    });
    const login = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'test-password' },
    });
    const cookie = login.headers['set-cookie'];
    const authenticated = await server.app.inject({
      method: 'GET',
      url: '/internal/settings',
      headers: { cookie: Array.isArray(cookie) ? cookie[0]! : cookie! },
    });
    const basic = await server.app.inject({
      method: 'GET',
      url: '/internal/settings',
      headers: { authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}` },
    });

    expect(health.statusCode).toBe(200);
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('Basic');
    expect(status.json()).toEqual({ required: true, authenticated: false });
    expect(wrong.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(authenticated.statusCode).toBe(200);
    expect(basic.statusCode).toBe(200);
  });
});
