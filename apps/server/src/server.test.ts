import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import type { CustomAdapterRef } from '@imagine/shared';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { createAdapterWorkerFactory, type AdapterWorkerFactory } from './adapters/worker-host.js';
import type { AppConfig } from './config.js';
import {
  MOCK_VIDEO_MP4_BASE64,
  MOCK_VIDEO_MP4_SHA256,
  MockProviderAdapter,
} from './providers/mock-provider.js';
import { MOCK_PROVIDER_ID } from './providers/provider-registry.js';
import type { ProviderHttpExecutor } from './providers/provider-http-client.js';
import { canonicalDeclarativeSpec, parseDeclarativeJson } from './providers/custom-http/index.js';
import { createServer, type ImagineServer } from './server.js';
import { acquireOfflineMaintenanceLease, OfflineMaintenanceLeaseError } from './maintenance/runtime-lock.js';

const temporaryDirectories: string[] = [];
const servers: ImagineServer[] = [];
const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const VALID_PNG_SHA256 = createHash('sha256').update(VALID_PNG).digest('hex');
const CUSTOM_HTTP_FIXTURE = new URL(
  '../../../fixtures/providers/custom-http/sync-image/adapter.json',
  import.meta.url,
);
const TRUSTED_JS_FIXTURE_DIRECTORY = new URL('./providers/custom-js/fixtures/', import.meta.url);
type DeclarativeAdapterRef = Omit<CustomAdapterRef, 'kind'> & { kind: 'declarative-http' };
type TrustedJavaScriptAdapterRef = Omit<CustomAdapterRef, 'kind'> & { kind: 'trusted-javascript' };

async function customHttpRevision(withConnection = false): Promise<{
  definition: Record<string, unknown>;
  ref: DeclarativeAdapterRef;
}> {
  const definition = JSON.parse(await readFile(CUSTOM_HTTP_FIXTURE, 'utf8')) as Record<string, unknown>;
  if (withConnection) {
    definition.connection = {
      expectedStatus: [200],
      extract: {},
      method: 'GET',
      path: '/health',
    };
  }
  const canonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(definition)));
  return {
    definition,
    ref: {
      adapterId: 'sync-image',
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      kind: 'declarative-http',
      version: withConnection ? '1.0.1' : '1.0.0',
    },
  };
}

async function trustedJavaScriptRevision(): Promise<{
  manifest: Record<string, unknown>;
  ref: TrustedJavaScriptAdapterRef;
  source: Buffer;
}> {
  const manifest = JSON.parse(await readFile(new URL('trusted-fixture-manifest.json', TRUSTED_JS_FIXTURE_DIRECTORY), 'utf8')) as Record<string, unknown>;
  const source = await readFile(new URL('trusted-fixture.mjs', TRUSTED_JS_FIXTURE_DIRECTORY));
  const adapterId = manifest.id;
  const version = manifest.version;
  const digest = manifest.sha256;
  if (typeof adapterId !== 'string' || typeof version !== 'string' || typeof digest !== 'string') {
    throw new Error('Trusted JavaScript fixture manifest is invalid.');
  }
  return {
    manifest,
    ref: { adapterId, digest, kind: 'trusted-javascript', version },
    source,
  };
}

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

function multipartTrustedAdapter(
  manifest: Readonly<Record<string, unknown>>,
  source: Buffer,
  providerId?: string,
) {
  const boundary = '----imagine-trusted-adapter-test-boundary';
  const chunks: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="adapter.mjs"\r\nContent-Type: application/javascript\r\n\r\n`,
    ),
    source,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${JSON.stringify(manifest)}\r\n`),
  ];
  if (providerId !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="providerId"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${providerId}\r\n`,
    ));
  }
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
  providerHttpExecutor?: ProviderHttpExecutor,
  adapterWorkerFactory?: AdapterWorkerFactory,
  migrationsDirectoryOverride = migrationsDirectory,
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
    allowInsecureProviderHttp: false,
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
    providerInputMaxBytesPerFile: 64 * 1024 * 1024,
    providerInputMaxTotalBytes: 256 * 1024 * 1024,
    mediaProcessTimeoutMs: 30_000,
    mockProviderEnabled,
    nodeEnvironment: 'test',
    webDistDir: withWebDist ? webDistDir : resolve(dataDir, 'missing-web-dist'),
  };
  const server = await createServer({
    config,
    logger: false,
    migrationsDirectory: migrationsDirectoryOverride,
    startRunner,
    ...(providerHttpExecutor === undefined ? {} : { providerHttpExecutor }),
    ...(adapterWorkerFactory === undefined ? {} : { adapterWorkerFactory }),
  });
  servers.push(server);
  return server;
}

async function reopenTestServer(dataDir: string, appPassword: string | null = null): Promise<ImagineServer> {
  const server = await createServer({
    config: {
      allowHttpMediaDownloads: false,
      allowInsecureProviderHttp: false,
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
      providerInputMaxBytesPerFile: 64 * 1024 * 1024,
      providerInputMaxTotalBytes: 256 * 1024 * 1024,
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

  it('reports the release-facing application version', async () => {
    const { app } = await createTestServer();
    const response = await app.inject({ method: 'GET', url: '/internal/app-info' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Imagine Media Studio',
      version: '0.1.0',
    });
  });

  it('holds the shared runtime gate until the server closes its SQLite resources', async () => {
    const server = await createTestServer(false, false);
    const dataDir = temporaryDirectories.at(-1)!;
    const lockPath = join(dataDir, '.offline-maintenance.lock');
    expect(await readFile(lockPath, 'utf8')).toContain('server-runtime-lease-v1');
    await expect(acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: dataDir,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);

    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not initialize an offline-held root before the server gate is acquired', async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-server-offline-held-'));
    temporaryDirectories.push(dataDir);
    const offlineLease = await acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: dataDir,
    });
    try {
      await expect(createServer({
        config: {
          allowHttpMediaDownloads: false,
          allowInsecureProviderHttp: false,
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
          providerInputMaxBytesPerFile: 64 * 1024 * 1024,
          providerInputMaxTotalBytes: 256 * 1024 * 1024,
          mediaProcessTimeoutMs: 30_000,
          mockProviderEnabled: false,
          nodeEnvironment: 'test',
          webDistDir: resolve(dataDir, 'missing-web-dist'),
        },
        logger: false,
        migrationsDirectory,
        startRunner: false,
      })).rejects.toThrow();
      expect(await readdir(dataDir)).toEqual(['.offline-maintenance.lock']);
    } finally {
      await offlineLease.release();
    }
  });

  it('releases the runtime gate when database initialization fails', async () => {
    await expect(createTestServer(
      false,
      false,
      false,
      null,
      undefined,
      undefined,
      resolve(tmpdir(), `imagine-server-missing-migrations-${Date.now()}`),
    )).rejects.toThrow();
    const dataDir = temporaryDirectories.at(-1)!;
    await expect(lstat(join(dataDir, '.offline-maintenance.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and releases the runtime gate when startup media reconciliation cannot persist', async () => {
    const first = await createTestServer(false, false);
    const dataDir = temporaryDirectories.at(-1)!;
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);

    const database = new Database(join(dataDir, 'app.db'));
    try {
      database.exec('DROP TABLE media_repair_queue');
    } finally {
      database.close();
    }

    await expect(reopenTestServer(dataDir)).rejects.toThrow('Media repair queue scan could not be stored.');
    const lockPath = join(dataDir, '.offline-maintenance.lock');
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const offlineLease = await acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: dataDir,
    });
    await offlineLease.release();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
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
      sha256: VALID_PNG_SHA256,
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
      sha256: VALID_PNG_SHA256,
    });
    const dataDir = temporaryDirectories.at(-1)!;
    await mkdir(resolve(dataDir, 'media/uploads'), { recursive: true });
    await mkdir(resolve(dataDir, 'media/masks'), { recursive: true });
    await writeFile(resolve(dataDir, source.filePath), VALID_PNG);
    await writeFile(resolve(dataDir, mask.filePath), VALID_PNG);
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

  it('reopens cleanly when the existing Mock Provider was intentionally disabled', async () => {
    const first = await createTestServer(false);
    const dataDir = temporaryDirectories.at(-1)!;
    expect(first.providers.update(MOCK_PROVIDER_ID, { enabled: false })).toMatchObject({ enabled: false });
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await reopenTestServer(dataDir);

    expect(second.providers.get(MOCK_PROVIDER_ID)).toMatchObject({
      id: MOCK_PROVIDER_ID,
      enabled: false,
    });
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

    const videoBytes = Buffer.from(MOCK_VIDEO_MP4_BASE64, 'base64');
    const video = server.assets.create({
      durationMs: 1_000,
      filePath: 'media/originals/mock-video.mp4',
      fileSize: videoBytes.byteLength,
      height: 90,
      mimeType: 'video/mp4',
      posterPath: 'media/posters/mock-video.jpg',
      role: 'output',
      sha256: MOCK_VIDEO_MP4_SHA256,
      type: 'video',
      width: 160,
    });
    const dataDir = temporaryDirectories.at(-1)!;
    await mkdir(resolve(dataDir, 'media/originals'), { recursive: true });
    await mkdir(resolve(dataDir, 'media/posters'), { recursive: true });
    const posterBytes = await sharp({
      create: { background: '#000000', channels: 3, height: 1, width: 1 },
    }).jpeg().toBuffer();
    await writeFile(resolve(dataDir, video.filePath), videoBytes);
    await writeFile(resolve(dataDir, video.posterPath!), posterBytes);

    const videoDto = await server.app.inject({
      method: 'GET',
      url: '/internal/assets/' + video.id,
    });
    expect(videoDto.json<{ asset: { type: string; posterUrl: string | null } }>().asset).toMatchObject({
      type: 'video',
      posterUrl: '/internal/assets/' + video.id + '/poster',
    });
    const videoContentUrl = '/internal/assets/' + video.id + '/content';
    const videoHead = await server.app.inject({ method: 'HEAD', url: videoContentUrl });
    expect(videoHead.statusCode).toBe(200);
    expect(videoHead.headers['content-type']).toContain('video/mp4');
    expect(videoHead.headers['content-length']).toBe(String(videoBytes.byteLength));
    expect(videoHead.body).toBe('');
    const videoFull = await server.app.inject({ method: 'GET', url: videoContentUrl });
    expect(videoFull.statusCode).toBe(200);
    expect(videoFull.rawPayload).toEqual(videoBytes);
    const videoPartial = await server.app.inject({
      method: 'GET',
      url: videoContentUrl,
      headers: { range: 'bytes=0-7', 'if-range': videoHead.headers.etag },
    });
    expect(videoPartial.statusCode).toBe(206);
    expect(videoPartial.rawPayload).toEqual(videoBytes.subarray(0, 8));
    expect(videoPartial.headers['content-range']).toBe('bytes 0-7/' + videoBytes.byteLength);
    const staleRange = await server.app.inject({
      method: 'GET',
      url: videoContentUrl,
      headers: { range: 'bytes=0-7', 'if-range': '"stale"' },
    });
    expect(staleRange.statusCode).toBe(200);
    expect(staleRange.rawPayload).toEqual(videoBytes);
    const unsatisfiable = await server.app.inject({
      method: 'GET',
      url: videoContentUrl,
      headers: { range: 'bytes=' + videoBytes.byteLength + '-' },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers['content-range']).toBe('bytes */' + videoBytes.byteLength);
    const poster = await server.app.inject({
      method: 'GET',
      url: '/internal/assets/' + video.id + '/poster',
    });
    expect(poster.statusCode).toBe(200);
    expect(poster.headers['content-type']).toContain('image/jpeg');
    expect(poster.rawPayload).toEqual(posterBytes);

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
    server.settings.upsertMany({
      'legacy.preferences': {
        keep: true,
        nested: { token: 'legacy-secret', value: 'safe' },
      },
      'legacy.api_key': 'legacy-top-level-api-key',
      'legacy.authorization': 'Bearer legacy-top-level-token',
    });
    const settingsRead = await server.app.inject({ method: 'GET', url: '/internal/settings' });
    expect(settingsRead.statusCode).toBe(200);
    expect(settingsRead.headers['cache-control']).toBe('no-store');
    expect(settingsRead.headers['content-security-policy']).toContain("default-src 'self'");
    expect(settingsRead.json()).toMatchObject({
      settings: {
        'legacy.preferences': { keep: true, nested: { value: 'safe' } },
      },
    });
    expect(JSON.stringify(settingsRead.json())).not.toContain('legacy-top-level');
    const settingsPatchAfterLegacy = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      payload: { values: { 'ui.preferences.safe': true } },
    });
    expect(JSON.stringify(settingsPatchAfterLegacy.json())).not.toContain('legacy-top-level');
    const rejectedSecret = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      payload: { values: { 'provider.api-key': 'must-not-be-stored-here' } },
    });
    expect(rejectedSecret.statusCode).toBe(400);
    const rejectedNestedSecret = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      payload: {
        values: {
          'ui.preferences': { profiles: [{ headers: { Authorization: 'must-not-be-stored' } }] },
        },
      },
    });
    expect(rejectedNestedSecret.statusCode).toBe(400);

    const providers = await server.app.inject({ method: 'GET', url: '/internal/providers' });
    const mock = providers.json<{ items: Array<Record<string, unknown>> }>().items[0];
    expect(mock).toMatchObject({ id: 'mock', type: 'mock', hasApiKey: false });
    expect(JSON.stringify(mock)).not.toContain('Ciphertext');
    const models = await server.app.inject({ method: 'GET', url: '/internal/models' });
    expect(models.json<{ items: Array<{ modelId: string }> }>().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'mock-image-v1' }),
        expect.objectContaining({ modelId: 'mock-video-v1' }),
      ]),
    );
    const connection = await server.app.inject({
      method: 'POST',
      url: '/internal/providers/mock/test',
      payload: {},
    });
    expect(connection.json()).toMatchObject({ ok: true });

    const configured = await server.app.inject({
      method: 'POST',
      url: '/internal/providers',
      payload: {
        name: 'Header Provider',
        type: 'mock',
        apiKey: 'route-secret-key',
        headers: { 'X-Trace': 'route-secret-header' },
        config: { region: 'fixture' },
      },
    });
    expect(configured.statusCode).toBe(201);
    expect(configured.json()).toMatchObject({
      provider: { hasApiKey: true, hasCustomHeaders: true },
    });
    expect(configured.body).not.toContain('route-secret');
    const configuredId = configured.json<{ provider: { id: string } }>().provider.id;
    const clearedHeaders = await server.app.inject({
      method: 'PATCH',
      url: `/internal/providers/${configuredId}`,
      payload: { headers: {} },
    });
    expect(clearedHeaders.statusCode).toBe(200);
    expect(clearedHeaders.json()).toMatchObject({
      provider: { hasCustomHeaders: false, config: { region: 'fixture' } },
    });
    const disabled = await server.app.inject({
      method: 'PATCH',
      url: `/internal/providers/${configuredId}`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({
      provider: { name: 'Header Provider', config: { region: 'fixture' }, enabled: false },
    });
    const unsupportedCreate = await server.app.inject({
      method: 'POST',
      url: '/internal/providers',
      payload: { name: 'Custom HTTP', type: 'custom-http', config: {} },
    });
    expect(unsupportedCreate.statusCode).toBe(400);
    const unsupportedPatch = await server.app.inject({
      method: 'PATCH',
      url: `/internal/providers/${configuredId}`,
      payload: { type: 'custom-http' },
    });
    expect(unsupportedPatch.statusCode).toBe(400);
    const unsafeBaseUrl = await server.app.inject({
      method: 'POST',
      url: '/internal/providers',
      payload: {
        name: 'Unsafe Base URL',
        type: 'mock',
        baseUrl: 'https://user:pass@example.test/v1?token=secret',
        config: {},
      },
    });
    expect(unsafeBaseUrl.statusCode).toBe(400);
  });

  it('supports strict manual model CRUD while preserving overrides on refresh', async () => {
    const server = await createTestServer();
    const capabilities = {
      operations: ['image.generate'],
      aspectRatios: ['1:1'],
      inputImageConstraints: { mimeTypes: ['image/png'] },
    };
    const created = await server.app.inject({
      method: 'POST',
      url: '/internal/models',
      payload: {
        providerId: 'mock',
        modelId: 'manual-image-v1',
        displayName: 'Manual image',
        capabilities,
        enabled: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const manual = created.json<{ model: { id: string; capabilitySource: string } }>().model;
    expect(manual.capabilitySource).toBe('manual');

    const invalid = await server.app.inject({
      method: 'PATCH',
      url: `/internal/models/${manual.id}`,
      payload: { capabilities: { operations: ['image.generate'], unknown: true } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toBe('invalid_request');

    const updated = await server.app.inject({
      method: 'PATCH',
      url: `/internal/models/${manual.id}`,
      payload: { displayName: 'Manual image updated', enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ model: { displayName: string; enabled: boolean } }>().model)
      .toMatchObject({ displayName: 'Manual image updated', enabled: false });

    const providerModels = await server.app.inject({ method: 'GET', url: '/internal/models' });
    const providerModel = providerModels.json<{ items: Array<{ id: string; capabilitySource: string }> }>()
      .items.find((model) => model.capabilitySource !== 'manual');
    if (!providerModel) throw new Error('Expected a provider model.');
    const providerEdit = await server.app.inject({
      method: 'PATCH',
      url: `/internal/models/${providerModel.id}`,
      payload: { displayName: 'Cannot edit provider model' },
    });
    expect(providerEdit.statusCode).toBe(409);
    expect(providerEdit.json<{ error: string }>().error).toBe('model_not_manual');

    const refreshed = await server.app.inject({
      method: 'POST',
      url: '/internal/providers/mock/models/refresh',
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    const refreshedManual = refreshed.json<{ items: Array<{ id: string; enabled: boolean; capabilitySource: string }> }>()
      .items.find((model) => model.id === manual.id);
    expect(refreshedManual).toMatchObject({ id: manual.id, enabled: false, capabilitySource: 'manual' });

    const deleted = await server.app.inject({ method: 'DELETE', url: `/internal/models/${manual.id}` });
    expect(deleted.statusCode).toBe(204);
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
      headers: { host: 'studio.local', origin: 'http://studio.local' },
      payload: { values: { mode: 'image' } },
    });
    const equivalentDefaultPort = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      headers: { host: 'studio.local:80', origin: 'http://studio.local' },
      payload: { values: { mode: 'image' } },
    });
    const mismatchedScheme = await server.app.inject({
      method: 'PATCH',
      url: '/internal/settings',
      headers: { host: 'studio.local', origin: 'https://studio.local' },
      payload: { values: { mode: 'image' } },
    });
    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(equivalentDefaultPort.statusCode).toBe(200);
    expect(mismatchedScheme.statusCode).toBe(403);
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

  it('serves successful retry and cancellation mutations without losing the late-result guard', async () => {
    const server = await createTestServer();
    const created = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: createMockGenerationRequest({ prompt: 'Route retry fixture' }),
    });
    expect(created.statusCode).toBe(202);
    const sourceJobId = created.json<{ job: { id: string } }>().job.id;
    await server.runner.waitForIdle();
    expect(server.jobs.get(sourceJobId)?.status).toBe('completed');

    const retried = await server.app.inject({
      method: 'POST',
      url: `/internal/jobs/${sourceJobId}/retry`,
      payload: {},
    });
    expect(retried.statusCode).toBe(202);
    const retryJobId = retried.json<{ job: { id: string }; sourceJobId: string }>();
    expect(retryJobId.sourceJobId).toBe(sourceJobId);
    await server.runner.waitForIdle();
    expect(server.jobs.get(retryJobId.job.id)?.status).toBe('completed');

    const cancellable = server.jobs.create(createMockGenerationRequest({ prompt: 'Route cancel fixture' }));
    const cancelled = await server.app.inject({
      method: 'POST',
      url: `/internal/jobs/${cancellable.id}/cancel`,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<{ job: { status: string } }>().job.status).toBe('cancelled');
    await server.runner.waitForIdle();
    expect(server.jobs.get(cancellable.id)?.status).toBe('cancelled');
  });

  it('runs an encrypted xAI profile through the safe executor, input loader, runner, and local media store', async () => {
    const requests: Array<{ method: string; url: string; headers: Readonly<Record<string, string>>; body?: string }> = [];
    const providerHttpExecutor: ProviderHttpExecutor = async (_target, request) => {
      requests.push(request);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          data: [{
            id: 'integration-result',
            b64_json: VALID_PNG.toString('base64'),
            revised_prompt: 'safe fixture result',
          }],
        }),
      };
    };
    const server = await createTestServer(true, true, false, null, providerHttpExecutor);
    const provider = server.providers.create({
      name: 'xAI integration fixture',
      type: 'xai-imagine-image-v1',
      baseUrl: 'https://8.8.8.8/v1',
      apiKey: 'integration-secret',
      headers: { 'X-Trace-Id': 'integration-trace' },
      config: { region: 'fixture' },
    });
    await server.providers.refreshModels(provider.id);

    const dataDir = temporaryDirectories.at(-1)!;
    await mkdir(resolve(dataDir, 'media/uploads'), { recursive: true });
    const source = server.assets.create({
      type: 'image',
      role: 'upload',
      filePath: 'media/uploads/xai-source.png',
      originalFilename: 'xai-source.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      fileSize: VALID_PNG.byteLength,
      sha256: VALID_PNG_SHA256,
    });
    const reference = server.assets.create({
      type: 'image',
      role: 'reference',
      filePath: 'media/uploads/xai-reference.png',
      originalFilename: 'xai-reference.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      fileSize: VALID_PNG.byteLength,
      sha256: VALID_PNG_SHA256,
    });
    await writeFile(resolve(dataDir, source.filePath), VALID_PNG);
    await writeFile(resolve(dataDir, reference.filePath), VALID_PNG);

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/internal/jobs',
      payload: {
        operation: 'image.edit',
        providerId: provider.id,
        modelId: 'grok-imagine-image',
        prompt: 'Combine the fixture subjects.',
        inputs: [
          { assetId: source.id, role: 'source' },
          { assetId: reference.id, role: 'reference' },
        ],
      },
    });
    expect(accepted.statusCode).toBe(202);
    const jobId = accepted.json<{ job: { id: string } }>().job.id;
    await server.runner.waitForIdle();

    const job = server.jobs.get(jobId);
    const output = server.assets.page({ jobId }).items[0];
    expect(job?.status).toBe('completed');
    expect(job?.resultManifest).toEqual([{ slot: 0, assetId: output?.id }]);
    expect(output?.filePath).toMatch(/^media\/originals\//);
    expect(output ? await readFile(resolve(dataDir, output.filePath)) : null).toEqual(VALID_PNG);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://8.8.8.8/v1/models',
      headers: {
        Authorization: 'Bearer integration-secret',
        'X-Trace-Id': 'integration-trace',
      },
    });
    const submitRequest = requests[1];
    expect(submitRequest).toMatchObject({
      method: 'POST',
      url: 'https://8.8.8.8/v1/images/edits',
      headers: {
        Authorization: 'Bearer integration-secret',
        'X-Trace-Id': 'integration-trace',
      },
    });
    expect(submitRequest?.body).toContain('images');
    expect(submitRequest?.body).not.toContain(source.id);
    expect(submitRequest?.body).not.toContain(reference.id);
    const providerResponse = await server.app.inject({ method: 'GET', url: '/internal/providers' });
    expect(providerResponse.body).not.toContain('integration-secret');
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
    expect(status.json()).toEqual({
      required: true,
      authenticated: false,
      publicAccessWarning: false,
    });
    expect(wrong.statusCode).toBe(401);
    expect(login.statusCode).toBe(200);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(authenticated.statusCode).toBe(200);
    expect(basic.statusCode).toBe(200);
  });

  it('keeps auth public paths exact and hardens browser writes against CSRF', async () => {
    const server = await createTestServer(false, true, false, 'test-password');
    const childPath = await server.app.inject({
      method: 'GET',
      url: '/internal/auth/status/child',
    });
    const logoutUnauthenticated = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
    });
    const health = await server.app.inject({ method: 'GET', url: '/internal/health' });
    const login = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'test-password' },
    });
    const cookie = login.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookie) ? cookie[0]! : cookie!;
    const missingOrigin = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      headers: { cookie: cookieHeader },
    });
    const fetchMetadataWithoutOrigin = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      headers: { 'sec-fetch-site': 'same-origin', cookie: cookieHeader },
    });
    const crossSite = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { password: 'test-password' },
    });
    const basic = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      headers: {
        authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
      },
    });
    const sameOrigin = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/logout',
      headers: {
        cookie: cookieHeader,
        host: 'studio.local',
        origin: 'http://studio.local',
      },
    });

    expect(childPath.statusCode).toBe(401);
    expect(logoutUnauthenticated.statusCode).toBe(401);
    expect(health.statusCode).toBe(200);
    expect(login.statusCode).toBe(200);
    expect(missingOrigin.statusCode).toBe(403);
    expect(missingOrigin.json<{ error: string }>().error).toBe('origin_required');
    expect(fetchMetadataWithoutOrigin.statusCode).toBe(403);
    expect(crossSite.statusCode).toBe(403);
    expect(basic.statusCode).toBe(204);
    expect(sameOrigin.statusCode).toBe(204);
  });

  it('protects database maintenance and publishes a readable database-only backup', async () => {
    const publicServer = await createTestServer(false, true, false, null);
    const publicIntegrity = await publicServer.app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
    });
    const publicMedia = await publicServer.app.inject({
      method: 'GET',
      url: '/internal/maintenance/media',
    });
    const publicBackup = await publicServer.app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
    });
    expect(publicIntegrity.statusCode).toBe(403);
    expect(publicMedia.statusCode).toBe(403);
    expect(publicBackup.statusCode).toBe(403);

    const server = await createTestServer(false, true, false, 'test-password');
    const dataDir = temporaryDirectories.at(-1)!;
    const unauthenticated = await server.app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
    });
    const adminHeaders = {
      authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
    };
    const integrity = await server.app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
      headers: adminHeaders,
    });
    const media = await server.app.inject({
      method: 'GET',
      url: '/internal/maintenance/media',
      headers: adminHeaders,
    });
    const backup = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: adminHeaders,
    });
    const body = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: adminHeaders,
      payload: {},
    });
    const query = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups?filename=app.db',
      headers: adminHeaders,
    });
    const crossOrigin = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: { ...adminHeaders, host: 'studio.local', origin: 'http://evil.example' },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain('Basic');
    expect(integrity.statusCode).toBe(200);
    expect(integrity.headers['cache-control']).toContain('no-store');
    expect(integrity.json()).toMatchObject({
      integrity: {
        foreignKeyCheck: { ok: true, violationCount: 0 },
        foreignKeysEnabled: true,
        integrityCheck: { errorCount: 0, ok: true },
        ok: true,
      },
    });
    expect(integrity.body).not.toContain('schema_migrations');
    expect(media.statusCode).toBe(200);
    expect(media.headers['cache-control']).toContain('no-store');
    expect(media.headers['content-security-policy']).toContain("object-src 'none'");
    expect(media.json()).toEqual({
      media: {
        assetCount: 0,
        fileCount: 0,
        hashedBytes: 0,
        issueCount: 0,
        issues: [],
        ok: true,
        truncated: false,
      },
    });
    expect(media.body).not.toContain(dataDir);
    expect(media.body).not.toContain('error');
    expect(backup.statusCode).toBe(201);
    expect(backup.headers['cache-control']).toContain('no-store');
    const backupBody = backup.json<{ backup: { id: string; size: number; sha256: string; createdAt: string } }>();
    expect(backupBody.backup).toEqual({
      createdAt: expect.any(String),
      id: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      size: expect.any(Number),
    });
    expect(backup.body).not.toContain('path');
    expect(backup.body).not.toContain('filename');
    expect(backup.body).not.toContain(dataDir);
    const backupPath = resolve(dataDir, 'backups', `${backupBody.backup.id}.db`);
    const backupStats = await lstat(backupPath);
    expect(backupStats.mode & 0o777).toBe(0o600);
    const snapshot = new Database(backupPath, { fileMustExist: true, readonly: true });
    try {
      snapshot.pragma('foreign_keys = ON');
      expect(snapshot.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(snapshot.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 9 });
    } finally {
      snapshot.close();
    }
    expect(body.statusCode).toBe(400);
    expect(query.statusCode).toBe(400);
    expect(crossOrigin.statusCode).toBe(403);
  });

  it('reconciles a bounded media audit into a persistent repair queue', async () => {
    const server = await createTestServer(false, true, false, 'test-password');
    const dataDir = temporaryDirectories.at(-1)!;
    const missing = server.assets.create({
      filePath: 'media/uploads/reconcile-missing.png',
      fileSize: 1,
      mimeType: 'image/png',
      role: 'upload',
      sha256: 'a'.repeat(64),
      type: 'image',
    });
    const adminHeaders = {
      authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
    };
    const unauthenticated = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/reconcile',
    });
    const crossOrigin = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/reconcile',
      headers: { ...adminHeaders, host: 'studio.local', origin: 'http://evil.example' },
    });
    const body = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/reconcile',
      headers: adminHeaders,
      payload: {},
    });
    const query = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/reconcile?limit=1',
      headers: adminHeaders,
    });
    const reconcile = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/reconcile',
      headers: adminHeaders,
    });
    const repairs = await server.app.inject({
      method: 'GET',
      url: '/internal/maintenance/media/repairs',
      headers: adminHeaders,
    });
    const repairsQuery = await server.app.inject({
      method: 'GET',
      url: '/internal/maintenance/media/repairs?state=open',
      headers: adminHeaders,
    });
    const unauthenticatedRun = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run',
    });
    const crossOriginRun = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run',
      headers: { ...adminHeaders, host: 'studio.local', origin: 'http://evil.example' },
    });
    const runBody = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run',
      headers: adminHeaders,
      payload: {},
    });
    const runQuery = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run?limit=1',
      headers: adminHeaders,
    });
    const run = await server.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run',
      headers: adminHeaders,
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(crossOrigin.statusCode).toBe(403);
    expect(body.statusCode).toBe(400);
    expect(query.statusCode).toBe(400);
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.headers['cache-control']).toContain('no-store');
    expect(reconcile.headers['content-security-policy']).toContain("object-src 'none'");
    expect(reconcile.json()).toEqual({
      media: {
        queue: {
          inserted: 1,
          reopened: 0,
          resolved: 0,
          seen: 1,
          truncated: false,
          updated: 0,
        },
        scan: {
          assetCount: 1,
          fileCount: 0,
          hashedBytes: 0,
          issueCount: 1,
          ok: false,
          truncated: false,
        },
      },
    });
    expect(repairs.statusCode).toBe(200);
    expect(repairs.headers['cache-control']).toContain('no-store');
    expect(repairs.headers['content-security-policy']).toContain("object-src 'none'");
    expect(repairs.json()).toEqual({
      repairs: {
        count: 1,
        items: [{
          assetId: missing.id,
          attempts: 0,
          firstSeenAt: expect.any(String),
          issueKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
          jobId: null,
          kind: 'missing',
          lastErrorCode: null,
          lastSeenAt: expect.any(String),
          leaseUntil: null,
          nextAttemptAt: expect.any(String),
          resolvedAt: null,
          state: 'open',
          storedPath: 'media/uploads/reconcile-missing.png',
        }],
        truncated: false,
      },
    });
    expect(repairsQuery.statusCode).toBe(400);
    expect(unauthenticatedRun.statusCode).toBe(401);
    expect(crossOriginRun.statusCode).toBe(403);
    expect(runBody.statusCode).toBe(400);
    expect(runQuery.statusCode).toBe(400);
    expect(run.statusCode).toBe(200);
    expect(run.headers['cache-control']).toContain('no-store');
    expect(run.headers['content-security-policy']).toContain("object-src 'none'");
    expect(run.json()).toEqual({
      repairs: {
        attempted: 1,
        manual: 1,
        repaired: 0,
        retried: 0,
        truncated: false,
      },
    });
    expect(server.mediaRepairQueue.count()).toBe(1);

    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    const reopened = await reopenTestServer(dataDir, 'test-password');
    const persisted = await reopened.app.inject({
      method: 'GET',
      url: '/internal/maintenance/media/repairs',
      headers: adminHeaders,
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json<{ repairs: { count: number; items: Array<{ assetId: string | null }> } }>()).toMatchObject({
      repairs: { count: 1, items: [{ assetId: missing.id }] },
    });
    expect(reopened.mediaRepairQueue.count()).toBe(1);
  });

  it('queues completed physical media failures on restart without resubmitting the Provider', async () => {
    const first = await createTestServer(true, true, false, 'test-password');
    const dataDir = temporaryDirectories.at(-1)!;
    const adminHeaders = {
      authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
    };
    const createJob = async (prompt: string): Promise<string> => {
      const response = await first.app.inject({
        method: 'POST',
        url: '/internal/jobs',
        headers: adminHeaders,
        payload: createMockGenerationRequest({ prompt }),
      });
      expect(response.statusCode).toBe(202);
      return response.json<{ job: { id: string } }>().job.id;
    };
    const derivedJobId = await createJob('Startup repair derived fixture');
    const primaryJobId = await createJob('Startup repair primary fixture');
    await first.runner.waitForIdle();
    const derivedAsset = first.assets.page({ jobId: derivedJobId }).items[0];
    const primaryAsset = first.assets.page({ jobId: primaryJobId }).items[0];
    if (derivedAsset?.thumbnailPath === null || derivedAsset === undefined || primaryAsset === undefined) {
      throw new Error('Completed Mock Jobs must have image Assets with a thumbnail.');
    }
    const derivedBefore = first.jobs.get(derivedJobId);
    const primaryBefore = first.jobs.get(primaryJobId);
    expect(derivedBefore?.status).toBe('completed');
    expect(primaryBefore?.status).toBe('completed');
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);
    await rm(resolve(dataDir, derivedAsset.thumbnailPath));
    await rm(resolve(dataDir, primaryAsset.filePath));

    const submit = vi.spyOn(MockProviderAdapter.prototype, 'submit');
    const reopened = await reopenTestServer(dataDir, 'test-password');
    await reopened.runner.waitForIdle();

    expect(submit).not.toHaveBeenCalled();
    expect(reopened.jobs.get(derivedJobId)).toMatchObject({
      status: 'completed',
      submitAttempt: derivedBefore!.submitAttempt,
    });
    expect(reopened.jobs.get(primaryJobId)).toMatchObject({
      status: 'completed',
      submitAttempt: primaryBefore!.submitAttempt,
    });
    const queued = reopened.mediaRepairQueue.list();
    expect(queued).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: derivedAsset.id,
        kind: 'missing',
        state: 'open',
        storedPath: derivedAsset.thumbnailPath,
      }),
      expect.objectContaining({
        assetId: primaryAsset.id,
        kind: 'missing',
        state: 'open',
        storedPath: primaryAsset.filePath,
      }),
    ]));

    const run = await reopened.app.inject({
      method: 'POST',
      url: '/internal/maintenance/media/repairs/run',
      headers: adminHeaders,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toEqual({
      repairs: {
        attempted: 2,
        manual: 1,
        repaired: 1,
        retried: 0,
        truncated: false,
      },
    });
    const after = reopened.mediaRepairQueue.list();
    expect(after.find((item) => item.storedPath === derivedAsset.thumbnailPath)?.state).toBe('resolved');
    expect(after.find((item) => item.storedPath === primaryAsset.filePath)?.state).toBe('manual');
    const repairedThumbnail = await lstat(resolve(dataDir, derivedAsset.thumbnailPath));
    expect(repairedThumbnail.isFile()).toBe(true);
    expect(repairedThumbnail.size).toBeGreaterThan(0);
    expect(reopened.jobs.get(derivedJobId)?.status).toBe('completed');
    expect(reopened.jobs.get(primaryJobId)?.status).toBe('completed');
  });

  it('waits for an active database backup before closing SQLite', async () => {
    const server = await createTestServer(false, true, false, 'test-password');
    const sqlite = (server.databaseBackup as unknown as { readonly sqlite: Database.Database }).sqlite;
    let release!: () => void;
    const released = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    let started!: () => void;
    const backupStarted = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const realBackup = sqlite.backup.bind(sqlite);
    vi.spyOn(sqlite, 'backup').mockImplementation(async (destination, options) => {
      started();
      await released;
      return realBackup(destination, options);
    });

    const active = server.databaseBackup.create();
    await backupStarted;
    let closed = false;
    const closing = server.app.close().then(() => { closed = true; });
    expect(closed).toBe(false);
    release();
    await active;
    await closing;
    expect(closed).toBe(true);
    servers.splice(servers.indexOf(server), 1);
  });

  it('wires custom adapter definitions, scoped HTTP, and the worker runtime', async () => {
    const targets: string[] = [];
    const providerHttpExecutor: ProviderHttpExecutor = async (target) => {
      targets.push(target.url.toString());
      return { body: '{}', headers: {}, statusCode: 200 };
    };
    const adapterWorkerFactory = createAdapterWorkerFactory({
      workerEntryUrl: new URL('./providers/custom-js/fixtures/trusted-worker-entry.mjs', import.meta.url),
    });
    const server = await createTestServer(
      false,
      false,
      false,
      'test-password',
      providerHttpExecutor,
      adapterWorkerFactory,
    );
    const adminHeaders = {
      authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
    };

    const httpRevision = await customHttpRevision(true);
    const httpProvider = server.providers.create({
      baseUrl: 'https://8.8.8.8:8443',
      name: 'Scoped custom HTTP',
      type: 'custom-http-v1',
      apiKey: 'custom-http-secret',
    });
    server.adapterDefinitions.replace(httpProvider.id, httpRevision);
    await expect(server.providers.refreshModels(httpProvider.id)).resolves.toHaveLength(1);
    await expect(server.providers.testConnection(httpProvider.id)).resolves.toMatchObject({ ok: true });
    expect(targets).toEqual(['https://8.8.8.8:8443/health']);

    const httpJob = await server.app.inject({
      headers: adminHeaders,
      method: 'POST',
      payload: {
        extra: { style: 'clean' },
        inputs: [],
        modelId: 'image-model',
        operation: 'image.generate',
        prompt: 'custom HTTP fixture',
        providerId: httpProvider.id,
      },
      url: '/internal/jobs',
    });
    expect(httpJob.statusCode).toBe(202);
    expect(server.jobs.get(httpJob.json<{ job: { id: string } }>().job.id)?.adapterRef).toEqual(httpRevision.ref);

    const jsRevision = await trustedJavaScriptRevision();
    const jsProvider = server.providers.create({
      name: 'Trusted JavaScript fixture',
      type: 'custom-js-v1',
    });
    await server.adapterStore.install({ manifest: jsRevision.manifest, source: jsRevision.source });
    server.adapterDefinitions.replace(jsProvider.id, { ref: jsRevision.ref });
    await expect(server.providers.refreshModels(jsProvider.id)).resolves.toHaveLength(1);

    const jsJob = await server.app.inject({
      headers: adminHeaders,
      method: 'POST',
      payload: {
        inputs: [],
        modelId: 'fixture-model',
        operation: 'image.generate',
        prompt: 'custom JS fixture',
        providerId: jsProvider.id,
      },
      url: '/internal/jobs',
    });
    expect(jsJob.statusCode).toBe(202);
    expect(server.jobs.get(jsJob.json<{ job: { id: string } }>().job.id)?.adapterRef).toEqual(jsRevision.ref);
  });

  it('keeps adapter management fail-closed without an application password', async () => {
    const server = await createTestServer(false, false);
    await expect(server.adapterStore.install({ manifest: {}, source: '' })).rejects.toThrow(
      'Administrator authorization is required for adapter management.',
    );
  });

  it('integrates authenticated declarative and trusted adapter management across restart', async () => {
    const noPassword = await createTestServer(false, false);
    const denied = await noPassword.app.inject({ method: 'GET', url: '/internal/adapters' });
    expect(denied.statusCode).toBe(403);
    await noPassword.app.close();
    servers.splice(servers.indexOf(noPassword), 1);

    const server = await createTestServer(false, false, false, 'test-password');
    const dataDir = temporaryDirectories.at(-1)!;
    const admin = {
      authorization: `Basic ${Buffer.from('studio:test-password').toString('base64')}`,
    };
    const login = await server.app.inject({
      method: 'POST',
      url: '/internal/auth/login',
      payload: { password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const rawCookie = login.headers['set-cookie'];
    const cookie = Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!;
    const sameOrigin = {
      cookie,
      host: 'studio.local',
      origin: 'http://studio.local',
    };
    const customProvider = server.providers.create({
      baseUrl: 'https://8.8.8.8:8443',
      name: 'Management HTTP Provider',
      type: 'custom-http-v1',
    });
    const revision = await customHttpRevision();
    const jsonImport = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: {
        definition: revision.definition,
        schemaVersion: 1,
        version: revision.ref.version,
      },
    });
    expect(jsonImport.statusCode).toBe(200);

    const legacyVersionQuery = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter?version=2.0.0`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: revision.definition,
    });
    const bareSpec = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter`,
      headers: { ...admin, 'content-type': 'application/json' },
      payload: revision.definition,
    });
    expect(legacyVersionQuery.statusCode).toBe(200);
    const createdRevision = await server.app.inject({
      method: 'GET',
      url: `/internal/providers/${customProvider.id}/adapter/revisions?kind=declarative-http&adapterId=${revision.ref.adapterId}&version=2.0.0&digest=${revision.ref.digest}`,
      headers: sameOrigin,
    });
    expect(createdRevision.statusCode).toBe(200);
    expect(createdRevision.json<{ items: { ref: { version: string } }[] }>().items.map((item) => item.ref.version)).toEqual(['2.0.0']);
    expect(bareSpec.statusCode).toBe(400);

    const yamlExport = await server.app.inject({
      method: 'GET',
      url: `/internal/providers/${customProvider.id}/adapter/export?format=yaml`,
      headers: sameOrigin,
    });
    expect(yamlExport.statusCode).toBe(200);
    expect(yamlExport.headers['content-type']).toContain('application/yaml');
    expect(yamlExport.body).not.toContain('Management HTTP Provider');
    const yamlImport = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter`,
      headers: { ...sameOrigin, 'content-type': 'application/yaml' },
      payload: yamlExport.body,
    });
    expect(yamlImport.statusCode).toBe(200);
    const yamlEnvelope = parseYaml(yamlExport.body) as { definition?: Record<string, unknown> };
    const yamlRawImport = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter?version=3.0.0`,
      headers: { ...sameOrigin, 'content-type': 'application/yaml' },
      payload: stringifyYaml(yamlEnvelope.definition),
    });
    expect(yamlRawImport.statusCode).toBe(200);
    const yamlRoundTrip = await server.app.inject({
      method: 'GET',
      url: `/internal/providers/${customProvider.id}/adapter/export?format=yaml`,
      headers: sameOrigin,
    });
    expect(yamlRoundTrip.statusCode).toBe(200);
    expect((parseYaml(yamlRoundTrip.body) as { version?: string }).version).toBe('3.0.0');

    const adminEnabledQuery = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter?adminEnabled=true`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: revision.definition,
    });
    const unknownQuery = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter?unexpected=true`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: revision.definition,
    });
    expect(adminEnabledQuery.statusCode).toBe(400);
    expect(unknownQuery.statusCode).toBe(400);

    const request = createMockGenerationRequest({
      extra: { style: 'clean' },
      modelId: 'image-model',
      providerId: customProvider.id,
    });
    const preview = await server.app.inject({
      method: 'POST',
      url: `/internal/providers/${customProvider.id}/adapter/preview`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: { request },
    });
    const dryRun = await server.app.inject({
      method: 'POST',
      url: `/internal/providers/${customProvider.id}/adapter/dry-run`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: { request },
    });
    const pathTest = await server.app.inject({
      method: 'POST',
      url: `/internal/providers/${customProvider.id}/adapter/path-test`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: { json: { data: [{ id: 'result-id' }] }, path: '/data/0/id' },
    });
    const simulated = await server.app.inject({
      method: 'POST',
      url: `/internal/providers/${customProvider.id}/adapter/simulate`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: {
        response: { json: { data: [{ b64_json: 'aGVsbG8=', id: 'result-id' }] }, status: 200 },
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json<{ network: boolean; performed: boolean }>()).toMatchObject({ network: false, performed: false });
    expect(pathTest.statusCode).toBe(200);
    expect(simulated.statusCode).toBe(200);
    for (const response of [yamlExport, preview, dryRun, pathTest, simulated]) {
      expect(response.body).not.toContain('custom-secret');
    }

    const unsupported = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter`,
      headers: { ...sameOrigin, 'content-type': 'text/plain' },
      payload: '{}',
    });
    const oversized = await server.app.inject({
      method: 'PUT',
      url: `/internal/providers/${customProvider.id}/adapter`,
      headers: { ...sameOrigin, 'content-type': 'application/yaml' },
      payload: 'x'.repeat(128 * 1024 + 1),
    });
    expect(unsupported.statusCode).toBe(415);
    expect(oversized.statusCode).toBe(413);

    const trusted = await trustedJavaScriptRevision();
    const trustedProvider = server.providers.create({
      name: 'Management Trusted Provider',
      type: 'custom-js-v1',
    });
    const trustedPayload = multipartTrustedAdapter(trusted.manifest, trusted.source);
    const installed = await server.app.inject({
      method: 'POST',
      url: '/internal/adapters/trusted-javascript',
      headers: { ...sameOrigin, 'content-type': trustedPayload.contentType },
      payload: trustedPayload.body,
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.body).not.toContain(trusted.source.toString('utf8'));
    const listed = await server.app.inject({ method: 'GET', url: '/internal/adapters', headers: sameOrigin });
    const fetched = await server.app.inject({
      method: 'GET',
      url: `/internal/adapters/${trusted.ref.adapterId}`,
      headers: sameOrigin,
    });
    expect(listed.statusCode).toBe(200);
    expect(fetched.statusCode).toBe(200);
    expect(listed.body).not.toContain(trusted.source.toString('utf8'));
    expect(fetched.body).not.toContain(trusted.source.toString('utf8'));

    const bound = await server.app.inject({
      method: 'POST',
      url: `/internal/providers/${trustedProvider.id}/adapter/trusted-javascript`,
      headers: { ...sameOrigin, 'content-type': 'application/json' },
      payload: { ref: trusted.ref },
    });
    expect(bound.statusCode).toBe(201);

    await server.app.close();
    servers.splice(servers.indexOf(server), 1);
    const reopened = await reopenTestServer(dataDir, 'test-password');
    const restored = await reopened.app.inject({ method: 'GET', url: '/internal/adapters', headers: admin });
    expect(restored.statusCode).toBe(200);
    expect(restored.body).toContain(trusted.ref.adapterId);
    expect(reopened.adapterDefinitions.delete(trustedProvider.id, trusted.ref)).toBe(true);
    const removed = await reopened.app.inject({
      method: 'DELETE',
      url: `/internal/adapters/${trusted.ref.adapterId}`,
      headers: admin,
    });
    expect(removed.statusCode).toBe(204);
    const missing = await reopened.app.inject({
      method: 'GET',
      url: `/internal/adapters/${trusted.ref.adapterId}`,
      headers: admin,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('closes the runner, worker host, store, and database in order', async () => {
    const server = await createTestServer(false, false);
    const phases: string[] = [];
    vi.spyOn(server.runner, 'stop').mockImplementation(async () => {
      phases.push('runner');
    });
    vi.spyOn(server.adapterWorkerHost, 'close').mockImplementation(async () => {
      phases.push('worker');
    });
    vi.spyOn(server.adapterStore, 'close').mockImplementation(async () => {
      phases.push('store');
      expect(server.adapterDefinitions.getCurrent('missing')).toBeNull();
    });

    await server.app.close();
    expect(phases).toEqual(['runner', 'worker', 'store']);
    expect(() => server.adapterDefinitions.getCurrent('missing')).toThrow();
    servers.splice(servers.indexOf(server), 1);
  });

  it('continues resource cleanup when an earlier close step fails', async () => {
    const server = await createTestServer(false, false);
    const dataDir = temporaryDirectories.at(-1)!;
    const phases: string[] = [];
    vi.spyOn(server.runner, 'stop').mockRejectedValue(new Error('runner close failed'));
    vi.spyOn(server.adapterWorkerHost, 'close').mockImplementation(async () => {
      phases.push('worker');
    });
    vi.spyOn(server.adapterStore, 'close').mockImplementation(async () => {
      phases.push('store');
    });

    await expect(server.app.close()).rejects.toBeInstanceOf(AggregateError);
    expect(phases).toEqual(['worker', 'store']);
    expect(() => server.adapterDefinitions.getCurrent('missing')).toThrow();
    expect(await readFile(join(dataDir, '.offline-maintenance.lock'), 'utf8')).toContain('server-runtime-lease-v1');
    servers.splice(servers.indexOf(server), 1);
  });
});
