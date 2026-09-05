import { resolve } from 'node:path';

import { z } from 'zod';

const EnvironmentSchema = z.object({
  ADMIN_USERNAME: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/).default('admin'),
  ADMIN_PASSWORD: z.string().min(1).max(1024).default('admin'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  PUBLIC_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }, 'PUBLIC_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.').optional()),
  ALLOW_HTTP_MEDIA_DOWNLOADS: z.enum(['true', 'false']).default('false'),
  ALLOW_INSECURE_PROVIDER_HTTP: z.enum(['true', 'false']).default('false'),
  ALLOW_PRIVATE_NETWORK_ACCESS: z.enum(['true', 'false']).default('false'),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3030),
  APP_PASSWORD: z.string().max(1024).default(''),
  APP_SECRET: z.string().min(16).default('development-only-app-secret'),
  DATA_DIR: z.string().min(1).default('/data'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MOCK_PROVIDER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MAX_IMAGE_UPLOAD_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  MAX_VIDEO_UPLOAD_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  MAX_REMOTE_IMAGE_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  MAX_REMOTE_VIDEO_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  PROVIDER_INPUT_MAX_BYTES_PER_FILE: z.coerce.number().int().positive().max(512 * 1024 * 1024).default(64 * 1024 * 1024),
  PROVIDER_INPUT_MAX_TOTAL_BYTES: z.coerce.number().int().positive().max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
  MEDIA_PROCESS_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  WEB_DIST_DIR: z.string().optional(),
});

export interface AppConfig {
  adminUsername?: string;
  adminPassword?: string;
  trustProxyHops?: number;
  publicBaseUrl?: string;
  allowHttpMediaDownloads: boolean;
  allowInsecureProviderHttp: boolean;
  allowPrivateNetworkAccess: boolean;
  appPort: number;
  appPassword: string | null;
  appSecret: string;
  dataDir: string;
  logLevel: string;
  maxImageUploadBytes: number;
  maxRemoteImageBytes: number;
  maxRemoteVideoBytes: number;
  maxVideoUploadBytes: number;
  providerInputMaxBytesPerFile: number;
  providerInputMaxTotalBytes: number;
  mediaProcessTimeoutMs: number;
  mockProviderEnabled: boolean;
  nodeEnvironment: 'development' | 'production' | 'test';
  webDistDir: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);
  if (parsed.PROVIDER_INPUT_MAX_BYTES_PER_FILE > parsed.PROVIDER_INPUT_MAX_TOTAL_BYTES) {
    throw new Error('PROVIDER_INPUT_MAX_BYTES_PER_FILE cannot exceed PROVIDER_INPUT_MAX_TOTAL_BYTES.');
  }
  if (
    parsed.NODE_ENV === 'production' &&
    (parsed.APP_SECRET.length < 32 ||
      parsed.APP_SECRET === 'replace-with-a-long-random-secret' ||
      parsed.APP_SECRET === 'development-only-app-secret')
  ) {
    throw new Error('Production requires APP_SECRET with at least 32 non-placeholder characters.');
  }

  return {
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    ...(parsed.TRUST_PROXY_HOPS > 0 ? { trustProxyHops: parsed.TRUST_PROXY_HOPS } : {}),
    ...(parsed.PUBLIC_BASE_URL ? { publicBaseUrl: parsed.PUBLIC_BASE_URL } : {}),
    allowHttpMediaDownloads: parsed.ALLOW_HTTP_MEDIA_DOWNLOADS === 'true',
    allowInsecureProviderHttp: parsed.ALLOW_INSECURE_PROVIDER_HTTP === 'true',
    allowPrivateNetworkAccess: parsed.ALLOW_PRIVATE_NETWORK_ACCESS === 'true',
    appPort: parsed.APP_PORT,
    appPassword: parsed.APP_PASSWORD.length === 0 ? null : parsed.APP_PASSWORD,
    appSecret: parsed.APP_SECRET,
    dataDir: resolve(parsed.DATA_DIR),
    logLevel: parsed.LOG_LEVEL,
    maxImageUploadBytes: parsed.MAX_IMAGE_UPLOAD_BYTES,
    maxRemoteImageBytes: parsed.MAX_REMOTE_IMAGE_BYTES,
    maxRemoteVideoBytes: parsed.MAX_REMOTE_VIDEO_BYTES,
    maxVideoUploadBytes: parsed.MAX_VIDEO_UPLOAD_BYTES,
    providerInputMaxBytesPerFile: parsed.PROVIDER_INPUT_MAX_BYTES_PER_FILE,
    providerInputMaxTotalBytes: parsed.PROVIDER_INPUT_MAX_TOTAL_BYTES,
    mediaProcessTimeoutMs: parsed.MEDIA_PROCESS_TIMEOUT_MS,
    mockProviderEnabled: parsed.MOCK_PROVIDER_ENABLED,
    nodeEnvironment: parsed.NODE_ENV,
    webDistDir: resolve(parsed.WEB_DIST_DIR ?? 'apps/web/dist'),
  };
}
