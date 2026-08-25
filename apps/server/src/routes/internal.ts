import type { FastifyInstance } from 'fastify';

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
    version: '0.0.0',
    mockProviderEnabled: options.mockProviderEnabled,
  }));
}
