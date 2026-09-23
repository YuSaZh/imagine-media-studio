import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect } from './fixtures.js';
import { resetWorkspace, upload, open } from './workspace-helpers.js';

test.beforeEach(async ({ request, page }) => resetWorkspace(request, page));

test('editor exit shrinks the current image into its gallery card while the workspace fades in', async ({ page, request }, testInfo) => {
  const asset = await upload(request, 'coast');
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'never' } } });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (document.documentElement.dataset.pauseViewerExit === 'true') animation.pause();
      return animation;
    };
  });
  await open(page);
  const thumbnail = page.locator(`[data-study-id="${asset.id}"] .study-open > img`);
  await expect.poll(() => thumbnail.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await thumbnail.click();
  await expect(page.locator('.viewer-entry-layer')).toHaveCount(0);
  const image = page.locator('.viewer-stage > .viewer-image');
  await expect(image).toHaveAttribute('data-image-quality', 'original');
  const start = (await image.boundingBox())!;
  await page.evaluate(() => { document.documentElement.dataset.pauseViewerExit = 'true'; });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  const layer = page.locator('.viewer-exit-layer');
  await expect(layer).toBeVisible();
  const from = (await layer.boundingBox())!, target = (await thumbnail.boundingBox())!;
  expect(from.x).toBeCloseTo(start.x, 0); expect(from.y).toBeCloseTo(start.y, 0);
  expect(from.width).toBeCloseTo(start.width, 0); expect(from.height).toBeCloseTo(start.height, 0);
  await expect(image).toHaveCSS('visibility', 'hidden');
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => { a.currentTime = 160; }));
  await expect(page.locator('.imagine-app')).toHaveCSS('opacity', '0.5');
  await expect(page.locator('.study-viewer')).toHaveCSS('opacity', '0.5');
  expect((await layer.boundingBox())!.width).toBeGreaterThan(target.width);
  expect((await layer.boundingBox())!.width).toBeLessThan(start.width);
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('editor-exit-midpoint.png') });
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => { a.currentTime = 320; }));
  const end = (await layer.boundingBox())!;
  expect(end.x).toBeCloseTo(target.x, 0); expect(end.y).toBeCloseTo(target.y, 0);
  expect(end.width).toBeCloseTo(target.width, 0); expect(end.height).toBeCloseTo(target.height, 0);
  await page.evaluate(() => { delete document.documentElement.dataset.pauseViewerExit; document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => a.play()); });
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
  await expect(thumbnail).toHaveCSS('visibility', 'visible');
  await expect(page.locator('.imagine-app')).toHaveCSS('opacity', '1');
  await expect(page).not.toHaveURL(/asset=/);
});

test('video editor exit captures the current decoded frame', async ({ page, request }) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const response = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'exit-video.mp4', mimeType: 'video/mp4', buffer: await readFile(resolve('fixtures/providers/mock/mock-video-v1/tiny.mp4')) } } });
  expect(response.status()).toBe(201);
  const asset = (await response.json()).asset as { id: string };
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'never' } } });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
  });
  await open(page, `/imagine?asset=${asset.id}`);
  const video = page.locator('video.viewer-image');
  await expect.poll(async () => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThan(1);
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.viewer-exit-layer canvas')).toHaveCount(1);
  await page.evaluate(() => document.getAnimations().filter(animation => animation.id.startsWith('viewer-exit-')).forEach(animation => animation.play()));
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
});

test('editor exit respects reduced motion and cleans up interrupted exits', async ({ page, request }) => {
  const asset = await upload(request, 'coast');
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'never' } } });
  await open(page);
  const card = page.locator(`[data-study-id="${asset.id}"]`);
  await card.locator('.study-open').click();
  await expect(page.locator('.viewer-stage > .viewer-image')).toHaveAttribute('data-image-quality', 'original');
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
  });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.viewer-exit-layer')).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.reduceMotion = 'always'; });
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
  await expect(card.locator('img')).toHaveCSS('visibility', 'visible');
  await card.locator('.study-open').click();
  await expect(page.locator('.study-viewer')).toBeVisible();
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.viewerExit)).toBeUndefined();
});

test('editor exit restores an offscreen virtual card and falls back when no gallery target exists', async ({ page, request }) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const asset = await upload(request, 'coast');
  for (let index = 0; index < 44; index++) await upload(request, 'architecture');
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'always' } } });
  await open(page, `/imagine?asset=${asset.id}`);
  await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
  await expect(page.locator(`[data-study-id="${asset.id}"]`)).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = 'never';
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
  });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.viewer-exit-layer')).toBeVisible();
  const thumbnail = page.locator(`[data-study-id="${asset.id}"] .study-open > img`);
  const destination = (await thumbnail.boundingBox())!;
  expect(destination.y).toBeLessThan(page.viewportSize()!.height);
  expect(destination.y + destination.height).toBeGreaterThan(0);
  await page.setViewportSize({ width: page.viewportSize()!.width + 1, height: page.viewportSize()!.height });
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
  await expect(thumbnail).toHaveCSS('visibility', 'visible');
  // A direct-linked image outside the active filter has no card to shrink into.
  await request.patch('/internal/settings', { data: { values: { 'gallery.initial_filter': 'video', 'ui.reduce_motion': 'never' } } });
  await open(page, `/imagine?asset=${asset.id}`);
  await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
  await expect(page.locator('.study-card')).toHaveCount(0);
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
  });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-viewer-exit', 'fading');
  await expect(page.locator('.viewer-exit-layer')).toHaveCount(0);
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => { a.currentTime = 160; }));
  await expect(page.locator('.imagine-app')).toHaveCSS('opacity', '0.5');
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => a.play()));
  await expect(page.locator('.study-viewer')).toHaveCount(0);
});

test('editor exit targets the grouped series cover after switching to a generated member', async ({ page, request }) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const source = await upload(request, 'coast');
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Series exit fixture', inputs: [{ assetId: source.id, role: 'source' }] } });
  const { job } = await response.json();
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const output = (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0];
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.series_cover': 'original', 'ui.reduce_motion': 'never' } } });
  await open(page, `/imagine?asset=${output.id}`);
  await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
  await expect(page.locator(`[data-study-id="${output.id}"]`)).toHaveCount(0);
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { const animation = animate.apply(this, args); animation.pause(); return animation; };
  });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  const layer = page.locator('.viewer-exit-layer');
  await expect(layer).toBeVisible();
  const cover = (await page.locator(`[data-study-id="${source.id}"] .study-open > img`).boundingBox())!;
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => { a.currentTime = 320; }));
  expect((await layer.boundingBox())!.x).toBeCloseTo(cover.x, 0);
  expect((await layer.boundingBox())!.width).toBeCloseTo(cover.width, 0);
  await page.evaluate(() => document.getAnimations().filter(a => a.id.startsWith('viewer-exit-')).forEach(a => a.play()));
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
});

test('editor exit never reveals a faded modal again during final handoff', async ({ page, request }) => {
  const asset = await upload(request, 'coast');
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'never' } } });
  await open(page);
  await page.locator(`[data-study-id="${asset.id}"] .study-open`).click();
  await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
  await expect(page.locator('.viewer-entry-layer')).toHaveCount(0);
  await page.evaluate(() => {
    const records: { id: string; connected: boolean; before: string; after: string }[] = [];
    const cancel = Animation.prototype.cancel;
    Animation.prototype.cancel = function () {
      const target = (this.effect as KeyframeEffect | null)?.target;
      const before = target instanceof Element ? getComputedStyle(target).opacity : '';
      cancel.call(this);
      if (this.id.startsWith('viewer-exit-') && target instanceof Element) records.push({ id: this.id, connected: target.isConnected, before, after: getComputedStyle(target).opacity });
      document.documentElement.dataset.exitHandoff = JSON.stringify(records);
    };
  });
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.study-viewer')).toHaveCount(0);
  const records = await page.evaluate(() => JSON.parse(document.documentElement.dataset.exitHandoff ?? '[]') as { id: string; connected: boolean; before: string; after: string }[]);
  expect(records.filter(record => ['viewer-exit-editor', 'viewer-exit-backdrop'].includes(record.id) && record.connected && Number(record.after) > Number(record.before))).toEqual([]);
});


test('editor exit centers within natural scroll bounds without changing gallery layout', async ({ page, request }) => {
  const assets = [];
  for (let index = 0; index < 25; index++) assets.push(await upload(request, 'coast'));
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'never' } } });
  await open(page);
  const ordered = (await (await request.get('/internal/assets?limit=60')).json()).items as { id: string }[];
  const scroll = page.locator(page.viewportSize()!.width > 760 ? '.gallery-scroll' : '.workspace');
  const gridHeight = await page.locator('.study-grid').evaluate(el => el.getBoundingClientRect().height);
  for (const asset of [ordered[0]!, ordered[12]!, ordered.at(-1)!]) {
    // Keep focus on a different card, as when browsing to a new item in the editor.
    await page.locator('.study-open').first().focus();
    await page.evaluate(id => { const next = new URL(location.href); next.searchParams.set('asset', id); history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, asset.id);
    await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
    const thumbnail = page.locator(`[data-study-id="${asset.id}"] .study-open > img`);
    await expect(thumbnail).toBeVisible();
    const viewport = (await scroll.boundingBox())!;
    await expect.poll(async () => {
      const box = (await thumbnail.boundingBox())!;
      const delta = box.y + box.height / 2 - viewport.y - viewport.height / 2;
      const position = await scroll.evaluate(el => ({ top: el.scrollTop, maximum: el.scrollHeight - el.clientHeight }));
      return Math.min(Math.abs(delta), delta < 0 ? Math.abs(position.top) : Math.abs(position.maximum - position.top));
    }).toBeLessThanOrEqual(2);
    expect(await page.locator('.study-grid').evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(gridHeight, 0);
  }
});


test('reduced-motion editor exit preserves a short gallery without artificial spacing', async ({ page, request }) => {
  const asset = await upload(request, 'coast');
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'always' } } });
  await open(page, `/imagine?asset=${asset.id}`);
  await expect(page.locator('.viewer-image')).toHaveAttribute('data-image-quality', 'original');
  const thumbnail = page.locator(`[data-study-id="${asset.id}"] .study-open > img`);
  const before = (await thumbnail.boundingBox())!;
  const height = await page.locator('.study-grid').evaluate(el => el.getBoundingClientRect().height);
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.study-viewer,.viewer-exit-layer')).toHaveCount(0);
  expect((await thumbnail.boundingBox())!.y).toBeCloseTo(before.y, 0);
  expect(await page.locator('.study-grid').evaluate(el => el.getBoundingClientRect().height)).toBeCloseTo(height, 0);
});
