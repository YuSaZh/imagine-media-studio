import { existsSync } from 'node:fs';

import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { AssetRepository } from './database/assets.js';
import { createDatabase } from './database/client.js';
import { CollectionRepository } from './database/collections.js';
import { ChangeEventRepository } from './database/events.js';
import { JobRepository } from './database/jobs.js';
import { ModelRepository } from './database/models.js';
import { ProviderRepository } from './database/providers.js';
import { SettingsRepository } from './database/settings.js';
import { EventBroker } from './events/event-broker.js';
import { OutboxPublisher } from './events/outbox-publisher.js';
import { JobRunner } from './jobs/job-runner.js';
import { GenerationInputResolver } from './jobs/generation-input-resolver.js';
import { createSqliteRunnerOptions } from './jobs/sqlite-adapters.js';
import { AssetMediaRepositoryAdapter } from './media/asset-media-repository-adapter.js';
import { AssetMediaService } from './media/asset-media-service.js';
import { SharpImageProcessor } from './media/image-processor.js';
import { VideoProcessor } from './media/video-processor.js';
import {
  createProviderHttpClient,
  type ProviderHttpExecutor,
} from './providers/provider-http-client.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import { ProviderInputLoader } from './providers/provider-input-loader.js';
import { ProviderService } from './providers/provider-service.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerResourceRoutes } from './routes/resources.js';
import { NetworkPolicy } from './security/network-policy.js';
import { RemoteMediaDownloader } from './security/remote-download.js';
import { SafeHttpTransport } from './security/safe-http-transport.js';
import { SecretVault } from './security/secret-vault.js';
import { PasswordAuth } from './security/password-auth.js';
import { ensureStorage, getStoragePaths } from './storage/paths.js';

export interface CreateServerOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDirectory?: string;
  startRunner?: boolean;
  providerHttpExecutor?: ProviderHttpExecutor;
}

export interface ImagineServer {
  app: FastifyInstance;
  jobs: JobRepository;
  assets: AssetRepository;
  collections: CollectionRepository;
  providers: ProviderService;
  settings: SettingsRepository;
  runner: JobRunner;
}

export async function createServer(options: CreateServerOptions): Promise<ImagineServer> {
  const storage = getStoragePaths(options.config.dataDir);
  await ensureStorage(storage);

  const database = createDatabase(storage.database, options.migrationsDirectory);
  const jobs = new JobRepository(database.orm);
  const assets = new AssetRepository(database.orm);
  const settings = new SettingsRepository(database.orm);
  const providerRepository = new ProviderRepository(database.orm);
  const models = new ModelRepository(database.orm);
  const inputResolver = new GenerationInputResolver(assets, models);
  const inputLoader = new ProviderInputLoader({
    assets,
    dataRoot: storage.root,
    maxBytesPerFile: options.config.providerInputMaxBytesPerFile,
    maxTotalBytes: options.config.providerInputMaxTotalBytes,
  });
  const collections = new CollectionRepository(database.orm);
  const changeEvents = new ChangeEventRepository(database.orm);
  const broker = new EventBroker();
  const outbox = new OutboxPublisher(changeEvents, broker);
  const vault = new SecretVault(options.config.appSecret);
  const passwordAuth = new PasswordAuth({
    appSecret: options.config.appSecret,
    password: options.config.appPassword,
  });
  const networkPolicy = new NetworkPolicy({
    allowInsecureHttp: options.config.allowHttpMediaDownloads,
    allowPrivateNetwork: options.config.allowPrivateNetworkAccess,
  });
  const providerHttp = createProviderHttpClient({
    // Provider credentials must never be sent over the media-download HTTP
    // exception. Provider HTTP is independently opt-in and still uses the
    // private-network switch as a separate guard.
    policy: new NetworkPolicy({
      allowInsecureHttp: options.config.allowInsecureProviderHttp,
      allowPrivateNetwork: options.config.allowPrivateNetworkAccess,
    }),
    ...(options.providerHttpExecutor === undefined ? {} : { executor: options.providerHttpExecutor }),
  });
  const providerRegistry = new ProviderRegistry(providerRepository, vault, { http: providerHttp });
  const providerService = new ProviderService(
    providerRepository,
    models,
    vault,
    providerRegistry,
  );
  const mediaRepository = new AssetMediaRepositoryAdapter(assets);
  const imageProcessor = new SharpImageProcessor();
  const videoProcessor = new VideoProcessor({
    posterTimeoutMs: options.config.mediaProcessTimeoutMs,
    probeTimeoutMs: Math.min(options.config.mediaProcessTimeoutMs, 15_000),
  });
  const remoteDownloader = new RemoteMediaDownloader(
    new SafeHttpTransport({ policy: networkPolicy }),
  );
  const uploadMedia = new AssetMediaService({
    imageProcessor,
    maxImageBytes: options.config.maxImageUploadBytes,
    maxVideoBytes: options.config.maxVideoUploadBytes,
    paths: storage,
    repository: mediaRepository,
    videoProcessor,
  });
  const providerResultMedia = new AssetMediaService({
    imageProcessor,
    maxImageBytes: options.config.maxRemoteImageBytes,
    maxVideoBytes: options.config.maxRemoteVideoBytes,
    paths: storage,
    remoteDownloader,
    repository: mediaRepository,
    videoProcessor,
  });
  const runner = new JobRunner({
    ...createSqliteRunnerOptions({
      jobs,
      changeEvents,
      broker: outbox,
      providers: providerRegistry,
      media: providerResultMedia,
    }),
    inputLoader,
  });
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
    await app.register(fastifyMultipart, {
      limits: {
        files: 1,
        fileSize: Math.max(
          options.config.maxImageUploadBytes,
          options.config.maxVideoUploadBytes,
        ),
        fields: 8,
        parts: 9,
      },
    });
    app.addHook('onRequest', async (request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        const origin = request.headers.origin;
        const host = request.headers.host;
        if (origin && host) {
          let originHost: string;
          try {
            originHost = new URL(origin).host;
          } catch {
            return reply.code(403).send({ error: 'invalid_origin' });
          }
          if (originHost !== host) return reply.code(403).send({ error: 'cross_origin_write_denied' });
        }
      }
      const publicInternalPath =
        pathname === '/internal/health' || pathname.startsWith('/internal/auth/');
      if (
        passwordAuth.required &&
        /^\/internal(?:\/|$)/.test(pathname) &&
        !publicInternalPath &&
        !passwordAuth.authenticated(request)
      ) {
        reply.header('www-authenticate', 'Basic realm="Imagine Media Studio", charset="UTF-8"');
        return reply.code(401).send({
          error: 'authentication_required',
          message: 'Enter the application password to continue.',
        });
      }
    });
    app.addHook('onSend', async (request, reply, payload) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('referrer-policy', 'same-origin');
      reply.header('x-frame-options', 'DENY');
      reply.header(
        'content-security-policy',
        [
          "default-src 'self'",
          "base-uri 'self'",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
        ].join('; '),
      );
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (/^\/internal(?:\/|$)/.test(pathname) && !pathname.includes('/content')) {
        reply.header('cache-control', 'no-store');
      }
      return payload;
    });

    if (options.config.mockProviderEnabled) {
      const mockProvider = providerService.ensureMockProvider();
      if (mockProvider.enabled) await providerService.refreshModels('mock');
    }
    outbox.flush();
    await registerAuthRoutes(app, passwordAuth);
    await registerInternalRoutes(app, {
      mockProviderEnabled: options.config.mockProviderEnabled,
    });
    await registerProviderRoutes(app, {
      outbox,
      providers: providerService,
    });
    await registerResourceRoutes(app, {
      assets,
      collections,
      jobs,
      inputResolver,
      inputLoader,
      media: uploadMedia,
      models,
      outbox,
      providers: providerRegistry,
      runner,
      settings,
      storage,
      maxUploadBytes: Math.max(
        options.config.maxImageUploadBytes,
        options.config.maxVideoUploadBytes,
      ),
    });
    await registerEventRoutes(app, changeEvents, broker);

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

    if (options.startRunner ?? true) {
      await runner.start();
    }
  } catch (error) {
    await app.close();
    throw error;
  }

  return { app, jobs, assets, collections, providers: providerService, settings, runner };
}
