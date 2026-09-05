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
  expect(viewport.height - form!.y - form!.height).toBeLessThanOrEqual(26);
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
  const prompt = `edit masked coast ${randomUUID()}`;
  await page.getByLabel('创作描述', { exact: true }).fill(prompt);
  const response = page.waitForResponse(response => response.url().endsWith('/internal/jobs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
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
      operations: ['image.generate'], aspectRatios: ['1:1', '16:9', '4:3'], resolutions: ['auto', '1024x1024'], maxReferenceImages: 0, supportsBatchCount: true, maxBatchCount: 4,
      customFields: { type: 'object', properties: { size: { type: 'string' }, quality: { enum: ['low', 'high'] }, output_format: { enum: ['png', 'jpeg', 'webp'] } }, additionalProperties: false },
    } } });
    expect(added.status()).toBe(201);
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await page.getByLabel('画幅', { exact: true }).fill('4:3');
    await page.getByLabel('分辨率', { exact: true }).selectOption('custom');
    await page.getByLabel('像素宽度', { exact: true }).fill('1920');
    await page.getByLabel('像素高度', { exact: true }).fill('1080');
    await expect(page.getByLabel('画幅', { exact: true })).toHaveValue('16:9');
    await page.getByLabel('生成数量', { exact: true }).selectOption('2');
    await page.getByLabel('质量', { exact: true }).selectOption('high');
    await page.getByLabel('输出格式', { exact: true }).selectOption('jpeg');
    await page.keyboard.press('Escape');
    await page.getByLabel('创作描述', { exact: true }).fill('parameter contract');
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: { code: 'test_only', message: '参数捕获测试' } } }) : route.continue());
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    expect((await sent).postDataJSON()).toMatchObject({ resolution: '1920x1080', count: 2, extra: { quality: 'high', output_format: 'jpeg' } });
  } finally { expect((await request.delete(`/internal/providers/${provider.id}`)).ok()).toBeTruthy(); }
});

test('shared connection model management saves rules and renders them in the composer', async ({ page, request }) => {
  const name = `Managed connection ${randomUUID()}`;
  const created = await request.post('/internal/providers', { data: { name, type: 'xai', baseUrl: 'https://api.example.com/v1', enabled: true, isDefault: true } });
  expect(created.status()).toBe(201);
  const { provider } = await created.json();
  try {
    for (const kind of ['image', 'video']) {
      const response = await request.post('/internal/models', { data: { providerId: provider.id, modelId: `grok-imagine-${kind}-1.5`, displayName: `Managed ${kind}`, capabilities: { operations: [`${kind}.generate`], profile: `xai-imagine-${kind}-v1`, parameters: kind === 'image' ? [{ path: 'count', label: '生成数量', type: 'number', min: 1, max: 4, step: 1, defaultValue: 1 }] : [] }, enabled: true } });
      expect(response.status()).toBe(201);
    }
    await open(page, '/settings/providers');
    await page.getByRole('button', { name: `编辑连接 ${name}`, exact: true }).click();
    const types = page.getByLabel('接口类型', { exact: true });
    await expect(types).toHaveValue('xai');
    expect(await types.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['openai', 'gemini', 'xai', 'custom-http-v1', 'custom-js-v1']);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await open(page, '/settings/models');
    await page.getByLabel('筛选连接', { exact: true }).selectOption(provider.id);
    await expect(page.locator('.model-table tbody tr')).toHaveCount(2);
    await page.getByRole('button', { name: '编辑模型 Managed image', exact: true }).click();
    await expect(page.getByLabel('模型调用协议', { exact: true })).toHaveValue('xai-imagine-image-v1');
    await page.getByLabel('参数默认值 1', { exact: true }).fill('2');
    await page.getByLabel('固定默认值', { exact: true }).check();
    await page.screenshot({ path: `/tmp/imagine-model-editor-${page.viewportSize()!.width}.png`, fullPage: true });
    await page.getByRole('button', { name: '保存模型', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑模型', exact: true })).toHaveCount(0);
    const models = (await (await request.get(`/internal/models?providerId=${provider.id}`)).json()).items;
    expect(models.find((model: { displayName: string }) => model.displayName === 'Managed image').capabilities.parameters[0]).toMatchObject({ defaultValue: 2, locked: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/imagine-model-admin-${page.viewportSize()!.width}.png`, fullPage: true });
    await open(page);
    await page.getByRole('button', { name: '生成设置', exact: true }).click();
    await expect(page.getByLabel('生成数量', { exact: true })).toHaveValue('2');
    await expect(page.getByLabel('生成数量', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('画幅', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByLabel('创作描述', { exact: true }).fill('managed parameters');
    await page.route('**/internal/jobs', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, json: { error: 'captured' } }) : route.continue());
    const sent = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const payload = (await sent).postDataJSON();
    expect(payload).toMatchObject({ providerId: provider.id, count: 2 });
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
  await page.getByLabel('画幅', { exact: true }).selectOption('auto');
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
  await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '视频', exact: true }).click();
  const modes = await page.getByRole('group', { name: '视频输入方式' }).boundingBox();
  const controls = await page.locator('.creation-controls').boundingBox();
  if (page.viewportSize()!.width <= 760) {
    expect(Math.abs(modes!.y - controls!.y)).toBeLessThan(6);
    const modeSwitch = await page.getByRole('group', { name: '创作类型' }).boundingBox();
    expect(modes!.x).toBeGreaterThanOrEqual(modeSwitch!.x + modeSwitch!.width);
    const settings = await page.getByRole('button', { name: '生成设置', exact: true }).boundingBox();
    const submit = await page.getByRole('button', { name: '开始生成', exact: true }).boundingBox();
    expect(modes!.x + modes!.width).toBeLessThanOrEqual(settings!.x);
    expect(submit!.x - settings!.x).toBeLessThan(60);
    await expect(page.locator('.mode-segments span').first()).toBeHidden();
    await expect(page.locator('.mode-segments span').last()).toBeHidden();
  } else expect(Math.abs(modes!.y - controls!.y)).toBeLessThan(5);
  await page.screenshot({ path: `/tmp/imagine-inline-video-${page.viewportSize()!.width}.png` });
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await page.getByLabel('分辨率', { exact: true }).selectOption('720p');
  await page.getByLabel('画幅', { exact: true }).selectOption('9:16');
  await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('720p');
  await page.keyboard.press('Escape');
  await page.getByLabel('创作描述', { exact: true }).fill('video remembers independent dimensions');
  const submitted = page.waitForRequest(request => request.url().endsWith('/internal/jobs') && request.method() === 'POST');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({ aspectRatio: '9:16', resolution: '720p' });
  await expect.poll(async () => Object.values((await (await request.get('/internal/settings')).json()).settings).some((value: unknown) => !!value && typeof value === 'object' && 'resolution' in value && value.resolution === '720p')).toBe(true);
  await page.reload();
  await page.getByRole('group', { name: '创作类型' }).getByRole('button', { name: '视频', exact: true }).click();
  await page.getByRole('button', { name: '生成设置', exact: true }).click();
  await expect(page.getByLabel('画幅', { exact: true })).toHaveValue('9:16');
  await expect(page.getByLabel('分辨率', { exact: true })).toHaveValue('720p');
});

test('preferences expose administrator account management and live public domain', async ({ page, request }) => {
  await open(page, '/settings');
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
    await other.getByLabel('应用密码', { exact: true }).fill('member-password');
    await other.getByRole('button', { name: '进入工作区', exact: true }).click();
    await expect(other.getByRole('heading', { name: '还没有作品', exact: true })).toBeVisible();
    await expect(other.locator('.study-card')).toHaveCount(0);
    await other.goto('/settings');
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
    await other.getByLabel('应用密码', { exact: true }).fill('changed-password');
    await other.getByRole('button', { name: '进入工作区', exact: true }).click();
    await expect(other.getByLabel('账号用户名', { exact: true })).toHaveValue(username);
    await page.goto('/settings');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录 Imagine' })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('应用密码', { exact: true }).fill('changed-password');
    await page.getByRole('button', { name: '进入工作区', exact: true }).click();
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
  await page.goto('/settings');
  const input = page.getByLabel('新账号用户名', { exact: true });
  await input.click();
  expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => visualViewport?.scale ?? 1)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('gallery action buttons share the same frosted surface', async ({ page, request }) => {
  await upload(request); await open(page);
  const styles = await page.locator('.study-card').first().evaluate(element => ['.card-bookmark', '.card-reference', '.card-more'].map(selector => {
    const style = getComputedStyle(element.querySelector(selector)!);
    return { background: style.backgroundColor, blur: style.backdropFilter, radius: style.borderRadius, width: style.width, height: style.height };
  }));
  expect(styles[1]).toEqual(styles[0]); expect(styles[2]).toEqual(styles[0]);
  expect(styles[0]!.blur).toBe('blur(9px)');
});
