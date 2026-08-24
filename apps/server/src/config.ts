import { resolve } from 'node:path';

import { z } from 'zod';

const EnvironmentSchema = z.object({
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(3030),
  DATA_DIR: z.string().min(1).default('/data'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  MOCK_PROVIDER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  WEB_DIST_DIR: z.string().optional(),
});

export interface AppConfig {
  appPort: number;
  dataDir: string;
  logLevel: string;
  mockProviderEnabled: boolean;
  webDistDir: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(environment);

  return {
    appPort: parsed.APP_PORT,
    dataDir: resolve(parsed.DATA_DIR),
    logLevel: parsed.LOG_LEVEL,
    mockProviderEnabled: parsed.MOCK_PROVIDER_ENABLED,
    webDistDir: resolve(parsed.WEB_DIST_DIR ?? 'apps/web/dist'),
  };
}
