import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, request as playwrightRequest } from '@playwright/test';

import {
  E2E_BASE_URL,
  E2E_PASSWORD,
  E2E_STORAGE_STATE,
} from './runtime.js';

const VISUAL_VIEWPORTS = [
  'desktop-1920x1080',
  'desktop-1440x900',
  'desktop-1280x800',
  'tablet-1024x1366',
  'tablet-834x1112',
  'mobile-430x932',
  'mobile-390x844',
  'mobile-360x800',
] as const;

async function waitForServer(context: Awaited<ReturnType<typeof playwrightRequest.newContext>>): Promise<void> {
  let lastStatus = 'unavailable';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await context.get('/internal/auth/status');
      lastStatus = String(response.status());
      if (response.ok()) return;
    } catch {
      // webServer can still be starting; keep the bounded readiness loop.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`The Playwright webServer did not become ready (last status ${lastStatus}).`);
}

async function writeVisualReport(): Promise<void> {
  const directory = resolve('artifacts/visual/pr6');
  await mkdir(directory, { recursive: true });
  const rows = VISUAL_VIEWPORTS.map((viewport) => `| ${viewport} | responsive workspace | baseline pending; CI artifact only |`).join('\n');
  await writeFile(
    resolve(directory, 'visual-diff-report.md'),
    `# PR6 visual diff report\n\nNo local pixel comparison was run. CI screenshots are recorded for review against the approved baseline policy. Dynamic opaque Provider identifiers are masked with the neutral surface color only; functional state and secret-handling output are not masked.\n\n| Viewport | State | Baseline / diff |\n| --- | --- | --- |\n${rows}\n`,
    'utf8',
  );
}

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
    await writeVisualReport();
  } finally {
    await context.dispose();
  }
}
