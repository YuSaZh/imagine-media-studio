import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { open, upload, resetWorkspace, enterSelection } from './workspace-helpers.js';

test.beforeEach(async ({ request, page }) => {
  await resetWorkspace(request, page);
  await request.patch('/internal/settings', { data: { values: { 'branding.name': 'Imagine.', 'branding.logo': '', 'ui.reduce_motion': 'never' } } });
});

test('sidebar and mobile header search animate and respect reduced motion', async ({ page, request }, info) => {
  await upload(request, 'coast'); await upload(request, 'mountain');
  await open(page, '/imagine', false);
  if (page.viewportSize()!.width >= 761) {
    const rail = page.locator('.side-rail');
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
    await expect.poll(() => rail.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(260);
    await expect(page.locator('.rail-label').first()).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
    await expect.poll(async () => (await rail.boundingBox())!.width).toBe(72);
  } else {
    await expect(page.locator('.library-heading')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '选择作品', exact: true })).toHaveCount(0);
    const searchButton = page.getByRole('button', { name: '搜索作品', exact: true });
    const history = page.getByRole('button', { name: '生成任务', exact: true });
    expect((await searchButton.boundingBox())!.x).toBeLessThan((await history.boundingBox())!.x);
    await searchButton.click();
    const search = page.getByRole('textbox', { name: '搜索作品', exact: true });
    await expect(search).toBeFocused();
    await expect(page.locator('.workspace-location')).toHaveCSS('opacity', '0');
    await search.fill('mountain');
    await expect(page.locator('[data-study-id]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('mobile-header-search.png'), animations: 'disabled' });
    await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
    await expect(searchButton).toBeFocused();
    await expect(page.locator('.workspace-location')).toHaveCSS('opacity', '1');
    await expect(page.locator('[data-study-id]')).toHaveCount(2);
    await enterSelection(page);
    await expect(page.locator('.study-viewer')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭多选', exact: true }).click();
    const card = page.locator('.study-open').first();
    const box = (await card.boundingBox())!;
    await card.dispatchEvent('pointerdown', { pointerId: 23, pointerType: 'touch', clientX: box.x + 30, clientY: box.y + 30 });
    await card.dispatchEvent('pointermove', { pointerId: 23, pointerType: 'touch', clientX: box.x + 30, clientY: box.y + 80 });
    await card.dispatchEvent('pointercancel', { pointerId: 23, pointerType: 'touch' });
    // Let the original hold deadline pass to ensure a cancelled timer cannot select.
    await page.waitForTimeout(550);
    await expect(page.locator('.batch-toolbar')).toHaveCount(0);
  }
  await request.patch('/internal/settings', { data: { values: { 'ui.reduce_motion': 'always' } } });
  await expect(page.locator('html')).toHaveAttribute('data-reduce-motion', 'always');
  const animated = page.viewportSize()!.width >= 761 ? page.locator('.side-rail') : page.locator('.mobile-header-search');
  await expect(animated).toHaveCSS('transition-duration', '0s');
});

test('site identity uploads persist and appear in the header favicon and login', async ({ page }, info) => {
  await open(page, '/settings', false);
  const appearance = page.getByRole('region', { name: '网站外观', exact: true });
  await appearance.getByRole('textbox', { name: '网站名称', exact: true }).fill('星海 Studio');
  await appearance.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page).toHaveTitle('星海 Studio');
  await expect(page.locator('.wordmark')).toHaveText('星海 Studio');
  await appearance.getByLabel('上传 Logo', { exact: true }).setInputFiles({ name: 'test-logo.png', mimeType: 'image/png', buffer: await readFile('apps/web/public/icons/app-icon-512.png') });
  await expect(appearance.getByRole('img', { name: '网站 Logo', exact: true })).toHaveAttribute('src', /internal\/branding\/logo/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /internal\/branding\/logo/);
  await page.reload();
  await expect(page).toHaveTitle('星海 Studio');
  await expect(appearance.getByRole('img', { name: '网站 Logo', exact: true })).toHaveAttribute('src', /internal\/branding\/logo/);
  await page.screenshot({ path: info.outputPath('branding-preferences.png'), animations: 'disabled' });
  const publicContext = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await publicContext.newPage();
  try {
    await publicPage.goto(new URL('/', page.url()).href);
    await expect(publicPage.getByRole('heading', { name: '星海 Studio', exact: true })).toBeVisible();
    await expect(publicPage).toHaveTitle('星海 Studio');
    await expect(publicPage.locator('link[rel="icon"]')).toHaveAttribute('href', /internal\/branding\/logo/);
  } finally { await publicContext.close(); }
  await appearance.getByRole('button', { name: '恢复默认 Logo', exact: true }).click();
  await expect(appearance.getByRole('img', { name: '网站 Logo', exact: true })).toHaveAttribute('src', '/icons/app-icon-192.png');
});
