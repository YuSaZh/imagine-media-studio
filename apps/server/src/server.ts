import { existsSync } from 'node:fs';

import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { AdapterStore } from './adapters/index.js';
import {
  AdapterWorkerHost,
  createSafeHttpPort,
  type AdapterWorkerFactory,
} from './adapters/worker-host.js';
import type { AppConfig } from './config.js';
import { ProviderAdapterDefinitionRepository } from './database/adapter-definitions.js';
import { AssetRepository } from './database/assets.js';
import { createDatabase, type DatabaseClient } from './database/client.js';
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
import { DatabaseBackup } from './maintenance/database-backup.js';
import { acquireServerRuntimeLease, type ServerRuntimeLease } from './maintenance/runtime-lock.js';
import { MediaRepairQueueRepository } from './database/media-repair.js';
import { AssetMediaRepositoryAdapter } from './media/asset-media-repository-adapter.js';
import { AssetMediaService } from './media/asset-media-service.js';
import { SharpImageProcessor } from './media/image-processor.js';
import {
  cleanupTerminalProviderOutputs,
  inspectMediaConsistency,
} from './media/maintenance.js';
import { MediaRepairCoordinator } from './media/media-repair-coordinator.js';
import { MediaRepairWorker } from './media/media-repair-worker.js';
import { VideoProcessor } from './media/video-processor.js';
import {
  createProviderHttpClient,
  type ProviderHttpClient,
  type ProviderHttpExecutor,
} from './providers/provider-http-client.js';
import { ProviderRegistry, type ProviderHttpClientFactory } from './providers/provider-registry.js';
import { ProviderInputLoader } from './providers/provider-input-loader.js';
import { ProviderService } from './providers/provider-service.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdapterRoutes } from './routes/adapters.js';
import { registerEventRoutes } from './routes/events.js';
import {
  registerErrorHandler,
  registerRawDocumentParsers,
  SERVER_BODY_LIMIT,
} from './routes/error.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerResourceRoutes } from './routes/resources.js';
import {
  MaintenanceUnauthenticatedError,
  registerMaintenanceRoutes,
} from './routes/maintenance.js';
import { NetworkPolicy } from './security/network-policy.js';
import { RemoteMediaDownloader } from './security/remote-download.js';
import { SafeHttpTransport } from './security/safe-http-transport.js';
import { SecretVault } from './security/secret-vault.js';
import { PasswordAuth } from './security/password-auth.js';
import { PublicInputLinks } from './security/public-input-links.js';
import { registerPublicInputRoutes } from './routes/public-inputs.js';
import { CustomAdapterService } from './services/custom-adapter-service.js';
import { TrustedAdapterService } from './services/trusted-adapter-service.js';
import { ensureStorage, getStoragePaths } from './storage/paths.js';

export interface CreateServerOptions {
  config: AppConfig;
  logger?: boolean;
  migrationsDirectory?: string;
  startRunner?: boolean;
  providerHttpExecutor?: ProviderHttpExecutor;
  adapterWorkerFactory?: AdapterWorkerFactory;
}

/** Internal adapter management view; runtime source stays behind runtimeReader. */
export type AdapterStoreManagement = Pick<AdapterStore, 'close' | 'get' | 'install' | 'list' | 'remove'>;

export type CustomAdapterServiceManagement = Pick<
  CustomAdapterService,
  | 'capabilities'
  | 'delete'
  | 'disable'
  | 'dryRun'
  | 'export'
  | 'get'
  | 'preview'
  | 'replace'
  | 'simulateResponse'
  | 'testPath'
  | 'validate'
>;

export type TrustedAdapterServiceManagement = Pick<
  TrustedAdapterService,
  'bind' | 'close' | 'get' | 'install' | 'list' | 'remove'
>;

export interface ImagineServer {
  app: FastifyInstance;
  databaseBackup: DatabaseBackup;
  adapterDefinitions: ProviderAdapterDefinitionRepository;
  adapterStore: AdapterStoreManagement;
  customAdapterService: CustomAdapterServiceManagement;
  adapterWorkerHost: Pick<AdapterWorkerHost, 'close'>;
  jobs: JobRepository;
  assets: AssetRepository;
  collections: CollectionRepository;
  mediaRepairQueue: MediaRepairQueueRepository;
  providers: ProviderService;
  settings: SettingsRepository;
  trustedAdapterService: TrustedAdapterServiceManagement;
  runner: JobRunner;
}

const PUBLIC_INTERNAL_PATHS = new Set([
  '/internal/health',
  '/internal/auth/status',
  '/internal/auth/login',
]);

function hasHeaderValue(value: string | string[] | undefined, expected: string): boolean {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.some((item) => item.trim().toLowerCase() === expected);
}

function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function scopedProviderHttpFactory(
  config: AppConfig,
  fallback: ProviderHttpClient,
  executor: ProviderHttpExecutor | undefined,
): ProviderHttpClientFactory {
  return (provider) => {
    if (provider.type !== 'custom-http-v1') return fallback;
    if (provider.baseUrl === null) {
      throw new Error('Custom HTTP providers require a Base URL.');
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(provider.baseUrl);
    } catch {
      throw new Error('Custom HTTP provider Base URL is invalid.');
    }
    const policy = new NetworkPolicy({
      allowInsecureHttp: config.allowInsecureProviderHttp,
      allowPrivateNetwork: config.allowPrivateNetworkAccess,
      allowedHosts: [baseUrl.hostname],
      allowedPorts: [effectivePort(baseUrl)],
    });
    return createProviderHttpClient({
      policy,
      ...(executor === undefined ? {} : { executor }),
    });
  };
}

async function closeInOrder(
  steps: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    const result = (await Promise.allSettled([Promise.resolve().then(step)]))[0]!;
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more server resources failed to close.');
  }
}

interface ResourceLedger {
  database?: DatabaseClient;
  databaseBackup?: DatabaseBackup;
  runtimeLease?: ServerRuntimeLease;
  adapterStore?: AdapterStore;
  adapterWorkerHost?: AdapterWorkerHost;
  trustedAdapterService?: TrustedAdapterService;
  runner?: JobRunner;
  databaseClosed: boolean;
  dataUsersClosed: boolean;
  closePromise?: Promise<void>;
}

function closeCreatedResources(ledger: ResourceLedger): Promise<void> {
  if (ledger.closePromise !== undefined) return ledger.closePromise;
  const steps: Array<() => Promise<void> | void> = [];
  if (ledger.runner !== undefined) steps.push(() => ledger.runner!.stop());
  if (ledger.adapterWorkerHost !== undefined) steps.push(() => ledger.adapterWorkerHost!.close());
  if (ledger.trustedAdapterService !== undefined) {
    steps.push(() => ledger.trustedAdapterService!.close());
  } else if (ledger.adapterStore !== undefined) {
    steps.push(() => ledger.adapterStore!.close());
  }
  if (ledger.database !== undefined) {
    if (ledger.databaseBackup !== undefined) {
      steps.push(() => ledger.databaseBackup!.close());
    }
    const database = ledger.database;
    steps.push(() => {
      if (!ledger.databaseClosed) {
        database.sqlite.close();
        ledger.databaseClosed = true;
      }
    });
  }
  ledger.closePromise = (async () => {
    // closeInOrder deliberately attempts every data user so one failure does
    // not strand another resource. The gate is released only after all of
    // those close operations report success.
    await closeInOrder(steps);
    ledger.dataUsersClosed = true;
    if (ledger.runtimeLease !== undefined) await ledger.runtimeLease.release();
  })();
  return ledger.closePromise;
}

type OriginProtocol = 'http:' | 'https:';

interface NormalizedOrigin {
  readonly protocol: OriginProtocol;
  readonly hostname: string;
  readonly port: number;
}

function defaultOriginPort(protocol: OriginProtocol): number {
  return protocol === 'https:' ? 443 : 80;
}

function originProtocol(value: unknown): OriginProtocol | null {
  if (typeof value !== 'string') return null;
  const normalized = value.endsWith(':') ? value.toLowerCase() : `${value.toLowerCase()}:`;
  return normalized === 'http:' || normalized === 'https:'
    ? normalized
    : null;
}

function normalizeOriginUrl(value: string): NormalizedOrigin | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const protocol = originProtocol(parsed.protocol);
  if (
    protocol === null ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  const port = parsed.port === '' ? defaultOriginPort(protocol) : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || parsed.hostname === '') return null;
  return { hostname: parsed.hostname.toLowerCase(), port, protocol };
}

function requestOrigin(request: FastifyRequest): NormalizedOrigin | null {
  const protocol = originProtocol(request.protocol);
  const host = request.host;
  if (protocol === null || typeof host !== 'string' || host === '') return null;
  return normalizeOriginUrl(`${protocol}//${host}`);
}

function isSameOriginWrite(request: FastifyRequest, origin: string): boolean {
  const expected = requestOrigin(request);
  const actual = normalizeOriginUrl(origin);
  return expected !== null && actual !== null &&
    expected.protocol === actual.protocol &&
    expected.hostname === actual.hostname &&
    expected.port === actual.port;
}

export async function createServer(options: CreateServerOptions): Promise<ImagineServer> {
  const storage = getStoragePaths(options.config.dataDir);
  const ledger: ResourceLedger = { databaseClosed: false, dataUsersClosed: false };
  let app: FastifyInstance | undefined;

  try {
    const runtimeLease = await acquireServerRuntimeLease(storage.root);
    ledger.runtimeLease = runtimeLease;
    await ensureStorage(storage);
    await runtimeLease.verify();

    const database = createDatabase(storage.database, options.migrationsDirectory);
    ledger.database = database;
  const databaseBackup = new DatabaseBackup({ paths: storage, sqlite: database.sqlite });
  ledger.databaseBackup = databaseBackup;
  const jobs = new JobRepository(database.orm);
  const assets = new AssetRepository(database.orm);
  const settings = new SettingsRepository(database.orm);
  const providerRepository = new ProviderRepository(database.orm);
  const models = new ModelRepository(database.orm);
  const inputResolver = new GenerationInputResolver(assets, models);
  const publicLinks = options.config.publicBaseUrl ? new PublicInputLinks(options.config.appSecret, options.config.publicBaseUrl) : undefined;
  const inputLoader = new ProviderInputLoader({
    ...(publicLinks ? { publicLinks } : {}),
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
  const providerNetworkPolicy = new NetworkPolicy({
    allowInsecureHttp: options.config.allowInsecureProviderHttp,
    allowPrivateNetwork: options.config.allowPrivateNetworkAccess,
  });
  const providerHttp = createProviderHttpClient({
    // Provider credentials must never be sent over the media-download HTTP
    // exception. Provider HTTP is independently opt-in and still uses the
    // private-network switch as a separate guard.
    policy: providerNetworkPolicy,
    ...(options.providerHttpExecutor === undefined ? {} : { executor: options.providerHttpExecutor }),
  });
  const adapterDefinitions = new ProviderAdapterDefinitionRepository(database.orm);
  const adapterStore = new AdapterStore(storage.adapters, {
    adminEnabled: passwordAuth.required,
    assertAdmin: () => undefined,
  });
  ledger.adapterStore = adapterStore;
  const adapterWorkerHost = new AdapterWorkerHost(
    adapterStore.runtimeReader(),
    createSafeHttpPort(providerHttp),
    options.adapterWorkerFactory,
  );
  ledger.adapterWorkerHost = adapterWorkerHost;
  const customAdapterService = new CustomAdapterService({
    providers: providerRepository,
    adapterDefinitions,
    authorization: {
      adminEnabled: passwordAuth.required,
      assertAdmin: () => undefined,
    },
    outbox,
  });
  const trustedAdapterService = new TrustedAdapterService({
    adminEnabled: passwordAuth.required,
    store: adapterStore,
    adapterDefinitions,
    providers: providerRepository,
    jobs,
    outbox,
  });
  ledger.trustedAdapterService = trustedAdapterService;
  const providerRegistry = new ProviderRegistry(providerRepository, vault, {
    adapterDefinitions,
    adapterWorkerHost,
    http: providerHttp,
    httpFactory: scopedProviderHttpFactory(
      options.config,
      providerHttp,
      options.providerHttpExecutor,
    ),
  });
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
  const providerRemoteDownloader = new RemoteMediaDownloader(
    new SafeHttpTransport({ policy: providerNetworkPolicy }),
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
    providerRemoteDownloader,
    remoteDownloader,
    repository: mediaRepository,
    videoProcessor,
  });
  const mediaAudit = {
    audit: () => inspectMediaConsistency({ jobs, paths: storage, repository: mediaRepository }),
  };
  const mediaRepairQueue = new MediaRepairQueueRepository(database.orm);
  const mediaRepairCoordinator = new MediaRepairCoordinator({
    audit: mediaAudit,
    queue: mediaRepairQueue,
  });
  const mediaRepairWorker = new MediaRepairWorker({
    assets: mediaRepository,
    imageProcessor,
    paths: storage,
    queue: mediaRepairQueue,
    videoProcessor,
  });
  const mediaMaintenance = {
    ...mediaAudit,
    listRepairs: () => mediaRepairCoordinator.listRepairs(),
    reconcile: () => mediaRepairCoordinator.reconcile(),
    runRepairs: () => mediaRepairWorker.run(),
  };
  await cleanupTerminalProviderOutputs({
    jobs,
    paths: storage,
    repository: mediaRepository,
  });
  await mediaRepairCoordinator.reconcile();
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
  ledger.runner = runner;
  app = Fastify({
    trustProxy: options.config.trustProxyHops ? (_address: string, hop: number) => hop < options.config.trustProxyHops! : false,
    bodyLimit: SERVER_BODY_LIMIT,
    logger: options.logger ?? { level: options.config.logLevel },
  });
  app.addHook('onClose', async () => {
    await closeCreatedResources(ledger);
  });
  registerRawDocumentParsers(app);
  registerErrorHandler(app);

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
        const fetchSite = request.headers['sec-fetch-site'];
        const fetchMode = request.headers['sec-fetch-mode'];
        const fetchDest = request.headers['sec-fetch-dest'];
        const hasCookie = request.headers.cookie !== undefined;
        const hasFetchMetadata = fetchSite !== undefined || fetchMode !== undefined || fetchDest !== undefined;
        const authorization = request.headers.authorization;
        const hasExplicitBasic = typeof authorization === 'string' && /^Basic\s+\S+$/iu.test(authorization);
        const nonBrowserBasic = hasExplicitBasic && !hasCookie && !hasFetchMetadata;

        if (hasHeaderValue(fetchSite, 'cross-site')) {
          return reply.code(403).send({
            error: 'cross_origin_write_denied',
            message: 'Cross-site writes are not allowed.',
          });
        }
        if (origin === undefined) {
          if (!nonBrowserBasic && (hasCookie || hasFetchMetadata)) {
            return reply.code(403).send({
              error: 'origin_required',
              message: 'An Origin header is required for browser writes.',
            });
          }
        } else if (typeof origin !== 'string') {
          return reply.code(403).send({ error: 'invalid_origin' });
        } else {
          if (normalizeOriginUrl(origin) === null || requestOrigin(request) === null) {
            return reply.code(403).send({ error: 'invalid_origin' });
          }
          if (!isSameOriginWrite(request, origin)) {
            return reply.code(403).send({
              error: 'cross_origin_write_denied',
              message: 'Cross-origin writes are not allowed.',
            });
          }
        }
      }
      const publicInternalPath = PUBLIC_INTERNAL_PATHS.has(pathname);
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
      reply.header('referrer-policy', request.url.startsWith('/media-inputs/') ? 'no-referrer' : 'same-origin');
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
    if (publicLinks) await registerPublicInputRoutes(app, { links: publicLinks, assets, dataRoot: storage.root });
    await registerMaintenanceRoutes(app, {
      authorization: {
        adminEnabled: passwordAuth.required,
        assertAdmin: (request) => {
          if (!passwordAuth.authenticated(request)) {
            throw new MaintenanceUnauthenticatedError();
          }
        },
      },
      backup: databaseBackup,
      media: mediaMaintenance,
      sqlite: database.sqlite,
    });
    await registerAdapterRoutes(app, {
      custom: customAdapterService,
      trusted: trustedAdapterService,
    });
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

    return {
      app,
      databaseBackup,
      adapterDefinitions,
      adapterStore,
      customAdapterService,
      adapterWorkerHost,
      jobs,
      assets,
      collections,
      mediaRepairQueue,
      providers: providerService,
      settings,
      trustedAdapterService,
      runner,
    };
  } catch (error) {
    if (app !== undefined) await app.close().catch(() => undefined);
    await closeCreatedResources(ledger).catch(() => undefined);
    throw error;
  }
}
