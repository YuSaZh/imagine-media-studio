
import { expect, request as playwrightRequest } from '@playwright/test';

import {
  E2E_BASE_URL,
  E2E_PASSWORD,
  E2E_STORAGE_STATE,
} from './runtime.js';
import { waitForServer } from './readiness.js';


export default async function globalSetup(): Promise<void> {
  const context = await playwrightRequest.newContext({ baseURL: E2E_BASE_URL });
  try {
    await waitForServer(context);
    const status = await context.get('/internal/auth/status');
    expect(status.ok()).toBeTruthy();
    const statusBody = await status.json() as { readonly required?: boolean };
    expect(statusBody.required).toBe(true);

    const login = await context.post('/internal/auth/login', { data: { password: E2E_PASSWORD } });
    expect(login.status()).toBe(200);
    await context.storageState({ path: E2E_STORAGE_STATE });
  } finally {
    await context.dispose();
  }
}
