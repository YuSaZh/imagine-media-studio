import type { APIRequestContext } from '@playwright/test';

export const READINESS_ATTEMPTS = 120;
export const READINESS_REQUEST_TIMEOUT_MS = 250;
export const READINESS_RETRY_DELAY_MS = 250;

type ReadinessContext = Pick<APIRequestContext, 'get'>;
type Sleep = (delayMs: number) => Promise<void>;

const sleep: Sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export async function waitForServer(
  context: ReadinessContext,
  wait: Sleep = sleep,
): Promise<void> {
  let lastStatus = 'unavailable';
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    try {
      const response = await context.get('/internal/auth/status', {
        timeout: READINESS_REQUEST_TIMEOUT_MS,
      });
      lastStatus = String(response.status());
      if (response.ok()) return;
    } catch {
      // webServer can still be starting; keep the bounded readiness loop.
    }
    await wait(READINESS_RETRY_DELAY_MS);
  }
  throw new Error(`The Playwright webServer did not become ready (last status ${lastStatus}).`);
}
