import { randomUUID } from 'node:crypto';

import { AxeBuilder } from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from './fixtures.js';

test.setTimeout(120_000);

const REPRESENTATIVE_PROJECTS = new Set([
  'pr7-desktop-1440x900',
  'pr7-mobile-390x844',
]);

const AXE_RULE_EXCLUSIONS = [] as const;

const MAX_ENTRY_RAW_BYTES = 500_000;
const MAX_INITIAL_JS_REQUESTS = 8;
const MAX_INITIAL_JS_BYTES = 950_000;
const MAX_CLS = 0.1;

interface PerformanceSnapshot {
  readonly cls: number;
  readonly entryRawBytes: number;
  readonly entryUrl: string | null;
  readonly initialJsBytes: number;
  readonly initialJsRequests: number;
  readonly jsResources: readonly {
    readonly bytes: number;
    readonly initiatorType: string;
    readonly url: string;
  }[];
}

interface AxeViolation {
  readonly help: string;
  readonly helpUrl: string;
  readonly id: string;
  readonly impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  readonly nodes: readonly unknown[];
}

interface JobDetailResponse {
  readonly assets: readonly {
    readonly id: string;
  }[];
  readonly job: {
    readonly errorMessage: string | null;
    readonly status: string;
  };
}

function skipNonRepresentative(testInfo: TestInfo): void {
  test.skip(
    !REPRESENTATIVE_PROJECTS.has(testInfo.project.name),
    'PR7 a11y and performance gates run on the representative desktop and mobile projects.',
  );
}

async function dismissPwaNotice(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click();
      break;
    }
    await page.waitForTimeout(200);
  }
  await expect(page.locator('.toast-notice--passive')).toBeHidden({ timeout: 6_000 });
}

async function loadApplication(
  page: Page,
  path: string,
  fixtureMode: boolean,
): Promise<void> {
  if (fixtureMode) {
    await page.addInitScript(() => {
      window.sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
    });
  }
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(5_000);
    const layoutShifts: { hadRecentInput: boolean; value: number }[] = [];
    Object.defineProperty(window, '__pr7LayoutShifts', {
      configurable: true,
      value: layoutShifts,
    });
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            readonly hadRecentInput?: boolean;
            readonly value?: number;
          };
          if (typeof shift.value === 'number') {
            layoutShifts.push({
              hadRecentInput: shift.hadRecentInput === true,
              value: shift.value,
            });
          }
        }
      });
      observer.observe({ buffered: true, type: 'layout-shift' });
    } catch {
      // Chromium supports layout-shift; retain an empty stable metric if unavailable.
    }
  });
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
  await dismissPwaNotice(page);
  if (path === '/imagine') {
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[aria-label="Media gallery"]').or(page.locator('.gallery-empty')),
    ).toBeVisible({ timeout: 30_000 });
  }
  if (path === '/settings/pwa') {
    await expect(page.getByRole('heading', { name: 'App', exact: true })).toBeVisible({ timeout: 30_000 });
  }
}

async function refreshMockModels(request: APIRequestContext): Promise<void> {
  const response = await request.post('/internal/providers/mock/models/refresh');
  expect(response.status()).toBe(200);
}

async function createMockImageJob(
  request: APIRequestContext,
  prompt: string,
): Promise<string> {
  await refreshMockModels(request);
  const response = await request.post('/internal/jobs', {
    data: {
      aspectRatio: '1:1',
      count: 1,
      inputs: [],
      modelId: 'mock-image-v1',
      operation: 'image.generate',
      prompt,
      providerId: 'mock',
    },
  });
  expect(response.status()).toBe(202);
  const body = await response.json() as { readonly job?: { readonly id?: string } };
  const jobId = body.job?.id;
  if (!jobId) throw new Error('The Mock image job response did not include an ID.');
  return jobId;
}

async function waitForCompletedJob(
  request: APIRequestContext,
  jobId: string,
): Promise<JobDetailResponse> {
  let detail: JobDetailResponse | null = null;
  await expect.poll(async () => {
    const response = await request.get(`/internal/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok()) return `http-${response.status()}`;
    detail = await response.json() as JobDetailResponse;
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

async function deleteMockImageJob(
  request: APIRequestContext,
  jobId: string,
  assets: readonly { readonly id: string }[],
): Promise<void> {
  const jobDelete = await request.delete(`/internal/jobs/${encodeURIComponent(jobId)}`);
  expect([204, 404]).toContain(jobDelete.status());
  for (const asset of assets) {
    const assetDelete = await request.delete(`/internal/assets/${encodeURIComponent(asset.id)}`);
    expect([204, 404]).toContain(assetDelete.status());
  }
}

function axeAttachmentName(label: string): string {
  return `pr7-a11y-${label.replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '')}.json`;
}

async function scanA11y(page: Page, label: string, testInfo: TestInfo): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']);
  if (AXE_RULE_EXCLUSIONS.length > 0) {
    builder.disableRules(AXE_RULE_EXCLUSIONS.map(({ id }) => id));
  }
  const results = await builder.analyze();
  const violations = (results.violations as readonly AxeViolation[]).map((violation) => ({
    help: violation.help,
    helpUrl: violation.helpUrl,
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.length,
  }));
  const blockingViolations = violations.filter(
    ({ impact }) => impact === 'critical' || impact === 'serious',
  );
  const report = JSON.stringify({
    blockingViolations,
    exclusions: AXE_RULE_EXCLUSIONS,
    label,
    nonBlockingViolations: violations.filter((violation) => !blockingViolations.includes(violation)),
  }, null, 2);
  console.info(`[pr7-a11y] ${report}`);
  await testInfo.attach(axeAttachmentName(label), {
    body: Buffer.from(report, 'utf8'),
    contentType: 'application/json',
  });
  expect(blockingViolations, `${label} has serious or critical axe violations`).toEqual([]);
}

async function readPerformanceSnapshot(page: Page): Promise<PerformanceSnapshot> {
  return page.evaluate(() => {
    const sameOriginJs = performance.getEntriesByType('resource').flatMap((entry) => {
      if (!(entry instanceof PerformanceResourceTiming)) return [];
      let url: URL;
      try {
        url = new URL(entry.name);
      } catch {
        return [];
      }
      if (
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/assets/') ||
        !url.pathname.endsWith('.js')
      ) return [];
      const bytes = Math.max(entry.decodedBodySize, entry.encodedBodySize, entry.transferSize);
      return [{ bytes, initiatorType: entry.initiatorType, url: url.pathname }];
    });
    const entry = sameOriginJs.find(({ url }) => /\/index-[^/]+\.js$/u.test(url)) ?? null;
    const layoutShifts = (window as Window & {
      readonly __pr7LayoutShifts?: readonly {
        readonly hadRecentInput: boolean;
        readonly value: number;
      }[];
    }).__pr7LayoutShifts ?? [];
    return {
      cls: layoutShifts.reduce(
        (total, shift) => shift.hadRecentInput ? total : total + shift.value,
        0,
      ),
      entryRawBytes: entry?.bytes ?? 0,
      entryUrl: entry?.url ?? null,
      initialJsBytes: sameOriginJs.reduce((total, resource) => total + resource.bytes, 0),
      initialJsRequests: sameOriginJs.length,
      jsResources: sameOriginJs,
    };
  });
}

async function assertPerformanceBudget(
  page: Page,
  label: string,
  testInfo: TestInfo,
): Promise<void> {
  await page.waitForTimeout(250);
  const snapshot = await readPerformanceSnapshot(page);
  const report = JSON.stringify({
    budget: {
      cls: MAX_CLS,
      entryRawBytes: MAX_ENTRY_RAW_BYTES,
      initialJsBytes: MAX_INITIAL_JS_BYTES,
      initialJsRequests: MAX_INITIAL_JS_REQUESTS,
    },
    label,
    snapshot,
  }, null, 2);
  console.info(`[pr7-perf] ${report}`);
  await testInfo.attach(`pr7-performance-${label}.json`, {
    body: Buffer.from(report, 'utf8'),
    contentType: 'application/json',
  });
  expect(snapshot.entryUrl, `${label} must expose a production entry resource`).not.toBeNull();
  expect(snapshot.entryRawBytes, `${label} entry raw bytes`).toBeLessThanOrEqual(MAX_ENTRY_RAW_BYTES);
  expect(snapshot.initialJsRequests, `${label} initial JS request count`).toBeLessThanOrEqual(MAX_INITIAL_JS_REQUESTS);
  expect(snapshot.initialJsBytes, `${label} initial JS raw bytes`).toBeLessThanOrEqual(MAX_INITIAL_JS_BYTES);
  expect(snapshot.cls, `${label} cumulative layout shift`).toBeLessThanOrEqual(MAX_CLS);
}

async function mountUpdateNoticeFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const notice = document.createElement('aside');
    notice.className = 'toast-notice toast-notice--interactive';
    notice.dataset.pr7UpdateFixture = 'true';
    notice.setAttribute('aria-labelledby', 'pr7-update-notice-title');
    notice.setAttribute('aria-live', 'polite');
    notice.setAttribute('role', 'status');
    notice.innerHTML = `
      <div class="toast-copy">
        <strong id="pr7-update-notice-title">Update available</strong>
        <span>Reload when you are ready.</span>
      </div>
      <div class="toast-actions">
        <button class="toast-command toast-command--primary" type="button">Update</button>
        <button class="toast-command" type="button">Later</button>
        <button aria-label="Dismiss" class="icon-button" type="button"><span class="sr-only">Dismiss</span></button>
      </div>`;
    document.body.append(notice);
  });
  await expect(page.locator('[data-pr7-update-fixture="true"]')).toBeVisible();
}

test('[PR7 a11y] scans the production Imagine page and generation parameters', async ({
  page,
  request,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  const prompt = `PR7 a11y viewer ${randomUUID()}`;
  const jobId = await createMockImageJob(request, prompt);
  let detail: JobDetailResponse | null = null;
  try {
    detail = await waitForCompletedJob(request, jobId);
    const asset = detail.assets[0];
    if (!asset) throw new Error(`Mock image job ${jobId} completed without an asset.`);

    await loadApplication(page, '/imagine', false);
    const generatedCard = page.locator(`[data-item-id="${asset.id}"]`);
    await expect(generatedCard).toBeVisible({ timeout: 30_000 });
    await scanA11y(page, 'production-imagine', testInfo);

    await page.getByRole('button', { name: 'Generation parameters', exact: true }).click();
    await expect(page.locator('.parameters-popover')).toBeVisible();
    await scanA11y(page, 'production-parameters', testInfo);

    await page.keyboard.press('Escape');
    await expect(page.locator('.parameters-popover')).toHaveCount(0);
    const viewerTrigger = generatedCard.locator('.media-card-open');
    await expect(viewerTrigger).toHaveCount(1);
    await viewerTrigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scanA11y(page, 'production-viewer', testInfo);
  } finally {
    await deleteMockImageJob(request, jobId, detail?.assets ?? []);
  }
});

test('[PR7 a11y] scans the fixture Imagine page and Viewer', async ({ page }, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/imagine', true);
  await scanA11y(page, 'fixture-imagine', testInfo);

  await page.getByRole('button', { name: 'Generation parameters', exact: true }).click();
  await expect(page.locator('.parameters-popover')).toBeVisible();
  await scanA11y(page, 'fixture-parameters', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.locator('.parameters-popover')).toHaveCount(0);

  const viewerTrigger = page.locator('.media-card-open').first();
  await expect(viewerTrigger).toBeVisible();
  await viewerTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scanA11y(page, 'fixture-viewer', testInfo);
});

test('[PR7 a11y] scans the mobile navigation and verifies keyboard focus return', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  test.skip((page.viewportSize()?.width ?? 0) > 720, 'Mobile navigation runs on the representative mobile project.');
  await loadApplication(page, '/imagine', true);

  const menuTrigger = page.getByRole('button', { name: 'Open navigation', exact: true });
  await menuTrigger.focus();
  await menuTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scanA11y(page, 'fixture-mobile-navigation', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
});

test('[PR7 a11y] scans the production mobile navigation', async ({ page }, testInfo) => {
  skipNonRepresentative(testInfo);
  test.skip((page.viewportSize()?.width ?? 0) > 720, 'Mobile navigation runs on the representative mobile project.');
  await loadApplication(page, '/imagine', false);

  const menuTrigger = page.getByRole('button', { name: 'Open navigation', exact: true });
  await menuTrigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scanA11y(page, 'production-mobile-navigation', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(menuTrigger).toBeFocused();
});

test('[PR7 a11y] scans production PWA settings online, offline, and update notice', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/settings/pwa', false);
  await scanA11y(page, 'production-settings-pwa', testInfo);

  await page.context().setOffline(true);
  try {
    await expect(page.locator('.network-banner--offline')).toBeVisible();
    await scanA11y(page, 'production-settings-pwa-offline', testInfo);
  } finally {
    await page.context().setOffline(false);
  }

  await mountUpdateNoticeFixture(page);
  await scanA11y(page, 'production-update-notice', testInfo);
});

test('[PR7 a11y] scans fixture PWA settings', async ({ page }, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/settings/pwa', true);
  await scanA11y(page, 'fixture-settings-pwa', testInfo);
  await mountUpdateNoticeFixture(page);
  await scanA11y(page, 'fixture-update-notice', testInfo);
});

test('[PR7 a11y] preserves Tab, Escape, and focus return across parameters and Viewer', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/imagine', true);

  const parametersTrigger = page.getByRole('button', { name: 'Generation parameters', exact: true });
  await parametersTrigger.focus();
  await parametersTrigger.click();
  await expect(page.locator('.parameters-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.parameters-popover')).toHaveCount(0);
  await expect(parametersTrigger).toBeFocused();

  const viewerTrigger = page.locator('.media-card-open').first();
  await viewerTrigger.focus();
  await viewerTrigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(viewerTrigger).toBeFocused();
});

test('[PR7 a11y] honors prefers-reduced-motion without hiding state feedback', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadApplication(page, '/imagine', true);
  const motion = await page.evaluate(() => {
    const selectors = ['.app-shell', '.composer', '.gallery-header', '.mobile-menu-trigger'];
    return {
      matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      styles: selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          animationName: style.animationName,
          selector,
          transitionDuration: style.transitionDuration,
        };
      }),
      statusVisible: [...document.querySelectorAll('[role="status"]')]
        .some((element) => getComputedStyle(element).display !== 'none'),
    };
  });
  expect(motion.matches).toBe(true);
  expect(motion.styles.filter((style): style is NonNullable<typeof style> => style !== null)
    .every((style) => style.animationName === 'none' && style.transitionDuration === '0s')).toBe(true);
  expect(motion.statusVisible).toBe(true);
});

test('[PR7 perf] keeps the production first-screen resource and CLS budgets', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/imagine', false);
  await assertPerformanceBudget(page, 'production-imagine', testInfo);
});

test('[PR7 perf] keeps the fixture first-screen resource and CLS budgets', async ({
  page,
}, testInfo) => {
  skipNonRepresentative(testInfo);
  await loadApplication(page, '/imagine', true);
  await assertPerformanceBudget(page, 'fixture-imagine', testInfo);
});
