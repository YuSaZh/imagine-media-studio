import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { enterSelection, open, upload, resetWorkspace } from './workspace-helpers.js';

test.beforeEach(async ({ request, page }) => resetWorkspace(request, page));

test('series project moves include filtered mixed media and retry without moving only the cover', async ({ page, request }) => {
  const photo = await upload(request, 'coast');
  const second = await upload(request, 'mountain');
  const videoResponse = await request.post('/internal/assets/upload', { multipart: { role: 'upload', file: { name: 'series-video.mp4', mimeType: 'video/mp4', buffer: await readFile('fixtures/providers/mock/mock-video-v1/tiny.mp4') } } });
  expect(videoResponse.status()).toBe(201);
  const video = (await videoResponse.json()).asset;
  const ids = [photo.id, second.id, video.id].sort();
  expect((await request.post('/internal/assets/series', { data: { assetIds: ids } })).status()).toBe(204);
  const source = (await (await request.post('/internal/collections', { data: { name: 'Move source' } })).json()).collection;
  const destination = (await (await request.post('/internal/collections', { data: { name: 'Move destination' } })).json()).collection;
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true } } });
  await open(page, '/library', false);
  await page.getByRole('button', { name: '图片', exact: true }).click();
  await expect(page.locator('.series-count')).toHaveText('2');
  const cover = (await page.locator('[data-study-id]').getAttribute('data-study-id'))!;
  expect((await request.post(`/internal/collections/${destination.id}/assets`, { data: { assetIds: [cover] } })).ok()).toBeTruthy();
  expect((await request.post(`/internal/collections/${source.id}/assets`, { data: { assetIds: ids.filter(id => id !== cover) } })).ok()).toBeTruthy();
  const attempts: string[][] = [];
  await page.route(`**/internal/collections/${destination.id}/assets/move`, async route => {
    attempts.push(route.request().postDataJSON().assetIds);
    if (attempts.length === 1) await route.fulfill({ status: 500, json: { error: 'fixture_move_failure', message: 'Move unavailable' } });
    else await route.continue();
  });
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '移动到项目', exact: true });
  const target = picker.getByRole('button', { name: 'Move destination', exact: true });
  await expect(target).toBeEnabled();
  await target.click();
  await expect.poll(() => attempts.length).toBe(1);
  expect([...attempts[0]!].sort()).toEqual(ids);
  await expect(target).toBeEnabled();
  for (const id of ids.filter(id => id !== cover)) expect((await (await request.get(`/internal/assets/${id}`)).json()).asset.collectionIds).toEqual([source.id]);
  await target.click();
  await expect(picker).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect([...attempts[1]!].sort()).toEqual(ids);
  for (const id of ids) expect((await (await request.get(`/internal/assets/${id}`)).json()).asset.collectionIds).toEqual([destination.id]);
  expect((await (await request.get(`/internal/assets?collectionId=${source.id}`)).json()).items).toEqual([]);
  await open(page, `/projects/${destination.id}`, false);
  await expect(page.locator('.series-count')).toHaveText('3');
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'Move destination 当前项目', exact: true })).toBeDisabled();
});

test('series project moves preserve concurrent batch membership', async ({ page, request }) => {
  const created = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt: 'Move concurrent series', count: 2, inputs: [] } });
  expect(created.status()).toBe(202);
  const { jobs } = await created.json();
  const ids: string[] = [];
  for (const job of jobs) {
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${job.id}`)).json()).job.status).toBe('completed');
    ids.push((await (await request.get(`/internal/jobs/${job.id}`)).json()).assets[0].id);
  }
  const project = (await (await request.post('/internal/collections', { data: { name: 'Concurrent destination' } })).json()).collection;
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.group_concurrent_images': true, 'gallery.group_uploaded_references': false } } });
  await open(page, '/imagine', false);
  await expect(page.locator('.series-count')).toHaveText('2');
  const seriesRead = page.waitForRequest(request => request.url().includes('/series?') && new URL(request.url()).searchParams.get('groupConcurrentImages') === 'true' && new URL(request.url()).searchParams.get('groupUploadedReferences') === 'false');
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '移动到项目', exact: true }).click();
  await seriesRead;
  const moved = page.waitForRequest(request => request.url().endsWith(`/internal/collections/${project.id}/assets/move`));
  await page.getByRole('dialog', { name: '移动到项目', exact: true }).getByRole('button', { name: 'Concurrent destination', exact: true }).click();
  expect((await moved).postDataJSON().assetIds.sort()).toEqual(ids.sort());
  await expect(page.getByRole('dialog', { name: '移动到项目', exact: true })).toHaveCount(0);
  await open(page, `/projects/${project.id}`, false);
  await expect(page.locator('.series-count')).toHaveText('2');
  await page.reload();
  await expect(page.locator('.series-count')).toHaveText('2');
});

for (const failure of ['truncated', 'empty', 'unavailable']) {
  test(`series project moves block ${failure} membership reads and recover on retry`, async ({ page, request }) => {
    const first = await upload(request, 'coast'), second = await upload(request, 'mountain');
    expect((await request.post('/internal/assets/series', { data: { assetIds: [first.id, second.id] } })).status()).toBe(204);
    const destination = (await (await request.post('/internal/collections', { data: { name: 'Complete destination' } })).json()).collection;
    await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true } } });
    await open(page, '/imagine', false);
    await expect(page.locator('.series-count')).toHaveText('2');
    let broken = true, moves = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/assets/move')) moves++; });
    await page.route('**/internal/assets/*/series?*', async route => {
      if (!broken) { await route.continue(); return; }
      if (failure === 'unavailable') { await route.fulfill({ status: 503, json: { error: 'fixture_series_unavailable', message: 'Series unavailable' } }); return; }
      const response = await route.fetch();
      const family = await response.json();
      if (failure === 'truncated') family.truncated = true;
      else family.assets = [];
      await route.fulfill({ response, json: family });
    });
    await page.locator('.card-more').click();
    await page.getByRole('button', { name: '移动到项目', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '移动到项目', exact: true });
    await expect(picker.getByRole('alert')).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Complete destination', exact: true })).toHaveCount(0);
    expect(moves).toBe(0);
    for (const id of [first.id, second.id]) expect((await (await request.get(`/internal/assets/${id}`)).json()).asset.collectionIds).toEqual([]);
    broken = false;
    await picker.getByRole('button', { name: '重试', exact: true }).click();
    await picker.getByRole('button', { name: 'Complete destination', exact: true }).click();
    await expect(picker).toHaveCount(0);
    expect(moves).toBe(1);
    for (const id of [first.id, second.id]) expect((await (await request.get(`/internal/assets/${id}`)).json()).asset.collectionIds).toEqual([destination.id]);
  });
}

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

for (const lostResponse of [false, true]) {
  test(`series deletion retries remaining assets after the cover disappears (lost response=${lostResponse})`, async ({ page, request }) => {
    const first = await upload(request, 'coast');
    const second = await upload(request, 'mountain');
    expect((await request.post('/internal/assets/series', { data: { assetIds: [first.id, second.id] } })).status()).toBe(204);
    await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true } } });
    await open(page, '/imagine', false);
    await expect(page.locator('.series-count')).toHaveText('2');
    const cover = await page.locator('[data-study-id]').getAttribute('data-study-id');
    const remaining = [first, second].find(asset => asset.id !== cover)!;
    const attempts: string[] = [];
    let seriesReads = 0;
    await page.route('**/internal/assets/*/series?*', async route => { seriesReads++; await route.continue(); });
    await page.route('**/internal/assets/*', async route => {
      if (route.request().method() !== 'DELETE') { await route.continue(); return; }
      const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
      attempts.push(id);
      if (id === remaining.id && attempts.filter(value => value === id).length === 1) {
        if (lostResponse) expect((await route.fetch()).status()).toBe(204);
        await route.fulfill({ status: 500, json: { error: 'fixture_delete_failure', message: 'Deletion response unavailable' } });
      } else await route.continue();
    });
    await page.locator('.card-more').click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除系列作品？', exact: true });
    await expect(dialog).toContainText('不会释放磁盘空间');
    await dialog.getByRole('button', { name: '删除整个系列', exact: true }).click();
    const retry = dialog.getByRole('button', { name: '重试剩余项', exact: true });
    await expect(retry).toBeEnabled();
    expect((await request.get(`/internal/assets/${cover}`)).status()).toBe(404);
    await expect(dialog.getByRole('button', { name: '删除封面图片', exact: true })).toBeDisabled();
    await retry.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-study-id]')).toHaveCount(0);
    expect(seriesReads).toBe(1);
    expect(attempts.filter(id => id === cover)).toHaveLength(1);
    expect(attempts.filter(id => id === remaining.id)).toHaveLength(2);
  });
}

test('series deletion retries a failed task after all covers were removed', async ({ page, request }) => {
  const created = await request.post('/internal/jobs', { data: { providerId: 'mock', modelId: 'mock-image-v1', operation: 'image.generate', prompt: 'Series task retry', count: 2, inputs: [] } });
  expect(created.status()).toBe(202);
  const { jobs } = await created.json();
  const ids: string[] = jobs.map((job: { id: string }) => job.id);
  const assets = [];
  for (const id of ids) {
    await expect.poll(async () => (await (await request.get(`/internal/jobs/${id}`)).json()).job.status).toBe('completed');
    assets.push((await (await request.get(`/internal/jobs/${id}`)).json()).assets[0]);
  }
  await request.patch('/internal/settings', { data: { values: { 'gallery.group_by_series': true, 'gallery.group_concurrent_images': true } } });
  // Terminal completed jobs are deletable too; project one as a failed job
  // to exercise the series cleanup stage while retaining real DELETE routes.
  let reads = 0, attempts = 0;
  await page.route('**/internal/assets/*/series?*', async route => {
    reads++;
    const response = await route.fetch(); const data = await response.json();
    data.jobs = data.jobs.map((job: { id: string }) => job.id === ids[1] ? { ...job, status: 'failed', errorMessage: 'Fixture failure' } : job);
    await route.fulfill({ response, json: data });
  });
  await page.route(`**/internal/jobs/${ids[1]}`, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 500, json: { error: 'fixture_delete_failure' } });
    else await route.continue();
  });
  await open(page, '/imagine', false);
  await expect(page.locator('.series-count')).toHaveText('2');
  await page.locator('.card-more').click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除系列作品？', exact: true });
  await dialog.getByRole('button', { name: '删除整个系列', exact: true }).click();
  const retry = dialog.getByRole('button', { name: '重试剩余项', exact: true });
  await expect(retry).toBeEnabled();
  for (const asset of assets) expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(404);
  await retry.click();
  await expect(dialog).toHaveCount(0);
  expect((await request.get(`/internal/jobs/${ids[1]}`)).status()).toBe(404);
  expect(reads).toBe(1); expect(attempts).toBe(2);
});

test('merge rejection preserves selection and explains the series limit', async ({ page, request }) => {
  const first = await upload(request, 'coast'); const second = await upload(request, 'mountain');
  await page.route('**/internal/assets/series', route => route.fulfill({ status: 409, json: { error: 'series_too_large' } }));
  await open(page, '/imagine', false);
  await enterSelection(page);
  for (const asset of [first, second]) await page.locator(`[data-study-id="${asset.id}"] .study-open`).click();
  await page.getByRole('button', { name: '将所选作品合并为系列', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('合并后的系列过大');
  await expect(page.locator('.batch-toolbar')).toContainText('已选 2 件');
  await expect(page.locator('[data-study-id]')).toHaveCount(2);
});

for (const language of ['zh-CN', 'en', 'ja']) {
  test(`deletion explains retained files in ${language}`, async ({ page, request }) => {
    const asset = await upload(request);
    await request.patch('/internal/settings', { data: { values: { 'ui.language': language } } });
    await open(page, '/imagine', false);
    await expect(page.locator('html')).toHaveAttribute('lang', language);
    await page.locator('.card-more').click();
    const label = language === 'en' ? 'Delete' : language === 'ja' ? '削除' : '删除';
    await page.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(language === 'en' ? 'disk space will not be freed' : language === 'ja' ? 'ディスク容量は解放されません' : '不会释放磁盘空间');
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect((await request.get(`/internal/assets/${asset.id}`)).status()).toBe(200);
  });
}
