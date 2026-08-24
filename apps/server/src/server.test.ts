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
): Promise<ImagineServer> {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'imagine-server-test-'));
  temporaryDirectories.push(dataDir);
  const webDistDir = resolve(dataDir, 'web-dist');
  if (withWebDist) {
    await mkdir(webDistDir);
    await writeFile(webDistDir + '/index.html', '<h1>Static App Shell fixture</h1>');
  }
  const config: AppConfig = {
    appPort: 3030,
    dataDir,
    logLevel: 'silent',
    mockProviderEnabled,
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

    const media = await readFile(
      resolve(temporaryDirectories.at(-1)!, 'media/originals', `${jobId}-0.png`),
    );
    expect(media.byteLength).toBeGreaterThan(0);
  });

  it('recovers a claimed Mock Job when a new runner starts', async () => {
    const first = await createTestServer(false);
    const queued = first.jobs.create(createMockGenerationRequest({ prompt: 'Recover me' }));
    expect(first.jobs.claimQueued(queued.id)?.status).toBe('submitting');
    const dataDir = temporaryDirectories.at(-1)!;
    await first.app.close();
    servers.splice(servers.indexOf(first), 1);

    const second = await createServer({
      config: {
        appPort: 3030,
        dataDir,
        logLevel: 'silent',
        mockProviderEnabled: true,
        webDistDir: resolve(dataDir, 'missing-web-dist'),
      },
      logger: false,
      migrationsDirectory,
    });
    servers.push(second);

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
});
