import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const { app } = await createServer({ config });

const close = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

try {
  await app.listen({ host: '0.0.0.0', port: config.appPort });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
