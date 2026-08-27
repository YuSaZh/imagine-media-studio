import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { loadConfig } from './config.js';
import { createServer } from './server.js';

export async function listenWithCleanup(
  app: FastifyInstance,
  options: { readonly host: string; readonly port: number },
): Promise<void> {
  try {
    await app.listen(options);
  } catch (error) {
    try {
      await app.close();
    } catch (closeError) {
      app.log.error(closeError);
    }
    throw error;
  }
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const { app } = await createServer({ config });

  const close = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };

  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());

  try {
    await listenWithCleanup(app, { host: '0.0.0.0', port: config.appPort });
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url;
}

if (isMainModule()) await startServer();
