import { describe, expect, it } from 'vitest';

import {
  configuredPort,
  DEFAULT_E2E_PORT,
  MAX_E2E_PORT,
  MIN_E2E_PORT,
} from './runtime.js';

describe('Playwright runtime port selection', () => {
  it('requires an explicit port for a local browser run', () => {
    expect(() => configuredPort({}, ['playwright', 'test'])).toThrow(
      'E2E_PORT must be set for local Playwright runs.',
    );
  });

  it('keeps static listing, Vitest, and CI safe on the default port', () => {
    expect(configuredPort({}, ['playwright', 'test', '--list'])).toBe(DEFAULT_E2E_PORT);
    expect(configuredPort({ VITEST: 'true' }, ['vitest', 'run'])).toBe(DEFAULT_E2E_PORT);
    expect(configuredPort({ CI: 'true' }, ['playwright', 'test'])).toBe(DEFAULT_E2E_PORT);
  });

  it('preserves the bounded explicit port range', () => {
    expect(configuredPort({ E2E_PORT: String(MIN_E2E_PORT) }, [])).toBe(MIN_E2E_PORT);
    expect(configuredPort({ E2E_PORT: String(MAX_E2E_PORT) }, [])).toBe(MAX_E2E_PORT);
    expect(() => configuredPort({ E2E_PORT: String(MIN_E2E_PORT - 1) }, [])).toThrow(
      `E2E_PORT must be an integer between ${MIN_E2E_PORT} and ${MAX_E2E_PORT}.`,
    );
    expect(() => configuredPort({ E2E_PORT: String(MAX_E2E_PORT + 1) }, [])).toThrow(
      `E2E_PORT must be an integer between ${MIN_E2E_PORT} and ${MAX_E2E_PORT}.`,
    );
    expect(() => configuredPort({ E2E_PORT: 'not-a-port' }, [])).toThrow(
      `E2E_PORT must be an integer between ${MIN_E2E_PORT} and ${MAX_E2E_PORT}.`,
    );
  });
});
