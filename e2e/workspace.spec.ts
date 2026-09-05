import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';

async function upload(request: APIRequestContext, name = 'coast') {
  const response = await request.post('/internal/assets/upload', { multipart: {
    role: 'upload', file: { name: `${name}.webp`, mimeType: 'image/webp', buffer: await readFile(resolve(`e2e/media/${name}.webp`)) },
  } });
  expect(response.status()).toBe(201);
  return (await response.json()).asset as { id: string; contentUrl: string; thumbnailUrl: string };
}

async function open(page: Page, path = '/imagine') {
  await page.goto(path);
  await expect(page.locator('.workspace-header')).toBeVisible();
}

test.beforeEach(async ({ request, page }) => {
  const response = await request.get('/internal/assets?limit=100');
  for (const asset of (await response.json()).items) expect((await request.delete(`/internal/assets/${asset.id}`)).ok()).toBeTruthy();
  const collections = await request.get('/internal/collections?limit=100');
  for (const project of (await collections.json()).items) expect((await request.delete(`/internal/collections/${project.id}`)).ok()).toBeTruthy();
  const providers = await request.get('/internal/providers?limit=100');
  for (const provider of (await providers.json()).items) if (provider.name === 'Workspace adapter') expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy();
  expect((await request.patch('/internal/settings', { data: { values: { 'composer.default_mode': 'image', 'gallery.initial_filter': 'all', 'composer.clear_prompt_after_submit': true } } })).ok()).toBeTruthy();
  page.on('pageerror', error => { throw error; });
});

test('new workspace visual baseline and accessible responsive geometry', async ({ page, request }) => {
  for (const name of ['coast', 'mountain', 'architecture', 'botanical']) await upload(request, name);
  await open(page);
  await expect(page.locator('.study-card')).toHaveCount(4);
  await expect.poll(() => page.locator('.study-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 1))).toBe(true);
  await expect(page.locator('.creation-composer')).toBeVisible();
  await expect(page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '图片', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const form = await page.locator('.creation-composer').boundingBox();
  const viewport = page.viewportSize()!;
  expect(form!.x).toBeGreaterThanOrEqual(0);
  expect(form!.x + form!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(form!.y + form!.height).toBeLessThanOrEqual(viewport.height + 1);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page).toHaveScreenshot('workspace.png', { animations: 'disabled', maxDiffPixelRatio: .005 });
});

test('real image and video generation, original download, favorites and failure feedback', async ({ page, request }) => {
  await open(page);
  for (const mode of ['图片', '视频']) {
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: mode, exact: true }).click();
    const prompt = `workspace ${mode} generation ${randomUUID()}`;
    await page.getByLabel('创作描述', { exact: true }).fill(prompt);
    const submitted = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const response = await submitted;
    expect(response.status()).toBe(202);
    const job = (await (await request.get('/internal/jobs?limit=100')).json()).items.find((item: { prompt: string }) => item.prompt === prompt);
    expect(job).toBeDefined();
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).job.status, { timeout: 20000 }).toBe('completed');
    const detail = await (await request.get(`/internal/jobs/${job.id}`)).json();
    await expect(page.getByLabel('创作描述', { exact: true })).toHaveValue('');
    await expect(page.locator(`[data-study-id="${detail.assets[0].id}"]`)).toBeVisible();
    await page.locator(`[data-study-id="${detail.assets[0].id}"] .study-open`).click();
    await expect(page.getByRole('link', { name: '下载原文件' })).toHaveAttribute('href', detail.assets[0].contentUrl);
    const media = page.locator('.viewer-image');
    await expect(media).toHaveAttribute('src', detail.assets[0].contentUrl);
    if (mode === '视频') await expect.poll(() => media.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: '收藏作品', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消收藏', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
  }
  await open(page, '/saved');
  await expect(page.locator('.study-card')).toHaveCount(2);
  await page.route('**/internal/assets/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 500, json: { error: { code: 'test_failure', message: '收藏保存失败' } } }) : route.continue());
  await page.locator('.card-bookmark').first().click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.study-card')).toHaveCount(2);
});

test('project creation, membership, search, reload and deletion confirmation', async ({ page, request }) => {
  const asset = await upload(request);
  await open(page, '/projects');
  await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
  await page.getByLabel('项目名称', { exact: true }).fill('旅行创作');
  await page.getByRole('button', { name: '保存项目' }).click();
  await expect(page).toHaveURL(/\/projects\/.+/);
  const path = new URL(page.url()).pathname;
  await open(page, `/imagine?asset=${asset.id}`);
  await page.getByRole('button', { name: '作品信息', exact: true }).click();
  await page.getByRole('button', { name: '加入项目', exact: true }).click();
  await page.getByRole('button', { name: '旅行创作', exact: true }).click();
  await open(page, path);
  await expect(page.locator('.study-card')).toHaveCount(1);
  await page.getByLabel('搜索作品', { exact: true }).fill('missing');
  await expect(page.locator('.study-card')).toHaveCount(0);
  await page.getByLabel('搜索作品', { exact: true }).fill('coast');
  await expect(page.locator('.study-card')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.study-card')).toHaveCount(1);
  await page.locator('.study-open').click();
  await page.getByRole('button', { name: '作品信息', exact: true }).click();
  await page.getByRole('button', { name: '删除作品', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '删除 1 件作品？' })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(200);
});

test('reference upload, canvas mask and server-backed edit submission', async ({ page, request }) => {
  await open(page);
  await page.getByLabel('上传参考图', { exact: true }).setInputFiles(resolve('e2e/media/coast.webp'));
  await expect(page.locator('.reference.upload-ready')).toBeVisible();
  await expect(page.locator('.study-card')).toHaveCount(1);
  await page.locator('.study-open').click();
  await page.getByRole('button', { name: '局部编辑', exact: true }).click();
  await expect(page.locator('.mask-source')).toBeVisible();
  await expect.poll(() => page.locator('.mask-source').evaluate(canvas => {
    const data = (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data;
    return data.some((value, index) => index % 4 !== 3 && value > 20);
  })).toBe(true);
  const box = (await page.locator('.mask-stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 8 }); await page.mouse.up();
  await expect(page.getByRole('button', { name: '撤销笔画' })).toBeEnabled();
  await page.getByRole('button', { name: '撤销笔画' }).click();
  await expect(page.getByRole('button', { name: '应用蒙版' })).toBeDisabled();
  await page.getByRole('button', { name: '重做笔画' }).click();
  await page.getByRole('button', { name: '应用蒙版' }).click();
  await expect(page.locator('.mask-workspace')).toHaveCount(0);
  await expect(page.locator('.reference')).toHaveCount(2);
  await page.getByLabel('创作描述', { exact: true }).fill('edit masked coast');
  const response = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(202);
  const { job } = await result.json();
  const detail = await (await request.get(`/internal/jobs/${job.id}`)).json();
  expect(detail.job.request.operation).toBe('image.edit');
  expect(detail.job.request.inputs.map((input: { role: string }) => input.role).sort()).toEqual(['mask', 'source']);
});

test('connections, persisted preferences and canonical legacy entry', async ({ page, request }) => {
  await open(page, '/settings/providers');
  await page.getByRole('region', { name: '连接 Mock Provider', exact: true }).getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接测试通过');
  await open(page, '/settings');
  await page.getByLabel('默认创作类型', { exact: true }).selectOption('video');
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['composer.default_mode']).toBe('video');
  await page.reload();
  await expect(page.getByLabel('默认创作类型', { exact: true })).toHaveValue('video');
  await open(page, '/interaction.html');
  await expect(page).toHaveURL(/\/imagine$/);
  await expect(page.locator('.creation-composer')).toBeVisible();
  await expect(page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '视频', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('创作描述', { exact: true }).fill('persist this draft');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByLabel('创作描述', { exact: true })).toHaveValue('persist this draft');
});

test('provider editor protects secrets and custom adapter management persists a real definition', async ({ page, request }) => {
  await open(page, '/settings/providers');
  await page.getByRole('button', { name: '添加连接', exact: true }).first().click();
  await page.getByLabel('连接名称', { exact: true }).fill('Workspace adapter');
  await page.getByLabel('接口类型', { exact: true }).selectOption('custom-http-v1');
  await page.getByLabel('Base URL', { exact: true }).fill('https://api.example.com');
  const secret = 'workspace-test-secret-not-production';
  await page.getByLabel('API Key', { exact: true }).fill(secret);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  const created = page.waitForResponse(response => response.url().endsWith('/internal/providers') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  expect(await response.text()).not.toContain(secret);
  const { provider } = await response.json();
  expect(provider.hasApiKey).toBe(true);
  await expect(page.getByLabel('适配器定义', { exact: true })).toBeVisible();
  await page.getByLabel('适配器定义', { exact: true }).fill(await readFile(resolve('examples/custom-providers/sync-image.json'), 'utf8'));
  const saved = page.waitForResponse(response => response.url().includes(`/internal/providers/${provider.id}/adapter`) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存定义', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.getByRole('tab', { name: '版本记录', exact: true }).click();
  await expect(page.locator('.adapter-revision').first()).toBeVisible();
  await open(page, '/settings/providers');
  await page.getByRole('button', { name: '编辑连接 Workspace adapter', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy();
});

test.describe('PWA', () => {
test.use({ serviceWorkers: 'allow' });
test('installed cache retains real previews and drafts while offline', async ({ page, request, context }) => {
  await upload(request);
  await open(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.locator('.study-card img')).toBeVisible();
  await expect.poll(() => page.locator('.study-card img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(1);
  await page.getByLabel('创作描述', { exact: true }).fill('offline draft');
  await page.waitForTimeout(700);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByLabel('创作描述', { exact: true })).toHaveValue('offline draft');
  await expect(page.getByRole('button', { name: '开始生成', exact: true })).toBeDisabled();
  await expect(page.locator('.study-card img')).toBeVisible();
  await expect.poll(() => page.locator('.study-card img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(1);
  await context.setOffline(false);
});
});
