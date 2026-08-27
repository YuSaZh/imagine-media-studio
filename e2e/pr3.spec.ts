import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Request, Route } from '@playwright/test';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from './fixtures.js';

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

interface CapturedJsonResponse<TResponse, TRequest = unknown> {
  readonly body: TResponse;
  readonly request: Request;
  readonly requestBody: TRequest | undefined;
  readonly status: number;
}

async function selectMockImageModel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Generation parameters' }).click();
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toBeVisible();
  await expect(model.locator('option[value="mock-image-v1"]')).toHaveCount(1);
  await model.selectOption('mock-image-v1');
  await expect(model).toHaveValue('mock-image-v1');
  await page.keyboard.press('Escape');
}

function isPostTo(request: Request, path: string): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === path;
}

async function captureJsonResponses<TResponse, TRequest = unknown>(
  page: Page,
  path: string,
  action: () => Promise<void>,
  expectedCount: number,
): Promise<readonly CapturedJsonResponse<TResponse, TRequest>[]> {
  const captures: CapturedJsonResponse<TResponse, TRequest>[] = [];
  const routePattern = `**${path}`;
  const handler = async (route: Route) => {
    const request = route.request();
    if (!isPostTo(request, path)) {
      await route.continue();
      return;
    }

    let requestBody: TRequest | undefined;
    try {
      requestBody = request.postDataJSON() as TRequest;
    } catch {
      // Multipart requests do not expose JSON request data.
    }

    try {
      const response = await route.fetch();
      const body = (await response.json()) as TResponse;
      captures.push({ body, request, requestBody, status: response.status() });
      await route.fulfill({ response });
    } catch (error) {
      await route.abort().catch(() => undefined);
      throw error;
    }
  };

  await page.route(routePattern, handler);
  try {
    await action();
    await expect.poll(() => captures.length, { timeout: 10_000 }).toBe(expectedCount);
    return captures;
  } finally {
    await page.unroute(routePattern, handler);
  }
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
  const mockRefresh = await request.post('/internal/providers/mock/models/refresh');
  expect(mockRefresh.status()).toBe(200);
  const mockCatalog = (await mockRefresh.json()) as {
    readonly items: readonly {
      readonly capabilities: Readonly<Record<string, unknown>>;
      readonly modelId: string;
    }[];
  };
  const mockModel = mockCatalog.items.find((item) => item.modelId === 'mock-image-v1');
  expect(mockModel).toBeDefined();
  expect(mockModel?.capabilities).toMatchObject({
    operations: expect.arrayContaining(['image.generate', 'image.edit']),
    supportsMask: true,
  });
  expect(mockModel?.capabilities.maxReferenceImages).toBeGreaterThanOrEqual(2);
  // PR4 settings tests run in parallel against the same E2E database. Keep
  // their model-catalog events from replacing this flow's explicit model.
  const blockEvents = async (route: Route) => {
    await route.abort();
  };
  await page.route('**/internal/events', blockEvents);
  try {
    await page.goto('/imagine');
    await dismissPwaNotice(page);
    await expect(page.getByRole('heading', { name: 'Imagine' })).toBeVisible();
    await selectMockImageModel(page);
    await expect(page.getByRole('button', { name: 'Add reference image' })).toBeEnabled();
    const uploadResponses = await captureJsonResponses<AssetResponse>(
      page,
      '/internal/assets/upload',
      async () => {
        await page.getByLabel('Reference image files').setInputFiles([
          { buffer: PNG, mimeType: 'image/png', name: `reference-a-${runId}.png` },
          { buffer: PNG, mimeType: 'image/png', name: `reference-b-${runId}.png` },
        ]);
      },
      2,
    );

    const generationInputs = page.getByLabel('Generation inputs');
    await expect(generationInputs.locator('img')).toHaveCount(2);
    const uploadedReferences = uploadResponses.map(({ body, status }) => {
      expect(status).toBe(201);
      return body.asset;
    });
    expect(uploadedReferences.every((asset) => asset.role === 'reference')).toBe(true);

    await page.getByLabel('Prompt').fill(generatePrompt);
    const generate = page.getByRole('button', { name: 'Generate', exact: true });
    await expect(generate).toBeEnabled();
    const [generationResponse] = await captureJsonResponses<
      { readonly job: { readonly id: string } },
      GenerationRequestBody
    >(page, '/internal/jobs', async () => {
      await generate.click();
    }, 1);
    expect(generationResponse).toBeDefined();
    expect(generationResponse?.status).toBe(202);
    const generationRequest = generationResponse?.requestBody;
    if (!generationRequest) throw new Error('The generation request body was not captured.');
    expect(generationRequest).toMatchObject({
      operation: 'image.generate',
      prompt: generatePrompt,
    });
    expect(sortedInputs(generationRequest.inputs)).toEqual(
      uploadedReferences.map((asset) => `reference:${asset.id}`).sort(),
    );
    const generationJobId = generationResponse?.body.job.id;
    if (!generationJobId) throw new Error('The generation job ID was not captured.');
    const generationDetail = await waitForCompletedJob(request, generationJobId);
    expect(generationDetail.assets).toHaveLength(1);
    const generatedOutput = generationDetail.assets[0]!;
    expect(generatedOutput.parentAssetId).toBeNull();
    expect(generatedOutput.width).toBeGreaterThan(0);
    expect(generatedOutput.height).toBeGreaterThan(0);
    const source = uploadedReferences[0]!;
    if (source.width === null || source.height === null) {
      throw new Error('The uploaded source has no decoded dimensions.');
    }
    expect(source.width).toBeGreaterThan(0);
    expect(source.height).toBeGreaterThan(0);

    await page.reload();
    await dismissPwaNotice(page);
    await selectMockImageModel(page);
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
    const desktopDirectory = resolve('artifacts/visual/pr3');
    await mkdir(desktopDirectory, { recursive: true });
    await page.screenshot({
      animations: 'disabled',
      path: resolve(desktopDirectory, 'editor-desktop-1440x900.png'),
    });
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

    const [maskResponse] = await captureJsonResponses<AssetResponse>(
      page,
      '/internal/assets/upload',
      async () => {
        await page.getByRole('button', { name: 'Apply mask' }).click();
      },
      1,
    );
    expect(maskResponse?.status).toBe(201);
    const mask = maskResponse?.body.asset;
    if (!mask) throw new Error('The mask upload response was not captured.');
    expect(mask).toMatchObject({
      height: source.height,
      mimeType: 'image/png',
      parentAssetId: source.id,
      role: 'mask',
      width: source.width,
    });

    await expect(page).toHaveURL(/\/imagine$/);
    await selectMockImageModel(page);
    const appliedInputs = page.getByLabel('Generation inputs');
    await expect(appliedInputs.getByText('Source', { exact: true })).toBeVisible();
    await expect(appliedInputs.getByText('Mask', { exact: true })).toBeVisible();
    await page.getByLabel('Prompt').fill(editPrompt);
    await expect(generate).toBeEnabled();
    const [editResponse] = await captureJsonResponses<
      { readonly job: { readonly id: string } },
      GenerationRequestBody
    >(page, '/internal/jobs', async () => {
      await generate.click();
    }, 1);
    expect(editResponse?.status).toBe(202);
    const editRequest = editResponse?.requestBody;
    if (!editRequest) throw new Error('The edit request body was not captured.');
    expect(editRequest).toMatchObject({ operation: 'image.edit', prompt: editPrompt });
    expect(sortedInputs(editRequest.inputs)).toEqual([
      `mask:${mask.id}`,
      `source:${source.id}`,
    ]);
    const editJobId = editResponse?.body.job.id;
    if (!editJobId) throw new Error('The edit job ID was not captured.');
    const editDetail = await waitForCompletedJob(request, editJobId);
    expect(sortedInputs(editDetail.inputs)).toEqual(sortedInputs(editRequest.inputs));
    expect(editDetail.assets).toHaveLength(1);
    expect(editDetail.assets[0]?.parentAssetId).toBe(source.id);
  } finally {
    await page.unroute('**/internal/events', blockEvents);
  }
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
