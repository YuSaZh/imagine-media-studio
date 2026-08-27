import { test as base, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import {
  basicAuthorizationHeader,
  E2E_BASE_URL,
} from './runtime.js';
import { apiRequestContextOptions } from './request-context-options.js';

/**
 * Keep API setup independent from browser cookies: the server-side test user
 * is authenticated explicitly with Basic auth and relative paths resolve
 * against the configured test origin.
 */
export const test = base.extend<{ request: APIRequestContext }>({
  request: async ({ playwright }, use) => {
    const context = await playwright.request.newContext(
      apiRequestContextOptions(E2E_BASE_URL, basicAuthorizationHeader()),
    );
    try {
      await use(context);
    } finally {
      await context.dispose();
    }
  },
});

export { expect };
export type { APIRequestContext, Locator, Page, Response, TestInfo } from '@playwright/test';
