import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

test('serves the PR 0 App Shell and installable manifest', async ({ page, request }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Imagine Media Studio/);
  await expect(page.getByRole('heading', { name: 'Foundation ready.' })).toBeVisible();

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', /manifest/);
  const manifestPath = await manifestLink.getAttribute('href');
  const manifestResponse = await request.get(manifestPath!);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
    ]),
  );

  for (const icon of manifest.icons as Array<{ src: string; type: string }>) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.ok()).toBeTruthy();
    expect(iconResponse.headers()['content-type']).toContain(icon.type);
  }

  const serviceWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(serviceWorkerUrl).not.toBeNull();
  expect((await request.get(serviceWorkerUrl!)).ok()).toBeTruthy();

  const screenshotDirectory = resolve('artifacts/pr0');
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(screenshotDirectory, `${testInfo.project.name}.png`),
  });

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Foundation ready.' })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test('creates and completes a persistent Mock Job', async ({ request }) => {
  const created = await request.post('/internal/jobs', {
    data: {
      operation: 'image.generate',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'GitHub Actions PR 0 smoke fixture',
      inputs: [],
    },
  });
  expect(created.status()).toBe(202);
  const jobId = (await created.json()).job.id as string;

  await expect
    .poll(async () => {
      const response = await request.get(`/internal/jobs/${jobId}`);
      return (await response.json()).job.status as string;
    })
    .toBe('completed');
});
