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
  page: async ({ page }, use, testInfo) => {
    try { await use(page); }
    finally {
      // Complete in-flight interception while the page/request context is still alive.
      // Successful tests drain handlers. Failed tests already retain their original error;
      // detach pending handlers so a timed-out test cannot deadlock its own teardown.
      if (!page.isClosed()) await page.unrouteAll({ behavior: testInfo.status === testInfo.expectedStatus ? 'wait' : 'ignoreErrors' });
    }
  },
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
