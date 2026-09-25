import type { APIResponse, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelDto } from '@imagine/shared';
import { expect, type APIRequestContext, type Page } from './fixtures.js';

// Buffer actual HTTP responses before fulfilling them to the browser. This avoids
// Chromium CDP body eviction during the editor's rapid media/layout updates.
export async function capturePost(page: Page, path: string) {
  let resolve!: (response: APIResponse) => void;
  let reject!: (error: unknown) => void;
  let captured = false;
  const response = new Promise<APIResponse>((yes, no) => { resolve = yes; reject = no; });
  const pattern = `**${path}`;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST' || captured) { await route.continue(); return; }
    captured = true;
    try {
      const upstream = await route.fetch();
      await upstream.body();
      await route.fulfill({ response: upstream });
      // Keep routing enabled until context cleanup: removing the last route
      // here can leave Chromium's fulfilled response body unfinished.
      resolve(upstream);
    } catch (error) { reject(error); }
  };
  await page.route(pattern, handler);
  return { response };
}

export async function upload(request: APIRequestContext, name = 'coast') {
  const response = await request.post('/internal/assets/upload', { multipart: {
    role: 'upload', file: { name: `${name}.webp`, mimeType: 'image/webp', buffer: await readFile(resolve(`e2e/media/${name}.webp`)) },
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).asset as { id: string; contentUrl: string; thumbnailUrl: string };
}

export async function open(page: Page, path = '/imagine', expandComposer = true) {
  await page.goto(path);
  await expect(page.locator('.workspace-header')).toBeVisible();
  // Toolbar scenarios start with the same explicit focus that reveals it on phones.
  if (expandComposer && page.viewportSize()!.width <= 760 && !new URL(page.url()).searchParams.has('asset')) {
    const prompt = page.locator('.composer-main textarea');
    if (await prompt.count()) await prompt.focus();
  }
}

export async function focusEditingPrompt(page: Page) {
  await expect(page.locator('.mask-workspace')).toHaveCount(0);
  await page.locator('.image-editing-controls').getByLabel('创作描述', { exact: true }).click();
}

export async function chooseRatio(page: Page, value: string) {
  await page.getByRole('button', { name: '画幅', exact: true }).click();
  await page.getByRole('button', { name: value, exact: true }).click();
}

export async function selectValue(page: Page, label: string, value: string | { label: string }) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  if (typeof value === 'string') await page.getByRole('listbox', { name: label, exact: true }).locator(`[role="option"][value=${JSON.stringify(value)}]`).click();
  else await page.getByRole('option', { name: value.label, exact: true }).click();
  await expect(page.getByRole('listbox', { name: label, exact: true })).toHaveCount(0);
}

export async function chooseResolution(page: Page, value: string) {
  await page.getByRole('button', { name: '分辨率', exact: true }).click();
  await page.getByRole('button', { name: value === 'custom' ? '自定义' : value, exact: true }).click();
}

export async function chooseCount(page: Page, value: string) {
  await page.getByRole('button', { name: '生成数量', exact: true }).click();
  if (['1', '2', '4', '8'].includes(value)) await page.locator('.count-segments').getByRole('button', { name: value, exact: true }).click();
  else {
    await page.getByRole('button', { name: '自定义生成数量', exact: true }).click();
    await page.getByLabel('自定义张数', { exact: true }).fill(value);
    await page.getByRole('button', { name: '应用', exact: true }).click();
  }
  await expect(page.locator('.count-options')).toHaveCount(0);
}

export async function savedModelOptions(request: APIRequestContext, providerId: string, name: string, mode: 'image' | 'video', options: object) {
  const { items } = await (await request.get('/internal/models?limit=100')).json();
  const model = (items as ModelDto[]).find(model => model.providerId === providerId && model.displayName === name)!;
  await expect.poll(async () => {
    const memory = (await (await request.get('/internal/settings')).json()).settings['generation.default']?.[mode];
    return { selected: memory?.selected, options: memory?.models?.[model.id] };
  }).toMatchObject({ selected: model.id, options });
}

export async function resetWorkspace(request: APIRequestContext, page: Page) {
  const response = await request.get('/internal/assets?limit=100');
  for (const asset of (await response.json()).items) expect((await request.delete(`/internal/assets/${asset.id}`)).ok()).toBeTruthy();
  const collections = await request.get('/internal/collections?limit=100');
  for (const project of (await collections.json()).items) expect((await request.delete(`/internal/collections/${project.id}`)).ok()).toBeTruthy();
  const providers = await request.get('/internal/providers?limit=100');
  for (const provider of (await providers.json()).items) if (provider.name === 'Workspace adapter') expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy();
  // Existing lineage fixtures include their uploaded originals explicitly.
  expect((await request.patch('/internal/settings', { data: { values: { 'branding.name': 'Imagine.', 'branding.logo': '', 'gallery.group_by_series': false, 'gallery.group_concurrent_images': false, 'gallery.group_uploaded_references': true, 'gallery.series_cover': 'latest', 'gallery.series_last_viewed': {}, 'generation.default': {}, 'composer.default_mode': 'image', 'ui.theme': 'light', 'ui.language': 'zh-CN', 'gallery.initial_filter': 'all', 'composer.clear_prompt_after_submit': true } } })).ok()).toBeTruthy();
  page.on('pageerror', error => { throw error; });
}

/** A real touch hold consumes its release click, then leaves selection empty for callers. */
export async function enterSelection(page: Page) {
  if (page.viewportSize()!.width >= 761) {
    await page.getByRole('button', { name: '选择作品', exact: true }).click();
    return;
  }
  const target = page.locator('.study-open').filter({ has: page.locator('img') }).first();
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await expect(page.locator('.batch-toolbar')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await target.click();
  await expect(page.locator('.batch-toolbar')).toContainText('已选 0 件');
}

export async function searchGallery(page: Page, value: string) {
  if (page.viewportSize()!.width < 761 && !await page.locator('.workspace-header').evaluate(element => element.classList.contains('is-searching'))) {
    await page.getByRole('button', { name: '搜索作品', exact: true }).click();
  }
  await page.getByRole('textbox', { name: '搜索作品', exact: true }).fill(value);
}
