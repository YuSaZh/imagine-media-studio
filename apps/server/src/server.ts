import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { createDatabase } from './database/client.js';
import { AssetRepository, JobRepository } from './database/jobs.js';
import { JobRunner } from './jobs/job-runner.js';
import { MockProviderAdapter } from './providers/mock-provider.js';
import { registerInternalRoutes } from './routes/internal.js';
import { ensureStorage, getStoragePaths } from './storage/paths.js';

export interface CreateServerOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDirectory?: string;
  startRunner?: boolean;
}

export interface ImagineServer {
  app: FastifyInstance;
  jobs: JobRepository;
  assets: AssetRepository;
  runner: JobRunner;
}

export async function createServer(options: CreateServerOptions): Promise<ImagineServer> {
  const storage = getStoragePaths(options.config.dataDir);
  await ensureStorage(storage);

  const database = createDatabase(storage.database, options.migrationsDirectory);
  const jobs = new JobRepository(database.orm);
  const assets = new AssetRepository(database.orm);
  const provider = new MockProviderAdapter();
  const runner = new JobRunner(jobs, assets, provider, storage);
  const app = Fastify({
    logger: options.logger ?? { level: options.config.logLevel },
  });
  let databaseClosed = false;

  app.addHook('onClose', async () => {
    await runner.stop();
    if (!databaseClosed) {
      database.sqlite.close();
      databaseClosed = true;
    }
  });

  try {
    await registerInternalRoutes(app, {
      jobs,
      runner,
      provider,
      mockProviderEnabled: options.config.mockProviderEnabled,
    });

    if (existsSync(options.config.webDistDir)) {
      await app.register(fastifyStatic, {
        root: options.config.webDistDir,
        wildcard: false,
      });
      app.setNotFoundHandler(async (request, reply) => {
        const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (
          request.method !== 'GET' ||
          /^\/internal(?:\/|$)/.test(pathname) ||
          !acceptsHtml
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply.sendFile('index.html');
      });
    }

    if ((options.startRunner ?? true) && options.config.mockProviderEnabled) {
      await runner.start();
    }
  } catch (error) {
    await app.close();
    throw error;
  }

  return { app, jobs, assets, runner };
}
