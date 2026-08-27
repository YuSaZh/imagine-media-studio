import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from './fixtures.js';

const DESKTOP_PROJECT = 'pr1-desktop-1440x900';
const MOBILE_PROJECT = 'pr1-mobile-390x844';
const FULL_FLOW_PROJECTS = new Set([DESKTOP_PROJECT, MOBILE_PROJECT]);
const IMAGE_PATH = resolve('apps/web/public/mock-media/study-03-square.png');

interface AssetRecord {
  readonly contentUrl: string;
  readonly fileSize: number;
  readonly id: string;
  readonly mimeType: string;
  readonly posterUrl: string | null;
  readonly role: string;
  readonly type: string;
}

interface JobDetail {
  readonly assets: readonly AssetRecord[];
  readonly inputs: readonly { readonly assetId: string; readonly role: string }[];
  readonly job: {
    readonly errorMessage: string | null;
    readonly id: string;
    readonly status: string;
  };
}

interface AssetResponse {
  readonly asset: AssetRecord;
}

function isFullFlowProject(testInfo: TestInfo): boolean {
  return FULL_FLOW_PROJECTS.has(testInfo.project.name);
}

async function dismissPwaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible()) await dismiss.click();
}

async function uploadImage(
  request: APIRequestContext,
  role: 'first_frame' | 'reference' | 'upload',
  filename: string,
): Promise<AssetRecord> {
  const response = await request.post('/internal/assets/upload', {
    multipart: {
      role,
      file: {
        buffer: await readFile(IMAGE_PATH),
        mimeType: 'image/png',
        name: filename,
      },
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as AssetResponse).asset;
}

async function createVideoJob(
  request: APIRequestContext,
  operation: 'video.generate' | 'video.image_to_video' | 'video.reference_to_video',
  prompt: string,
  inputs: readonly { readonly assetId: string; readonly role: string }[],
): Promise<string> {
  const response = await request.post('/internal/jobs', {
    data: {
      aspectRatio: '16:9',
      count: 1,
      durationSeconds: 1,
      inputs,
      modelId: 'mock-video-v1',
      operation,
      prompt,
      providerId: 'mock',
      resolution: '720p',
    },
  });
  expect(response.status()).toBe(202);
  return ((await response.json()) as { readonly job: { readonly id: string } }).job.id;
}

async function waitForCompletedJob(
  request: APIRequestContext,
  jobId: string,
): Promise<JobDetail> {
  let detail: JobDetail | null = null;
  await expect.poll(async () => {
    const response = await request.get(`/internal/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok()) return `http-${response.status()}`;
    detail = (await response.json()) as JobDetail;
    return detail.job.status;
  }, { timeout: 30_000 }).toBe('completed');
  if (detail === null) throw new Error(`Job ${jobId} completed without a detail response.`);
  return detail;
}

async function assertMediaRoutes(
  request: APIRequestContext,
  asset: AssetRecord,
): Promise<void> {
  expect(asset.type).toBe('video');
  expect(asset.mimeType).toBe('video/mp4');
  expect(asset.posterUrl).not.toBeNull();

  const head = await request.head(asset.contentUrl);
  expect(head.status()).toBe(200);
  expect(head.headers()['content-type']).toContain('video/mp4');
  expect(head.headers()['content-length']).toBe(String(asset.fileSize));
  expect(head.headers()['accept-ranges']).toBe('bytes');
  expect(await head.body()).toHaveLength(0);

  const range = await request.get(asset.contentUrl, {
    headers: { Range: 'bytes=0-7' },
  });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toBe(`bytes 0-7/${asset.fileSize}`);
  expect((await range.body()).byteLength).toBe(8);

  const staleIfRange = await request.get(asset.contentUrl, {
    headers: { 'If-Range': '"stale-etag"', Range: 'bytes=0-7' },
  });
  expect(staleIfRange.status()).toBe(200);
  expect((await staleIfRange.body()).byteLength).toBe(asset.fileSize);

  const unsatisfiable = await request.get(asset.contentUrl, {
    headers: { Range: `bytes=${asset.fileSize}-` },
  });
  expect(unsatisfiable.status()).toBe(416);
  expect(unsatisfiable.headers()['content-range']).toBe(`bytes */${asset.fileSize}`);

  const poster = await request.get(asset.posterUrl!);
  expect(poster.status()).toBe(200);
  expect(poster.headers()['content-type']).toBe('image/jpeg');
  expect((await poster.body()).byteLength).toBeGreaterThan(0);
}

async function clickCardAction(
  page: Page,
  card: ReturnType<Page['locator']>,
  action: 'Cancel' | 'Retry',
): Promise<void> {
  const directAction = card.getByRole('button', { name: action, exact: true });
  if (await directAction.isVisible()) {
    await directAction.click();
    return;
  }
  await card.getByRole('button', { name: 'Card actions', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.keyboard.press('Escape');
}

async function revealGalleryItem(page: Page, itemId: string): Promise<void> {
  const item = page.locator(`[data-item-id="${itemId}"]`);
  if (await item.count() === 0) {
    await page.locator('.page-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
  }
  await expect(item).toBeAttached();
}

async function ensureServiceWorkerControl(page: Page): Promise<boolean> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (await page.evaluate(() => navigator.serviceWorker.controller !== null)) return false;

  await page.reload();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  return true;
}

test('lists all PR5 video profiles and the compatible OpenAI warning', async ({ page }) => {
  await page.goto('/settings/providers');
  await dismissPwaNotice(page);
  await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const profile = dialog.getByRole('combobox', { name: 'Provider profile', exact: true });
  for (const value of [
    'openai-videos-v1-compatible',
    'gemini-veo-operation-v1',
    'gemini-omni-interactions-video-v1',
    'xai-imagine-video-v1',
  ]) {
    await expect(profile.locator(`option[value="${value}"]`)).toHaveCount(1);
    await profile.selectOption(value);
    await expect(profile).toHaveValue(value);
  }
  await profile.selectOption('openai-videos-v1-compatible');
  await expect(dialog.getByText('Base URL (required)', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/scheduled to shut down/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close provider editor', exact: true }).click();
});

test('keeps the PR5 video fixture transitions safe at every viewport', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
  await page.goto('/imagine');
  await dismissPwaNotice(page);

  await page.locator('.gallery-filter').getByRole('button', { name: 'Videos', exact: true }).click();
  const active = page.locator('[data-item-id="video-07"]');
  await expect(active).toBeVisible();
  await clickCardAction(page, active, 'Cancel');
  await expect(active).toHaveClass(/status-cancelled/);
  await expect(active).toContainText('Cancelled');

  const failed = page.locator('[data-item-id="video-08"]');
  await expect(failed).toBeVisible();
  await clickCardAction(page, failed, 'Retry');
  await expect(failed).toHaveClass(/status-queued/);
  await expect(failed).toContainText('Waiting in queue');

  await page.locator('.gallery-filter').getByRole('button', { name: 'Failed', exact: true }).click();
  const expired = page.locator('[data-item-id="image-28"]');
  await expect(expired).toBeVisible();
  await clickCardAction(page, expired, 'Retry');
  await page.locator('.gallery-filter').getByRole('button', { name: 'All', exact: true }).click();
  await revealGalleryItem(page, 'image-28');
  await expect(expired).toHaveClass(/status-queued/);
  await expect(expired).toContainText('Waiting in queue');

  const artifactDirectory = resolve('artifacts/visual/pr5');
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(artifactDirectory, `${testInfo.project.name.replace(/^pr1-/, '')}.png`),
  });
});

test('generates Mock text, image, and reference videos with durable media delivery', async ({
  page,
  request,
}, testInfo) => {
  test.skip(!isFullFlowProject(testInfo), 'The complete persistent video flow runs once on desktop and mobile.');
  const runId = randomUUID().slice(0, 8);

  const textJobId = await createVideoJob(request, 'video.generate', `PR5 text video ${runId}`, []);
  const textDetail = await waitForCompletedJob(request, textJobId);
  expect(textDetail.inputs).toEqual([]);
  expect(textDetail.assets).toHaveLength(1);

  const firstFrame = await uploadImage(request, 'first_frame', `pr5-first-frame-${runId}.png`);
  expect(firstFrame.role).toBe('first_frame');
  const imageJobId = await createVideoJob(
    request,
    'video.image_to_video',
    `PR5 image video ${runId}`,
    [{ assetId: firstFrame.id, role: 'first_frame' }],
  );
  const imageDetail = await waitForCompletedJob(request, imageJobId);
  expect(imageDetail.inputs).toHaveLength(1);
  expect(imageDetail.inputs.map(({ assetId, role }) => ({ assetId, role }))).toEqual([
    { assetId: firstFrame.id, role: 'first_frame' },
  ]);
  expect(imageDetail.assets).toHaveLength(1);

  const referenceA = await uploadImage(request, 'reference', `pr5-reference-a-${runId}.png`);
  const referenceB = await uploadImage(request, 'reference', `pr5-reference-b-${runId}.png`);
  const referenceJobId = await createVideoJob(
    request,
    'video.reference_to_video',
    `PR5 reference video ${runId}`,
    [
      { assetId: referenceA.id, role: 'reference' },
      { assetId: referenceB.id, role: 'reference' },
    ],
  );
  const referenceDetail = await waitForCompletedJob(request, referenceJobId);
  expect(referenceDetail.inputs).toHaveLength(2);
  expect(referenceDetail.inputs.map(({ assetId, role }) => ({ assetId, role }))).toEqual([
    { assetId: referenceA.id, role: 'reference' },
    { assetId: referenceB.id, role: 'reference' },
  ]);
  expect(referenceDetail.assets).toHaveLength(1);

  const output = textDetail.assets[0]!;
  await assertMediaRoutes(request, output);

  await page.goto('/imagine');
  await dismissPwaNotice(page);
  await page.reload();
  await dismissPwaNotice(page);
  const outputCard = page.locator(`[data-item-id="${output.id}"]`);
  await expect(outputCard).toBeVisible({ timeout: 30_000 });
  await outputCard.locator('.media-card-open').click();
  const video = page.locator('video.viewer-media');
  await expect(video).toHaveCount(1);
  const videoAttributes = await video.evaluate((element) => ({
    controls: element.hasAttribute('controls'),
    playsInline: element.hasAttribute('playsinline'),
    poster: element.getAttribute('poster'),
    source: element.getAttribute('src'),
  }));
  expect(videoAttributes.controls).toBe(true);
  expect(videoAttributes.playsInline).toBe(true);
  expect(videoAttributes.poster).toContain(`/internal/assets/${output.id}/poster`);
  expect(videoAttributes.source).toContain(`/internal/assets/${output.id}/content`);
  const download = page.getByRole('link', { name: 'Download video', exact: true });
  await expect(download).toHaveAttribute('href', new RegExp(`/internal/assets/${output.id}/content`));
  const [downloadedVideo] = await Promise.all([
    page.waitForEvent('download'),
    download.click(),
  ]);
  expect(downloadedVideo.suggestedFilename()).toBe(`${output.id}-video.mp4`);

  const reloadedForServiceWorker = await ensureServiceWorkerControl(page);
  if (reloadedForServiceWorker) {
    await dismissPwaNotice(page);
    await page.goto('/imagine');
    await dismissPwaNotice(page);
    const restoredOutputCard = page.locator(`[data-item-id="${output.id}"]`);
    await expect(restoredOutputCard).toBeVisible({ timeout: 30_000 });
    await restoredOutputCard.locator('.media-card-open').click();
    await expect(page.locator('video.viewer-media')).toHaveCount(1);
  }
  const serviceWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(serviceWorkerUrl).not.toBeNull();
  const serviceWorker = await request.get(serviceWorkerUrl!);
  expect(serviceWorker.ok()).toBeTruthy();
  const serviceWorkerSource = await serviceWorker.text();
  expect(serviceWorkerSource).toContain('imagine-derived-media-v1');
  expect(serviceWorkerSource).not.toContain('mock-media/');
  expect(serviceWorkerSource).not.toContain('.mp4');

  const cacheProbe = await page.evaluate(async ({ contentUrl, posterUrl }) => {
    const cache = await caches.open('imagine-derived-media-v1');
    const absolutePoster = new URL(posterUrl, location.origin).href;
    await cache.delete(absolutePoster);
    const authProbeResponse = await fetch(posterUrl, {
      headers: { Authorization: 'Bearer e2e-cache-probe' },
    });
    const authProbeCached = (await cache.match(absolutePoster)) !== undefined;
    const queryPosterUrl = `${posterUrl}?cache-probe=${crypto.randomUUID()}`;
    const queryResponse = await fetch(queryPosterUrl);
    const queryPosterCached = (await cache.match(queryPosterUrl)) !== undefined;
    const posterResponse = await fetch(posterUrl);
    const rangeResponse = await fetch(contentUrl, { headers: { Range: 'bytes=0-7' } });
    return {
      authProbeCached,
      authProbeStatus: authProbeResponse.status,
      posterStatus: posterResponse.status,
      queryPosterUrl,
      queryPosterCached,
      queryPosterStatus: queryResponse.status,
      rangeStatus: rangeResponse.status,
    };
  }, { contentUrl: output.contentUrl, posterUrl: output.posterUrl! });
  expect(cacheProbe.posterStatus).toBe(200);
  expect(cacheProbe.rangeStatus).toBe(206);
  expect(cacheProbe.authProbeStatus).toBe(200);
  expect(cacheProbe.authProbeCached).toBe(false);
  expect(cacheProbe.queryPosterStatus).toBe(200);
  expect(cacheProbe.queryPosterCached).toBe(false);
  await expect.poll(async () => page.evaluate(async (posterUrl) => {
    const cache = await caches.open('imagine-derived-media-v1');
    return (await cache.match(new URL(posterUrl, location.origin).href)) !== undefined;
  }, output.posterUrl!)).toBe(true);
  const cacheContents = await page.evaluate(async ({ contentUrl, queryPosterUrl }) => {
    const entries: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) entries.push(request.url);
    }
    return {
      contentCached: entries.includes(new URL(contentUrl, location.origin).href),
      queryPosterCached: entries.includes(new URL(queryPosterUrl, location.origin).href),
    };
  }, { contentUrl: output.contentUrl, queryPosterUrl: cacheProbe.queryPosterUrl });
  expect(cacheContents.contentCached).toBe(false);
  expect(cacheContents.queryPosterCached).toBe(false);

  await page.context().setOffline(true);
  try {
    const offlineContent = await page.evaluate(async (contentUrl) => {
      try {
        const response = await fetch(contentUrl);
        return { ok: true, status: response.status };
      } catch {
        return { ok: false, status: null };
      }
    }, output.contentUrl);
    expect(offlineContent).toEqual({ ok: false, status: null });
  } finally {
    await page.context().setOffline(false);
  }

  const artifactDirectory = resolve('artifacts/visual/pr5');
  await mkdir(artifactDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(artifactDirectory, `${testInfo.project.name.replace(/^pr1-/, '')}-generated.png`),
  });
});
