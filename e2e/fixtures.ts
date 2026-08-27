import { test as base, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import {
  basicAuthorizationHeader,
  E2E_BASE_URL,
  E2E_STORAGE_STATE,
} from './runtime.js';

/**
 * The built-in request fixture does not inherit browser storage state. Keep a
 * dedicated context so API setup has the same authenticated origin contract
 * as browser tests, with an explicit base URL for relative paths.
 */
export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: E2E_BASE_URL,
      extraHTTPHeaders: { Authorization: basicAuthorizationHeader() },
      storageState: E2E_STORAGE_STATE,
    });
    try {
      await use(context);
    } finally {
      await context.dispose();
    }
  },
});

export { expect };
export type { APIRequestContext, Locator, Page, Response, TestInfo } from '@playwright/test';
