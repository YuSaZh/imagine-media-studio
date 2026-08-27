import { describe, expect, it } from 'vitest';

import { apiRequestContextOptions } from './request-context-options.js';

describe('Playwright API request context options', () => {
  it('uses Basic auth without inheriting browser cookies', () => {
    expect(apiRequestContextOptions('http://127.0.0.1:3030', 'Basic credentials')).toEqual({
      baseURL: 'http://127.0.0.1:3030',
      extraHTTPHeaders: { Authorization: 'Basic credentials' },
      storageState: { cookies: [], origins: [] },
    });
  });
});
