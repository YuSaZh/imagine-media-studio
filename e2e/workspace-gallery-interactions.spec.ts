import { test, expect } from './fixtures.js';
import { open, upload, resetWorkspace, enterSelection } from './workspace-helpers.js';

test.beforeEach(async ({ request, page }) => resetWorkspace(request, page));

test('gallery hover, mixed series actions and outside search dismissal preserve interactions', async ({ page, request }, info) => {
  const uploaded = await upload(request, 'coast');
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.group_concurrent_images': true } } });
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt: 'Mixed series hover fixture', count: 2, inputs: [] } });
  const { jobs } = await response.json();
  for (const job of jobs) await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).job.status).toBe('completed');
  const first = (await (await request.get(`/internal/jobs/${jobs[0].id}`)).json()).assets[0];
  const second = (await (await request.get(`/internal/jobs/${jobs[1].id}`)).json()).assets[0];
  await request.delete(`/internal/assets/${second.id}`);
  await page.route('**/internal/jobs?*', async route => {
    const response = await route.fetch(), data = await response.json();
    data.items = data.items.map((job: { id: string }) => job.id === jobs[1].id ? { ...job, status: 'failed', errorMessage: 'Fixture failure', outputCount: 0 } : job);
    await route.fulfill({ response, json: data });
  });
  await open(page, '/imagine', false);
  const cover = page.locator(`[data-study-id="${first.id}"]`);
  const ordinary = page.locator(`[data-study-id="${uploaded.id}"]`);
  await expect(cover.locator('.series-count')).toHaveText('2');
  const desktop = page.viewportSize()!.width >= 761;
  for (const card of [ordinary, cover]) {
    await card.hover();
    for (const selector of ['.card-bookmark', '.card-reference', '.card-more']) await expect(card.locator(selector)).toHaveCSS('opacity', '1');
    if (desktop) await expect(card.locator('.study-caption')).toHaveCSS('opacity', '1');
  }
  await expect(cover.locator('.card-copy-prompt')).toHaveCSS('opacity', '1');
  if (!desktop) expect((await cover.locator('.pending-cover-status').boundingBox())!.y).toBeGreaterThanOrEqual((await cover.locator('.card-more').boundingBox())!.y + (await cover.locator('.card-more').boundingBox())!.height);
  await cover.locator('.card-more').click();
  await expect(page.getByRole('button', { name: '查看系列任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '删除失败任务', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.asset-options')).toHaveCount(0);
  await enterSelection(page);
  await expect(cover.locator('.card-more')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭多选', exact: true }).click();
  await cover.hover();
  await expect(cover.locator('.card-more')).toHaveCSS('opacity', '1');
  if (desktop) {
    await expect(cover.locator('.study-caption')).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await cover.locator('.study-open').focus();
    await expect(cover.locator('.study-caption')).toHaveCSS('opacity', '1');
  } else {
    const header = (await page.locator('.workspace-header').boundingBox())!;
    const tabs = (await page.locator('.library-filter').boundingBox())!;
    expect(header.height).toBe(56);
    expect(tabs.y - header.y - header.height).toBeCloseTo(0, 0);
    const searchButton = page.getByRole('button', { name: '搜索作品', exact: true });
    await searchButton.click();
    const input = page.getByRole('textbox', { name: '搜索作品', exact: true });
    const navigation = page.getByRole('button', { name: '打开导航', exact: true });
    await expect(navigation).toBeVisible();
    const navBox = (await navigation.boundingBox())!, searchBox = (await page.locator('.mobile-header-search').boundingBox())!;
    expect(searchBox.x).toBeGreaterThanOrEqual(navBox.x + navBox.width);
    await input.click();
    await expect(page.locator('.workspace-header')).toHaveClass(/is-searching/);
    await page.locator('.library-filter').getByRole('button', { name: '全部', exact: true }).click();
    await expect(page.locator('.workspace-header')).not.toHaveClass(/is-searching/);
    await searchButton.click();
    await input.fill('coast');
    await expect(page.locator('[data-study-id]')).toHaveCount(1);
    await page.locator('.library-filter').getByRole('button', { name: '全部', exact: true }).click();
    await expect(page.locator('.workspace-header')).toHaveClass(/is-searching/);
    await expect(input).toHaveValue('coast');
    await navigation.click();
    await expect(page.locator('.navigation-panel')).toBeVisible();
    await page.locator('.navigation-panel').getByRole('button', { name: '关闭面板', exact: true }).click();
    await expect(page.locator('.navigation-panel')).toHaveCount(0);
    await expect(input).toHaveValue('coast');
    await expect(page.locator('.workspace-header')).toHaveClass(/is-searching/);
    await ordinary.locator('.study-open').click();
    await expect(page.locator('.study-viewer')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('asset')).toBe(uploaded.id);
    await page.getByRole('button', { name: '返回作品', exact: true }).click();
    await expect(input).toHaveValue('coast');
    await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
    await expect(page.locator('[data-study-id]')).toHaveCount(2);
  }
  await page.screenshot({ path: info.outputPath('gallery-interactions.png'), animations: 'disabled' });
});
