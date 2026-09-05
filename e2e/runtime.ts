import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const DEFAULT_E2E_PORT = 3030;
export const MIN_E2E_PORT = 1024;
export const MAX_E2E_PORT = 65535;

function isVitestProcess(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return env.VITEST !== undefined || argv.some((argument) => {
    const name = basename(argument);
    return name === 'vitest' || name.startsWith('vitest.');
  });
}

function isPlaywrightList(argv: readonly string[]): boolean {
  return argv.some((argument) => argument === '--list' || argument.startsWith('--list='));
}

export function configuredPort(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): number {
  const requested = env.E2E_PORT?.trim();
  if (!requested) {
    const isCi = env.CI === 'true' || env.CI === '1';
    if (isCi || isVitestProcess(argv, env) || isPlaywrightList(argv)) return DEFAULT_E2E_PORT;
    throw new Error('E2E_PORT must be set for local Playwright runs.');
  }
  const port = Number(requested);
  if (!Number.isInteger(port) || port < MIN_E2E_PORT || port > MAX_E2E_PORT) {
    throw new Error(`E2E_PORT must be an integer between ${MIN_E2E_PORT} and ${MAX_E2E_PORT}.`);
  }
  return port;
}

export const E2E_PORT = configuredPort();
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATA_PREFIX = 'imagine-media-studio-e2e-';
export const E2E_DEFAULT_PASSWORD = 'pr6-e2e-password-not-production';

const requestedPassword = process.env.APP_PASSWORD;
export const E2E_PASSWORD = requestedPassword !== undefined && requestedPassword.length > 0
  ? requestedPassword
  : E2E_DEFAULT_PASSWORD;

function dataDirectory(): string {
  const root = resolve(tmpdir());
  const requested = process.env.IMAGINE_E2E_DATA_DIR?.trim();
  if (requested !== undefined && requested.length > 0) {
    const candidate = resolve(requested);
    if (dirname(candidate) !== root || !basename(candidate).startsWith(E2E_DATA_PREFIX)) {
      throw new Error(`IMAGINE_E2E_DATA_DIR must be a direct child of ${root} with prefix ${E2E_DATA_PREFIX}.`);
    }
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    return candidate;
  }
  return mkdtempSync(join(root, E2E_DATA_PREFIX));
}

export const E2E_DATA_DIR = dataDirectory();
process.env.IMAGINE_E2E_DATA_DIR = E2E_DATA_DIR;
export const E2E_STORAGE_STATE = resolve(E2E_DATA_DIR, 'storage-state.json');

export function basicAuthorizationHeader(): string {
  return `Basic ${Buffer.from(`admin:${E2E_PASSWORD}`, 'utf8').toString('base64')}`;
}
