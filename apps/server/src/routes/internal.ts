import type { FastifyInstance } from 'fastify';

import { APP_VERSION } from '../version.js';

interface InternalRoutesOptions {
  mockProviderEnabled: boolean;
}

export async function registerInternalRoutes(
  app: FastifyInstance,
  options: InternalRoutesOptions,
): Promise<void> {
  app.get('/internal/health', async () => ({
    status: 'ok',
    database: 'ok',
  }));

  app.get('/internal/app-info', async () => ({
    name: 'Imagine Media Studio',
    version: APP_VERSION,
    mockProviderEnabled: options.mockProviderEnabled,
  }));
}
