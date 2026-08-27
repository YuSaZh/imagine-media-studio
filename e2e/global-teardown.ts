import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { E2E_DATA_DIR, E2E_DATA_PREFIX } from './runtime.js';

export default async function globalTeardown(): Promise<void> {
  const root = resolve(tmpdir());
  const directory = resolve(E2E_DATA_DIR);
  if (dirname(directory) !== root || !basename(directory).startsWith(E2E_DATA_PREFIX)) {
    throw new Error('Refusing to clean a Playwright data directory outside the validated E2E prefix.');
  }
  await rm(directory, { force: true, recursive: true });
}
