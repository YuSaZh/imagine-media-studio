import type { APIResponse, Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { ModelDto } from '@imagine/shared';
import { test, expect, type APIRequestContext, type Page } from './fixtures.js';

// Buffer actual HTTP responses before fulfilling them to the browser. This avoids
// Chromium CDP body eviction during the editor's rapid media/layout updates.
async function capturePost(page: Page, path: string) {
  let resolve!: (response: APIResponse) => void;
  let reject!: (error: unknown) => void;
  const response = new Promise<APIResponse>((yes, no) => { resolve = yes; reject = no; });
  const pattern = `**${path}`;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    try {
      const upstream = await route.fetch();
      await upstream.body();
      await route.fulfill({ response: upstream });
      await page.unroute(pattern, handler);
      resolve(upstream);
    } catch (error) { reject(error); }
  };
  await page.route(pattern, handler);
  return { response };
}

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

async function focusEditingPrompt(page: Page) {
  await expect(page.locator('.mask-workspace')).toHaveCount(0);
  await page.locator('.image-editing-controls').getByLabel('创作描述', { exact: true }).click();
}

async function chooseRatio(page: Page, value: string) {
  await page.getByRole('button', { name: '画幅', exact: true }).click();
  await page.getByRole('button', { name: value, exact: true }).click();
}

async function selectValue(page: Page, label: string, value: string | { label: string }) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  if (typeof value === 'string') await page.getByRole('listbox', { name: label, exact: true }).locator(`[role="option"][value=${JSON.stringify(value)}]`).click();
  else await page.getByRole('option', { name: value.label, exact: true }).click();
}

async function chooseResolution(page: Page, value: string) {
  await page.getByRole('button', { name: '分辨率', exact: true }).click();
  await page.getByRole('button', { name: value === 'custom' ? '自定义' : value, exact: true }).click();
}

async function chooseCount(page: Page, value: string) {
  await page.getByRole('button', { name: '生成数量', exact: true }).click();
  if (['1', '2', '4', '8'].includes(value)) await page.locator('.count-segments').getByRole('button', { name: value, exact: true }).click();
  else {
    await page.getByRole('button', { name: '自定义生成数量', exact: true }).click();
    await page.getByLabel('自定义张数', { exact: true }).fill(value);
    await page.getByRole('button', { name: '应用', exact: true }).click();
  }
}

async function savedModelOptions(request: APIRequestContext, providerId: string, name: string, mode: 'image' | 'video', options: object) {
  const { items } = await (await request.get('/internal/models?limit=100')).json();
  const model = (items as ModelDto[]).find(model => model.providerId === providerId && model.displayName === name)!;
  await expect.poll(async () => {
    const memory = (await (await request.get('/internal/settings')).json()).settings['generation.default']?.[mode];
    return { selected: memory?.selected, options: memory?.models?.[model.id] };
  }).toMatchObject({ selected: model.id, options });
}

test.beforeEach(async ({ request, page }) => {
  const response = await request.get('/internal/assets?limit=100');
  for (const asset of (await response.json()).items) expect((await request.delete(`/internal/assets/${asset.id}`)).ok()).toBeTruthy();
  const collections = await request.get('/internal/collections?limit=100');
  for (const project of (await collections.json()).items) expect((await request.delete(`/internal/collections/${project.id}`)).ok()).toBeTruthy();
  const providers = await request.get('/internal/providers?limit=100');
  for (const provider of (await providers.json()).items) if (provider.name === 'Workspace adapter') expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy();
  expect((await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': false, 'gallery.series_cover': 'latest', 'gallery.series_last_viewed': {}, 'generation.default': {}, 'composer.default_mode': 'image', 'gallery.initial_filter': 'all', 'composer.clear_prompt_after_submit': true } } })).ok()).toBeTruthy();
  page.on('pageerror', error => { throw error; });
});

test('generation memory separates projects modes and models before submission', async ({ page, request }) => {
  const created = await request.post('/internal/providers', { data: { name: `Memory ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } });
  const { provider } = await created.json();
  const project = await (await request.post('/internal/collections', { data: { name: 'Memory project' } })).json();
  try {
    for (const [id, kind] of [['memory-a', 'image'], ['memory-b', 'image'], ['memory-video', 'video']]) {
      expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: id, displayName: id, capabilities: { operations: [`${kind}.generate`], aspectRatios: ['1:1', '16:9'], resolutions: ['1024x1024'], durations: [5, 10] }, enabled: true } })).status()).toBe(201);
    }
    await open(page, `/projects/${project.collection.id}`);
    const choose = async (id: string) => {
      if (page.viewportSize()!.width < 600) {
        await page.getByRole('button', { name: '生成设置', exact: true }).click();
        await selectValue(page, '模型与服务', { label: `${provider.name} · ${id}` });
        await page.keyboard.press('Escape');
        return;
      }
      await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
      await page.locator('.choice').filter({ has: page.getByText(id, { exact: true }) }).click();
    };
    const count = async (value?: string) => {
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      if (value) await chooseCount(page, value);
      const result = await page.getByRole('button', { name: '生成数量', exact: true }).innerText();
      await page.keyboard.press('Escape');
      return result.replace('×', '');
    };
    await choose('memory-a'); await count('3');
    await choose('memory-b'); expect(await count()).toBe('1'); await count('2');
    await choose('memory-a'); expect(await count()).toBe('3');
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await choose('memory-video'); await count('4');
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(page.locator('.model-trigger')).toContainText('memory-a');
    expect(await count()).toBe('3');
    await page.reload();
    await expect(page.locator('.model-trigger')).toContainText('memory-a');
    expect(await count()).toBe('3');
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(page.locator('.model-trigger')).toContainText('memory-video');
    expect(await count()).toBe('4');
    await page.goto('/imagine');
    await choose('memory-a'); expect(await count()).toBe('1'); await count('5');
    await page.goto(`/projects/${project.collection.id}`);
    await expect(page.locator('.model-trigger')).toContainText('memory-a');
    expect(await count()).toBe('3');
    await page.screenshot({ path: `/tmp/imagine-generation-memory-${page.viewportSize()!.width}.png` });
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('recognized catalog models are highlighted and stably ordered before unknown entries', async ({ page, request }) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Recognition ${randomUUID()}`, type: 'openai', enabled: true } })).json();
  try {
    await page.route(`**/internal/providers/${provider.id}/models/catalog`, route => route.fulfill({ json: { models: [
      { id: 'unknown-a', displayName: 'unknown-a', recognized: false }, { id: 'gpt-image-2', displayName: 'GPT Image 2', recognized: true },
      { id: 'unknown-b', displayName: 'unknown-b', recognized: false }, { id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2', recognized: true },
    ] } }));
    await open(page, '/settings/providers');
    await page.getByRole('region', { name: `连接 ${provider.name}`, exact: true }).getByRole('button', { name: '添加模型', exact: true }).click();
    const picker = page.getByRole('combobox', { name: '远端模型目录', exact: true });
    await picker.click();
    await expect(page.locator('.catalog-search-option strong')).toHaveText(['GPT Image 2', 'Nano Banana 2', 'unknown-a', 'unknown-b']);
    await expect(page.locator('.recognized-model-name')).toHaveCount(2);
    await picker.fill('unknown');
    await expect(page.locator('.catalog-search-option strong')).toHaveText(['unknown-a', 'unknown-b']);
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('media prompt copy and inset selection rings work at gallery edges', async ({ page, request }, testInfo) => {
  const uploaded = await upload(request);
  const prompt = '完整提示词第一行\n第二行，包含标点和末尾内容。';
  const result = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt, inputs: [] } });
  expect(result.status()).toBe(202);
  const job = (await result.json()).job;
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).job.status).toBe('completed');
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { copiedPrompt: string }).copiedPrompt = text; } } }); });
  await open(page);
  const card = page.locator('.study-card').first();
  await card.hover();
  if (page.viewportSize()!.width <= 760) {
    const buttons = card.locator('.card-bookmark, .card-reference, .card-more, .card-copy-prompt');
    await expect(buttons).toHaveCount(4);
    const boxes = await buttons.evaluateAll(nodes => nodes.map(node => {
      const css = getComputedStyle(node), box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height, background: css.backgroundColor, blur: css.backdropFilter };
    }));
    for (const box of boxes) expect(box).toMatchObject({ width: 40, height: 40, background: 'rgba(0, 0, 0, 0)', blur: 'none' });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    }
    await expect(card.locator('.card-more svg')).toHaveCSS('width', '20px');
    await page.screenshot({ path: testInfo.outputPath('mobile-icon-actions.png'), animations: 'disabled' });
  }
  await card.locator('.card-copy-prompt').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { copiedPrompt: string }).copiedPrompt)).toBe(prompt);
  await expect(page.locator('.study-viewer')).toHaveCount(0);
  await expect(page.getByText('已复制提示词', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-study-id="${uploaded.id}"] .card-copy-prompt`)).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }); document.execCommand = () => false; });
  await card.locator('.card-copy-prompt').click();
  await expect(page.getByText('复制失败，请打开详情选择提示词复制', { exact: true })).toBeVisible();
  await expect(page.locator('.study-viewer')).toHaveCount(0);
  await card.locator('.study-open').click({ modifiers: ['Shift'] });
  await expect(card).toHaveClass(/is-selected/);
  await expect(card.locator('.card-copy-prompt')).toHaveCount(0);
  expect(await card.evaluate(element => { const css = getComputedStyle(element, '::after'); return { top: css.top, left: css.left, right: css.right, bottom: css.bottom, width: css.borderTopWidth }; })).toEqual({ top: '0px', left: '0px', right: '0px', bottom: '0px', width: '3px' });
  await page.screenshot({ path: testInfo.outputPath('selection-ring-at-edge.png'), animations: 'disabled' });
});

test('video edit accepts a source and omits inherited generation options', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Video workflow ${randomUUID()}`, type: 'xai', enabled: true, isDefault: true } })).json();
  try {
    const preset = await (await request.get(`/internal/providers/${provider.id}/models/capabilities?modelId=grok-imagine-video&operation=video.generate`)).json();
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'grok-imagine-video', displayName: 'Workflow Video', enabled: true, capabilities: preset.capabilities } })).status()).toBe(201);
    await open(page);
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    if (page.viewportSize()!.width <= 760) await page.getByRole('button', { name: '选择视频输入方式', exact: true }).click();
    await page.getByRole('button', { name: '编辑视频', exact: true }).click();
    await page.getByLabel('上传源视频', { exact: true }).setInputFiles(resolve('fixtures/providers/mock/mock-video-v1/tiny.mp4'));
    await expect(page.locator('.reference-tray')).toContainText('源视频');
    await expect(page.getByRole('button', { name: '选择画幅', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择视频分辨率', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择视频时长', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '开始生成', exact: true })).toBeInViewport();
    expect(await page.locator('.creation-controls').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByLabel('创作描述', { exact: true }).fill('change the lighting');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured-no-paid-call' } }) : route.continue());
    const sent = page.waitForRequest(req => req.url().endsWith('/internal/jobs') && req.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload).toMatchObject({ operation: 'video.edit', inputs: [{ role: 'source' }] });
    for (const key of ['aspectRatio', 'resolution', 'durationSeconds', 'audio']) expect(payload).not.toHaveProperty(key);
    await page.screenshot({ path: testInfo.outputPath('video-edit-controls.png'), animations: 'disabled' });
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('model editor offers the complete catalog and cross-family protocols', async ({ page, request }) => {
  const name = `Catalog ${randomUUID()}`;
  const { provider } = await (await request.post('/internal/providers', { data: { name, type: 'openai', enabled: true } })).json();
  try {
    await page.route(`**/internal/providers/${provider.id}/models/catalog`, route => route.fulfill({ json: { models: [{ id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2' }, { id: 'unknown-model', displayName: 'unknown-model' }] } }));
    await open(page, '/settings/providers');
    await page.getByRole('region', { name: `连接 ${name}`, exact: true }).getByRole('button', { name: '添加模型', exact: true }).click();
    const picker = page.getByRole('combobox', { name: '远端模型目录', exact: true });
    await picker.fill('no-such-model');
    await expect(page.getByRole('status', { name: '' }).filter({ hasText: '没有匹配的模型' })).toBeVisible();
    await picker.press('Enter');
    await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toBeVisible();
    await picker.fill('NANO banana');
    await expect(page.getByRole('option', { name: 'unknown-model', exact: true })).toHaveCount(0);
    await picker.press('ArrowDown');
    await page.screenshot({ path: `/tmp/imagine-catalog-search-${page.viewportSize()!.width}.png` });
    await picker.press('Enter');
    await expect(page.getByLabel('模型显示名称', { exact: true })).toHaveValue('Nano Banana 2');
    await expect(page.getByText('已载入模型能力', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成参数', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: '生成参数', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '模型调用协议', exact: true })).toContainText('Gemini · Generate Content');
    await picker.click();
    await picker.fill('unknown');
    await page.getByRole('option', { name: 'unknown-model', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '模型调用协议', exact: true })).toContainText('提供商默认（OpenAI）');
    await picker.click();
    await picker.fill('gemini-3.1');
    await picker.press('Escape');
    await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toBeVisible();
    await picker.click();
    await picker.fill('gemini-3.1');
    await picker.press('Enter');
    await selectValue(page, '模型调用协议', 'openai-responses-image-v1');
    await page.screenshot({ path: `/tmp/imagine-catalog-editor-${page.viewportSize()!.width}.png` });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toHaveCount(0);
    const models = await (await request.get(`/internal/models?providerId=${provider.id}`)).json();
    expect(models.items[0]).toMatchObject({ displayName: 'Nano Banana 2', capabilities: { profile: 'openai-responses-image-v1' } });
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('new workspace visual baseline and accessible responsive geometry', async ({ page, request }) => {
  for (const name of ['coast', 'mountain', 'architecture', 'botanical']) await upload(request, name);
  await open(page);
  await expect(page.locator('.study-card')).toHaveCount(4);
  await expect.poll(() => page.locator('.study-card img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 1))).toBe(true);
  await expect(page.locator('.creation-composer')).toBeVisible();
  await expect(page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const form = await page.locator('.creation-composer').boundingBox();
  const viewport = page.viewportSize()!;
  expect(form!.x).toBeGreaterThanOrEqual(0);
  expect(form!.x + form!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(form!.y + form!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(viewport.height - form!.y - form!.height).toBeLessThanOrEqual(26);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page).toHaveScreenshot('workspace.png', { animations: 'disabled', maxDiffPixelRatio: .005 });
});

test('real image and video generation, original download, favorites and failure feedback', async ({ page, request }) => {
  await open(page);
  for (const mode of ['图片', '视频']) {
    const modeToggle = page.getByRole('button', { name: '切换图片/视频', exact: true });
    if (await modeToggle.getAttribute('aria-pressed') !== String(mode === '视频')) await modeToggle.click();
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

test('deleting freshly generated results never restores completed placeholders', async ({ page, request }, testInfo) => {
  await open(page);
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await chooseCount(page, '4');
  await page.keyboard.press('Escape');
  const prompt = `delete generated results ${randomUUID()}`;
  await page.getByLabel('创作描述', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.study-card')).toHaveCount(4, { timeout: 20000 });
  await expect.poll(async () => (await (await request.get('/internal/jobs?limit=100')).json()).items.filter((job: { prompt: string; status: string }) => job.prompt === prompt && job.status === 'completed').length).toBe(4);
  await expect(page.locator('.pending-study')).toHaveCount(0);
  await page.locator('.study-open').first().click();
  await page.getByRole('button', { name: '作品信息', exact: true }).click();
  await page.getByRole('button', { name: '删除作品', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.study-card')).toHaveCount(3);
  await expect(page.locator('.pending-study')).toHaveCount(0);
  const remaining = await page.locator('.study-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-study-id')!));
  const blocked = remaining[0]!;
  await page.route(`**/internal/assets/${blocked}`, route => route.request().method() === 'DELETE' ? route.fulfill({ status: 500, json: { error: 'fixture_failure' } }) : route.continue());
  await page.getByRole('button', { name: '选择作品', exact: true }).click();
  for (const id of remaining) await page.locator(`[data-study-id="${id}"] .study-open`).click();
  await page.getByRole('button', { name: '删除所选作品', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('2 件已删除，1 件失败');
  await expect(page.locator('.study-card')).toHaveCount(1);
  await expect(page.locator('.pending-study')).toHaveCount(0);
  await expect(page.locator('.batch-toolbar')).toContainText('已选 1 件');
  await page.unroute(`**/internal/assets/${blocked}`);
  await page.getByRole('button', { name: '删除所选作品', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByText('还没有作品', { exact: true })).toBeVisible();
  await expect(page.locator('.pending-study')).toHaveCount(0);
  expect((await (await request.get('/internal/jobs?limit=100')).json()).items.filter((job: { prompt: string }) => job.prompt === prompt)).toHaveLength(4);
  await page.screenshot({ path: testInfo.outputPath('deleted-generated-results.png'), animations: 'disabled' });
});

test('login presents a conventional form and supports authentication', async ({ browser, request }, testInfo) => {
  const username = `login_${randomUUID().slice(0, 8)}`;
  const created = await request.post('/internal/accounts', { data: { username, password: 'login-test-password' } });
  expect(created.status()).toBe(201);
  const context = await browser.newContext({ ...testInfo.project.use, storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto('/imagine');
    await expect(page.getByRole('heading', { name: '登录 Imagine', exact: true })).toBeVisible();
    await expect(page.getByText('受保护的工作区', { exact: true })).toHaveCount(0);
    await expect(page.locator('.auth-password-field svg')).toHaveCount(0);
    const usernameInput = page.getByLabel('用户名', { exact: true });
    await expect(usernameInput).toHaveValue('');
    await expect(usernameInput).toHaveAttribute('autocomplete', 'username');
    const password = page.getByLabel('密码', { exact: true });
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).not.toBeFocused();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('login.png'), animations: 'disabled' });
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await password.fill('login-test-password');
    await usernameInput.fill('');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
    await usernameInput.fill(username);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('.workspace-header')).toBeVisible();
    await page.goto('/settings/account');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(usernameInput).toHaveValue('');
    await expect(password).toHaveValue('');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
  } finally { await context.close(); }
});

test('private projects hide recent results and obscure project covers', async ({ page, request }, testInfo) => {
  const privateAsset = await upload(request);
  const publicAsset = await upload(request, 'mountain');
  const { collection } = await (await request.post('/internal/collections', { data: { name: '隐私测试项目' } })).json();
  await request.post(`/internal/collections/${collection.id}/assets`, { data: { assetIds: [privateAsset.id] } });
  await open(page, `/projects/${collection.id}`);
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toBeVisible();
  await page.getByRole('button', { name: '项目操作', exact: true }).click();
  await page.getByRole('button', { name: '设为隐私项目', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已设为隐私项目' })).toBeVisible();
  await open(page);
  await expect(page.locator(`[data-study-id="${publicAsset.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`[data-study-id="${publicAsset.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toHaveCount(0);
  await page.getByLabel('搜索作品', { exact: true }).fill('coast');
  await expect(page.locator('.study-card')).toHaveCount(0);
  await open(page, '/library');
  await expect(page.locator(`[data-study-id="${publicAsset.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toHaveCount(0);
  await page.getByLabel('搜索作品', { exact: true }).fill('coast');
  await expect(page.locator('.study-card')).toHaveCount(0);
  await open(page, '/projects');
  const cover = page.getByLabel('隐私项目封面已模糊');
  await expect(cover).toBeVisible();
  await expect(cover.locator('img')).toHaveCount(0);
  await expect(cover).toContainText('隐私项目');
  await page.screenshot({ path: testInfo.outputPath('private-projects.png'), animations: 'disabled' });
  await page.getByRole('button').filter({ hasText: '隐私测试项目' }).click();
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toBeVisible();
  await page.getByRole('button', { name: '项目操作', exact: true }).click();
  await page.getByRole('button', { name: '取消隐私项目', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已在最近创作中显示' })).toBeVisible();
  await open(page);
  await expect(page.locator(`[data-study-id="${privateAsset.id}"]`)).toBeVisible();
});

test('media mode toggles across the entire capsule and from the keyboard', async ({ page }) => {
  await open(page);
  const toggle = page.getByRole('button', { name: '切换图片/视频', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  for (const mode of ['image', 'video']) {
    // Clicking the currently selected half must switch too, including its label.
    await toggle.locator(`[data-mode="${mode}"]`).click();
    await expect(toggle).toHaveAttribute('aria-pressed', mode === 'image' ? 'true' : 'false');
  }
  const bounds = (await toggle.boundingBox())!;
  await toggle.click({ position: { x: bounds.width / 2, y: 1 } });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('prompt focus keeps geometry and settings fields share one appearance', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Settings appearance ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'gpt-image-2', displayName: 'GPT Image 2', enabled: true, capabilities: {
      operations: ['image.generate'], aspectRatios: ['auto', '1:1', '16:9'], imageResolution: { mode: 'pixels', values: ['auto', '1024x1024', '1536x1024'], allowCustomDimensions: true },
      parameters: [
        { path: 'aspectRatio', label: '画幅', type: 'select', options: ['auto', '1:1', '16:9'] },
        { path: 'resolution', label: '分辨率', type: 'text' },
        { path: 'extra.quality', label: '质量', type: 'select', options: ['low', 'high'] },
        { path: 'extra.partial_images', label: '中间预览数量', type: 'number', min: 0, max: 3 },
      ],
    } } })).status()).toBe(201);
    await open(page);
    const input = page.getByLabel('创作描述', { exact: true });
    await expect(page.locator('.mobile-model-status:visible, .model-trigger:visible').filter({ hasText: 'GPT Image 2' }).first()).toBeVisible();
    const composer = page.locator('.creation-composer');
    const before = (await composer.boundingBox())!;
    const inputBefore = (await input.boundingBox())!;
    await input.click();
    expect((await composer.boundingBox())!.height).toBe(before.height);
    expect((await input.boundingBox())!.height).toBe(inputBefore.height);
    await input.fill('第一行\n第二行\n第三行');
    const lineHeight = await input.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
    await expect.poll(async () => Math.abs((await composer.boundingBox())!.height - before.height - lineHeight)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    const panel = page.locator('.composer-generation-settings');
    const fields = panel.locator('.setting-line > .option-trigger, .setting-line > .select-trigger, .setting-line > input:not([type="checkbox"])');
    const styles = await fields.evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height > 0).map(node => {
      const css = getComputedStyle(node); const box = node.getBoundingClientRect();
      return { height: box.height, width: box.width, background: css.backgroundColor, border: css.borderTopWidth, fontSize: css.fontSize, radius: css.borderRadius };
    }));
    expect(styles.length).toBeGreaterThanOrEqual(5);
    for (const style of styles) expect(style).toEqual(styles[0]);
    for (const name of ['生成数量', '画幅', '分辨率']) await expect(panel.getByRole('button', { name, exact: true }).locator('svg')).toHaveCount(1);
    await panel.getByRole('button', { name: '生成数量', exact: true }).click();
    await expect(page.locator('.count-segments').getByRole('button')).toHaveCount(5);
    await page.locator('.count-segments').getByRole('button', { name: '2', exact: true }).click();
    await panel.getByRole('button', { name: '画幅', exact: true }).click();
    await expect(page.locator('.ratio-options')).toBeVisible();
    await page.locator('.ratio-options').getByRole('button', { name: '1:1', exact: true }).click();
    await panel.getByRole('button', { name: '分辨率', exact: true }).click();
    await expect(page.locator('.image-resolution-options')).toBeVisible();
    await page.locator('.image-resolution-options').getByRole('button', { name: '1K', exact: true }).click();
    await selectValue(page, '质量', 'high');
    await panel.getByLabel('中间预览数量').fill('2');
    await page.screenshot({ path: testInfo.outputPath('unified-settings.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    const expectedHeight = before.height + (testInfo.project.use.viewport!.width > 760 ? lineHeight : 0);
    await expect.poll(async () => Math.abs((await composer.boundingBox())!.height - expectedHeight)).toBeLessThanOrEqual(1);
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
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
  await focusEditingPrompt(page);
  await page.getByRole('button', { name: '编辑蒙版', exact: true }).click();
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
  await expect(page.locator('.image-editing-viewer')).toBeVisible();
  await focusEditingPrompt(page);
  await expect(page.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const prompt = `edit masked coast ${randomUUID()}`;
  await page.locator('.image-editing-controls').getByLabel('创作描述', { exact: true }).fill(prompt);
  const response = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
  await page.locator('.image-editing-controls').getByRole('button', { name: '开始生成', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(202);
  const job = (await (await request.get('/internal/jobs?limit=100')).json()).items.find((item: { prompt: string }) => item.prompt === prompt);
  expect(job).toBeDefined();
  const detail = await (await request.get(`/internal/jobs/${job.id}`)).json();
  expect(detail.job.request.operation).toBe('image.edit');
  expect(detail.job.request.inputs.map((input: { role: string }) => input.role).sort()).toEqual(['mask', 'source']);
});

test('connections, persisted preferences and canonical legacy entry', async ({ page, request }) => {
  await open(page, '/settings/providers');
  await page.getByRole('region', { name: '连接 Mock Provider', exact: true }).getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('连接测试通过');
  await open(page, '/settings');
  await selectValue(page, '默认创作类型', 'video');
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['composer.default_mode']).toBe('video');
  await page.reload();
  await expect(page.getByRole('combobox', { name: '默认创作类型', exact: true })).toHaveText('视频');
  await open(page, '/interaction.html');
  await expect(page).toHaveURL(/\/imagine$/);
  await expect(page.locator('.creation-composer')).toBeVisible();
  await expect(page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('创作描述', { exact: true }).fill('persist this draft');
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.getByLabel('创作描述', { exact: true })).toHaveValue('persist this draft');
});

test('provider editor protects secrets and custom adapter management persists a real definition', async ({ page, request }) => {
  await open(page, '/settings/providers');
  await page.getByRole('button', { name: '添加连接', exact: true }).first().click();
  await page.getByLabel('连接名称', { exact: true }).fill('Workspace adapter');
  await selectValue(page, '接口类型', 'custom-http-v1');
  await page.getByLabel('Base URL', { exact: true }).fill('https://api.example.com');
  const secret = 'workspace-test-secret-not-production';
  await page.getByLabel('API Key', { exact: true }).fill(secret);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  const created = page.waitForResponse(response => response.url().endsWith('/internal/providers') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const stored = await request.get('/internal/providers?limit=100');
  expect(await stored.text()).not.toContain(secret);
  const provider = (await stored.json()).items.find((item: { name: string }) => item.name === 'Workspace adapter');
  expect(provider).toBeDefined();
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

test('custom generation parameters reach the job request from the bottom composer', async ({ page, request }) => {
  const created = await request.post('/internal/providers', { data: { name: 'Workspace parameters', type: 'openai-images-v1', baseUrl: 'https://api.example.com', enabled: true, isDefault: true } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    const added = await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'grok-imagine-image-2.0', displayName: 'Custom image model', enabled: true, capabilities: {
      profile: 'openai-images-v1', operations: ['image.generate'], aspectRatios: ['1:1', '16:9', '4:3'], resolutions: ['auto', '1024x1024'], maxReferenceImages: 0, supportsBatchCount: true, maxBatchCount: 4,
      customFields: { type: 'object', properties: { size: { type: 'string' }, quality: { enum: ['low', 'high'] }, output_format: { enum: ['png', 'jpeg', 'webp'] } }, additionalProperties: false },
    } } });
    expect(added.status()).toBe(201);
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await chooseRatio(page, '4:3');
    await chooseResolution(page, 'custom');
    await page.getByRole('button', { name: '解锁画幅比例', exact: true }).click();
    await page.getByLabel('自定义图片宽度', { exact: true }).fill('1920');
    await page.getByLabel('自定义图片高度', { exact: true }).fill('1080');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByRole('button', { name: '画幅', exact: true })).toHaveText('auto');
    await chooseCount(page, '2');
    await selectValue(page, '质量', 'high');
    await selectValue(page, '输出格式', 'jpeg');
    await page.keyboard.press('Escape');
    await page.getByLabel('创作描述', { exact: true }).fill('parameter contract');
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: { code: 'test_only', message: '参数捕获测试' } } }) : route.continue());
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await sent).postDataJSON()).toMatchObject({ resolution: '1920x1088', count: 2, extra: { quality: 'high', output_format: 'jpeg' } });
  } finally { expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy(); }
});

test('aspect ratio stays selectable with managed rules and mode controls keep stable geometry', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Ratio ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    for (const kind of ['image', 'video']) {
      expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: `ratio-${kind}`, displayName: `Ratio ${kind}`, enabled: true, capabilities: {
        operations: kind === 'image' ? ['image.generate'] : ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
        aspectRatios: ['1:1', '16:9'], maxReferenceImages: 3,
        parameters: [{ path: 'aspectRatio', label: '画幅', type: 'select', options: ['1:1', '16:9', '21:9'], allowCustom: true, defaultValue: '1:1' }],
      } } })).status()).toBe(201);
    }
    await open(page);
    const mobile = page.viewportSize()!.width <= 760;
    const ratio = page.getByRole('button', { name: '选择画幅', exact: true });
    if (mobile) await expect(ratio).toBeVisible();
    else {
      await expect(ratio).toBeVisible();
      await ratio.click();
      const auto = page.getByRole('button', { name: 'auto', exact: true });
      await expect(auto.locator('.ratio-auto')).toBeVisible();
      const square = (await auto.locator('.ratio-auto').boundingBox())!;
      expect(square.width).toBe(square.height);
      await page.screenshot({ path: testInfo.outputPath('auto-ratio.png'), animations: 'disabled' });
      await auto.click();
      await expect(ratio).toContainText('auto');
      await ratio.click();
      await page.getByRole('button', { name: '21:9', exact: true }).click();
      await expect(ratio).toContainText('21:9');
    }
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    if (mobile) await chooseRatio(page, '21:9');
    await expect(page.getByRole('button', { name: '画幅', exact: true })).toHaveText('21:9');
    await expect(page.getByRole('textbox', { name: '画幅', exact: true })).toHaveCount(0);
    await chooseRatio(page, '16:9');
    await page.keyboard.press('Escape');
    if (!mobile) await expect(ratio).toContainText('16:9');
    const modes = page.getByRole('group', { name: '创作类型', exact: true });
    const add = page.getByRole('button', { name: '添加参考图', exact: true });
    await expect(add).toBeEnabled();
    const before = await add.boundingBox();
    const iconBefore = await add.locator('svg').boundingBox();
    const modeBefore = await modes.boundingBox();
    const settingsBefore = await page.getByRole('button', { name: '生成设置', exact: true }).boundingBox();
    const submitBefore = await page.getByRole('button', { name: '开始生成', exact: true }).boundingBox();
    await expect(modes.locator('.mode-segment[data-mode="video"] > span')).toBeHidden();
    if (mobile) await expect(modes.locator('.mode-segment[data-mode="image"] > span')).toBeHidden();
    else await expect(modes.locator('.mode-segment[data-mode="image"] > span')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('composer-image.png'), animations: 'disabled' });
    await modes.getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(add).toBeDisabled();
    expect(await add.boundingBox()).toEqual(before);
    expect(await add.locator('svg').boundingBox()).toEqual(iconBefore);
    expect(await modes.boundingBox()).toEqual(modeBefore);
    await expect(modes.locator('.mode-segment[data-mode="image"] > span')).toBeHidden();
    if (mobile) {
      await expect(modes.locator('.mode-segment[data-mode="video"] > span')).toBeHidden();
      expect(await page.getByRole('button', { name: '生成设置', exact: true }).boundingBox()).toEqual(settingsBefore);
      expect(await page.getByRole('button', { name: '开始生成', exact: true }).boundingBox()).toEqual(submitBefore);
      await expect(ratio).toBeHidden();
    } else await expect(modes.locator('.mode-segment[data-mode="video"] > span')).toBeVisible();
    const videoInputs = (await page.getByRole('group', { name: '视频输入方式', exact: true }).boundingBox())!;
    if (mobile) expect(Math.abs(videoInputs.y + videoInputs.height / 2 - before!.y - before!.height / 2)).toBeLessThan(1);
    else {
      expect(videoInputs.y + videoInputs.height).toBeLessThanOrEqual(before!.y);
      expect(videoInputs.x).toBe(before!.x);
    }
    await page.screenshot({ path: testInfo.outputPath('composer-video.png'), animations: 'disabled' });
    if (page.viewportSize()!.width === 360) {
      await page.setViewportSize({ width: 320, height: 800 });
      const toolbar = (await page.locator('.creation-controls').boundingBox())!;
      const smallModes = (await page.getByRole('group', { name: '视频输入方式', exact: true }).boundingBox())!;
      expect(smallModes.y).toBeLessThan(toolbar.y + 6);
      await page.screenshot({ path: testInfo.outputPath('composer-video-320.png'), animations: 'disabled' });
    }
    const boxes = await page.locator('.creation-controls > button:not([hidden]), .mode-segments, .video-input-row').evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => { const box = node.getBoundingClientRect(); return { x: box.x, right: box.right, y: box.y, bottom: box.bottom }; }));
    const composer = (await page.locator('.creation-composer').boundingBox())!;
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(composer.x); expect(box.right).toBeLessThanOrEqual(composer.x + composer.width); }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    }
    const addVideo = await add.boundingBox();
    await modes.getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(add).toBeEnabled();
    expect(await add.boundingBox()).toEqual(addVideo);
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('image shortcuts respect desktop scope and ratio choices balance their rows', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Image controls ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  const ratios = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '21:9', '9:21'];
  try {
    for (const name of ['Pixel image', 'Named image', 'Locked image']) {
      expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: name.replace(' ', '-'), displayName: name, enabled: true, capabilities: {
        profile: name === 'Pixel image' ? 'openai-images-v1' : 'openai-chat-image-v1',
        operations: ['image.generate'], aspectRatios: ratios, resolutions: ['1K', '2K', '4K'],
        customFields: { type: 'object', properties: { size: { type: 'string' } } },
        parameters: [
          { path: 'aspectRatio', label: '画幅', type: 'select', options: ratios.slice(0, name === 'Pixel image' ? 7 : 9), defaultValue: '1:1' },
          { path: 'resolution', label: '分辨率', type: 'select', options: name === 'Pixel image' ? ['auto', '1024x1024'] : ['1K', '2K', '4K'], allowCustom: name === 'Pixel image', ...(name === 'Locked image' ? { locked: true, defaultValue: '2K' } : {}) },
          { path: 'count', label: '生成数量', type: 'number', min: 1, max: 4, step: 1, defaultValue: name === 'Locked image' ? 2 : 1, locked: name === 'Locked image' },
          ...Array.from({ length: 8 }, (_, index) => ({ path: `extra.field${index}`, label: `Field ${index}`, type: 'text' })),
        ],
      } } })).status()).toBe(201);
    }
    await upload(request);
    await open(page);
    const mobile = page.viewportSize()!.width <= 760;
    const resolution = page.getByRole('button', { name: '选择图片分辨率', exact: true });
    const count = page.getByRole('button', { name: '选择图片生成数量', exact: true });
    for (const name of ['Pixel image', 'Named image', 'Locked image']) {
      if (mobile) {
        await page.getByRole('button', { name: '生成设置', exact: true }).click();
        await selectValue(page, '模型与服务', { label: `${provider.name} · ${name}` });
        await page.keyboard.press('Escape');
      } else {
        await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
        await page.locator('.choice').filter({ has: page.getByText(name, { exact: true }) }).click();
      }
      await expect(page.locator('.model-trigger')).toContainText(name);
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '生成设置', exact: true });
      await expect(settings.getByLabel('模型与服务', { exact: true })).toHaveCSS('appearance', 'none');
      if (!mobile) {
        await expect(settings).toHaveCSS('scrollbar-width', 'none');
        await settings.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(page.getByLabel('Field 7', { exact: true })).toBeInViewport();
      }
      await page.getByRole('button', { name: '画幅', exact: true }).click();
      const choices = page.locator('.ratio-options .choice');
      const boxes = await choices.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right }; }));
      const rows = [...new Set(boxes.map(box => box.y))].map(y => boxes.filter(box => box.y === y).length);
      expect(rows).toEqual(name === 'Pixel image' ? [4, 4] : [5, 5]);
      for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width); }
      await page.screenshot({ path: testInfo.outputPath(`${name}-ratio-grid.png`), animations: 'disabled' });
      await page.getByRole('button', { name: '16:9', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('.creation-controls .lucide-chevron-down')).toHaveCount(0);
      if (name !== 'Locked image') {
        for (const [ratio, pixels] of [['3:2', '3840x2560'], ['2:3', '2560x3840'], ['1:1', '3840x3840']]) {
          await page.getByRole('button', { name: '选择画幅', exact: true }).click();
          await page.getByRole('button', { name: ratio, exact: true }).click();
          await page.keyboard.press('Escape');
          await resolution.click();
          await page.getByRole('button', { name: '4K', exact: true }).click();
          await savedModelOptions(request, provider.id, name, 'image', { parameters: { resolution: name === 'Pixel image' ? pixels : '4K' } });
        }
        await page.getByRole('button', { name: '选择画幅', exact: true }).click();
        await page.getByRole('button', { name: 'auto', exact: true }).click();
        await page.keyboard.press('Escape');
        await savedModelOptions(request, provider.id, name, 'image', { parameters: { aspectRatio: 'auto', resolution: name === 'Pixel image' ? 'auto' : '4K' } });
        await resolution.click();
        for (const preset of ['1K', '2K', '4K']) {
          const button = page.getByRole('button', { name: preset, exact: true });
          await expect(button).toBeEnabled();
        }
        await page.screenshot({ path: testInfo.outputPath(`${name}-automatic-resolution.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '选择画幅', exact: true }).click();
        await page.getByRole('button', { name: '16:9', exact: true }).click();
        await page.keyboard.press('Escape');
      }
      if (mobile) {
        await expect(resolution).toBeVisible(); await expect(count).toBeVisible();
        const shortcutBoxes = await page.getByRole('group', { name: '图片快捷设置' }).locator('button').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.x, right: box.right, y: box.y, height: box.height }; }));
        expect(shortcutBoxes).toHaveLength(3);
        expect(new Set(shortcutBoxes.map(box => box.y)).size).toBe(1);
        const modeBox = (await page.getByRole('group', { name: '创作类型', exact: true }).boundingBox())!;
        expect(Math.abs(shortcutBoxes[0]!.y + shortcutBoxes[0]!.height / 2 - modeBox.y - modeBox.height / 2)).toBeLessThan(1);
        expect(shortcutBoxes[0]!.x).toBeGreaterThanOrEqual(modeBox.x + modeBox.width);
        await page.mouse.move(0, 0);
        await expect(resolution).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        for (const box of shortcutBoxes) { expect(box.height).toBeGreaterThanOrEqual(40); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width); }
        await page.getByRole('button', { name: '生成设置', exact: true }).click();
        const selector = page.getByLabel('分辨率', { exact: true });
        if (name === 'Locked image') { await expect(selector).toBeDisabled(); await expect(selector).toContainText('2K'); }
        else {
          await chooseResolution(page, '4K');
          await savedModelOptions(request, provider.id, name, 'image', { parameters: { resolution: name === 'Pixel image' ? '3840x2160' : '4K' } });
          await chooseRatio(page, '9:16');
          await expect(selector).toContainText('4K');
          await savedModelOptions(request, provider.id, name, 'image', { parameters: { resolution: name === 'Pixel image' ? '2160x3840' : '4K' } });
          await page.screenshot({ path: testInfo.outputPath(`${name}-mobile-resolution.png`), animations: 'disabled' });
        }
        await page.keyboard.press('Escape');
        continue;
      }
      if (name === 'Locked image') { await expect(resolution).toBeDisabled(); await expect(resolution).toContainText('2K'); await expect(count).toBeEnabled(); await expect(count).toContainText('×1'); continue; }
      const ratioBox = (await page.getByRole('button', { name: '选择画幅', exact: true }).boundingBox())!;
      expect((await resolution.boundingBox())!.x).toBeGreaterThanOrEqual(ratioBox.x + ratioBox.width);
      await resolution.click();
      await expect(page.locator('.image-resolution-options > .choice')).toHaveText(['auto', '1K', '2K', '4K', '自定义']);
      await page.getByRole('button', { name: '2K', exact: true }).click();
      await expect(resolution).toContainText('2K');
      await count.click();
      await expect(page.locator('.count-segments button')).toHaveText(['1', '2', '4', '8', '']);
      await page.getByRole('button', { name: '2', exact: true }).click();
      if (name === 'Pixel image') {
        await savedModelOptions(request, provider.id, name, 'image', { count: 2, parameters: { resolution: '2048x1152' } });
        await resolution.click();
        await page.getByRole('button', { name: '4K', exact: true }).click();
        await savedModelOptions(request, provider.id, name, 'image', { count: 2, parameters: { resolution: '3840x2160' } });
        await page.getByRole('button', { name: '选择画幅', exact: true }).click();
        await page.getByRole('button', { name: '9:16', exact: true }).click();
        await page.keyboard.press('Escape');
        await expect(resolution).toContainText('4K');
        await savedModelOptions(request, provider.id, name, 'image', { count: 2, parameters: { resolution: '2160x3840' } });
        await resolution.click();
        await page.getByRole('button', { name: '自定义', exact: true }).click();
        await page.getByLabel('自定义图片宽度').fill('0');
        await page.getByRole('button', { name: '应用', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: '图片尺寸超出' })).toBeVisible();
        await page.getByRole('button', { name: '解锁画幅比例', exact: true }).click();
    await page.getByLabel('自定义图片宽度').fill('1920');
        await page.getByLabel('自定义图片高度').fill('1080');
        await page.getByRole('button', { name: '应用', exact: true }).click();
        await expect(resolution).toContainText('自定义');
      } else {
        await resolution.click();
        await expect(page.getByRole('button', { name: '自定义', exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
      }
      await page.getByLabel('创作描述', { exact: true }).fill('image shortcuts request');
      await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: { code: 'captured', message: 'Captured locally' } } }) : route.continue());
      const submitted = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
      expect((await submitted).postDataJSON()).toMatchObject({ count: 2, resolution: name === 'Pixel image' ? '1920x1088' : '2K' });
      await savedModelOptions(request, provider.id, name, 'image', { count: 2, parameters: { resolution: name === 'Pixel image' ? '1920x1088' : '2K' } });
      await page.reload();
      await expect(count).toContainText('×2');
      await expect(resolution).toContainText(name === 'Pixel image' ? '自定义' : '2K');
      await page.screenshot({ path: testInfo.outputPath(`${name}-image-shortcuts.png`), animations: 'disabled' });
    }
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('native image protocols select tiers without forcing ratio across policies and reloads', async ({ page, request }, testInfo) => {
  test.setTimeout(60000);
  const scenarios = [
    { name: 'Legacy Chat', profile: 'openai-chat-image-v1', modelId: 'gemini-3.1-flash-image', resolutions: ['auto', '1024x1024', '2048x2048'], tier: '4K' },
    { name: 'Managed Chat', profile: 'openai-chat-image-v1', modelId: 'gemini-3.1-flash-image', resolutions: ['auto', '512', '1K', '2K', '4K'], tier: '4K', ruleType: 'select' },
    { name: 'Text Chat', profile: 'openai-chat-image-v1', modelId: 'gemini-3.1-flash-image', resolutions: ['auto', '1024x1024'], tier: '4K', ruleType: 'text' },
    { name: 'Native Gemini', profile: 'gemini-generate-content-image-v1', modelId: 'gemini-3.1-flash-image', resolutions: ['auto', '1024x1024'], tier: '4K' },
    { name: 'Native Interactions', profile: 'gemini-interactions-image-v1', modelId: 'gemini-3-pro-image', resolutions: ['auto', '1024x1024'], tier: '4K' },
    { name: 'Native xAI', profile: 'xai-imagine-image-v1', modelId: 'grok-imagine-image', resolutions: ['1k', '2k'], tier: '2K' },
    { name: 'Limited Gemini', profile: 'gemini-generate-content-image-v1', modelId: 'gemini-2.5-flash-image', resolutions: ['auto', '1024x1024'], tier: '1K' },
  ];
  const providers: string[] = [];
  try {
    for (const scenario of scenarios) {
      const { provider } = await (await request.post('/internal/providers', { data: { name: scenario.name, type: 'openai', enabled: true, isDefault: true } })).json();
      providers.push(provider.id);
      expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: scenario.modelId, displayName: scenario.name, enabled: true, capabilities: {
        profile: scenario.profile, operations: ['image.generate'], aspectRatios: ['auto', '1:1', '16:9'], resolutions: scenario.resolutions,
        imageResolution: { mode: 'native', values: scenario.tier === '1K' ? ['auto', '1K'] : scenario.profile === 'xai-imagine-image-v1' ? ['auto', '1k', '2k'] : ['auto', '1K', '2K', '4K'], allowCustomDimensions: false },
        ...(scenario.ruleType ? { parameters: [
          { path: 'aspectRatio', label: '画幅', type: 'select', options: ['auto', '1:1', '16:9'] },
          { path: 'resolution', label: '分辨率', type: scenario.ruleType, ...(scenario.ruleType === 'select' ? { options: scenario.resolutions } : {}) },
        ] } : {}),
      } } })).status()).toBe(201);
    }
    await upload(request);
    await open(page);
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    for (const [index, scenario] of scenarios.entries()) {
      if (page.viewportSize()!.width <= 760) {
        await page.getByRole('button', { name: '生成设置', exact: true }).click();
        await selectValue(page, '模型与服务', { label: `${scenario.name} · ${scenario.name}` });
        await page.keyboard.press('Escape');
      } else {
        await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
        await page.locator('.choice').filter({ has: page.getByText(scenario.name, { exact: true }) }).click();
      }
      const ratio = page.getByRole('button', { name: '选择画幅', exact: true });
      const resolution = page.getByRole('button', { name: '选择图片分辨率', exact: true });
      await expect(ratio).toContainText('auto');
      await resolution.click();
      if (scenario.tier !== '4K') await expect(page.getByRole('button', { name: '4K', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: scenario.tier, exact: true }).click();
      await expect(page.locator('.image-resolution-options')).toHaveCount(0);
      await expect(ratio).toContainText('auto');
      const wire = scenario.profile === 'xai-imagine-image-v1' ? scenario.tier.toLowerCase() : scenario.tier;
      await savedModelOptions(request, providers[index]!, scenario.name, 'image', scenario.ruleType ? { parameters: { resolution: wire } } : { ratio: 'auto', resolution: wire });
      await page.reload();
      await expect(resolution).toContainText(scenario.tier);
      await expect(ratio).toContainText('auto');
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      await chooseResolution(page, scenario.tier);
      await expect(page.locator('.image-resolution-options')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '画幅', exact: true })).toHaveText('auto');
      await page.keyboard.press('Escape');
      await page.getByLabel('创作描述', { exact: true }).fill('native resolution fixture');
      const sent = page.waitForRequest(req => req.url().endsWith('/internal/jobs') && req.method() === 'POST');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
      const payload = (await sent).postDataJSON();
      expect(payload.resolution).toBe(wire);
      expect([undefined, 'auto']).toContain(payload.aspectRatio);
      if (scenario.name === 'Legacy Chat') await page.screenshot({ path: testInfo.outputPath('native-auto-resolution.png'), animations: 'disabled' });
    }
  } finally { for (const id of providers) await request.delete(`/internal/providers/${id}`); }
});

test('custom model resolution capabilities edit, persist and expose a future native tier', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Custom resolution ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    const created = await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'private-future-image', displayName: 'Future image', enabled: true, capabilities: {
      profile: 'openai-chat-image-v1', operations: ['image.generate'], aspectRatios: ['auto', '1:1', '16:9'], resolutions: ['auto', '1K'],
    } } });
    expect(created.status()).toBe(201);
    await open(page, '/settings/providers');
    await page.getByRole('button', { name: '编辑模型 Future image', exact: true }).click();
    await page.getByRole('button', { name: '生成参数', exact: true }).click();
    await page.getByLabel('分辨率允许值', { exact: true }).fill('auto, 1K, 8K');
    await page.getByLabel('最大宽度', { exact: true }).fill('8192');
    await page.getByLabel('边长对齐倍数', { exact: true }).fill('32');
    await page.getByLabel('最大宽度', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('custom-resolution-capabilities.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑模型', exact: true })).toHaveCount(0);
    const model = (await (await request.get('/internal/models')).json()).items.find((item: ModelDto) => item.providerId === provider.id);
    expect(model.capabilities.imageResolution).toEqual({ mode: 'native', values: ['auto', '1K', '8K'], allowCustomDimensions: false, dimensions: { maxWidth: 8192, multipleOf: 32 } });
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await selectValue(page, '模型与服务', { label: `${provider.name} · Future image` });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择图片分辨率', exact: true }).click();
    await expect(page.getByRole('button', { name: '4K', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '8K', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择画幅', exact: true })).toContainText('auto');
    await savedModelOptions(request, provider.id, 'Future image', 'image', { resolution: '8K', ratio: 'auto' });
    await page.reload();
    await expect(page.getByRole('button', { name: '选择图片分辨率', exact: true })).toContainText('8K');
    await page.screenshot({ path: testInfo.outputPath('custom-native-tier.png'), animations: 'disabled' });
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('GPT Image 2 presets choose a valid ratio from auto on both layouts', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `GPT sizes ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  const ratios = ['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'];
  try {
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'gpt-image-2', displayName: 'GPT sizes', enabled: true, capabilities: {
      profile: 'openai-images-v1', operations: ['image.generate'], aspectRatios: ratios, resolutions: ['auto', '1024x1024', '3840x2160'],
      customFields: { properties: { size: { type: 'string' } } },
      parameters: [
        { path: 'aspectRatio', label: '画幅', type: 'select', options: ratios, defaultValue: 'auto' },
        { path: 'resolution', label: '分辨率', type: 'select', options: ['auto', '1024x1024', '3840x2160'], allowCustom: true, defaultValue: 'auto' },
      ],
    } } })).status()).toBe(201);
    await upload(request);
    await open(page);
    if (page.viewportSize()!.width <= 760) {
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      await selectValue(page, '模型与服务', { label: `${provider.name} · GPT sizes` });
      await page.keyboard.press('Escape');
    } else {
      await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
      await page.locator('.choice').filter({ has: page.getByText('GPT sizes', { exact: true }) }).click();
    }
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    await page.getByLabel('创作描述', { exact: true }).fill('GPT size fixture');
    for (const [preset, ratio, resolution] of [['1K', '16:9', '1280x720'], ['2K', '3:2', '2048x1360'], ['4K', '9:16', '2160x3840']]) {
      await page.getByRole('button', { name: '选择画幅', exact: true }).click();
      await page.getByRole('button', { name: 'auto', exact: true }).click();
      await page.keyboard.press('Escape');
      // Exercise generation settings as well as the shortcut, with atomic ratio/size updates.
      if (preset === '2K') await page.getByRole('button', { name: '生成设置', exact: true }).click();
      await page.getByRole('button', { name: preset === '2K' ? '分辨率' : '选择图片分辨率', exact: true }).click();
      await page.getByRole('button', { name: preset, exact: true }).click();
      if (preset === '4K') {
        await expect(page.locator('.image-resolution-options .ratio-options .choice')).toHaveText(['16:9', '9:16']);
        await page.screenshot({ path: testInfo.outputPath('gpt-4k-ratio-choices.png'), animations: 'disabled' });
      }
      await page.getByRole('button', { name: ratio, exact: true }).click();
      if (preset === '2K') await page.keyboard.press('Escape');
      await savedModelOptions(request, provider.id, 'GPT sizes', 'image', { parameters: { aspectRatio: ratio, resolution } });
      const sent = page.waitForRequest(req => req.url().endsWith('/internal/jobs') && req.method() === 'POST');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
      expect((await sent).postDataJSON()).toMatchObject({ aspectRatio: ratio, resolution });
      await page.reload();
      await expect(page.getByRole('button', { name: '选择画幅', exact: true })).toContainText(ratio);
      await expect(page.getByRole('button', { name: '选择图片分辨率', exact: true })).toContainText(preset);
    }
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('mobile pixel resolution presets submit mapped dimensions and retain custom sizes', async ({ page, request }, testInfo) => {
  test.skip(page.viewportSize()!.width > 760, 'Mobile generation settings');
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Mobile pixels ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'mobile-pixels', displayName: 'Mobile pixels', enabled: true, capabilities: {
      operations: ['image.generate'], aspectRatios: ['1:1', '16:9', '9:16'], resolutions: ['auto', '1024x1024', '1920x1080'],
      customFields: { type: 'object', properties: { size: { type: 'string' } } },
    } } })).status()).toBe(201);
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await selectValue(page, '模型与服务', { label: `${provider.name} · Mobile pixels` });
    await chooseRatio(page, '16:9');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择图片分辨率', exact: true }).click();
    await expect(page.locator('.image-resolution-options > .choice')).toHaveText(['auto', '1K', '2K', '4K', '自定义']);
    await page.getByRole('button', { name: '4K', exact: true }).click();
    await page.getByRole('button', { name: '选择图片生成数量', exact: true }).click();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('mobile-image-shortcuts.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '生成数量', exact: true })).toHaveText('×2');
    const resolution = page.getByLabel('分辨率', { exact: true });
    await chooseResolution(page, '4K');
    await chooseRatio(page, '9:16');
    await savedModelOptions(request, provider.id, 'Mobile pixels', 'image', { resolution: 'custom', customWidth: 2160, customHeight: 3840 });
    await page.keyboard.press('Escape');
    await page.getByLabel('创作描述', { exact: true }).fill('mobile resolution fixture');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: { code: 'captured', message: 'Captured locally' } } }) : route.continue());
    const submitted = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await submitted).postDataJSON()).toMatchObject({ resolution: '2160x3840' });
    await page.reload();
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(resolution).toContainText('4K');
    await chooseResolution(page, 'custom');
    await page.getByLabel('自定义图片宽度').fill('0');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '图片尺寸超出' })).toBeVisible();
    await page.getByRole('button', { name: '解锁画幅比例', exact: true }).click();
    await page.getByLabel('自定义图片宽度').fill('1920');
    await page.getByLabel('自定义图片高度').fill('1080');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await savedModelOptions(request, provider.id, 'Mobile pixels', 'image', { resolution: 'custom', customWidth: 1920, customHeight: 1088 });
    await page.screenshot({ path: testInfo.outputPath('mobile-custom-resolution.png'), animations: 'disabled' });
    await chooseResolution(page, 'auto');
    await savedModelOptions(request, provider.id, 'Mobile pixels', 'image', { resolution: 'auto' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '选择图片分辨率', exact: true })).toContainText('自动');
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(page.getByRole('group', { name: '图片快捷设置' })).toHaveCount(0);
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('count presets custom count ratio lock and card selects work across layouts', async ({ page, request }, testInfo) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Independent count ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'independent-image', displayName: 'Independent image', enabled: true, capabilities: {
      profile: 'openai-images-v1',
      operations: ['image.generate'], supportsBatchCount: false, maxBatchCount: 1,
      imageResolution: { mode: 'pixels', values: ['auto'], allowCustomDimensions: true },
      parameters: [
        { path: 'count', label: '生成数量', type: 'number', max: 1, defaultValue: 1, locked: true, visible: false },
        { path: 'aspectRatio', label: '画幅', type: 'select', options: ['auto', '16:9'], defaultValue: '16:9' },
        { path: 'resolution', label: '分辨率', type: 'select', options: ['1280x720', '2048x1152', '3840x2160'], allowCustom: true, defaultValue: '1280x720' },
        { path: 'quality', label: '质量', type: 'select', options: ['low', 'medium', 'high'], defaultValue: 'medium' },
      ],
    } } })).status()).toBe(201);
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await selectValue(page, '模型与服务', { label: `${provider.name} · Independent image` });
    await page.keyboard.press('Escape');
    const count = page.getByRole('button', { name: '选择图片生成数量', exact: true });
    await expect(count).toBeEnabled();
    await count.click();
    await expect(page.locator('.count-segments button')).toHaveText(['1', '2', '4', '8', '']);
    await page.screenshot({ path: testInfo.outputPath('count-presets.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '8', exact: true }).click();
    await expect(count).toContainText('×8');
    await count.click();
    await page.getByRole('button', { name: '自定义生成数量', exact: true }).click();
    await page.getByLabel('自定义张数', { exact: true }).fill('33');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('1 到 32');
    await page.getByLabel('自定义张数', { exact: true }).fill('13');
    await page.getByLabel('自定义张数', { exact: true }).press('Enter');
    await expect(count).toContainText('×13');
    await page.getByRole('button', { name: '选择图片分辨率', exact: true }).click();
    await page.getByRole('button', { name: '2K', exact: true }).click();
    await page.getByRole('button', { name: '选择图片分辨率', exact: true }).click();
    await page.getByRole('button', { name: '自定义', exact: true }).click();
    const width = page.getByLabel('自定义图片宽度', { exact: true });
    const height = page.getByLabel('自定义图片高度', { exact: true });
    await width.fill('1919');
    await height.focus();
    await expect(width).toHaveValue('1920');
    await expect(height).toHaveValue('1088');
    await width.focus();
    await expect(width).toHaveValue('1920');
    await height.fill('1440');
    await expect(width).toHaveValue('2560');
    await page.screenshot({ path: testInfo.outputPath('resolution-ratio-lock.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '解锁画幅比例', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择画幅', exact: true })).toContainText('auto');
    await expect(width).toHaveValue('2560');
    await expect(height).toHaveValue('1440');
    await savedModelOptions(request, provider.id, 'Independent image', 'image', { parameters: { aspectRatio: 'auto', resolution: '2048x1152' } });
    await page.screenshot({ path: testInfo.outputPath('resolution-ratio-unlocked.png'), animations: 'disabled' });
    await width.fill('1000');
    await height.focus();
    await expect(width).toHaveValue('1008');
    await expect(height).toHaveValue('1440');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '生成数量', exact: true })).toHaveText('×13');
    await expect(page.getByRole('button', { name: '画幅', exact: true })).toHaveText('auto');
    await chooseResolution(page, 'custom');
    await width.fill('2001');
    await height.focus();
    await expect(width).toHaveValue('2000');
    await expect(height).toHaveValue('1440');
    await page.getByRole('button', { name: '应用', exact: true }).click();
    const quality = page.getByRole('combobox', { name: '质量', exact: true });
    await quality.focus();
    await quality.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'medium', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('option', { name: 'high', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('h');
    await expect(page.getByRole('option', { name: 'high', exact: true })).toBeFocused();
    expect((await new AxeBuilder({ page }).include('.select-options').analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('parameter-select.png'), animations: 'disabled' });
    await page.keyboard.press('Enter');
    await expect(quality).toBeFocused();
    await expect(quality).toHaveText('high');
    await quality.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '生成设置', exact: true })).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    await page.getByLabel('创作描述', { exact: true }).fill('independent tasks');
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload).toMatchObject({ count: 13, resolution: '2000x1440', quality: 'high' });
    expect(payload.aspectRatio).toBe('auto');
    await savedModelOptions(request, provider.id, 'Independent image', 'image', { count: 13, parameters: { resolution: '2000x1440', aspectRatio: 'auto' } });
    await page.reload();
    await expect(count).toContainText('×13');
    await expect(page.getByRole('button', { name: '选择画幅', exact: true })).toContainText('auto');
    const { items } = await (await request.get(`/internal/models?providerId=${provider.id}`)).json();
    const model = items.find((item: ModelDto) => item.displayName === 'Independent image');
    expect((await request.patch(`/internal/models/${model.id}`, { data: { capabilities: { ...model.capabilities, parameters: model.capabilities.parameters.map((rule: { path: string }) => rule.path === 'aspectRatio' ? { ...rule, locked: true, defaultValue: '16:9' } : rule) } } })).ok()).toBeTruthy();
    await page.reload();
    await page.getByRole('button', { name: '选择图片分辨率', exact: true }).click();
    await page.getByRole('button', { name: '自定义', exact: true }).click();
    await expect(page.getByRole('button', { name: '模型固定画幅比例', exact: true })).toBeDisabled();
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('desktop video shortcuts preserve presets custom values and model rules', async ({ page, request }, testInfo) => {
  test.skip(page.viewportSize()!.width <= 760);
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Desktop ${randomUUID()}`, type: 'openai', enabled: true, isDefault: true } })).json();
  try {
    for (const name of ['Standard video', 'Managed video']) {
      const added = await request.post('/internal/models', { data: { providerId: provider.id, modelId: name.replace(' ', '-'), displayName: name, enabled: true, capabilities: {
        operations: ['video.generate'], aspectRatios: ['16:9'], resolutions: ['480p', '720p', '1080p', '1440p'], durations: { min: 1, max: 30 },
        ...(name.startsWith('Managed') ? { parameters: [
          { path: 'resolution', label: '分辨率', type: 'select', options: ['480p', '720p', '1080p'], allowCustom: true, defaultValue: '480p' },
          { path: 'durationSeconds', label: '视频时长', type: 'number', min: 1, max: 30, step: 1, defaultValue: 6 },
        ] } : {}),
      } } });
      expect(added.status()).toBe(201);
    }
    await open(page);
    await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
    for (const name of ['Standard video', 'Managed video']) {
      await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
      await page.locator('.choice').filter({ has: page.getByText(name, { exact: true }) }).click();
      const resolution = page.getByRole('button', { name: '选择视频分辨率', exact: true });
      const duration = page.getByRole('button', { name: '选择视频时长', exact: true });
      await resolution.click();
      await expect(page.locator('.desktop-video-options > .choice')).toHaveText(['480p', '720p', '1080p', '1440p', '自定义']);
      await page.getByRole('button', { name: '1080p', exact: true }).click();
      await expect(resolution).toContainText('1080p');
      await duration.click();
      await expect(page.locator('.desktop-video-options > .choice')).toHaveText(['6s', '10s', '15s', '自定义']);
      await page.getByRole('button', { name: '15s', exact: true }).click();
      await expect(duration).toContainText('15s');
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      if (name === 'Standard video') await expect(page.getByRole('combobox', { name: '分辨率', exact: true })).toHaveText('1080p');
      else await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('1080p');
      await expect(page.getByLabel('视频时长', { exact: true })).toHaveValue('15');
      await page.keyboard.press('Escape');
      await resolution.click();
      await page.getByRole('button', { name: '自定义', exact: true }).click();
      await page.getByLabel('自定义视频分辨率', { exact: true }).fill('0');
      await page.getByRole('button', { name: '应用', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: '超出当前模型允许范围' })).toBeVisible();
      await page.getByLabel('自定义视频分辨率', { exact: true }).fill('1440');
      await page.getByRole('button', { name: '应用', exact: true }).click();
      await expect(resolution).toContainText('1440p');
      await duration.click();
      await page.getByRole('button', { name: '自定义', exact: true }).click();
      await page.getByLabel('自定义视频时长', { exact: true }).fill('12');
      await page.getByRole('button', { name: '应用', exact: true }).click();
      await expect(duration).toContainText('12s');
      await page.screenshot({ path: testInfo.outputPath(`${name}-shortcuts.png`), animations: 'disabled' });
      await page.getByLabel('创作描述', { exact: true }).fill('desktop video parameter contract');
      await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: { code: 'captured', message: 'Captured locally' } } }) : route.continue());
      const submitted = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
      await page.getByRole('button', { name: '开始生成', exact: true }).click();
      expect((await submitted).postDataJSON()).toMatchObject({ resolution: '1440p', durationSeconds: 12 });
      await savedModelOptions(request, provider.id, name, 'video', name.startsWith('Managed') ? { parameters: { resolution: '1440p', durationSeconds: 12 } } : { resolution: '1440p', duration: 12 });
      await page.reload();
      await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
      await expect(page.locator('.model-trigger')).toContainText(name);
      await expect(resolution).toContainText('1440p');
      await expect(duration).toContainText('12s');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: '选择视频分辨率', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择视频时长', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('1440p');
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('desktop gallery scroll keeps headers fixed and paginates in its own viewport', async ({ page, request }, testInfo) => {
  test.skip(page.viewportSize()!.width <= 760);
  await upload(request);
  const base = (await (await request.get('/internal/assets?limit=1')).json()).items[0];
  const items = Array.from({ length: 90 }, () => ({ ...base, id: randomUUID() }));
  let nextPages = 0;
  await page.route(/\/internal\/assets\?/, route => {
    const next = new URL(route.request().url()).searchParams.has('cursor');
    if (next) nextPages++;
    return route.fulfill({ json: { items: next ? items.slice(60) : items.slice(0, 60), nextCursor: next ? null : 'next-page' } });
  });
  await open(page);
  const scroll = page.locator('.gallery-scroll');
  await expect(scroll).toHaveCSS('scrollbar-width', 'none');
  await expect(scroll).toHaveCSS('overflow-x', 'hidden');
  const fixed = ['.workspace-header', '.library-heading', '.library-filter', '.creation-composer'];
  const before = await Promise.all(fixed.map(selector => page.locator(selector).boundingBox()));
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const bounds = (await scroll.boundingBox())!;
  await page.mouse.move(bounds.x + 80, bounds.y + 80);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  expect(await page.locator('.workspace').evaluate(element => element.scrollTop)).toBe(0);
  for (const [index, selector] of fixed.entries()) expect(await page.locator(selector).boundingBox()).toEqual(before[index]);
  await page.screenshot({ path: testInfo.outputPath('desktop-gallery-scrolled.png'), animations: 'disabled' });
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => nextPages).toBeGreaterThan(0);
  await expect(page.getByText('已显示全部作品', { exact: true })).toBeAttached();
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(`[data-study-id="${items.at(-1)!.id}"]`)).toBeInViewport();
  expect(await page.locator('.study-card').count()).toBeLessThan(items.length);
  const desktop = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.workspace-mobile')).toBeVisible();
  await expect(scroll).toHaveCSS('display', 'contents');
  await page.locator('.workspace').evaluate(element => { element.scrollTop = 100; });
  await expect.poll(() => page.locator('.workspace').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.setViewportSize(desktop);
  await expect(page.locator('.workspace-desktop')).toBeVisible();
  await scroll.evaluate(element => { element.scrollTop = 300; });
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

test('catalog selection loads capabilities and unknown models copy builtin or saved configuration', async ({ page, request }, testInfo) => {
  const name = `Template connection ${randomUUID()}`;
  const { provider } = await (await request.post('/internal/providers', { data: { name, type: 'openai', enabled: true } })).json();
  const sourceCapabilities = { operations: ['image.generate', 'image.edit'], profile: 'openai-chat-image-v1', aspectRatios: ['auto', '16:9'], resolutions: ['2K'], maxReferenceImages: 3, parameters: [{ path: 'resolution', label: '固定分辨率', type: 'select', options: ['2K'], defaultValue: '2K', locked: true }] };
  const created = await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'saved-template-image', displayName: 'Saved template', enabled: false, capabilities: sourceCapabilities } });
  expect(created.status()).toBe(201);
  const source = (await created.json()).model;
  try {
    await page.route(`**/internal/providers/${provider.id}/models/catalog`, route => route.fulfill({ json: { models: [{ id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2' }, { id: 'private-image-alias', displayName: 'private-image-alias' }] } }));
    await open(page, '/settings/providers');
    await page.getByRole('region', { name: `连接 ${name}`, exact: true }).getByRole('button', { name: '添加模型', exact: true }).click();
    const picker = page.getByRole('combobox', { name: '远端模型目录', exact: true });
    await picker.click();
    await page.getByRole('option').filter({ hasText: 'Nano Banana 2' }).click();
    await expect(page.getByText('已载入模型能力', { exact: true })).toBeVisible();
    await expect(page.getByLabel('最大参考图数量', { exact: true })).toHaveValue('14');
    await expect(page.getByLabel('分辨率允许值', { exact: true })).toHaveValue('512, 1K, 2K, 4K');
    await expect(page.getByLabel('参数路径 2', { exact: true })).toHaveValue('resolution');
    await picker.click();
    await page.getByRole('option').filter({ hasText: 'private-image-alias' }).click();
    await expect(page.getByText('未找到内置能力', { exact: true })).toBeVisible();
    await page.getByLabel('模型显示名称', { exact: true }).fill('My private alias');
    await selectValue(page, '配置来源模型', { label: '内置 · Nano Banana 2 · Generate Content' });
    await page.getByRole('button', { name: '复制配置', exact: true }).click();
    await expect(page.getByLabel('最大参考图数量', { exact: true })).toHaveValue('14');
    await selectValue(page, '配置来源模型', { label: `${name} · Saved template · saved-template-image` });
    await page.getByRole('button', { name: '复制配置', exact: true }).click();
    await expect(page.getByLabel('最大参考图数量', { exact: true })).toHaveValue('3');
    await expect(page.getByLabel('参数默认值 1', { exact: true })).toHaveValue('2K');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('private-image-alias');
    await expect(page.getByLabel('模型显示名称', { exact: true })).toHaveValue('My private alias');
    await page.getByLabel('配置来源模型', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('copy-model-capabilities.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toHaveCount(0);
    const items = (await (await request.get('/internal/models')).json()).items;
    expect(items.find((item: ModelDto) => item.modelId === 'private-image-alias')).toMatchObject({ providerId: provider.id, displayName: 'My private alias', enabled: true, capabilities: source.capabilities });
    expect(items.find((item: ModelDto) => item.id === source.id)).toEqual(source);
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('delayed automatic capability loading preserves newer model edits', async ({ page, request }) => {
  const name = `Delayed template ${randomUUID()}`;
  const { provider } = await (await request.post('/internal/providers', { data: { name, type: 'openai', enabled: true } })).json();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route(`**/internal/providers/${provider.id}/models/catalog`, route => route.fulfill({ json: { models: [{ id: 'gemini-3.1-flash-image', displayName: 'Nano Banana 2' }] } }));
    await page.route(`**/internal/providers/${provider.id}/models/capabilities?*`, async route => { await gate; await route.fulfill({ json: { capabilities: { operations: ['image.generate'], maxReferenceImages: 14 } } }); });
    await open(page, '/settings/providers');
    await page.getByRole('region', { name: `连接 ${name}`, exact: true }).getByRole('button', { name: '添加模型', exact: true }).click();
    await page.getByRole('combobox', { name: '远端模型目录', exact: true }).click();
    await page.getByRole('option').filter({ hasText: 'Nano Banana 2' }).click();
    await expect(page.getByText('正在载入模型能力…', { exact: true })).toBeVisible();
    await page.getByLabel('最大参考图数量', { exact: true }).fill('7');
    const response = page.waitForResponse(res => res.url().includes('/models/capabilities?'));
    release(); await response;
    await expect(page.getByLabel('最大参考图数量', { exact: true })).toHaveValue('7');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toHaveCount(0);
    expect((await (await request.get('/internal/models')).json()).items.find((item: ModelDto) => item.providerId === provider.id).capabilities.maxReferenceImages).toBe(7);
  } finally { release(); await request.delete(`/internal/providers/${provider.id}`); }
});

test('catalog models delete directly and capability loading preserves model edits', async ({ page, request }) => {
  const refresh = await request.post('/internal/providers/mock/models/refresh');
  expect(refresh.status()).toBe(200);
  const discovered = (await refresh.json()).items.find((model: ModelDto) => model.capabilitySource !== 'manual') as ModelDto;
  expect(discovered).toBeDefined();
  const { provider } = await (await request.post('/internal/providers', { data: { name: `CPA capability fixture ${randomUUID()}`, type: 'xai', enabled: true } })).json();
  try {
    const created = await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'gemini-3.1-flash-image', displayName: 'Nano Banana fixture', capabilities: { operations: ['image.generate'], parameters: [] }, enabled: true } });
    expect(created.status()).toBe(201);
    const saved = (await created.json()).model;
    await open(page, '/settings/providers');
    await expect(page.getByRole('button', { name: '刷新模型', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `删除模型 ${discovered.displayName}`, exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('button', { name: `删除模型 ${discovered.displayName}`, exact: true })).toHaveCount(0);
    expect((await (await request.get('/internal/models')).json()).items.some((model: ModelDto) => model.id === discovered.id)).toBe(false);
    await page.getByRole('button', { name: '编辑模型 Nano Banana fixture', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑模型', exact: true });
    const toggle = dialog.getByRole('button', { name: '生成参数', exact: true });
    const save = dialog.getByRole('button', { name: '保存模型', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.locator('.parameter-content')).toBeHidden();
    await expect(dialog.locator('.model-form-body')).toHaveCSS('scrollbar-width', 'none');
    await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `/tmp/imagine-collapsed-model-${page.viewportSize()!.width}.png` });
    await expect(page.getByLabel('参数路径 1', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '从模型能力载入', exact: true }).click();
    await expect(page.getByLabel('参数路径 1', { exact: true })).toHaveValue('aspectRatio');
    await expect(page.getByLabel('参数路径 2', { exact: true })).toHaveValue('resolution');
    expect((await (await request.get('/internal/models')).json()).items.find((model: ModelDto) => model.id === saved.id).capabilities).toEqual(saved.capabilities);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.getByLabel('参数默认值 1', { exact: true }).fill('16:9');
    await expect(save).toBeInViewport({ ratio: 1 });
    await dialog.locator('.model-form-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => dialog.locator('.model-form-body').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(save).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `/tmp/imagine-expanded-model-${page.viewportSize()!.width}.png` });
    await toggle.click();
    await expect(dialog.locator('.parameter-content')).toBeHidden();
    await toggle.click();
    await expect(page.getByLabel('参数默认值 1', { exact: true })).toHaveValue('16:9');
    await page.getByLabel('模型显示名称', { exact: true }).fill('Pinned Nano Banana');
    await page.getByRole('button', { name: '从模型能力载入', exact: true }).click();
    await expect(page.getByRole('button', { name: '从模型能力载入', exact: true })).toBeEnabled();
    await expect(page.getByLabel('参数默认值 1', { exact: true })).toHaveValue('16:9');
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑模型', exact: true })).toHaveCount(0);
    const updated = (await (await request.get('/internal/models')).json()).items.find((model: ModelDto) => model.id === saved.id);
    expect(updated).toMatchObject({ displayName: 'Pinned Nano Banana', capabilities: { resolutions: ['512', '1K', '2K', '4K'], parameters: expect.arrayContaining([expect.objectContaining({ path: 'aspectRatio', defaultValue: '16:9' })]) } });
    await page.reload();
    await expect(page.getByRole('button', { name: '删除模型 Pinned Nano Banana', exact: true })).toBeVisible();
  } finally { await request.delete(`/internal/providers/${provider.id}`); await request.post('/internal/providers/mock/models/refresh'); }
});

test('shared connection model management saves rules and renders them in the composer', async ({ page, request }) => {
  const name = `Managed connection ${randomUUID()}`;
  const created = await request.post('/internal/providers', { data: { name, type: 'xai', baseUrl: 'https://api.example.com/v1', enabled: true, isDefault: true } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    for (const kind of ['image', 'video']) {
      const response = await request.post('/internal/models', { data: { providerId: provider.id, modelId: `grok-imagine-${kind}-1.5`, displayName: `Managed ${kind}`, capabilities: { operations: [`${kind}.generate`], profile: `xai-imagine-${kind}-v1`, parameters: kind === 'image' ? [{ path: 'quality', label: '质量', type: 'text', defaultValue: 'low' }] : [] }, enabled: true } });
      expect(response.status()).toBe(201);
    }
    await open(page, '/settings/providers');
    await page.getByRole('button', { name: `编辑连接 ${name}`, exact: true }).click();
    const types = page.getByLabel('接口类型', { exact: true });
    await expect(types).toHaveText('xAI');
    await types.click();
    expect(await page.getByRole('listbox', { name: '接口类型', exact: true }).getByRole('option').evaluateAll(options => options.map(option => (option as HTMLButtonElement).value))).toEqual(['openai', 'gemini', 'xai', 'custom-http-v1', 'custom-js-v1']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await open(page, '/settings/models');
    await selectValue(page, '筛选连接', provider.id);
    await expect(page.locator('.model-table tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: '编辑模型 Managed image', exact: true }).click();
    await page.getByRole('button', { name: '生成参数', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '模型调用协议', exact: true })).toContainText('xAI');
    await page.getByRole('combobox', { name: '选择参数路径 1', exact: true }).click();
    await expect(page.getByRole('option', { name: 'count', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `/tmp/imagine-parameter-path-${page.viewportSize()!.width}.png` });
    await page.getByRole('option', { name: 'quality', exact: true }).click();
    await page.getByLabel('参数默认值 1', { exact: true }).fill('high');
    await page.getByLabel('固定默认值', { exact: true }).check();
    await page.screenshot({ path: `/tmp/imagine-model-editor-${page.viewportSize()!.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑模型', exact: true })).toHaveCount(0);
    const models = (await (await request.get(`/internal/models?providerId=${provider.id}`)).json()).items;
    expect(models.find((model: { displayName: string }) => model.displayName === 'Managed image').capabilities.parameters[0]).toMatchObject({ defaultValue: 'high', locked: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/imagine-model-admin-${page.viewportSize()!.width}.png`, fullPage: true });
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '生成数量', exact: true })).toBeEnabled();
    await chooseCount(page, '2');
    await expect(page.getByLabel('质量', { exact: true })).toHaveValue('high');
    await expect(page.getByLabel('质量', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('画幅', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByLabel('创作描述', { exact: true }).fill('managed parameters');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload).toMatchObject({ providerId: provider.id, count: 2, quality: 'high' });
    expect(payload).not.toHaveProperty('format');
    expect(payload).not.toHaveProperty('aspectRatio');
  } finally { expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy(); }
});

test('project selection scopes resources, references and generated outputs with inline loading', async ({ page, request }) => {
  const first = await upload(request, 'coast');
  await upload(request, 'mountain');
  const project = (await (await request.post('/internal/collections', { data: { name: `项目 ${randomUUID()}` } })).json()).collection;
  expect((await request.post(`/internal/collections/${project.id}/assets`, { data: { assetIds: [first.id] } })).ok()).toBeTruthy();
  await open(page);
  await page.getByRole('button', { name: '选择项目', exact: true }).click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  await expect(page.getByRole('button', { name: '选择项目', exact: true })).toContainText(project.name);
  await expect(page.locator('.study-card')).toHaveCount(1);
  await page.getByRole('button', { name: '添加参考图', exact: true }).click();
  await page.getByRole('button', { name: '从资源库选择', exact: true }).click();
  await expect(page.locator('.reference-option')).toHaveCount(1);
  await page.locator('.reference-option').click();
  await page.getByRole('button', { name: '添加 1 张图片', exact: true }).click();
  await expect(page.locator('.reference-tray .reference')).toHaveCount(1);
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await chooseRatio(page, 'auto');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const prompt = `project generation ${randomUUID()}`;
  await page.getByLabel('创作描述', { exact: true }).fill(prompt);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/internal/jobs', async route => { if (route.request().method() === 'POST') await held; await route.continue(); });
  try {
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    await expect(page.locator('.study-grid .pending-study')).toHaveCount(1);
    await expect(page.locator('.pending-jobs')).toHaveCount(0);
    await expect(page.locator('.pending-study')).toHaveAttribute('aria-busy', 'true');
    expect(await page.locator('.pending-study-art').evaluate(element => getComputedStyle(element).backgroundImage)).toContain('linear-gradient');
    await page.screenshot({ path: `/tmp/imagine-pending-${page.viewportSize()!.width}.png`, fullPage: true });
  } finally { release(); }
  await expect.poll(async () => {
    const jobs = (await (await request.get('/internal/jobs?limit=100')).json()).items;
    return jobs.find((job: { prompt: string }) => job.prompt === prompt)?.status;
  }, { timeout: 20000 }).toBe('completed');
  const jobs = (await (await request.get('/internal/jobs?limit=100')).json()).items;
  const job = jobs.find((job: { prompt: string }) => job.prompt === prompt);
  expect(job.request).toMatchObject({ collectionId: project.id, operation: 'image.edit', inputs: [{ assetId: first.id, role: 'source' }] });
  expect(job.request).not.toHaveProperty('aspectRatio');
  await expect(page.locator('.study-grid .pending-study')).toHaveCount(0);
  await expect(page.locator('.study-card')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('button', { name: '选择项目', exact: true })).toContainText(project.name);
  await expect(page.locator('.study-card')).toHaveCount(2);
});

test('xAI reference upload automatically chooses image edit and auto ratio', async ({ page, request }) => {
  const created = await request.post('/internal/providers', { data: { name: `xAI edits ${randomUUID()}`, type: 'xai', baseUrl: 'https://api.example.com/v1', enabled: true, isDefault: true } });
  const { provider } = await created.json();
  try {
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'grok-imagine-image-2.0', displayName: 'xAI reference model', enabled: true, capabilities: { operations: ['image.generate', 'image.edit'], aspectRatios: ['1:1', '16:9'], maxReferenceImages: 3 } } })).status()).toBe(201);
    await open(page);
    await page.getByRole('button', { name: '添加参考图', exact: true }).click();
    await expect(page.getByRole('button', { name: '上传新图片', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByLabel('上传参考图', { exact: true }).setInputFiles(resolve('e2e/media/coast.webp'));
    await expect(page.locator('.reference.upload-ready')).toBeVisible();
    await page.getByLabel('创作描述', { exact: true }).fill('change the lighting');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload.operation).toBe('image.edit');
    expect(payload.inputs[0].role).toBe('source');
    expect(payload).not.toHaveProperty('aspectRatio');
  } finally { expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy(); }
});

test('card references, video parameter memory and responsive video controls', async ({ page, request }) => {
  const asset = await upload(request);
  await request.patch('/internal/providers/mock', { data: { isDefault: true } });
  await open(page);
  const card = page.locator(`[data-study-id="${asset.id}"]`);
  await card.hover();
  await card.locator('.card-reference').click();
  await expect(page.locator('.reference-tray img')).toHaveCount(1);
  await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
  const modes = await page.getByRole('group', { name: '视频输入方式' }).boundingBox();
  const controls = await page.locator('.creation-controls').boundingBox();
  if (page.viewportSize()!.width <= 760) {
    expect(Math.abs(modes!.y - controls!.y)).toBeLessThan(6);
    const settings = await page.getByRole('button', { name: '生成设置', exact: true }).boundingBox();
    const submit = await page.getByRole('button', { name: '开始生成', exact: true }).boundingBox();
    expect(Math.abs(modes!.y + modes!.height / 2 - settings!.y - settings!.height / 2)).toBeLessThan(1);
    expect(modes!.x + modes!.width).toBeLessThanOrEqual(settings!.x);
    expect(submit!.x - settings!.x).toBeLessThan(60);
    await expect(page.locator('.mode-segment > span').first()).toBeHidden();
    await expect(page.locator('.mode-segment > span').last()).toBeHidden();
  } else {
    expect(modes!.y + modes!.height).toBeLessThanOrEqual(controls!.y);
    expect(modes!.x).toBe(controls!.x);
  }
  await page.screenshot({ path: `/tmp/imagine-inline-video-${page.viewportSize()!.width}.png` });
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await selectValue(page, '分辨率', '720p');
  await chooseRatio(page, '9:16');
  await expect(page.getByRole('combobox', { name: '分辨率', exact: true })).toHaveText('720p');
  await page.keyboard.press('Escape');
  await page.getByLabel('创作描述', { exact: true }).fill('video remembers independent dimensions');
  const submitted = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({ aspectRatio: '9:16', resolution: '720p' });
  await expect.poll(async () => Object.values((await (await request.get('/internal/settings')).json()).settings['generation.default']?.video?.models ?? {}).some((value: unknown) => !!value && typeof value === 'object' && 'resolution' in value && value.resolution === '720p')).toBe(true);
  await page.reload();
  await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '画幅', exact: true })).toHaveText('9:16');
  await expect(page.getByRole('combobox', { name: '分辨率', exact: true })).toHaveText('720p');
});

test('account category exposes administrator account management and live public domain', async ({ page, request }) => {
  await open(page, '/settings');
  await expect(page.getByLabel('账号用户名', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '账号管理', exact: true }).click();
  await page.getByLabel('公网域名', { exact: true }).fill('https://imagine.example.com');
  await page.getByRole('button', { name: '保存公网域名', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings.public_base_url).toBe('https://imagine.example.com');
  await page.reload();
  await expect(page.getByLabel('公网域名', { exact: true })).toHaveValue('https://imagine.example.com');
  const username = `user-${randomUUID()}`;
  await page.getByLabel('新账号用户名', { exact: true }).fill(username);
  await page.getByLabel('新账号初始密码', { exact: true }).fill('test-user-password');
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByLabel(`启用账号 ${username}`, { exact: true })).toBeChecked();
  await page.getByLabel(`启用账号 ${username}`, { exact: true }).uncheck();
  await expect(page.getByLabel(`启用账号 ${username}`, { exact: true })).not.toBeChecked();
  await expect(page.getByLabel(`启用账号 ${username}`, { exact: true })).toBeEnabled();
  expect((await request.post('/internal/auth/login', { data: { username, password: 'test-user-password' } })).status()).toBe(401);
  await request.patch('/internal/settings', { data: { values: { public_base_url: '' } } });
});

test('failed waterfall cards can be deleted independently', async ({ page, request }) => {
  const response = await request.post('/internal/jobs', { data: { operation: 'image.generate', providerId: 'mock', modelId: 'mock-image-v1', prompt: 'failed card deletion', inputs: [] } });
  expect(response.status()).toBe(202);
  const id = (await response.json()).job.id as string;
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${id}`)).json()).job.status).toBe('completed');
  await page.route('**/internal/jobs?*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.items = body.items.map((job: { id: string; request: Record<string, unknown> }) => job.id === id ? { ...job, status: 'failed', errorMessage: '测试失败状态', request: { ...job.request, count: 2 } } : job);
    await route.fulfill({ response, json: body });
  });
  await open(page);
  const card = page.locator(`[data-pending-job="${id}"]`).first();
  await expect(card.getByRole('button', { name: '重试生成' })).toBeVisible();
  await card.getByRole('button', { name: '删除失败任务' }).click();
  await expect(page.locator(`[data-pending-job="${id}"]`)).toHaveCount(0);
  expect((await request.get(`/internal/jobs/${id}`)).status()).toBe(404);
  await page.unrouteAll({ behavior: 'wait' });
});

test('ordinary accounts log in without seeing administrator data and can change their credentials', async ({ page, request, browser }) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  await upload(request);
  const username = `member-${randomUUID()}`;
  expect((await request.post('/internal/accounts', { data: { username, password: 'member-password' } })).status()).toBe(201);
  await open(page);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: page.viewportSize()!, storageState: { cookies: [], origins: [] } });
  try {
    const other = await context.newPage();
    await other.goto('/imagine');
    await expect(other.getByRole('heading', { name: '登录 Imagine' })).toBeVisible();
    await other.screenshot({ path: `/tmp/imagine-account-login-${page.viewportSize()!.width}.png` });
    await other.getByLabel('用户名', { exact: true }).fill(username);
    await other.getByLabel('密码', { exact: true }).fill('member-password');
    await other.getByRole('button', { name: '登录', exact: true }).click();
    await expect(other.getByRole('heading', { name: '还没有作品', exact: true })).toBeVisible();
    await expect(other.locator('.study-card')).toHaveCount(0);
    await other.goto('/settings/account');
    await expect(other.getByLabel('账号用户名', { exact: true })).toHaveValue(username);
    await expect(other.getByLabel('公网域名', { exact: true })).toHaveCount(0);
    await expect(other.getByLabel('新账号用户名', { exact: true })).toHaveCount(0);
    await other.getByLabel('当前密码', { exact: true }).fill('member-password');
    await other.getByLabel('新密码', { exact: true }).fill('changed-password');
    await other.getByRole('button', { name: '保存账号', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: '已保存' })).toBeVisible();
    await other.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(other.getByRole('heading', { name: '登录 Imagine' })).toBeVisible();
    await other.getByLabel('用户名', { exact: true }).fill(username);
    await other.getByLabel('密码', { exact: true }).fill('changed-password');
    await other.getByRole('button', { name: '登录', exact: true }).click();
    await expect(other.getByLabel('账号用户名', { exact: true })).toHaveValue(username);
    await page.goto('/settings/account');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录 Imagine' })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill('changed-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('账号用户名', { exact: true })).toHaveValue(username);
    await page.goto('/imagine');
    await expect(page.getByRole('heading', { name: '还没有作品', exact: true })).toBeVisible();
    await expect(page.locator('.study-card')).toHaveCount(0);
  } finally { await context.close(); }
});

test('mobile edge navigation, scroll boundaries and installed viewport remain stable', async ({ page }) => {
  test.skip(page.viewportSize()!.width > 760);
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }));
  await open(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /maximum-scale=1, user-scalable=no/);
  const swipe = async (x: number, y: number, nextX: number, nextY: number) => page.evaluate(({ x, y, nextX, nextY }) => {
    const target = document.querySelector('.workspace')!;
    const dispatch = (type: string, clientX: number, clientY: number) => {
      const touch = { identifier: 1, target, clientX, clientY };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
      target.dispatchEvent(event); return event.defaultPrevented;
    };
    dispatch('touchstart', x, y); const prevented = dispatch('touchmove', nextX, nextY); dispatch('touchend', nextX, nextY); return prevented;
  }, { x, y, nextX, nextY });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await swipe(8, 160, 100, 164);
  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await swipe(100, 160, 190, 162);
  await expect(page.getByRole('navigation', { name: '手机导航' })).toHaveCount(0);
  await page.locator('.workspace').evaluate(element => { element.scrollTop = 0; });
  expect(await swipe(120, 160, 122, 250)).toBe(true);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.locator('.library-area').evaluate(element => { (element as HTMLElement).style.minHeight = '2000px'; });
  await page.locator('.workspace').evaluate(element => { element.scrollTop = 100; });
  expect(await swipe(120, 160, 122, 180)).toBe(false);
  expect(await page.evaluate(() => { const event = new Event('gesturestart', { cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await page.goto('/settings/account');
  const input = page.getByLabel('新账号用户名', { exact: true });
  await input.click();
  expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('gallery action buttons share the intended surface for each layout', async ({ page, request }) => {
  await upload(request); await open(page);
  const styles = await page.locator('.study-card').first().evaluate(element => ['.card-bookmark', '.card-reference', '.card-more'].map(selector => {
    const style = getComputedStyle(element.querySelector(selector)!);
    return { background: style.backgroundColor, blur: style.backdropFilter, radius: style.borderRadius, width: style.width, height: style.height };
  }));
  expect(styles[1]).toEqual(styles[0]); expect(styles[2]).toEqual(styles[0]);
  const mobile = page.viewportSize()!.width <= 760;
  expect(styles[0]!.blur).toBe(mobile ? 'none' : 'blur(9px)');
  if (mobile) expect(styles[0]!.background).toBe('rgba(0, 0, 0, 0)');
});


test('back to top follows the active gallery viewport and avoids composer selection and keyboard', async ({ page, request }, testInfo) => {
  await upload(request);
  const base = (await (await request.get('/internal/assets?limit=1')).json()).items[0];
  const items = Array.from({ length: 80 }, () => ({ ...base, id: randomUUID() }));
  await page.route(/\/internal\/assets\?/, route => route.fulfill({ json: { items, nextCursor: null } }));
  const { collection } = await (await request.post('/internal/collections', { data: { name: 'Return to top' } })).json();
  await page.route(`**/internal/collections/${collection.id}/assets?*`, route => route.fulfill({ json: { items, nextCursor: null } }));
  for (const path of ['/imagine', '/library', '/saved', `/projects/${collection.id}`]) {
    await open(page, path);
    const scroll = page.locator(page.viewportSize()!.width > 760 ? '.gallery-scroll' : '.workspace');
    const button = page.getByRole('button', { name: '返回顶部', exact: true });
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1000);
    await scroll.evaluate(element => { element.scrollTop = 600; });
    await expect(button).toHaveCount(0);
    await scroll.evaluate(element => { element.scrollTop = 700; });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    const grid = (await page.locator('.study-grid').boundingBox())!;
    if (await page.locator('.creation-composer').count()) {
      const send = (await page.locator('.creation-composer .generate-button').boundingBox())!;
      expect(Math.abs(box.x + box.width / 2 - send.x - send.width / 2)).toBeLessThanOrEqual(2);
    } else expect(Math.abs(box.x + box.width - (grid.x + grid.width))).toBeLessThanOrEqual(2);
    expect(box.width).toBe(page.viewportSize()!.width > 760 ? 40 : 44);
    await expect(button).toHaveCSS('backdrop-filter', 'none');
    const composer = page.locator('.creation-composer');
    if (await composer.count()) expect(Math.abs((await composer.boundingBox())!.y - box.y - box.height - 12)).toBeLessThanOrEqual(2);
    else expect(Math.abs(page.viewportSize()!.height - box.y - box.height - 20)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath(`back-top-${path.split('/')[1]}.png`), animations: 'disabled' });
    await button.click();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(0);
    await expect(button).toHaveCount(0);
    await page.getByRole('button', { name: '选择作品', exact: true }).click();
    await scroll.evaluate(element => { element.scrollTop = 700; });
    await expect(button).toHaveCount(0);
    await page.getByRole('button', { name: '关闭多选', exact: true }).click();
  }
  await open(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scroll = page.locator(page.viewportSize()!.width > 760 ? '.gallery-scroll' : '.workspace');
  await scroll.evaluate(element => { element.scrollTop = 700; });
  await expect(page.locator('.back-to-top')).toBeVisible();
  await page.evaluate(() => {
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args: Parameters<Element['scrollTo']>) {
      document.documentElement.dataset.topScrollBehavior = typeof args[0] === 'object' ? args[0]?.behavior : '';
      return Reflect.apply(original, this, args);
    };
  });
  await page.locator('.back-to-top').click();
  expect(await page.locator('html').getAttribute('data-top-scroll-behavior')).toBe('instant');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.workspace').evaluate(element => { element.scrollTop = 700; });
  await expect(page.locator('.back-to-top')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 480 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
  await expect(page.locator('.back-to-top')).toHaveCount(0);
  await page.evaluate(() => { delete (window.visualViewport as unknown as { height?: number }).height; window.visualViewport!.dispatchEvent(new Event('resize')); });
  await expect(page.locator('.back-to-top')).toBeVisible();
  await page.locator('.back-to-top').click();
  await expect.poll(() => page.locator('.workspace').evaluate(element => element.scrollTop)).toBe(0);
});


test('image editing workspace expands in place preserves masks and shows local results', async ({ page, request }, testInfo) => {
  const source = await upload(request, 'coast');
  await open(page);
  await page.getByLabel('创作描述', { exact: true }).fill('main-page draft stays intact');
  await page.locator(`[data-study-id="${source.id}"] .study-open`).click();
  const viewer = page.locator('.image-editing-viewer'), controls = page.locator('.image-editing-controls');
  await expect(controls.locator('.composer-compact')).toBeVisible();
  await expect(viewer.locator('.viewer-footer, .zoom-tools')).toHaveCount(0);
  const before = (await controls.boundingBox())!;
  const prompt = controls.getByLabel('创作描述', { exact: true });
  await prompt.fill('Change the marked region into a small garden');
  await expect(controls.locator('.composer-compact')).toHaveCount(0);
  expect((await controls.boundingBox())!.height).toBeGreaterThan(before.height);
  await expect.poll(async () => { const mask = (await controls.locator('.editing-mask-entry').boundingBox())!; const send = (await controls.locator('.generate-button').boundingBox())!; return Math.abs(mask.x + mask.width / 2 - send.x - send.width / 2); }).toBeLessThanOrEqual(1);
  const stage = viewer.locator('.viewer-stage');
  await stage.click({ position: { x: 10, y: 10 } });
  await expect(controls.locator('.composer-compact')).toBeVisible();
  await expect(prompt).toHaveValue('Change the marked region into a small garden');
  if (page.viewportSize()!.width > 760) {
    const image = viewer.locator('.viewer-image'); const rect = (await image.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.wheel(0, -400);
    await expect.poll(async () => Number(await stage.getAttribute('data-viewer-scale'))).toBeGreaterThan(1);
    await image.dblclick();
    await expect(stage).toHaveAttribute('data-viewer-scale', '1');
  }
  await focusEditingPrompt(page);
  await controls.getByRole('button', { name: '编辑蒙版', exact: true }).click();
  const maskStage = page.locator('.mask-stage'); await expect(maskStage).toBeVisible();
  await expect.poll(() => page.locator('.mask-source').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
  const bounds = (await maskStage.boundingBox())!;
  expect((await page.locator('.mask-tools').boundingBox())!.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2, { steps: 5 }); await page.mouse.up();
  await page.screenshot({ path: testInfo.outputPath('mask-bottom-tools.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '应用蒙版', exact: true }).click();
  await focusEditingPrompt(page);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.viewer-image')).toHaveAttribute('src', /^blob:/);
  const masked = await viewer.locator('.viewer-image').getAttribute('src');
  await prompt.click();
  await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await expect(viewer.locator('.viewer-image')).toHaveAttribute('src', source.contentUrl);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveCount(0);
  await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await expect(controls.getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('.viewer-image')).toHaveAttribute('src', /^blob:/);
  expect(masked).toBeTruthy();
  await focusEditingPrompt(page);
  await controls.getByRole('button', { name: '编辑蒙版', exact: true }).click();
  await expect(page.getByRole('button', { name: '清空蒙版', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '清空蒙版', exact: true }).click();
  await page.getByRole('button', { name: '确认清空', exact: true }).click();
  await page.getByRole('button', { name: '应用蒙版', exact: true }).click();
  await focusEditingPrompt(page);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer.locator('.viewer-image')).toHaveAttribute('src', source.contentUrl);
  await prompt.click();
  await controls.getByRole('button', { name: '生成设置', exact: true }).click();
  const panel = page.locator('.composer-generation-settings');
  if (page.viewportSize()!.width <= 760) await expect(panel.getByRole('combobox', { name: '模型与服务', exact: true })).toHaveCSS('font-size', '12px');
  await panel.getByRole('button', { name: '生成数量', exact: true }).click();
  await page.locator('.count-segments').getByRole('button', { name: '2', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(controls.locator('.composer-compact')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('image-edit-expanded.png'), animations: 'disabled' });
  const submitted = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
  await controls.getByRole('button', { name: '开始生成', exact: true }).click();
  expect((await submitted).status()).toBe(202);
  await expect(viewer).toBeVisible();
  await expect(controls.getByRole('button', { name: '编辑此生成结果', exact: true })).toHaveCount(2, { timeout: 25000 });
  await page.screenshot({ path: testInfo.outputPath('image-edit-results.png'), animations: 'disabled' });
  await controls.getByRole('button', { name: '编辑此生成结果', exact: true }).first().click();
  await focusEditingPrompt(page);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page.getByLabel('创作描述', { exact: true })).toHaveValue('main-page draft stays intact');
});


test('image editor submits overlay masks and clean first-frame videos without navigation', async ({ page, request }, testInfo) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const catalog = (await (await request.get('/internal/models?limit=100')).json()).items as ModelDto[];
  const original = catalog.find(model => model.modelId === 'mock-image-v1')!;
  const save = (capabilities: ModelDto['capabilities']) => request.post('/internal/models', { data: { providerId: original.providerId, modelId: original.modelId, displayName: original.displayName, capabilities, enabled: true } });
  expect((await save({ ...original.capabilities, supportsMask: false })).ok()).toBe(true);
  try {
    const source = await upload(request); await open(page);
    await page.locator(`[data-study-id="${source.id}"] .study-open`).click();
    const controls = page.locator('.image-editing-controls'), viewer = page.locator('.study-viewer');
    await focusEditingPrompt(page);
  await controls.getByRole('button', { name: '编辑蒙版', exact: true }).click();
    const stage = page.locator('.mask-stage'); await expect(stage).toBeVisible();
    await expect.poll(() => page.locator('.mask-source').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
    await page.getByRole('button', { name: '应用蒙版', exact: true }).click();
    await expect(page.locator('.mask-workspace')).toHaveCount(0);
    await focusEditingPrompt(page);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const prompt = controls.getByLabel('创作描述', { exact: true }); await prompt.fill('Overlay mask edit fixture');
    await expect(prompt).toHaveValue('Overlay mask edit fixture');
    let response = (await capturePost(page, '/internal/jobs')).response;
    await controls.getByRole('button', { name: '开始生成', exact: true }).click();
    const imageResponse = await response; expect(imageResponse.status()).toBe(202);
    const imageJob = (await imageResponse.json()).job;
    expect(imageJob.request.maskProcessing).toMatchObject({ mode: 'overlay', sourceAssetId: source.id });
    expect(imageJob.prompt).toBe('Overlay mask edit fixture');
    await expect(controls.getByRole('button', { name: '编辑此生成结果' })).toHaveCount(1, { timeout: 20000 });
    await controls.getByRole('button', { name: '查看原图', exact: true }).click();
    await focusEditingPrompt(page);
    await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await expect(controls.getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await prompt.fill('Animate the clean sea');
    response = (await capturePost(page, '/internal/jobs')).response;
    await controls.getByRole('button', { name: '开始生成', exact: true }).click();
    const videoResponse = await response; expect(videoResponse.status()).toBe(202);
    const videoJob = (await videoResponse.json()).job;
    expect(videoJob.request.operation).toBe('video.image_to_video');
    expect(videoJob.request.inputs).toEqual([{ assetId: source.id, role: 'first_frame' }]);
    expect(videoJob.request.maskProcessing).toBeUndefined();
    const video = page.locator('.study-viewer .viewer-source-video'); await expect(video).toBeVisible({ timeout: 25000 });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(element => { const video = element as HTMLVideoElement; video.currentTime = 0; return video.play(); });
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('editor-video-result.png'), animations: 'disabled' });
    await viewer.getByRole('button', { name: '返回作品', exact: true }).click(); await expect(viewer).toHaveCount(0);
    await page.locator(`[data-study-id="${source.id}"] .study-open`).click();
    await controls.getByLabel('创作描述', { exact: true }).click();
    await expect(controls.getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await focusEditingPrompt(page);
  await expect(controls.getByRole('button', { name: '编辑蒙版', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(viewer.locator('.viewer-image')).toHaveAttribute('src', /^blob:/);
  } finally { expect((await save(original.capabilities)).ok()).toBe(true); }
});


test('mask entry follows prompt focus and remains clickable by touch', async ({ page, request }, testInfo) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const source = await upload(request); await open(page);
  await page.locator(`[data-study-id="${source.id}"] .study-open`).click();
  const controls = page.locator('.image-editing-controls');
  const mask = controls.getByRole('button', { name: '编辑蒙版', exact: true });
  await expect(controls.locator('.composer-compact')).toBeVisible(); await expect(mask).toHaveCount(0);
  await focusEditingPrompt(page); await expect(mask).toBeVisible();
  await controls.getByRole('button', { name: '生成设置', exact: true }).click(); await expect(mask).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(mask).toHaveCount(0);
  await focusEditingPrompt(page);
  if (page.viewportSize()!.width < 761) await mask.tap(); else await mask.click();
  await expect(page.locator('.mask-workspace')).toBeVisible();
  await page.getByRole('button', { name: '关闭局部编辑', exact: true }).click();
  await expect(page.locator('.mask-workspace')).toHaveCount(0);
  await page.locator('.viewer-stage').click({ position: { x: 5, y: 5 } }); await expect(mask).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('idle-editor-without-mask-button.png'), animations: 'disabled' });
});


test('video workspace defers frame capture until send and removes temporary inputs', async ({ page, request }, testInfo) => {
  test.setTimeout(60000);
  const path = testInfo.outputPath('two-color.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path]);
  const uploaded = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'two-color.mp4', mimeType: 'video/mp4', buffer: await readFile(path) } } });
  expect(uploaded.status()).toBe(201); const source = (await uploaded.json()).asset;
  await open(page, `/imagine?asset=${source.id}`);
  const viewer = page.locator('.study-viewer'), controls = viewer.locator('.image-editing-controls'), video = viewer.locator('.viewer-source-video');
  let uploads = 0; page.on('request', req => { if (req.url().endsWith('/internal/assets/upload')) uploads++; });
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await controls.getByLabel('创作描述', { exact: true }).click();
  await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await expect(video).toBeVisible(); expect(uploads).toBe(0);
  await video.evaluate(element => { const video = element as HTMLVideoElement; video.currentTime = 1.5; });
  await expect.poll(() => video.evaluate(element => !(element as HTMLVideoElement).seeking)).toBe(true);
  expect(uploads).toBe(0);
  await controls.getByLabel('创作描述', { exact: true }).fill('Edit the currently paused blue frame');
  const capture = (await capturePost(page, '/internal/assets/upload')).response;
  const jobResponse = (await capturePost(page, '/internal/jobs')).response;
  await controls.getByRole('button', { name: '开始生成', exact: true }).click();
  const frameResponse = await capture; expect(frameResponse.status()).toBe(201); const frame = (await frameResponse.json()).asset;
  expect(frame).toMatchObject({ parentAssetId: source.id, width: 320, height: 180, type: 'image' });
  const pixels = await page.evaluate(async src => { const image = new Image(); image.src = src; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data); }, frame.contentUrl);
  expect(pixels[2]).toBeGreaterThan(240); expect(pixels[0]).toBeLessThan(15);
  const submitted = await jobResponse; expect(submitted.status()).toBe(202); const job = (await submitted.json()).job;
  expect(job.request.inputs).toEqual([{ assetId: frame.id, role: 'source' }]);
  expect((await (await request.get('/internal/assets?limit=100')).json()).items.some((asset: { id: string }) => asset.id === frame.id)).toBe(false);
  await expect(controls.getByRole('button', { name: '编辑此生成结果' })).toHaveCount(1, { timeout: 20000 });
  await expect.poll(async () => (await request.get(`/internal/assets/${frame.id}`)).status()).toBe(404);
  await controls.getByRole('button', { name: '查看原图', exact: true }).click();
  await expect(video).toBeVisible(); expect(uploads).toBe(1);
  const detail = (await (await request.get(`/internal/jobs/${job.id}`)).json()); expect(detail.assets[0].parentAssetId).toBe(source.id);
  await page.screenshot({ path: testInfo.outputPath('deferred-video-frame.png'), animations: 'disabled' });
});

test('video viewer edits and extends in place and reports capture upload failures', async ({ page, request }, testInfo) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Video editor ${randomUUID()}`, type: 'xai', enabled: true } })).json();
  try {
    const preset = await (await request.get(`/internal/providers/${provider.id}/models/capabilities?modelId=grok-imagine-video&operation=video.generate`)).json();
    expect((await request.post('/internal/models', { data: { providerId: provider.id, modelId: 'grok-imagine-video', displayName: 'Editor Video', enabled: true, capabilities: preset.capabilities } })).status()).toBe(201);
    const path = testInfo.outputPath('video-source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path]);
    const uploaded = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'video-source.mp4', mimeType: 'video/mp4', buffer: await readFile(path) } } });
    expect(uploaded.status()).toBe(201); const source = (await uploaded.json()).asset;
    await open(page, `/imagine?asset=${source.id}`);
    const viewer = page.locator('.study-viewer'), controls = viewer.locator('.image-editing-controls');
    await controls.getByLabel('创作描述', { exact: true }).fill('Change the video lighting');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured-no-paid-call' } }) : route.continue());
    for (const operation of ['edit', 'extend']) {
      await controls.getByRole('button', { name: operation === 'edit' ? '编辑视频' : '续写视频', exact: true }).click();
      const sent = page.waitForRequest(req => req.url().endsWith('/internal/jobs') && req.method() === 'POST');
      await controls.getByRole('button', { name: '开始生成', exact: true }).click();
      const payload = (await sent).postDataJSON(); expect(payload).toMatchObject({ operation: `video.${operation}`, inputs: [{ assetId: source.id, role: 'source' }] });
      expect(payload).not.toHaveProperty('aspectRatio'); expect(payload).not.toHaveProperty('resolution');
      await expect(controls.locator('.editing-error')).toBeVisible(); await expect(viewer).toBeVisible();
    }
    await page.route('**/internal/assets/upload', route => route.fulfill({ status: 400, json: { error: 'frame-upload-fixture-failure', message: '视频截图上传失败，请重试' } }));
    await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
    await controls.getByLabel('创作描述', { exact: true }).click();
    await controls.getByRole('button', { name: '编辑蒙版', exact: true }).click();
    await expect(controls.locator('.editing-error')).toContainText('视频截图上传失败，请重试');
    await expect(controls.getByRole('button', { name: '切换图片/视频', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(viewer.locator('.viewer-source-video')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('video-edit-extend.png'), animations: 'disabled' });
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('video mask entry captures lazily and its temporary mask is cleaned with the frame', async ({ page, request }, testInfo) => {
  test.skip(![1440, 390].includes(page.viewportSize()!.width));
  const response = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'mask-video.mp4', mimeType: 'video/mp4', buffer: await readFile(resolve('fixtures/providers/mock/mock-video-v1/tiny.mp4')) } } });
  expect(response.status()).toBe(201); const source = (await response.json()).asset;
  await open(page, `/imagine?asset=${source.id}`);
  const viewer = page.locator('.study-viewer'), controls = viewer.locator('.image-editing-controls');
  await controls.getByLabel('创作描述', { exact: true }).click();
  await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await expect(viewer.locator('.viewer-source-video')).toBeVisible();
  await controls.getByLabel('创作描述', { exact: true }).click();
  const capture = (await capturePost(page, '/internal/assets/upload')).response;
  await controls.getByRole('button', { name: '编辑蒙版', exact: true }).click();
  const frame = (await (await capture).json()).asset;
  await expect(page.locator('.mask-stage')).toBeVisible();
  await expect.poll(() => page.locator('.mask-source').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
  const stage = (await page.locator('.mask-stage').boundingBox())!;
  await page.locator('.mask-stage').click({ position: { x: stage.width / 2, y: stage.height / 2 } });
  await expect(page.getByRole('button', { name: '撤销笔画', exact: true })).toBeEnabled();
  const uploadMask = (await capturePost(page, '/internal/assets/upload')).response;
  await page.getByRole('button', { name: '应用蒙版', exact: true }).click();
  const mask = (await (await uploadMask).json()).asset;
  await expect(page.locator('.mask-workspace')).toHaveCount(0);
  await expect(viewer.locator('img.viewer-image')).toBeVisible();
  const library = (await (await request.get('/internal/assets?limit=100')).json()).items;
  expect(library.some((asset: { id: string }) => [frame.id, mask.id].includes(asset.id))).toBe(false);
  await controls.getByLabel('创作描述', { exact: true }).fill('Modify the marked video frame');
  const submitted = (await capturePost(page, '/internal/jobs')).response;
  await controls.getByRole('button', { name: '开始生成', exact: true }).click();
  const result = await submitted; expect(result.status()).toBe(202);
  expect((await result.json()).job.request.inputs).toEqual([{ assetId: frame.id, role: 'source' }, { assetId: mask.id, role: 'mask' }]);
  await expect(controls.getByRole('button', { name: '编辑此生成结果' })).toHaveCount(1, { timeout: 20000 });
  for (const id of [frame.id, mask.id]) await expect.poll(async () => (await request.get(`/internal/assets/${id}`)).status()).toBe(404);
  await controls.getByRole('button', { name: '查看原图', exact: true }).click();
  await expect(viewer.locator('.viewer-source-video')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('video-mask-cleanup.png'), animations: 'disabled' });
});

test('model dialog select menus scroll by wheel without scrolling the form', async ({ page, request }, testInfo) => {
  const { provider } = (await (await request.post('/internal/providers', { data: { name: 'Wheel fixture', type: 'openai', enabled: true } })).json());
  try {
    await page.route(`**/internal/providers/${provider.id}/models/catalog`, route => route.fulfill({ json: { models: [] } }));
    await open(page, '/settings/providers');
    await page.getByRole('region', { name: '连接 Wheel fixture', exact: true }).getByRole('button', { name: '添加模型', exact: true }).click();
    await expect(page.getByText('正在加载内置模型…', { exact: true })).toHaveCount(0);
    for (const label of ['配置来源模型', '模型调用协议']) {
      await page.getByRole('combobox', { name: label, exact: true }).click();
      const list = page.getByRole('listbox', { name: label, exact: true }); await expect(list).toBeVisible();
      const initial = await list.evaluate(element => element.scrollTop);
      const formScroll = await page.locator('.model-form-body').evaluate(element => element.scrollTop);
      const bounds = (await list.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(initial);
      expect(await page.locator('.model-form-body').evaluate(element => element.scrollTop)).toBe(formScroll);
      await page.screenshot({ path: testInfo.outputPath(`scroll-${label}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
      await expect(page.getByRole('dialog', { name: '添加模型', exact: true })).toBeVisible();
    }
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('add catalog excludes saved models per provider and restores deleted entries', async ({ page, request }) => {
  const providers = [];
  for (const name of ['Catalog current', 'Catalog other']) providers.push((await (await request.post('/internal/providers', { data: { name, type: 'openai', enabled: true } })).json()).provider);
  const save = async (providerId: string, modelId: string, enabled: boolean) => (await (await request.post('/internal/models', { data: { providerId, modelId, displayName: modelId, enabled, capabilities: { operations: ['image.generate'] } } })).json()).model;
  try {
    const saved = await save(providers[0].id, 'saved-disabled', false);
    await save(providers[1].id, 'other-only', true);
    await page.route(`**/internal/providers/${providers[0].id}/models/catalog`, route => route.fulfill({ json: { models: ['saved-disabled', 'other-only', 'unknown-future'].map(id => ({ id, displayName: id })) } }));
    await open(page, '/settings/providers');
    const add = page.getByRole('region', { name: '连接 Catalog current', exact: true }).getByRole('button', { name: '添加模型', exact: true });
    await add.click();
    const picker = page.getByRole('combobox', { name: '远端模型目录', exact: true }); await picker.click();
    await expect(page.getByRole('option', { name: 'saved-disabled', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'other-only', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'unknown-future', exact: true })).toBeVisible();
    await picker.fill('saved-disabled'); await expect(page.getByText('没有匹配的模型', { exact: true })).toBeVisible();
    expect((await request.delete(`/internal/models/${saved.id}`)).ok()).toBe(true);
    await expect(page.getByRole('option', { name: 'saved-disabled', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'saved-disabled', exact: true }).click();
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('saved-disabled');
  } finally { for (const provider of providers) await request.delete(`/internal/providers/${provider.id}`); }
});

test('gallery shows live generation seconds and compact completed duration', async ({ page, request }, testInfo) => {
  const submitted = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt: 'Timing completed fixture', inputs: [] } });
  expect(submitted.status()).toBe(202); const id = (await submitted.json()).job.id;
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${id}`)).json()).job.status, { timeout: 20000 }).toBe('completed');
  const detail = (await (await request.get(`/internal/jobs/${id}`)).json());
  const end = Date.now(), start = end - 70000;
  const completed = { ...detail.job, createdAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString() };
  const activeId = randomUUID(), active = { ...detail.job, id: activeId, prompt: 'Timing active fixture', status: 'submitting', stage: 'submitting', progress: null, outputCount: 0, createdAt: new Date(end - 10000).toISOString(), completedAt: null };
  await page.route('**/internal/assets?**', async route => {
    const response = await route.fetch(), data = await response.json();
    if (data.jobs) data.jobs = data.jobs.map((job: { id: string }) => job.id === id ? completed : job);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/internal/jobs?**', async route => {
    const response = await route.fetch(), data = await response.json();
    data.items = [active, ...data.items]; await route.fulfill({ response, json: data });
  });
  await open(page);
  const pending = page.locator(`[data-pending-job="${activeId}"] .pending-study-copy`);
  await expect(pending).toContainText(/生成中 · \d+s/);
  await expect(pending).not.toContainText('正在提交');
  const seconds = async () => Number((await pending.innerText()).match(/生成中 · (\d+)s/)![1]);
  const first = await seconds(); expect(first).toBeGreaterThanOrEqual(10);
  await expect.poll(seconds).toBeGreaterThan(first);
  const caption = page.locator(`[data-study-id="${detail.assets[0].id}"] .study-caption > span`);
  await expect(caption).toHaveText('mock-image-v1 · 1m10s');
  await page.reload(); await expect(caption).toHaveText('mock-image-v1 · 1m10s');
  await expect.poll(seconds).toBeGreaterThan(first);
  await page.locator(`[data-study-id="${detail.assets[0].id}"] .study-open`).hover();
  await page.screenshot({ path: testInfo.outputPath('generation-duration.png'), animations: 'disabled' });
});

test('prompt grows by content and mobile blur collapses without losing text', async ({ page }, testInfo) => {
  await open(page);
  const input = page.getByLabel('创作描述', { exact: true });
  const mobile = page.viewportSize()!.width <= 760;
  const dimensions = () => input.evaluate(element => { const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, line: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), overflow: style.overflowY }; });
  const expectLines = async (lines: number) => { await expect.poll(async () => { const d = await dimensions(); return Math.abs(d.height - (d.line * lines + d.padding)); }).toBeLessThan(2); };
  await input.click(); await input.fill('first\nsecond'); await expectLines(2);
  await input.fill('first\nsecond\nthird'); await expectLines(3);
  const long = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  await input.fill(long); await expectLines(mobile ? 4 : 5);
  expect((await dimensions()).overflow).toBe('auto');
  await input.evaluate(element => (element as HTMLTextAreaElement).blur());
  await expectLines(mobile ? 2 : 5); await expect(input).toHaveValue(long);
  await input.click(); await expectLines(mobile ? 4 : 5);
  await input.fill(''); await expectLines(2);
  await input.fill('wrapped words '.repeat(100)); await expectLines(mobile ? 4 : 5);
  await page.screenshot({ path: testInfo.outputPath('prompt-content-height.png'), animations: 'disabled' });
});

test('desktop rail expands in place with fixed logo and mobile keeps its drawer', async ({ page, request }, testInfo) => {
  const project = (await (await request.post('/internal/collections', { data: { name: 'Sidebar project' } })).json()).collection;
  await open(page);
  const desktop = page.viewportSize()!.width > 760;
  if (desktop) {
    const rail = page.locator('.side-rail'), logo = rail.locator('.identity');
    const before = (await logo.boundingBox())!;
    const iconBefore = (await rail.getByRole('button', { name: '创作', exact: true }).locator('svg').boundingBox())!;
    await logo.click(); await expect(logo).toHaveAttribute('aria-expanded', 'true');
    expect((await rail.boundingBox())!.width).toBe(260);
    const after = (await logo.boundingBox())!; expect(after.x).toBe(before.x); expect(after.y).toBe(before.y);
    const iconAfter = (await rail.getByRole('button', { name: '创作', exact: true }).locator('svg').boundingBox())!;
    expect(iconAfter.x).toBe(iconBefore.x); expect(iconAfter.y).toBe(iconBefore.y);
    await expect(page.locator('.navigation-panel')).toHaveCount(0); await expect(page.locator('.panel-backdrop')).toHaveCount(0);
    expect((await page.locator('.workspace').boundingBox())!.x).toBe(260);
    const composer = (await page.locator('.creation-composer').boundingBox())!;
    expect(composer.x).toBeGreaterThan(260); expect(composer.x + composer.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.getByLabel('创作描述', { exact: true }).fill('The workspace remains interactive');
    for (const name of ['创作', '全部作品', '收藏', '项目', 'Sidebar project']) await expect(rail.getByRole('button', { name, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('inline-sidebar.png'), animations: 'disabled' });
    await rail.getByRole('button', { name: 'Sidebar project', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`)); await expect(logo).toHaveAttribute('aria-expanded', 'true');
    await expect(rail.getByRole('button', { name: 'Sidebar project', exact: true })).toHaveAttribute('aria-current', 'page');
    await logo.click(); expect((await rail.boundingBox())!.width).toBe(72); expect((await logo.boundingBox())!.x).toBe(before.x);
  } else {
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Imagine', exact: true }); await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Sidebar project', exact: true }).click(); await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}$`));
  }
});

test('card project moves and optional project file deletion', async ({ page, request }, testInfo) => {
  const asset = await upload(request);
  const source = (await (await request.post('/internal/collections', { data: { name: 'Source project' } })).json()).collection;
  const destination = (await (await request.post('/internal/collections', { data: { name: 'Destination project' } })).json()).collection;
  await open(page, '/library');
  const card = page.locator(`[data-study-id="${asset.id}"]`);
  await card.hover();
  await card.getByRole('button', { name: /更多操作/ }).click();
  await expect(page.locator('.asset-options')).toBeVisible();
  expect((await page.locator('.asset-options').boundingBox())!.width).toBe(190);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('asset-menu.png') });
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  await page.getByRole('dialog', { name: '移动到项目' }).getByRole('button', { name: 'Source project', exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/internal/assets/${asset.id}`)).json()).asset.collectionIds).toEqual([source.id]);
  await open(page, `/projects/${source.id}`);
  await card.hover();
  await card.getByRole('button', { name: /更多操作/ }).click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '移动到项目' });
  await expect(picker.getByRole('button', { name: 'Source project 当前项目' })).toBeDisabled();
  await picker.getByRole('button', { name: 'Destination project', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`/internal/assets/${asset.id}`)).json()).asset.collectionIds).toEqual([destination.id]);
  await open(page, `/projects/${destination.id}`);
  await page.getByRole('button', { name: '项目操作', exact: true }).click();
  await page.getByRole('button', { name: '删除项目', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '同时删除项目内文件' })).not.toBeChecked();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(200);
  await request.post(`/internal/collections/${source.id}/assets`, { data: { assetIds: [asset.id] } });
  await open(page, `/projects/${source.id}`);
  await page.getByRole('button', { name: '项目操作', exact: true }).click();
  await page.getByRole('button', { name: '删除项目', exact: true }).click();
  await page.getByRole('checkbox', { name: '同时删除项目内文件' }).check();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('delete-project.png') });
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page).toHaveURL(/\/projects$/);
  expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(404);
});

test('editor keeps a reloadable series across repeated image and video generations', async ({ page, request }, testInfo) => {
  const original = await upload(request);
  let hold = true;
  const heldJobs = new Set<string>();
  await page.route('**/internal/jobs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(), data = await response.json();
    for (const job of data.jobs ?? [data.job]) heldJobs.add(job.id);
    await route.fulfill({ response, json: data });
  });
  await page.route('**/internal/jobs/*', async route => {
    const response = await route.fetch(), data = await response.json();
    if (hold && heldJobs.has(data.job?.id)) { data.assets = []; data.job = { ...data.job, status: 'remote_running', completedAt: null }; }
    await route.fulfill({ response, json: data });
  });
  await page.route('**/internal/assets/*/series', async route => {
    const response = await route.fetch(), data = await response.json();
    if (hold) { data.assets = data.assets.filter((asset: { jobId: string }) => !heldJobs.has(asset.jobId)); data.jobs = data.jobs.map((job: { id: string }) => heldJobs.has(job.id) ? { ...job, status: 'remote_running', completedAt: null } : job); }
    await route.fulfill({ response, json: data });
  });
  await open(page, `/imagine?asset=${original.id}`);
  const viewer = page.locator('.study-viewer'), controls = viewer.locator('.image-editing-controls');
  const prompt = controls.getByLabel('创作描述', { exact: true });
  let previous = original.id;
  for (let round = 1; round <= 2; round++) {
    hold = true; heldJobs.clear();
    await prompt.fill(`Series round ${round}`);
    const response = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
    await controls.getByRole('button', { name: '开始生成', exact: true }).click();
    const created = await (await response).json();
    expect(created.job.request.inputs[0].assetId).toBe(previous);
    await expect(viewer.getByLabel('编辑生成状态')).toContainText(/生成中|排队/);
    await expect(viewer.getByLabel('编辑生成状态').getByRole('button')).toHaveCount(0);
    await expect(viewer.getByLabel('编辑生成状态')).not.toContainText(`Series round ${round}`);
    await expect(viewer.locator('.viewer-stage > img')).toHaveCount(0);
    await expect(controls.getByRole('button', { name: '开始生成', exact: true })).toBeDisabled();
    await expect(controls.getByRole('button', { name: '查看原图', exact: true })).toBeVisible();
    const strip = (await controls.locator('.editing-results').boundingBox())!;
    expect(strip.y + strip.height).toBeLessThanOrEqual((await controls.locator('.creation-composer').boundingBox())!.y - 8);
    await page.screenshot({ path: testInfo.outputPath(`series-pending-${round}.png`), animations: 'disabled' });
    if (round === 1) {
      await controls.getByRole('button', { name: '查看原图', exact: true }).click();
      await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', original.contentUrl);
      await controls.getByRole('button', { name: '查看任务 Series round 1', exact: true }).click();
      await expect(viewer.getByLabel('编辑生成状态')).toBeVisible();
    }
    hold = false;
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${created.job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
    const detail = await (await request.get(`/internal/jobs/${created.job.id}`)).json();
    previous = detail.assets[0].id;
    await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', detail.assets[0].contentUrl, { timeout: 25000 });
    await expect(controls.locator('.editing-result button:has(img)')).toHaveCount(round + 1);
  }
  await page.reload();
  await expect(controls.locator('.editing-result button:has(img)')).toHaveCount(3);
  await controls.getByRole('button', { name: '查看原图', exact: true }).click();
  await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', original.contentUrl);
  await prompt.fill('Series video');
  await controls.getByRole('button', { name: '切换图片/视频', exact: true }).click();
  await controls.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(viewer.locator('video.viewer-source-video')).toBeVisible({ timeout: 25000 });
  await expect(controls.locator('.editing-result button:has(img)')).toHaveCount(4);
  await controls.getByRole('button', { name: '查看原图', exact: true }).click();
  await controls.getByRole('button', { name: '查看生成视频', exact: true }).click();
  await expect(viewer.locator('video.viewer-source-video')).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  expect((await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.series_cover': 'latest' } } })).ok()).toBe(true);
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveCount(1);
  const badge = page.getByLabel('系列共 4 件作品');
  await expect(badge).toBeVisible();
  await expect(badge.locator('svg')).toBeVisible();
  const badgeBox = (await badge.boundingBox())!, durationBox = (await page.locator('.video-tag').boundingBox())!;
  const cardBox = (await page.locator('.study-open').boundingBox())!;
  expect(badgeBox.y).toBeGreaterThan(durationBox.y + durationBox.height);
  expect(cardBox.y + cardBox.height - badgeBox.y - badgeBox.height).toBeCloseTo(8, 0);
  await page.screenshot({ path: testInfo.outputPath('series-video-badge.png'), animations: 'disabled' });
});

test('failed gallery generation copies its full prompt', async ({ page, request }) => {
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt: 'Original fixture', inputs: [] } });
  const job = (await response.json()).job;
  const prompt = '失败提示词完整内容\n第二行也需要保留';
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.documentElement.dataset.copiedPrompt = text; } } }));
  const data = await (await request.get('/internal/jobs?limit=50')).json();
  data.items = [{ ...job, id: 'failed-copy-fixture', status: 'failed', prompt, request: { ...job.request, prompt }, errorMessage: 'Fixture failure', completedAt: new Date().toISOString() }, ...data.items];
  await page.route('**/internal/jobs?**', route => route.fulfill({ json: data }));
  await open(page);
  await page.locator('[data-pending-job="failed-copy-fixture"]').getByRole('button', { name: '复制提示词', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-copied-prompt', prompt);
  await page.unrouteAll({ behavior: 'wait' });
});


test('series preferences group gallery entries and persist all three cover choices', async ({ page, request }, testInfo) => {
  const original = await upload(request);
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Series preference result', inputs: [{ assetId: original.id, role: 'source' }] } });
  expect(response.ok()).toBe(true);
  const job = (await response.json()).job;
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const result = (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0];
  await open(page, '/settings');
  await expect(page.getByLabel('系列封面', { exact: true })).toHaveCount(0);
  await page.getByLabel('按照系列显示', { exact: true }).click();
  await expect(page.getByLabel('按照系列显示', { exact: true })).toBeChecked();
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.group_by_series']).toBe(true);
  await expect(page.getByLabel('系列封面', { exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('series-preferences.png'), animations: 'disabled' });
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveCount(1);
  await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', result.id);
  await expect(page.getByLabel('系列共 2 件作品')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('series-gallery.png'), animations: 'disabled' });
  await open(page, '/settings');
  await selectValue(page, '系列封面', 'original');
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_cover']).toBe('original');
  await expect(page.getByLabel('系列封面', { exact: true })).toBeEnabled();
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', original.id);
  await page.locator('.study-open').click();
  await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', original.contentUrl);
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[original.id]).toBeTruthy();
  await open(page, '/settings');
  await selectValue(page, '系列封面', 'recent');
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_cover']).toBe('recent');
  await expect(page.getByLabel('系列封面', { exact: true })).toBeEnabled();
  await open(page, '/library');
  await page.reload();
  await expect(page.locator('.study-card')).toHaveCount(1);
  await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', original.id);
  await page.locator('.study-open').click();
  await page.getByRole('button', { name: '编辑此生成结果', exact: true }).click();
  await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', result.contentUrl);
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[result.id]).toBeTruthy();
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', result.id);
  await open(page, '/settings');
  await page.getByLabel('按照系列显示', { exact: true }).click();
  await expect(page.getByLabel('按照系列显示', { exact: true })).not.toBeChecked();
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.group_by_series']).toBe(false);
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveCount(2);
});

test('editor navigation crosses series on desktop and uses separate mobile swipe axes', async ({ page, request }, testInfo) => {
  const original = await upload(request), single = await upload(request, 'mountain');
  const members = [original];
  for (let index = 0; index < 3; index++) {
    const video = index === 2;
    const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: video ? 'mock-video-v1' : 'mock-image-v1', operation: video ? 'video.image_to_video' : 'image.edit', prompt: `Navigation ${index}`, inputs: [{ assetId: members.at(-1)!.id, role: video ? 'first_frame' : 'source' }] } });
    expect(response.ok()).toBe(true);
    const { job } = await response.json();
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
    members.push((await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0]);
  }
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.series_cover': 'recent', 'gallery.series_last_viewed': { default: { [original.id]: Date.now() } } } } });
  await open(page, '/library');
  await page.locator(`[data-study-id="${original.id}"] .study-open`).click();
  const viewer = page.locator('.study-viewer');
  await expect(viewer.locator('.editing-result button:has(img)')).toHaveCount(4);
  await expect(page.getByRole('tooltip', { name: '返回作品', exact: true })).toHaveCount(0);
  // Every selection is committed independently, without requiring closing/reloading.
  for (const index of [1, 2]) {
    await viewer.locator('.editing-result button:has(img)').nth(index).click();
    await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', members[index]!.contentUrl);
    await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[members[index]!.id]).toBeTruthy();
    const ring = await viewer.locator('.editing-result.is-selected').evaluate(element => ({ outline: getComputedStyle(element).outlineStyle, inset: getComputedStyle(element, '::after').inset, border: getComputedStyle(element, '::after').borderTopWidth }));
    expect(ring).toEqual({ outline: 'none', inset: '0px', border: '2px' });
  }
  await viewer.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator(`[data-study-id="${members[2]!.id}"]`)).toBeVisible();
  await page.locator(`[data-study-id="${members[2]!.id}"] .study-open`).click();
  const desktop = page.viewportSize()!.width >= 761;
  const swipe = async (dx: number, dy: number) => {
    const box = (await viewer.locator('.viewer-stage').boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 250);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  };
  if (desktop) await viewer.getByRole('button', { name: '下一张作品', exact: true }).click();
  else await swipe(-100, 0);
  await expect(viewer.locator('video.viewer-source-video')).toHaveAttribute('src', members[3]!.contentUrl);
  if (desktop) await viewer.getByRole('button', { name: '下一张作品', exact: true }).click();
  else {
    await swipe(-100, 0);
    await expect(viewer.locator('video.viewer-source-video')).toHaveAttribute('src', members[3]!.contentUrl);
    await swipe(0, -100);
  }
  await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', single.contentUrl);
  await expect(viewer.locator('.editing-results')).toHaveCount(0);
  if (desktop) {
    await viewer.getByRole('button', { name: '上一张作品', exact: true }).click();
    await expect(viewer.locator('video.viewer-source-video')).toHaveAttribute('src', members[3]!.contentUrl);
    await page.keyboard.press('ArrowLeft');
    await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', members[2]!.contentUrl);
  } else {
    await swipe(-100, 0);
    await expect(viewer.locator('.viewer-stage > img')).toHaveAttribute('src', single.contentUrl);
    await swipe(0, 100);
    await expect(viewer.locator('video.viewer-source-video')).toHaveAttribute('src', members[3]!.contentUrl);
  }
  await page.screenshot({ path: testInfo.outputPath('editor-navigation.png'), animations: 'disabled' });
});

test('cold gallery filters retain the current gallery while the next type loads', async ({ page, request }) => {
  await upload(request);
  await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: await readFile(resolve('fixtures/providers/mock/mock-video-v1/tiny.mp4')) } } });
  await open(page, '/library');
  await expect(page.locator('.study-card')).toHaveCount(2);
  for (const kind of ['image', 'video']) {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const received = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/internal/assets?**', async route => {
      if (new URL(route.request().url()).searchParams.get('type') === kind) { started(); await gate; }
      await route.continue();
    });
    try {
      const before = await page.locator('.study-card').count();
      await page.getByRole('group', { name: '作品类型', exact: true }).getByRole('button', { name: kind === 'image' ? '图片' : '视频', exact: true }).click();
      await received;
      await expect(page.locator('.study-card')).toHaveCount(before);
      await expect(page.locator('.gallery-scroll > .loading-state')).toHaveCount(0);
      release();
      await expect(page.locator('.study-card')).toHaveCount(1);
      await expect(page.locator('.gallery-scroll')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.study-card .video-tag')).toHaveCount(kind === 'video' ? 1 : 0);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  }
});

test('recent series cover changes before the view save finishes and without a reload', async ({ page, request }) => {
  const original = await upload(request);
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Immediate cover', inputs: [{ assetId: original.id, role: 'source' }] } });
  const { job } = await response.json();
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const result = (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0];
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.series_cover': 'recent', 'gallery.series_last_viewed': { default: { [original.id]: Date.now() } } } } });
  await open(page, '/library');
  await page.locator(`[data-study-id="${original.id}"] .study-open`).click();
  await expect(page.locator('.editing-result')).toHaveCount(2);
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[original.id]).toBeTruthy();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/internal/settings', async route => {
    const body = route.request().method() === 'PATCH' ? route.request().postDataJSON() : null;
    if (body?.values?.['gallery.series_last_viewed']?.default?.[result.id]) { started(); await gate; }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '编辑此生成结果', exact: true }).click();
    await received;
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', result.id);
    release();
    await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[result.id]).toBeTruthy();
    await expect(page.locator('.study-card')).toHaveAttribute('data-study-id', result.id);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('mobile editor uses small series thumbnails floating tools and focus-only model guidance', async ({ page, request }, testInfo) => {
  const original = await upload(request);
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Floating toolbar fixture', inputs: [{ assetId: original.id, role: 'source' }] } });
  const { job } = await response.json();
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  await open(page, `/library?asset=${original.id}`);
  const mobile = page.viewportSize()!.width < 761, viewer = page.locator('.study-viewer');
  const strip = viewer.locator('.editing-results');
  await expect(strip.locator('button:has(img)')).toHaveCount(2);
  const thumbnail = (await strip.locator('button:has(img)').first().boundingBox())!;
  expect(thumbnail.width).toBe(mobile ? 59 : 88); expect(thumbnail.height).toBe(mobile ? 53 : 80);
  await viewer.getByLabel('创作描述', { exact: true }).focus();
  const mask = (await viewer.getByRole('button', { name: '编辑蒙版', exact: true }).boundingBox())!;
  if (mobile) {
    expect(mask.y + mask.height).toBeLessThan((await strip.boundingBox())!.y - 8);
    const back = (await viewer.getByRole('button', { name: '返回作品', exact: true }).boundingBox())!;
    const actions = (await viewer.locator('.viewer-heading-actions').boundingBox())!;
    expect(back.width).toBe(44); expect(back.height).toBe(44);
    expect(actions.x).toBeGreaterThan(back.x + back.width + 20);
    expect(actions.y).toBeCloseTo(back.y, 0);
    expect(await viewer.locator('.viewer-heading').evaluate(element => getComputedStyle(element).position)).toBe('absolute');
  }
  await page.screenshot({ path: testInfo.outputPath('floating-editor-tools.png'), animations: 'disabled' });
  await page.route('**/internal/models?**', async route => {
    const response = await route.fetch(), data = await response.json();
    data.items = data.items.filter((model: { capabilities: { operations: string[] } }) => !model.capabilities.operations.some(operation => ['video.edit', 'video.extend'].includes(operation)));
    await route.fulfill({ response, json: data });
  });
  const videoResponse = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'guidance.mp4', mimeType: 'video/mp4', buffer: await readFile(resolve('fixtures/providers/mock/mock-video-v1/tiny.mp4')) } } });
  const video = (await videoResponse.json()).asset;
  await open(page, `/library?asset=${video.id}`);
  const guidance = viewer.getByText('没有支持当前创作类型的模型', { exact: true });
  await expect(viewer.locator('video')).toBeVisible(); await expect(guidance).toHaveCount(0);
  await viewer.getByLabel('创作描述', { exact: true }).focus(); await expect(guidance).toBeVisible();
  await viewer.getByLabel('创作描述', { exact: true }).blur(); await expect(guidance).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });
});

test('editor slides media on navigation follows touch drags and respects reduced motion', async ({ page, request }, testInfo) => {
  const original = await upload(request), single = await upload(request, 'mountain');
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Slide fixture', inputs: [{ assetId: original.id, role: 'source' }] } });
  const { job } = await response.json();
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const result = (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0];
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'ui.reduce_motion': 'system' } } });
  // Pause actual Web Animations to inspect the outgoing and incoming frames deterministically.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const animation = animate.call(this, keyframes, options);
      if (this.matches('.viewer-image,.viewer-slide-overlay,.viewer-drag-neighbor,.viewer-drag-neighbor img')) animation.pause();
      return animation;
    };
  });
  await open(page, `/library?asset=${original.id}`);
  const viewer = page.locator('.study-viewer'), stage = viewer.locator('.viewer-stage');
  await expect(viewer.locator('.editing-result')).toHaveCount(2);
  const finish = async () => { await page.evaluate(() => document.getAnimations().forEach(animation => { if (animation.playState === 'paused') animation.finish(); })); await expect(page.locator('.viewer-slide-overlay')).toHaveCount(0); };
  const mobile = page.viewportSize()!.width < 761;
  const swipe = async (dx: number, dy: number) => {
    const box = (await stage.boundingBox())!, x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 240);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] });
    await expect.poll(() => stage.locator('.viewer-image').evaluate((element, horizontal) => parseFloat(element.style.translate.split(' ')[horizontal ? 0 : 1]!), !!dx)).toBe(dx || dy);
    await expect(stage.locator('.viewer-drag-neighbor')).toHaveCount(1);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach();
  };
  if (mobile) await swipe(-90, 0); else await viewer.getByRole('button', { name: '下一张作品', exact: true }).click();
  await expect(stage.locator('> img')).toHaveAttribute('src', result.contentUrl);
  await expect(stage).toHaveAttribute('data-slide-axis', 'x');
  await expect(page.locator('.viewer-slide-overlay')).toBeVisible();
  const animated = mobile ? stage.locator('.viewer-drag-neighbor') : stage.locator('> img');
  expect(await animated.evaluate(element => (element.getAnimations()[0]!.effect as KeyframeEffect).getKeyframes()[0]!.translate)).toMatch(/^[1-9][0-9.]*px(?: 0px)?$/);
  await page.evaluate(() => document.getAnimations().forEach(animation => { if (animation.playState === 'paused') animation.currentTime = 140; }));
  await page.screenshot({ path: testInfo.outputPath('horizontal-slide.png') });
  await finish();
  if (mobile) await swipe(0, -100); else await viewer.getByRole('button', { name: '下一张作品', exact: true }).click();
  await expect(stage.locator('> img')).toHaveAttribute('src', single.contentUrl);
  await expect(stage).toHaveAttribute('data-slide-axis', mobile ? 'y' : 'x');
  await finish();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (mobile) {
    const box = (await stage.boundingBox())!, session = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2, y = box.y + 200;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 100 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach();
  } else await page.keyboard.press('ArrowLeft');
  await expect(stage.locator('> img')).toHaveAttribute('src', result.contentUrl);
  await expect(page.locator('.viewer-slide-overlay')).toHaveCount(0);
  await expect(stage).not.toHaveAttribute('data-slide-axis');
});

test('neighbor media follows the finger before release and cancels without saving a view', async ({ page, request }, testInfo) => {
  const original = await upload(request), single = await upload(request, 'mountain');
  const created = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.edit', prompt: 'Finger-following fixture', inputs: [{ assetId: original.id, role: 'source' }] } });
  const { job } = await created.json();
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const result = (await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0];
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.series_cover': 'recent', 'ui.reduce_motion': 'system', 'gallery.series_last_viewed': {} } } });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      if (this.matches('.viewer-image,.viewer-slide-overlay,.viewer-drag-neighbor,.viewer-drag-neighbor img')) animation.pause();
      return animation;
    };
  });
  await open(page, `/library?asset=${result.id}`);
  const stage = page.locator('.viewer-stage'), mobile = page.viewportSize()!.width < 761;
  await expect(page.locator('.editing-result')).toHaveCount(2);
  const finish = async () => { await page.evaluate(() => document.getAnimations().forEach(animation => { if (animation.playState === 'paused') animation.finish(); })); await expect(page.locator('.viewer-slide-overlay,.viewer-drag-neighbor')).toHaveCount(0); };
  const viewed = async (id: string) => (await (await request.get('/internal/settings')).json()).settings['gallery.series_last_viewed']?.default?.[id];
  const drag = async (axis: 'x' | 'y', expectedId: string, cancel: boolean) => {
    const box = (await stage.boundingBox())!, distance = axis === 'x' ? box.width : box.height;
    const x = axis === 'x' ? box.x + 48 : box.x + box.width / 2, y = axis === 'x' ? box.y + 220 : box.y + box.height * .8;
    const session = mobile ? await page.context().newCDPSession(page) : null;
    if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    else { await page.mouse.move(x, y); await page.mouse.down(); }
    const move = async (fraction: number) => {
      const point = { x: x + (axis === 'x' ? distance * fraction : 0), y: y - (axis === 'y' ? distance * fraction : 0) };
      if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
      else await page.mouse.move(point.x, point.y, { steps: 8 });
    };
    if (session && axis === 'y') await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 8, y: y - 3 }] });
    await move(.62);
    const neighbor = stage.locator('.viewer-drag-neighbor');
    await expect(neighbor).toHaveAttribute('data-asset-id', expectedId);
    const first = (await neighbor.locator('img').boundingBox())!;
    const visible = axis === 'x' ? Math.min(first.x + first.width, box.x + box.width) - Math.max(first.x, box.x) : Math.min(first.y + first.height, box.y + box.height) - Math.max(first.y, box.y);
    expect(visible).toBeGreaterThan(10);
    if (axis === 'x') expect(visible).toBeLessThan(first.width - 10);
    expect(await viewed(expectedId)).toBeUndefined();
    await move(.72);
    await expect.poll(async () => {
      const second = (await neighbor.locator('img').boundingBox())!;
      return axis === 'x' ? second.x - first.x : first.y - second.y;
    }).toBeCloseTo(distance * .1, 0);
    await page.screenshot({ path: testInfo.outputPath(`following-${axis}-${cancel ? 'cancel' : 'commit'}.png`) });
    const beforeRelease = (await neighbor.locator('img').boundingBox())!;
    if (session) { await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] }); await session.detach(); }
    else {
      if (cancel) await page.mouse.move(x + 12, y);
      await page.mouse.up();
    }
    if (cancel) {
      await finish(); expect(await viewed(expectedId)).toBeUndefined();
      await expect(page).toHaveURL(new RegExp(`asset=${result.id}`));
    } else {
      await expect(page).toHaveURL(new RegExp(`asset=${expectedId}`));
      await expect(stage).toHaveAttribute('data-slide-axis', axis);
      const afterRelease = (await stage.locator('.viewer-drag-neighbor img').boundingBox())!;
      expect(afterRelease.x).toBeCloseTo(beforeRelease.x, 0); expect(afterRelease.y).toBeCloseTo(beforeRelease.y, 0);
      await finish(); await expect.poll(() => viewed(expectedId)).toBeTruthy();
    }
  };
  await drag('x', original.id, true);
  await drag('x', original.id, false);
  if (mobile) await drag('y', single.id, false);
});

test('opening an uncached gallery item never displays the previously closed item', async ({ page, request }) => {
  const previous = await upload(request, 'coast');
  await upload(request, 'mountain');
  const target = await upload(request, 'architecture');
  await open(page, '/library');
  await page.locator(`[data-study-id="${previous.id}"] .study-open`).click();
  await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', previous.contentUrl);
  await page.getByRole('button', { name: '返回作品', exact: true }).click();
  await expect(page.locator('.study-viewer')).toHaveCount(0);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/internal/assets/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/internal/assets/${target.id}` || path === `/internal/assets/${target.id}/series`) await gate;
    await route.continue();
  });
  await page.evaluate(() => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const src = document.querySelector('.viewer-stage > img')?.getAttribute('src');
      if (src && seen.at(-1) !== src) seen.push(src);
      document.documentElement.dataset.openedMediaSources = JSON.stringify(seen);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  });
  try {
    await page.locator(`[data-study-id="${target.id}"] .study-open`).click();
    await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', target.contentUrl);
    await expect(page.locator('.viewer-heading h2')).toHaveText('architecture.webp');
    await expect(page.locator('html')).toHaveAttribute('data-opened-media-sources', JSON.stringify([target.contentUrl]));
    await expect(page.locator('.viewer-slide-overlay,.viewer-drag-neighbor')).toHaveCount(0);
    release();
    await expect(page.locator('.viewer-stage > img')).toHaveAttribute('src', target.contentUrl);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('HTTP content preference saves and survives reload', async ({ page, request }, testInfo) => {
  await request.patch('/internal/settings', { data: { values: { 'network.allow_http_content': true } } });
  await open(page, '/settings');
  const toggle = page.getByRole('checkbox', { name: '是否允许 HTTP 内容', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['network.allow_http_content']).toBe(false);
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings['network.allow_http_content']).toBe(true);
  await expect(toggle).toBeEnabled();
  await expect(page.getByText('同时允许 HTTP 提供商连接和媒体下载；HTTP 不加密传输。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('http-content-preference.png') });
});


test('mobile editor closes on a committed left edge swipe without losing its draft', async ({ page, request }, testInfo) => {
  const original = await upload(request);
  await open(page, `/library?asset=${original.id}`);
  const viewer = page.locator('.study-viewer');
  const stage = viewer.locator('.viewer-stage');
  await expect(stage.locator('img.viewer-image')).toBeVisible();
  const swipe = async (x: number, dx: number, dy = 0, cancel = false, hold = false) => {
    const box = (await stage.boundingBox())!, y = box.y + 220;
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] });
    if (hold) {
      await expect(viewer.locator('.viewer-edge-back')).toBeVisible();
      await expect(viewer.locator('.viewer-drag-neighbor')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('edge-back.png') });
    }
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    await session.detach();
  };
  if (page.viewportSize()!.width >= 761) {
    await swipe(8, 120);
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.viewer-edge-back')).toHaveCount(0);
    return;
  }
  for (const [x, dx, dy, cancel] of [[8, 40, 0, false], [8, 10, 110, false], [8, 120, 0, true], [48, 120, 0, false]] as const) {
    await swipe(x, dx, dy, cancel);
    await expect(viewer).toBeVisible();
    await expect(page).toHaveURL(new RegExp(original.id));
  }
  const prompt = viewer.getByRole('textbox', { name: '创作描述', exact: true });
  await prompt.fill('保留这次编辑草稿');
  await stage.click({ position: { x: 170, y: 180 } });
  await swipe(8, 120, 0, false, true);
  await expect(viewer).toHaveCount(0);
  await expect(page).not.toHaveURL(/asset=/);
  await page.locator(`[data-study-id="${original.id}"] .study-open`).click();
  await expect(viewer.getByRole('textbox', { name: '创作描述', exact: true })).toHaveValue('保留这次编辑草稿');
  await viewer.getByRole('button', { name: '返回作品', exact: true }).click();

  const created = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-video-v1', operation: 'video.generate', prompt: 'Edge back video', inputs: [] } });
  const id = (await created.json()).job.id;
  await expect.poll(async () => (await (await request.get(`/internal/jobs/${id}`)).json()).assets.length, { timeout: 25000 }).toBe(1);
  const video = (await (await request.get(`/internal/jobs/${id}`)).json()).assets[0];
  await open(page, `/library?asset=${video.id}`);
  await expect(viewer.getByLabel('原视频')).toBeVisible();
  await swipe(8, 120);
  await expect(viewer).toHaveCount(0);
});

test('UUID project editor remembers per-model settings across reloads', async ({ page, request }) => {
  const { provider } = await (await request.post('/internal/providers', { data: { name: `Editor memory ${randomUUID()}`, type: 'openai', enabled: true } })).json();
  const { collection } = await (await request.post('/internal/collections', { data: { name: 'Editor memory project' } })).json();
  const original = await upload(request);
  await request.post(`/internal/collections/${collection.id}/assets`, { data: { assetIds: [original.id] } });
  const scope = `generation.edit.${collection.id}.${original.id}`;
  try {
    const modelKeys = new Map<string, string>();
    for (const modelId of ['editor-memory-a', 'editor-memory-b']) {
      const response = await request.post('/internal/models', { data: { providerId: provider.id, modelId, displayName: modelId, enabled: true, capabilities: { operations: ['image.edit'], maxReferenceImages: 2, aspectRatios: ['1:1', '16:9'], resolutions: ['1024x1024'] } } });
      expect(response.status()).toBe(201); modelKeys.set(modelId, (await response.json()).model.id);
    }
    await open(page, `/projects/${collection.id}?asset=${original.id}`);
    const choose = async (id: string) => {
      await page.locator('.study-viewer').getByLabel('创作描述', { exact: true }).fill('Remember editor parameters');
      if (page.viewportSize()!.width < 600) {
        await page.getByRole('button', { name: '生成设置', exact: true }).click();
        await selectValue(page, '模型与服务', { label: `${provider.name} · ${id}` });
        await expect(page.locator('.study-viewer .model-trigger')).toContainText(id);
        if (await page.getByRole('dialog', { name: '生成设置', exact: true }).count()) await page.keyboard.press('Escape');
      } else {
        await page.getByRole('button', { name: '选择生成模型', exact: true }).click();
        await page.locator('.choice').filter({ has: page.getByText(id, { exact: true }) }).click();
      }
    };
    const count = async (value?: string) => {
      await page.getByRole('button', { name: '生成设置', exact: true }).click();
      if (value) await chooseCount(page, value);
      const result = await page.getByRole('button', { name: '生成数量', exact: true }).innerText();
      await page.keyboard.press('Escape'); return result.replace('×', '');
    };
    await choose('editor-memory-a'); await count('3');
    await expect.poll(async () => (await (await request.get('/internal/settings')).json()).settings[scope]?.image?.models?.[modelKeys.get('editor-memory-a')!]?.count).toBe(3);
    await choose('editor-memory-b'); expect(await count()).toBe('1'); await count('2');
    await choose('editor-memory-a'); expect(await count()).toBe('3');
    await page.reload();
    await expect(page.locator('.study-viewer .model-trigger')).toContainText('editor-memory-a');
    await page.locator('.study-viewer').getByLabel('创作描述', { exact: true }).fill('Restored');
    expect(await count()).toBe('3');
    await page.goto(`/library?asset=${original.id}`); await choose('editor-memory-a'); expect(await count()).toBe('1');
  } finally { await request.delete(`/internal/providers/${provider.id}`); }
});

test('settings events synchronize open pages without crossing account boundaries', async ({ page, context, request, browser, baseURL }) => {
  await open(page, '/settings');
  const peer = await context.newPage();
  const otherContext = await browser.newContext({ baseURL, serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });
  try {
    const username = `sync-${randomUUID().slice(0, 8)}`;
    await request.post('/internal/accounts', { data: { username, password: 'fixture-password' } });
    const login = await otherContext.request.post('/internal/auth/login', { headers: { Origin: baseURL! }, data: { username, password: 'fixture-password' } }); expect(login.ok()).toBeTruthy();
    const other = await otherContext.newPage();
    await open(other, '/settings'); await open(peer, '/settings');
    await expect(peer.getByRole('combobox', { name: '默认创作类型', exact: true })).toHaveText('图片');
    await page.bringToFront();
    await selectValue(page, '默认创作类型', 'video');
    await expect(peer.getByRole('combobox', { name: '默认创作类型', exact: true })).toHaveText('视频');
    await expect(other.getByRole('combobox', { name: '默认创作类型', exact: true })).toHaveText('图片');
    const allowed = peer.getByRole('checkbox', { name: '是否允许 HTTP 内容', exact: true });
    await page.getByRole('checkbox', { name: '是否允许 HTTP 内容', exact: true }).click();
    await expect(allowed).not.toBeChecked();
    expect((await (await otherContext.request.get('/internal/settings')).json()).settings['network.allow_http_content']).toBe(false);
    await request.patch('/internal/settings', { data: { values: { 'network.allow_http_content': true } } });
  } finally {
    await request.patch('/internal/settings', { data: { values: { 'network.allow_http_content': true } } });
    await peer.close(); await otherContext.close();
  }
});
