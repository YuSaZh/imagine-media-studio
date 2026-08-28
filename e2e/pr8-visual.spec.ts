import { expect, test, type Page } from './fixtures.js';

const VISUAL_FIXTURE_STORAGE_KEY = 'imagine.visual-fixtures';
const VISUAL_FIXTURE_STORAGE_VALUE = 'pr1-v1';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASELINE_FONT_STYLE = `
  :root {
    --font-ui: "Liberation Sans", sans-serif;
    --font-mono: "Liberation Mono", monospace;
  }
`;

const EXPECTED_VIEWPORTS: Readonly<Record<string, { readonly height: number; readonly width: number }>> = {
  'pr8-visual-desktop-1440x900': { height: 900, width: 1440 },
  'pr8-visual-desktop-1920x1080': { height: 1080, width: 1920 },
  'pr8-visual-mobile-390x844': { height: 844, width: 390 },
  'pr8-visual-mobile-430x932': { height: 932, width: 430 },
};

interface Rect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

function intersects(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width - 0.5 &&
    left.x + left.width > right.x + 0.5 &&
    left.y < right.y + right.height - 0.5 &&
    left.y + left.height > right.y + 0.5;
}

async function dismissPwaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click();
      break;
    }
    await page.waitForTimeout(100);
  }
  await expect(page.locator('.toast-notice--passive')).toBeHidden({ timeout: 6_000 });
}

async function assertNoVisualOverlap(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const rect = (element: Element | null): Rect | null => {
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      const box = element.getBoundingClientRect();
      return { height: box.height, width: box.width, x: box.x, y: box.y };
    };
    return {
      cards: [...document.querySelectorAll('.virtual-gallery-item')]
        .map((element) => rect(element))
        .filter((box): box is Rect => box !== null && box.width > 0 && box.height > 0),
      fixedRegions: ['.mobile-header', '.gallery-header', '.composer']
        .map((selector) => ({ box: rect(document.querySelector(selector)), selector }))
        .filter((entry): entry is { readonly box: Rect; readonly selector: string } => entry.box !== null),
    };
  });

  for (let leftIndex = 0; leftIndex < geometry.fixedRegions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.fixedRegions.length; rightIndex += 1) {
      const left = geometry.fixedRegions[leftIndex];
      const right = geometry.fixedRegions[rightIndex];
      if (left !== undefined && right !== undefined && intersects(left.box, right.box)) {
        throw new Error(`Visual baseline fixed regions overlap: ${left.selector} and ${right.selector}.`);
      }
    }
  }

  for (let leftIndex = 0; leftIndex < geometry.cards.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < geometry.cards.length; rightIndex += 1) {
      const left = geometry.cards[leftIndex];
      const right = geometry.cards[rightIndex];
      if (left !== undefined && right !== undefined && intersects(left, right)) {
        throw new Error(`Visual baseline gallery cards overlap at indexes ${leftIndex} and ${rightIndex}.`);
      }
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, value }) => {
    window.sessionStorage.setItem(key, value);
  }, { key: VISUAL_FIXTURE_STORAGE_KEY, value: VISUAL_FIXTURE_STORAGE_VALUE });
});

test('matches the project-owned PR8 visual baseline', async ({ page }, testInfo) => {
  const expectedViewport = EXPECTED_VIEWPORTS[testInfo.project.name];
  const viewport = page.viewportSize();
  if (expectedViewport === undefined || viewport === null) {
    throw new Error(`Missing fixed viewport definition for ${testInfo.project.name}.`);
  }
  expect(viewport).toEqual(expectedViewport);

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/imagine', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
  await dismissPwaNotice(page);
  await expect(page.locator('.virtual-gallery')).toBeVisible();
  await expect(page.locator('.virtual-gallery')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.composer')).toBeVisible();

  await page.addStyleTag({ content: BASELINE_FONT_STYLE });
  const environment = await page.evaluate(async () => {
    await document.fonts.ready;
    const monoTarget = document.querySelector('.brand-mark');
    return {
      locale: new Intl.DateTimeFormat().resolvedOptions().locale,
      motionReduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      monoFont: monoTarget === null ? '' : getComputedStyle(monoTarget).fontFamily,
      timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      uiFont: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(environment.locale).toBe('en-US');
  expect(environment.timezone).toBe('UTC');
  expect(environment.motionReduced).toBe(true);
  expect(environment.uiFont).toContain('Liberation Sans');
  expect(environment.monoFont).toContain('Liberation Mono');

  await expect.poll(async () => page.locator('.virtual-gallery-item').count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator('.media-card-image').evaluateAll((images) => images
    .filter((image) => {
      const box = image.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= window.innerHeight;
    })
    .every((image) => {
      const element = image as HTMLImageElement;
      return element.complete && element.naturalWidth > 0;
    }))).toBe(true);
  await assertNoVisualOverlap(page);

  const screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
  expect(screenshot.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
  expect(screenshot.readUInt32BE(16)).toBe(viewport.width);
  expect(screenshot.readUInt32BE(20)).toBe(viewport.height);
  expect(screenshot.byteLength).toBeGreaterThan(4_096);

  await expect(page).toHaveScreenshot('workspace.png', {
    animations: 'disabled',
    caret: 'hide',
    mask: [],
    maxDiffPixelRatio: 0.02,
    scale: 'css',
    threshold: 0.2,
  });
});
