import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
});

async function dismissPwaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible()) await dismiss.click();
}

async function navigateWithPrimaryUi(
  page: Page,
  destination: 'Folders' | 'Imagine' | 'Jobs' | 'Saved',
): Promise<void> {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 720) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('link', { name: destination, exact: true }).click();
}

async function navigateToProviders(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 720) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Providers', exact: true }).click();
}

async function clickCardAction(
  page: Page,
  card: ReturnType<Page['locator']>,
  action: 'Cancel' | 'Retry' | 'Save',
): Promise<void> {
  const directAction = card.getByRole('button', { name: action, exact: true });
  if (await directAction.isVisible()) {
    await directAction.click();
    return;
  }
  await card.getByRole('button', { name: 'Card actions', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.keyboard.press('Escape');
}

async function captureInteractionState(
  page: Page,
  projectName: string,
  state: string,
): Promise<void> {
  if (!['pr1-desktop-1440x900', 'pr1-mobile-390x844'].includes(projectName)) return;
  const directory = resolve('artifacts/visual/pr1/states');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${state}-${projectName.replace(/^pr1-/, '')}.png`),
  });
}

async function verifyGalleryGeometry(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const firstCard = page.locator('.virtual-gallery-item').first();
  const composer = page.locator('.composer');
  await expect(firstCard).toBeVisible();
  await expect(composer).toBeVisible();

  const cardBox = await firstCard.boundingBox();
  const composerBox = await composer.boundingBox();
  if (!cardBox || !composerBox || !viewport) {
    throw new Error('Gallery geometry requires measurable card, Composer, and viewport boxes.');
  }

  let visibleHeaderBottom = 0;
  for (const header of [page.locator('.gallery-header'), page.locator('.mobile-header')]) {
    if (await header.isVisible()) {
      const headerBox = await header.boundingBox();
      if (headerBox) visibleHeaderBottom = Math.max(visibleHeaderBottom, headerBox.y + headerBox.height);
    }
  }

  expect(cardBox.width).toBeGreaterThan(viewport.width <= 720 ? 150 : 200);
  expect(cardBox.y).toBeGreaterThanOrEqual(visibleHeaderBottom - 1);
  expect(composerBox.x).toBeGreaterThanOrEqual(0);
  expect(composerBox.y).toBeGreaterThanOrEqual(0);
  expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(viewport.width);
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(viewport.height);

  const horizontalGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(horizontalGeometry.scrollWidth).toBeLessThanOrEqual(horizontalGeometry.clientWidth);

  if (viewport.width <= 720) {
    const scroll = page.locator('.page-scroll');
    const mobileHeader = page.locator('.mobile-header');
    const stickyHeader = page.locator('.gallery-header, .section-header').first();
    await scroll.evaluate((element) => { element.scrollTop = 420; });
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const mobileHeaderBox = await mobileHeader.boundingBox();
    const stickyHeaderBox = await stickyHeader.boundingBox();
    if (!mobileHeaderBox || !stickyHeaderBox) {
      throw new Error('Mobile sticky geometry requires measurable header boxes.');
    }
    expect(stickyHeaderBox.y).toBeGreaterThanOrEqual(
      mobileHeaderBox.y + mobileHeaderBox.height - 1,
    );
    await scroll.evaluate((element) => { element.scrollTop = 0; });
  }
}

test('serves the PR 1 UI shell as an installable offline PWA', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/imagine$/);
  await expect(page).toHaveTitle(/Imagine Media Studio/);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('nav[aria-label="Primary navigation"]')).toBeAttached();
  await verifyGalleryGeometry(page);

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute('href', /manifest/);
  const manifestPath = await manifestLink.getAttribute('href');
  const manifestResponse = await request.get(manifestPath!);
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
      expect.objectContaining({ purpose: 'maskable' }),
    ]),
  );
  expect(manifest.screenshots.length).toBeGreaterThanOrEqual(2);

  for (const icon of manifest.icons as Array<{ src: string; type: string }>) {
    const iconResponse = await request.get(icon.src);
    expect(iconResponse.ok()).toBeTruthy();
    expect(iconResponse.headers()['content-type']).toContain(icon.type);
  }
  for (const screenshot of manifest.screenshots as Array<{ src: string; type: string }>) {
    const screenshotResponse = await request.get(screenshot.src);
    expect(screenshotResponse.ok()).toBeTruthy();
    expect(screenshotResponse.headers()['content-type']).toContain(screenshot.type);
  }

  const serviceWorkerUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(serviceWorkerUrl).not.toBeNull();
  const serviceWorkerResponse = await request.get(serviceWorkerUrl!);
  expect(serviceWorkerResponse.ok()).toBeTruthy();
  const serviceWorkerSource = await serviceWorkerResponse.text();
  expect(serviceWorkerSource).not.toContain('mock-media/');
  expect(serviceWorkerSource).not.toContain('screenshots/');

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Page.enable');
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors.filter((error) => error.errorId !== 'in-incognito')).toEqual([]);
  } finally {
    await cdp.detach();
  }

  await dismissPwaNotice(page);
  const screenshotDirectory = resolve('artifacts/visual/pr1');
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(screenshotDirectory, `${testInfo.project.name.replace(/^pr1-/, '')}.png`),
  });

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test('supports Composer, Viewer, filters, and primary routes with Mock data', async ({ page }, testInfo) => {
  await page.goto('/imagine');
  await dismissPwaNotice(page);

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const generate = page.getByRole('button', { name: 'Generate' });
  const gallery = page.locator('[aria-label="Media gallery"]');
  await expect(gallery).toBeVisible();
  const totalItemsAttribute = await gallery.getAttribute('data-total-items');
  expect(totalItemsAttribute).not.toBeNull();
  const totalItemsBeforeSubmit = Number(totalItemsAttribute);
  expect(Number.isInteger(totalItemsBeforeSubmit)).toBe(true);
  expect(totalItemsBeforeSubmit).toBeGreaterThan(0);
  await expect(generate).toBeDisabled();
  await prompt.fill('A quiet geometric study in morning light');
  await expect(generate).toBeEnabled();

  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Video', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Generation parameters' }).click();
  await expect(page.getByText('Parameters', { exact: true })).toBeVisible();
  const parametersBox = await page.locator('.parameters-popover').boundingBox();
  const parameterViewport = page.viewportSize();
  if (!parametersBox || !parameterViewport) {
    throw new Error('Generation parameters must have measurable viewport geometry.');
  }
  expect(parametersBox.x).toBeGreaterThanOrEqual(0);
  expect(parametersBox.y).toBeGreaterThanOrEqual(0);
  expect(parametersBox.x + parametersBox.width).toBeLessThanOrEqual(parameterViewport.width);
  expect(parametersBox.y + parametersBox.height).toBeLessThanOrEqual(parameterViewport.height);
  await expect(page.locator('.toast-notice')).toBeHidden();
  await captureInteractionState(page, testInfo.project.name, 'parameters');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  const desktopCount = page.getByRole('combobox', { name: 'Result count' });
  if (await desktopCount.isVisible()) {
    await desktopCount.selectOption('2');
  } else {
    await page.getByRole('button', { name: 'Generation parameters' }).click();
    await page.getByRole('combobox', { name: 'Mobile result count' }).selectOption('2');
    await page.keyboard.press('Escape');
  }
  await page.locator('input[type="file"]').setInputFiles(
    resolve('apps/web/public/mock-media/study-03-square.png'),
  );
  await expect(page.locator('[aria-label="Reference images"] img')).toHaveCount(1);
  await generate.click();
  await expect(prompt).toHaveValue('');
  await expect(gallery).toHaveAttribute('data-total-items', String(totalItemsBeforeSubmit + 2));

  await page.getByRole('button', { name: 'Videos', exact: true }).click();
  const renderedVideoCards = page.locator('.media-card');
  await expect(renderedVideoCards.first()).toBeVisible();
  await expect
    .poll(() =>
      renderedVideoCards.evaluateAll((cards) =>
        cards.every((card) => card.getAttribute('data-kind') === 'video'),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  const viewerTrigger = page.locator('.media-card-open').nth(1);
  await viewerTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('Prompt', { exact: true })).toBeVisible();
  await captureInteractionState(page, testInfo.project.name, 'viewer');
  const viewerCounter = page.locator('.viewer-counter');
  const counterBeforeMove = (await viewerCounter.textContent())?.trim();
  expect(counterBeforeMove).toBeTruthy();
  await page.keyboard.press('ArrowRight');
  await expect(viewerCounter).not.toHaveText(counterBeforeMove!);
  await page.getByRole('button', { name: 'Close viewer' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(viewerTrigger).toBeFocused();

  await navigateWithPrimaryUi(page, 'Saved');
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  await navigateWithPrimaryUi(page, 'Folders');
  await expect(page.getByRole('heading', { name: 'Editorial Studies' })).toBeVisible();
  await navigateWithPrimaryUi(page, 'Jobs');
  await expect(page.getByRole('heading', { name: 'Jobs' })).toBeVisible();
  await expect(page.locator('.item-count')).toHaveText(`${totalItemsBeforeSubmit + 1} items`);
  await expect(page.locator('.job-row')).toHaveCount(totalItemsBeforeSubmit + 1);
  await navigateToProviders(page);
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await expect(page.getByText('Studio Mock', { exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 720) {
    const mobileHeaderBox = await page.locator('.mobile-header').boundingBox();
    const settingsNavigationBox = await page.locator('.settings-navigation').boundingBox();
    if (!mobileHeaderBox || !settingsNavigationBox) {
      throw new Error('Mobile Settings geometry requires measurable header and tab boxes.');
    }
    expect(settingsNavigationBox.y).toBeGreaterThanOrEqual(
      mobileHeaderBox.y + mobileHeaderBox.height - 1,
    );
    expect(settingsNavigationBox.y).toBeLessThanOrEqual(
      mobileHeaderBox.y + mobileHeaderBox.height + 1,
    );
  }
});

test('keeps Saved and folder actions consistent across primary routes', async ({ page }) => {
  await page.goto('/imagine');
  await dismissPwaNotice(page);

  const targetItem = page.locator('[data-item-id="image-02"]');
  await expect(targetItem).toBeVisible();
  const directSave = targetItem.getByRole('button', { name: 'Save', exact: true });
  if (await directSave.isVisible()) {
    await directSave.click();
    await targetItem.getByRole('button', { name: 'Organize folders', exact: true }).click();
  } else {
    await targetItem.getByRole('button', { name: 'Card actions', exact: true }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Editorial Studies', exact: true }).click();
  await page.keyboard.press('Escape');

  await navigateWithPrimaryUi(page, 'Saved');
  await expect(page.locator('[data-item-id="image-02"]')).toBeVisible();

  await navigateWithPrimaryUi(page, 'Folders');
  await expect(page.getByRole('heading', { name: 'Editorial Studies' })).toBeVisible();
  await expect(page.locator('[data-item-id="image-02"]')).toBeVisible();

  await navigateWithPrimaryUi(page, 'Imagine');
  await expect(page).toHaveURL(/\/imagine$/);
  await expect(page.locator('[aria-label="Media gallery"]')).toBeVisible();
});

test('keeps touch selection, cancel, and retry transitions deterministic', async ({ page }) => {
  await page.goto('/imagine');
  await dismissPwaNotice(page);

  const selectionTarget = page.locator('[data-item-id="image-03"]');
  await selectionTarget.dispatchEvent('pointerdown', {
    clientX: 40,
    clientY: 160,
    pointerId: 7,
    pointerType: 'touch',
  });
  await page.waitForTimeout(100);
  await selectionTarget.dispatchEvent('contextmenu', { button: 2 });
  await page.waitForTimeout(550);
  await selectionTarget.dispatchEvent('pointerup', {
    clientX: 40,
    clientY: 160,
    pointerId: 7,
    pointerType: 'touch',
  });
  await expect(selectionTarget).toHaveClass(/is-selected/);
  await page.getByRole('button', { name: 'Clear selection' }).click();

  const activeItem = page.locator('[data-item-id="image-01"]');
  await clickCardAction(page, activeItem, 'Cancel');
  await expect(activeItem.getByText('Cancelled', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Failed', exact: true }).click();
  const failedGallery = page.locator('[aria-label="Media gallery"]');
  const failedBefore = Number(await failedGallery.getAttribute('data-total-items'));
  const failedItem = page.locator('[data-item-id="image-19"]');
  await expect(failedItem).toBeVisible();
  await clickCardAction(page, failedItem, 'Retry');
  await expect(failedGallery).toHaveAttribute('data-total-items', String(failedBefore - 1));
});

test('returns Viewer continuations to a capability-normalized Composer', async ({ page }) => {
  await page.goto('/imagine');
  await dismissPwaNotice(page);

  const imagePath = resolve('apps/web/public/mock-media/study-03-square.png');
  await page.locator('input[type="file"]').setInputFiles([
    imagePath,
    imagePath,
    imagePath,
    imagePath,
  ]);
  await expect(page.locator('[aria-label="Reference images"] img')).toHaveCount(4);

  const desktopCount = page.getByRole('combobox', { name: 'Result count' });
  if (await desktopCount.isVisible()) {
    await desktopCount.selectOption('4');
  } else {
    await page.getByRole('button', { name: 'Generation parameters' }).click();
    await page.getByRole('combobox', { name: 'Mobile result count' }).selectOption('4');
    await page.keyboard.press('Escape');
  }

  await navigateWithPrimaryUi(page, 'Saved');
  await page.locator('.media-card-open').first().click();
  await page.getByRole('button', { name: 'Make video' }).click();

  await expect(page).toHaveURL(/\/imagine$/);
  await expect(page.getByRole('button', { name: 'Video', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const normalizedCount = page.locator('select[aria-label="Result count"]');
  await expect(normalizedCount).toBeDisabled();
  await expect(normalizedCount).toHaveValue('1');
  await expect(page.locator('[aria-label="Reference images"] img')).toHaveCount(1);
});

test('creates and completes a persistent Mock Job through the server API', async ({ request }) => {
  const created = await request.post('/internal/jobs', {
    data: {
      operation: 'image.generate',
      providerId: 'mock',
      modelId: 'mock-image-v1',
      prompt: 'GitHub Actions PR 1 server smoke fixture',
      inputs: [],
    },
  });
  expect(created.status()).toBe(202);
  const jobId = (await created.json()).job.id as string;

  await expect
    .poll(async () => {
      const response = await request.get(`/internal/jobs/${jobId}`);
      return (await response.json()).job.status as string;
    })
    .toBe('completed');
});
