import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type Response,
} from '@playwright/test';

const DESKTOP_PROJECT = 'pr1-desktop-1440x900';
const MOBILE_PROJECT = 'pr1-mobile-390x844';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWMwSpn2HwAEJAIsdtK5/wAAAABJRU5ErkJggg==',
  'base64',
);

interface AssetRecord {
  readonly id: string;
  readonly height: number | null;
  readonly mimeType: string;
  readonly parentAssetId: string | null;
  readonly role: string;
  readonly width: number | null;
}

interface AssetResponse {
  readonly asset: AssetRecord;
}

interface GenerationInput {
  readonly assetId: string;
  readonly role: string;
}

interface GenerationRequestBody {
  readonly inputs: readonly GenerationInput[];
  readonly operation: string;
  readonly prompt: string;
}

interface JobDetailResponse {
  readonly assets: readonly AssetRecord[];
  readonly inputs: readonly GenerationInput[];
  readonly job: {
    readonly errorMessage: string | null;
    readonly id: string;
    readonly status: string;
  };
}

function isPostTo(response: Response, path: string): boolean {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === path;
}

async function dismissPwaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible()) await dismiss.click();
}

async function uploadSource(
  request: APIRequestContext,
  filename: string,
): Promise<AssetRecord> {
  const response = await request.post('/internal/assets/upload', {
    multipart: {
      role: 'upload',
      file: { buffer: PNG, mimeType: 'image/png', name: filename },
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as AssetResponse).asset;
}

async function waitForCompletedJob(
  request: APIRequestContext,
  jobId: string,
): Promise<JobDetailResponse> {
  let detail: JobDetailResponse | null = null;
  await expect.poll(async () => {
    const response = await request.get(`/internal/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok()) return `http-${response.status()}`;
    detail = (await response.json()) as JobDetailResponse;
    if (['cancelled', 'expired', 'failed', 'rejected'].includes(detail.job.status)) {
      throw new Error(
        `Job ${jobId} reached ${detail.job.status}: ${detail.job.errorMessage ?? 'no detail'}`,
      );
    }
    return detail.job.status;
  }, { timeout: 30_000 }).toBe('completed');
  if (detail === null) throw new Error(`Job ${jobId} completed without a detail response.`);
  return detail;
}

function sortedInputs(inputs: readonly GenerationInput[]): readonly string[] {
  return inputs.map((input) => `${input.role}:${input.assetId}`).sort();
}

test('uploads multiple references and completes a persistent Mask edit', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== DESKTOP_PROJECT, 'The persistent PR 3 flow runs once.');
  const runId = randomUUID();
  const generatePrompt = `PR3 multi-reference ${runId}`;
  const editPrompt = `PR3 masked edit ${runId}`;
  const uploadBodies: Array<Promise<AssetResponse>> = [];
  const collectUpload = (response: Response) => {
    if (response.status() === 201 && isPostTo(response, '/internal/assets/upload')) {
      uploadBodies.push(response.json() as Promise<AssetResponse>);
    }
  };

  page.on('response', collectUpload);
  await page.goto('/imagine');
  await dismissPwaNotice(page);
  await expect(page.getByRole('heading', { name: 'Imagine' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add reference image' })).toBeEnabled();
  await page.getByLabel('Reference image files').setInputFiles([
    { buffer: PNG, mimeType: 'image/png', name: `reference-a-${runId}.png` },
    { buffer: PNG, mimeType: 'image/png', name: `reference-b-${runId}.png` },
  ]);

  const generationInputs = page.getByLabel('Generation inputs');
  await expect(generationInputs.locator('img')).toHaveCount(2);
  await expect.poll(() => uploadBodies.length).toBe(2);
  const uploadedReferences = (await Promise.all(uploadBodies)).map((body) => body.asset);
  expect(uploadedReferences.every((asset) => asset.role === 'reference')).toBe(true);

  await page.getByLabel('Prompt').fill(generatePrompt);
  const generate = page.getByRole('button', { name: 'Generate', exact: true });
  await expect(generate).toBeEnabled();
  const generationResponsePromise = page.waitForResponse(
    (response) => isPostTo(response, '/internal/jobs'),
  );
  await generate.click();
  const generationResponse = await generationResponsePromise;
  expect(generationResponse.status()).toBe(202);
  const generationRequest = generationResponse.request().postDataJSON() as GenerationRequestBody;
  expect(generationRequest).toMatchObject({
    operation: 'image.generate',
    prompt: generatePrompt,
  });
  expect(sortedInputs(generationRequest.inputs)).toEqual(
    uploadedReferences.map((asset) => `reference:${asset.id}`).sort(),
  );
  const generationJobId = ((await generationResponse.json()) as { job: { id: string } }).job.id;
  const generationDetail = await waitForCompletedJob(request, generationJobId);
  expect(generationDetail.assets).toHaveLength(1);
  const source = generationDetail.assets[0]!;
  expect(source.parentAssetId).toBeNull();
  if (source.width === null || source.height === null) {
    throw new Error('The persistent image output has no decoded dimensions.');
  }
  expect(source.width).toBeGreaterThan(0);
  expect(source.height).toBeGreaterThan(0);

  await page.reload();
  await dismissPwaNotice(page);
  const sourceCard = page.locator(`[data-item-id="${source.id}"]`);
  await expect(sourceCard).toBeVisible();
  await sourceCard.locator('.media-card-open').click();
  await page.getByRole('button', { name: 'Edit image' }).click();
  await expect(page).toHaveURL(new RegExp(`/edit/${source.id}$`));
  await expect(page.getByRole('heading', { name: 'Edit image' })).toBeVisible();

  const canvas = page.getByLabel('Mask canvas');
  const brush = page.getByRole('button', { name: 'Brush', exact: true });
  const eraser = page.getByRole('button', { name: 'Eraser', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  const clear = page.getByRole('button', { name: 'Clear mask', exact: true });
  const overlay = page.getByLabel('Show mask overlay');
  const brushSize = page.getByRole('slider', { name: 'Brush size' });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel editing' })).toBeVisible();
  await brushSize.fill('24');
  await expect(brushSize).toHaveValue('24');
  await overlay.click();
  await overlay.click();
  await brush.click();
  await canvas.click();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(redo).toBeEnabled();
  await redo.click();
  await eraser.click();
  await brush.click();
  await clear.click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await canvas.click();

  const maskResponsePromise = page.waitForResponse(
    (response) => isPostTo(response, '/internal/assets/upload'),
  );
  await page.getByRole('button', { name: 'Apply mask' }).click();
  const maskResponse = await maskResponsePromise;
  expect(maskResponse.status()).toBe(201);
  const mask = ((await maskResponse.json()) as AssetResponse).asset;
  expect(mask).toMatchObject({
    height: source.height,
    mimeType: 'image/png',
    parentAssetId: source.id,
    role: 'mask',
    width: source.width,
  });

  await expect(page).toHaveURL(/\/imagine$/);
  const appliedInputs = page.getByLabel('Generation inputs');
  await expect(appliedInputs.getByText('Source', { exact: true })).toBeVisible();
  await expect(appliedInputs.getByText('Mask', { exact: true })).toBeVisible();
  await page.getByLabel('Prompt').fill(editPrompt);
  await expect(generate).toBeEnabled();
  const editResponsePromise = page.waitForResponse(
    (response) => isPostTo(response, '/internal/jobs'),
  );
  await generate.click();
  const editResponse = await editResponsePromise;
  expect(editResponse.status()).toBe(202);
  const editRequest = editResponse.request().postDataJSON() as GenerationRequestBody;
  expect(editRequest).toMatchObject({ operation: 'image.edit', prompt: editPrompt });
  expect(sortedInputs(editRequest.inputs)).toEqual([
    `mask:${mask.id}`,
    `source:${source.id}`,
  ]);
  const editJobId = ((await editResponse.json()) as { job: { id: string } }).job.id;
  const editDetail = await waitForCompletedJob(request, editJobId);
  expect(sortedInputs(editDetail.inputs)).toEqual(sortedInputs(editRequest.inputs));
  expect(editDetail.assets).toHaveLength(1);
  expect(editDetail.assets[0]?.parentAssetId).toBe(source.id);
  page.off('response', collectUpload);
});

test('keeps the mobile Mask editor within the viewport', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== MOBILE_PROJECT, 'The responsive editor runs once on mobile.');
  const source = await uploadSource(request, `mobile-editor-${randomUUID()}.png`);

  await page.goto(`/edit/${encodeURIComponent(source.id)}`);
  await dismissPwaNotice(page);
  await expect(page.getByRole('heading', { name: 'Edit image' })).toBeVisible();
  await expect(page.getByLabel('Mask canvas')).toBeVisible();
  for (const name of [
    'Brush',
    'Eraser',
    'Undo',
    'Redo',
    'Clear mask',
    'Apply mask',
    'Cancel editing',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('slider', { name: 'Brush size' })).toBeVisible();
  await expect(page.getByLabel('Show mask overlay')).toBeVisible();

  const viewport = page.viewportSize();
  const canvasBox = await page.getByLabel('Mask canvas').boundingBox();
  if (!viewport || !canvasBox) throw new Error('Mobile editor geometry is not measurable.');
  expect(canvasBox.x).toBeGreaterThanOrEqual(0);
  expect(canvasBox.x + canvasBox.width).toBeLessThanOrEqual(viewport.width);
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  const directory = resolve('artifacts/visual/pr3');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, 'editor-mobile-390x844.png'),
  });
});
