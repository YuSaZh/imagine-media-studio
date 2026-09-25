import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { enterSelection, open, upload, resetWorkspace } from './workspace-helpers.js';

test.beforeEach(async ({ request, page }) => resetWorkspace(request, page));

test('manual series persist and offer cover or whole series deletion', async ({ page, request }, testInfo) => {
  const first = await upload(request, 'coast');
  const second = await upload(request, 'mountain');
  const third = await upload(request, 'architecture');
  await open(page, '/imagine', false);
  await enterSelection(page);
  for (const asset of [first, second, third]) await page.locator(`[data-study-id="${asset.id}"] .study-open`).click();
  if (page.viewportSize()!.width >= 761) {
    const composer = page.locator('.creation-area .creation-composer');
    const toolbar = page.locator('.batch-toolbar');
    const checkPosition = async () => {
      await expect.poll(async () => {
        const input = (await composer.boundingBox())!, batch = (await toolbar.boundingBox())!;
        return Math.abs(input.y - batch.y - batch.height - 12);
      }).toBeLessThanOrEqual(2);
      await expect.poll(async () => {
        const input = (await composer.boundingBox())!, batch = (await toolbar.boundingBox())!;
        return Math.abs(input.x + input.width / 2 - batch.x - batch.width / 2);
      }).toBeLessThanOrEqual(2);
    };
    await checkPosition();
    await composer.locator('textarea').fill('Long prompt with multiple lines\n'.repeat(8));
    await checkPosition();
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
    await checkPosition();
    await page.screenshot({ path: testInfo.outputPath('selection-above-composer.png'), animations: 'disabled' });
  }
  await page.getByRole('button', { name: '将所选作品合并为系列', exact: true }).click();
  await expect(page.locator('.series-count')).toHaveText('3');
  await page.reload();
  await expect(page.locator('.series-count')).toHaveText('3');
  await expect(page.locator('[data-study-id]')).toHaveCount(1);
  const cover = await page.locator('[data-study-id]').getAttribute('data-study-id');
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除系列作品？', exact: true });
  for (const label of ['取消', '删除封面图片', '删除整个系列']) await expect(dialog.getByRole('button', { name: label, exact: true })).toBeVisible();
  const coverDelete = dialog.getByRole('button', { name: '删除封面图片', exact: true });
  const seriesDelete = dialog.getByRole('button', { name: '删除整个系列', exact: true });
  const dangerColor = await seriesDelete.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(coverDelete).toHaveCSS('background-color', dangerColor);
  expect(dangerColor).not.toBe(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(element => getComputedStyle(element).backgroundColor));
  await page.screenshot({ path: testInfo.outputPath('series-danger-actions.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await request.get(`/internal/assets/${cover}`)).status()).toBe(200);
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.getByRole('button', { name: '删除封面图片', exact: true }).click();
  await expect(page.locator('.series-count')).toHaveText('2');
  expect((await request.get(`/internal/assets/${cover}`)).status()).toBe(404);
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await dialog.getByRole('button', { name: '删除整个系列', exact: true }).click();
  await expect(page.locator('[data-study-id]')).toHaveCount(0);
  for (const asset of [first, second, third]) expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(404);
});

test('failed series menu and compact task disclosure support deletion', async ({ page, request }, testInfo) => {
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.group_concurrent_images': true } } });
  const prompt = 'Long task prompt '.repeat(300);
  const response = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt, count: 2, inputs: [] } });
  expect(response.status()).toBe(202);
  const { jobs } = await response.json();
  // Fixture the displayed terminal state; cancel real jobs so real deletion is safe.
  for (const job of jobs) await request.post(`/internal/jobs/${job.id}/cancel`);
  for (const job of jobs) {
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).job.status).toMatch(/^(completed|cancelled)$/);
    const { assets } = await (await request.get(`/internal/jobs/${job.id}`)).json();
    for (const asset of assets) await request.delete(`/internal/assets/${asset.id}`);
  }
  await page.route('**/internal/jobs?*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.items = data.items.map((job: { id: string }) => jobs.some((member: { id: string }) => member.id === job.id) ? { ...job, status: 'failed', errorMessage: 'Fixture generation failure', outputCount: 0 } : job);
    await route.fulfill({ response, json: data });
  });
  await open(page, '/imagine', false);
  await page.getByRole('button', { name: '系列更多操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '生成任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除失败任务', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看系列任务', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '生成任务', exact: true });
  const rows = panel.locator('.task-row');
  await expect(rows).toHaveCount(2);
  expect((await rows.first().boundingBox())!.height).toBeLessThan(200);
  expect((await rows.first().locator('.task-body').boundingBox())!.width).toBeCloseTo((await rows.first().boundingBox())!.width, 0);
  await page.screenshot({ path: testInfo.outputPath('task-prompt-collapsed.png'), animations: 'disabled' });
  const toggle = rows.first().getByRole('button', { name: '展开全部', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(rows.first().getByRole('button', { name: '收起', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('task-prompt-expanded.png'), animations: 'disabled' });
  await expect(rows.first().locator('.task-error')).toHaveText('Fixture generation failure');
  await rows.first().getByRole('button', { name: '收起', exact: true }).click();
  await rows.first().getByRole('button', { name: '删除此任务', exact: true }).click();
  await page.getByRole('dialog', { name: '删除任务？', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await panel.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.getByRole('button', { name: '删除失败任务', exact: true }).click();
  await page.getByRole('dialog', { name: '删除任务？', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('[data-pending-job]')).toHaveCount(0);
});


test('manual series accept video-only and mixed media selections', async ({ page, request }) => {
  const videos = [];
  for (const name of ['first', 'second']) {
    const response = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: `${name}.mp4`, mimeType: 'video/mp4', buffer: await readFile('fixtures/providers/mock/mock-video-v1/tiny.mp4') } } });
    expect(response.status()).toBe(201);
    videos.push((await response.json()).asset);
  }
  const photo = await upload(request);
  await open(page, '/imagine', false);
  await enterSelection(page);
  for (const asset of videos) await page.locator(`[data-study-id="${asset.id}"] .study-open`).click();
  const merge = page.getByRole('button', { name: '将所选作品合并为系列', exact: true });
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(page.locator('.series-count')).toHaveText('2');
  await enterSelection(page);
  await page.locator('[data-study-id]').filter({ has: page.locator('.series-count') }).locator('.study-open').click();
  await page.locator(`[data-study-id="${photo.id}"] .study-open`).click();
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(page.locator('.series-count')).toHaveText('3');
  await page.reload();
  await expect(page.locator('[data-study-id]')).toHaveCount(1);
  await expect(page.locator('.series-count')).toHaveText('3');
  for (const video of videos) {
    const series = await (await request.get(`/internal/assets/${video.id}/series`)).json();
    expect(series.assets.map((asset: { id: string }) => asset.id).sort()).toEqual([...videos.map(asset => asset.id), photo.id].sort());
  }
});
