import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from './fixtures.js';

test.setTimeout(120_000);

const SCREENSHOT_PROJECTS = new Set([
  'pr7-desktop-1920x1080',
  'pr7-desktop-1440x900',
  'pr7-desktop-1280x800',
  'pr7-tablet-1024x1366',
  'pr7-tablet-834x1194',
  'pr7-mobile-430x932',
  'pr7-mobile-390x844',
  'pr7-mobile-360x800',
]);

const OFFLINE_AUTH_MARKER_KEY = 'imagine-authenticated-session-v1';
const OFFLINE_PUBLIC_BOOTSTRAP_KEY = 'imagine-public-offline-bootstrap-v1';
const OFFLINE_SNAPSHOT_DB_NAME = 'imagine-media-studio-offline-v1';
const OFFLINE_SNAPSHOT_STORE_NAME = 'metadata';
const OFFLINE_SNAPSHOT_KEY = 'recent-gallery';
const DERIVED_MEDIA_CACHE_NAME = 'imagine-derived-media-v2';
const COMPOSER_DRAFT_KEY = 'imagine.composer-draft.v1';
const PR7_STATE_ISOLATION_KEY = 'imagine.pr7-test-isolation-v1';
const FORBIDDEN_SERIALIZED_SECRET = /(APP_PASSWORD|Authorization|apiKey)/iu;

interface AssetRecord {
  readonly contentUrl: string;
  readonly height: number | null;
  readonly id: string;
  readonly thumbnailUrl: string | null;
  readonly type: string;
  readonly width: number | null;
}

interface JobDetailResponse {
  readonly assets: readonly AssetRecord[];
  readonly job: {
    readonly errorMessage: string | null;
    readonly id: string;
    readonly status: string;
  };
}

interface BrowserSerializations {
  readonly cacheEntries: readonly {
    readonly cacheName: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly url: string;
  }[];
  readonly indexedDbSnapshot: string | null;
  readonly localStorage: readonly string[];
  readonly sessionStorage: readonly string[];
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

async function waitForAppShell(page: Page, path = '/imagine'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
  await dismissPwaNotice(page);
}

async function ensureServiceWorkerControl(page: Page): Promise<string> {
  await expect.poll(
    () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL ?? null;
    }),
    { timeout: 30_000 },
  ).not.toBeNull();

  if (!await page.evaluate(() => navigator.serviceWorker.controller !== null)) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
    timeout: 30_000,
  }).toBe(true);
  const scriptUrl = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? '';
  });
  if (scriptUrl.length === 0) throw new Error('The production Service Worker has no active script.');
  return scriptUrl;
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

async function deleteJobAndAssets(
  request: APIRequestContext,
  jobId: string,
  assets: readonly AssetRecord[],
): Promise<void> {
  const jobDelete = await request.delete(`/internal/jobs/${encodeURIComponent(jobId)}`);
  expect([204, 404]).toContain(jobDelete.status());
  for (const asset of assets) {
    const assetDelete = await request.delete(`/internal/assets/${encodeURIComponent(asset.id)}`);
    expect([204, 404]).toContain(assetDelete.status());
  }
}

async function readOfflineSnapshot(page: Page): Promise<string | null> {
  return page.evaluate(async ({ dbName, key, storeName }) => {
    if (typeof indexedDB === 'undefined') return null;
    return new Promise<string | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(dbName);
      } catch {
        resolve(null);
        return;
      }
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.close();
          resolve(null);
          return;
        }
        try {
          const read = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
          read.onerror = () => {
            database.close();
            resolve(null);
          };
          read.onsuccess = () => {
            const value = read.result;
            database.close();
            resolve(value === undefined ? null : JSON.stringify(value));
          };
        } catch {
          database.close();
          resolve(null);
        }
      };
    });
  }, {
    dbName: OFFLINE_SNAPSHOT_DB_NAME,
    key: OFFLINE_SNAPSHOT_KEY,
    storeName: OFFLINE_SNAPSHOT_STORE_NAME,
  });
}

async function readBrowserSerializations(page: Page): Promise<BrowserSerializations> {
  return page.evaluate(async ({ dbName, key, storeName }) => {
    const indexedDbSnapshot = await new Promise<string | null>((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(dbName);
      } catch {
        resolve(null);
        return;
      }
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(storeName)) {
          database.close();
          resolve(null);
          return;
        }
        try {
          const read = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
          read.onerror = () => {
            database.close();
            resolve(null);
          };
          read.onsuccess = () => {
            const value = read.result;
            database.close();
            resolve(value === undefined ? null : JSON.stringify(value));
          };
        } catch {
          database.close();
          resolve(null);
        }
      };
    });
    const localStorage = Object.entries(window.localStorage).map(([name, value]) => `${name}=${value}`);
    const sessionStorage = Object.entries(window.sessionStorage).map(([name, value]) => `${name}=${value}`);
    const cacheEntries: BrowserSerializations['cacheEntries'][number][] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        cacheEntries.push({
          cacheName,
          headers: Object.fromEntries(request.headers.entries()),
          url: request.url,
        });
      }
    }
    return { cacheEntries, indexedDbSnapshot, localStorage, sessionStorage };
  }, {
    dbName: OFFLINE_SNAPSHOT_DB_NAME,
    key: OFFLINE_SNAPSHOT_KEY,
    storeName: OFFLINE_SNAPSHOT_STORE_NAME,
  });
}

async function clearOfflineBootstrapAndSnapshot(page: Page): Promise<void> {
  await page.evaluate(async ({ authKey, dbName, publicKey, snapshotKey }) => {
    localStorage.removeItem(authKey);
    localStorage.removeItem(publicKey);
    localStorage.removeItem(snapshotKey);
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onerror = () => resolve();
      request.onsuccess = () => resolve();
      request.onblocked = () => resolve();
    });
  }, {
    authKey: OFFLINE_AUTH_MARKER_KEY,
    dbName: OFFLINE_SNAPSHOT_DB_NAME,
    publicKey: OFFLINE_PUBLIC_BOOTSTRAP_KEY,
    snapshotKey: OFFLINE_SNAPSHOT_KEY,
  });
}

async function setUnknownOfflineMarker(page: Page): Promise<void> {
  await clearOfflineBootstrapAndSnapshot(page);
  await page.evaluate((authKey) => {
    localStorage.setItem(authKey, JSON.stringify({ authenticatedAt: Date.now(), version: 2 }));
  }, OFFLINE_AUTH_MARKER_KEY);
}

async function installPr7StateIsolation(page: Page): Promise<void> {
  const isolationValue = randomUUID();
  await page.addInitScript(({
    authKey,
    cacheName,
    dbName,
    draftKey,
    publicKey,
    snapshotKey,
    stateKey,
    stateValue,
  }) => {
    try {
      if (localStorage.getItem(stateKey) === stateValue) return;
      localStorage.removeItem(authKey);
      localStorage.removeItem(publicKey);
      localStorage.removeItem(snapshotKey);
      localStorage.removeItem(draftKey);
      localStorage.setItem(stateKey, stateValue);
      if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(dbName);
      if (typeof caches !== 'undefined') void caches.delete(cacheName).catch(() => undefined);
    } catch {
      // The application remains fail-closed when browser storage is unavailable.
    }
  }, {
    authKey: OFFLINE_AUTH_MARKER_KEY,
    cacheName: DERIVED_MEDIA_CACHE_NAME,
    dbName: OFFLINE_SNAPSHOT_DB_NAME,
    draftKey: COMPOSER_DRAFT_KEY,
    publicKey: OFFLINE_PUBLIC_BOOTSTRAP_KEY,
    snapshotKey: OFFLINE_SNAPSHOT_KEY,
    stateKey: PR7_STATE_ISOLATION_KEY,
    stateValue: isolationValue,
  });
}

async function clearPr7BrowserState(page: Page): Promise<void> {
  try {
    await page.evaluate(async ({ authKey, cacheName, dbName, draftKey, publicKey, snapshotKey, stateKey }) => {
      localStorage.removeItem(authKey);
      localStorage.removeItem(publicKey);
      localStorage.removeItem(snapshotKey);
      localStorage.removeItem(draftKey);
      localStorage.removeItem(stateKey);
      sessionStorage.clear();
      if (typeof indexedDB !== 'undefined') {
        await new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(dbName);
          request.onerror = () => resolve();
          request.onsuccess = () => resolve();
          request.onblocked = () => resolve();
        });
      }
      if (typeof caches !== 'undefined') await caches.delete(cacheName);
    }, {
      authKey: OFFLINE_AUTH_MARKER_KEY,
      cacheName: DERIVED_MEDIA_CACHE_NAME,
      dbName: OFFLINE_SNAPSHOT_DB_NAME,
      draftKey: COMPOSER_DRAFT_KEY,
      publicKey: OFFLINE_PUBLIC_BOOTSTRAP_KEY,
      snapshotKey: OFFLINE_SNAPSHOT_KEY,
      stateKey: PR7_STATE_ISOLATION_KEY,
    });
  } catch {
    // The page can be intentionally closed by the production offline flow.
  }
}

test.beforeEach(async ({ page }) => {
  await installPr7StateIsolation(page);
});

test.afterEach(async ({ page }) => {
  await clearPr7BrowserState(page);
});

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function assertViewportLayout(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('A fixed viewport is required for PR7 geometry checks.');
  await assertNoHorizontalOverflow(page);
  const shell = await page.locator('.app-shell').boundingBox();
  if (shell === null) throw new Error('The AppShell has no measurable box.');
  expect(shell.x).toBeGreaterThanOrEqual(0);
  expect(shell.x + shell.width).toBeLessThanOrEqual(viewport.width + 1);
  const prompt = await page.getByRole('textbox', { name: 'Prompt' }).boundingBox();
  if (prompt === null) throw new Error('The Prompt has no measurable box.');
  expect(prompt.x).toBeGreaterThanOrEqual(0);
  expect(prompt.x + prompt.width).toBeLessThanOrEqual(viewport.width + 1);
  if (viewport.width <= 720) {
    await expect(page.locator('.mobile-header')).toBeVisible();
    const composer = await page.locator('.composer').boundingBox();
    if (composer === null) throw new Error('The mobile Composer has no measurable box.');
    expect(composer.x).toBeGreaterThanOrEqual(0);
    expect(composer.x + composer.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height + 1);
  }
}

async function capturePr7Screenshot(page: Page, testInfo: TestInfo): Promise<void> {
  if (!SCREENSHOT_PROJECTS.has(testInfo.project.name)) return;
  const directory = resolve('artifacts/visual/pr7');
  await mkdir(directory, { recursive: true });
  await dismissPwaNotice(page);
  await writeFile(
    resolve(directory, 'visual-diff-report.md'),
    '# PR7 visual diff report\n\nScreenshots are captured at the approved PR7 viewports with animations disabled. The responsive gallery state uses the fixed PR1 Mock fixture; the production cold-offline and unknown-marker checks run at every PR7 viewport. No pixel comparison was run locally.\n\nKeyboard screenshots named `*-keyboard-mock.png` use an injected visualViewport and CSS safe-area mock for geometry coverage. They are not real iOS or Android keyboard/device evidence.\n\n| Viewport | State | Baseline / diff |\n| --- | --- | --- |\n| desktop-1920x1080 | gallery | CI artifact only |\n| desktop-1440x900 | gallery | CI artifact only |\n| desktop-1280x800 | gallery | CI artifact only |\n| tablet-1024x1366 | gallery | CI artifact only |\n| tablet-834x1194 | gallery | CI artifact only |\n| mobile-430x932 | gallery | CI artifact only |\n| mobile-390x844 | gallery | CI artifact only |\n| mobile-360x800 | gallery | CI artifact only |\n| mobile-430x932 | keyboard + safe-area mock | CI artifact only |\n| mobile-390x844 | keyboard + safe-area mock | CI artifact only |\n',
    'utf8',
  );
  const reportPath = resolve(directory, 'visual-diff-report.md');
  const report = await readFile(reportPath, 'utf8');
  if (!report.includes('| mobile-430x932 | mobile selection |')) {
    await writeFile(
      reportPath,
      `${report}| mobile-430x932 | mobile selection | CI artifact only |\n| mobile-390x844 | mobile selection | CI artifact only |\n| tablet-1024x1366 | tablet menu / selection | CI artifact only |\n| tablet-834x1194 | tablet menu / selection | CI artifact only |\n| mobile-430x932 | mobile image viewer / video viewer | CI artifact only |\n| mobile-390x844 | mobile image viewer / video viewer | CI artifact only |\n`,
      'utf8',
    );
  }
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${testInfo.project.name.replace(/^pr7-/, '')}.png`),
  });
}

async function capturePr7KeyboardMockScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
  if (!['pr7-mobile-390x844', 'pr7-mobile-430x932'].includes(testInfo.project.name)) return;
  const directory = resolve('artifacts/visual/pr7');
  await mkdir(directory, { recursive: true });
  await dismissPwaNotice(page);
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${testInfo.project.name.replace(/^pr7-/, '')}-keyboard-mock.png`),
  });
}

async function captureGalleryInteractionScreenshot(
  page: Page,
  testInfo: TestInfo,
  state: 'menu' | 'selection',
): Promise<void> {
  const width = page.viewportSize()?.width;
  if (width !== 390 && width !== 430 && width !== 834 && width !== 1024) return;
  if (state === 'menu' && width !== 834 && width !== 1024) return;
  const directory = resolve('artifacts/visual/pr7');
  await mkdir(directory, { recursive: true });
  await dismissPwaNotice(page);
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${testInfo.project.name.replace(/^pr7-/, '')}-gallery-${state}.png`),
  });
}

async function captureViewerScreenshot(
  page: Page,
  testInfo: TestInfo,
  state: 'image-viewer' | 'video-viewer',
): Promise<void> {
  const width = page.viewportSize()?.width;
  if (width !== 390 && width !== 430) return;
  await dismissPwaNotice(page);
  await expect(page.locator('.viewer-metadata')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous item', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next item', exact: true })).toBeVisible();
  await expect(page.locator('.viewer-top-actions')).toBeVisible();
  const directory = resolve('artifacts/visual/pr7');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${testInfo.project.name}-${state}.png`),
  });
}

interface TouchSequenceOptions {
  readonly contextmenu?: boolean;
  readonly move?: { readonly x: number; readonly y: number };
  readonly scroll?: boolean;
}

async function dispatchTouchSequence(
  page: Page,
  target: ReturnType<Page['locator']>,
  durationMs: number,
  options: TouchSequenceOptions = {},
): Promise<void> {
  const targetBox = await target.boundingBox();
  if (targetBox === null) throw new Error('Touch coverage requires a measurable Gallery card.');
  const cdp = await page.context().newCDPSession(page);
  const touchId = 17;
  const start = {
    id: touchId,
    x: Math.round(targetBox.x + targetBox.width / 2),
    y: Math.round(targetBox.y + Math.min(targetBox.height / 2, 180)),
  };
  const move = options.move === undefined
    ? start
    : { id: touchId, x: start.x + options.move.x, y: start.y + options.move.y };
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    const setupDelay = options.move !== undefined || options.scroll || options.contextmenu ? 100 : 0;
    if (setupDelay > 0) await page.waitForTimeout(setupDelay);
    if (options.contextmenu) {
      await target.dispatchEvent('contextmenu', { button: 2 });
    }
    if (options.move !== undefined) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [move],
      });
    }
    if (options.scroll) {
      await page.locator('.page-scroll').evaluate((element) => {
        element.scrollTop = Math.min(element.scrollTop + 160, element.scrollHeight);
      });
    }
    const remaining = Math.max(0, durationMs - setupDelay);
    if (remaining > 0) await page.waitForTimeout(remaining);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach();
  }
}

async function closeViewerIfOpen(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
  }
}

async function installStandaloneMediaQueryMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    let standalone = false;
    const listeners = new Set<(event: Event) => void>();
    const standaloneQuery = {
      get matches() { return standalone; },
      media: '(display-mode: standalone)',
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener as (event: Event) => void);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener as (event: Event) => void);
      },
      addListener: (listener: (event: Event) => void) => listeners.add(listener),
      removeListener: (listener: (event: Event) => void) => listeners.delete(listener),
      dispatchEvent: (event: Event) => {
        for (const listener of listeners) listener(event);
        return true;
      },
    } as unknown as MediaQueryList;
    window.matchMedia = ((query: string) => {
      if (query === '(display-mode: standalone)') return standaloneQuery;
      return nativeMatchMedia(query);
    }) as typeof window.matchMedia;
    Object.defineProperty(window, '__pr7SetStandalone', {
      configurable: true,
      value: (value: boolean) => {
        standalone = value;
        standaloneQuery.dispatchEvent(new Event('change'));
      },
    });
  });
}

async function installVisualViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let width = window.innerWidth;
    let height = window.innerHeight;
    let offsetTop = 0;
    let offsetLeft = 0;
    const listeners = new Set<(event: Event) => void>();
    const viewport = {
      get height() { return height; },
      get offsetLeft() { return offsetLeft; },
      get offsetTop() { return offsetTop; },
      get width() { return width; },
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'resize' || type === 'scroll') listeners.add(listener);
      },
      removeEventListener(type: string, listener: (event: Event) => void) {
        if (type === 'resize' || type === 'scroll') listeners.delete(listener);
      },
      dispatchEvent(event: Event) {
        listeners.forEach((listener) => listener(event));
        return true;
      },
      setMetrics(next: { height: number; width: number; offsetLeft: number; offsetTop: number }) {
        width = next.width;
        height = next.height;
        offsetLeft = next.offsetLeft;
        offsetTop = next.offsetTop;
        this.dispatchEvent(new Event('resize'));
        this.dispatchEvent(new Event('scroll'));
      },
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
  });
}

async function installSafeAreaMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const apply = () => {
      const root = document.documentElement;
      root.style.setProperty('--safe-area-inset-top', '24px');
      root.style.setProperty('--safe-area-inset-right', '18px');
      root.style.setProperty('--safe-area-inset-bottom', '28px');
      root.style.setProperty('--safe-area-inset-left', '16px');
    };
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
}

test('restores the authenticated production gallery offline without write or secret leakage', async ({
  page,
  request,
}) => {
  const runId = randomUUID();
  const prompt = `PR7 offline gallery ${runId}`;
  const draftPrompt = `${prompt} with an unfinished edit`;
  let jobId: string | null = null;
  let detail: JobDetailResponse | null = null;
  let offlinePage: Page | null = null;
  const context = page.context();
  const requests: Array<{ readonly method: string; readonly path: string }> = [];
  try {
    jobId = await createMockImageJob(request, prompt);
    detail = await waitForCompletedJob(request, jobId);
    const asset = detail.assets[0];
    if (!asset || asset.thumbnailUrl === null) {
      throw new Error('The completed Mock image did not include a thumbnail.');
    }
    const thumbnailUrl = asset.thumbnailUrl;
    const thumbnail = await request.get(thumbnailUrl);
    expect(thumbnail.status()).toBe(200);
    expect(thumbnail.headers()['content-type']).toMatch(/^image\//u);

    await waitForAppShell(page);
    await ensureServiceWorkerControl(page);
    const card = page.locator(`[data-item-id="${asset.id}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('img.media-card-image')).toHaveAttribute('src', thumbnailUrl);
    await expect(card.locator('img.media-card-image')).toHaveJSProperty('complete', true);
    await page.getByRole('textbox', { name: 'Prompt' }).fill(draftPrompt);

    await expect.poll(
      () => page.evaluate((key) => window.localStorage.getItem(key), COMPOSER_DRAFT_KEY),
      { timeout: 10_000 },
    ).toContain(draftPrompt);
    await expect.poll(
      async () => {
        const serialized = await readOfflineSnapshot(page);
        if (serialized === null) return false;
        try {
          const snapshot = JSON.parse(serialized) as { readonly items?: readonly { readonly id?: string }[] };
          return snapshot.items?.some((item) => item.id === asset.id) ?? false;
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    ).toBe(true);
    await expect.poll(
      () => page.evaluate(async ({ cacheName, url }) => {
        const cache = await caches.open(cacheName);
        return (await cache.match(new URL(url, location.origin).href)) !== undefined;
      }, { cacheName: DERIVED_MEDIA_CACHE_NAME, url: thumbnailUrl }),
      { timeout: 15_000 },
    ).toBe(true);

    await page.close();
    offlinePage = await context.newPage();
    offlinePage.on('request', (request) => {
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });
    });
    await context.setOffline(true);
    await offlinePage.goto('/imagine', { waitUntil: 'domcontentloaded' });
    await expect(offlinePage.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
    await dismissPwaNotice(offlinePage);
    await expect(offlinePage.locator('.network-banner--offline')).toBeVisible();
    await expect(offlinePage.getByRole('textbox', { name: 'Prompt' })).toHaveValue(draftPrompt);
    const restoredCard = offlinePage.locator(`[data-item-id="${asset.id}"]`);
    await expect(restoredCard).toBeVisible({ timeout: 30_000 });
    await expect(restoredCard.locator('img.media-card-image')).toHaveAttribute('src', thumbnailUrl);
    await expect(restoredCard.locator('img.media-card-image')).toHaveJSProperty('complete', true);

    const jobsPostsBeforeInput = requests.filter(
      ({ method, path }) => method === 'POST' && path === '/internal/jobs',
    ).length;
    const generate = offlinePage.getByRole('button', { name: /Generate|Unavailable offline/u }).last();
    await expect(generate).toBeDisabled();
    await generate.evaluate((button) => (button as HTMLButtonElement).click());
    await offlinePage.getByRole('textbox', { name: 'Prompt' }).press('Control+Enter');
    await offlinePage.getByRole('textbox', { name: 'Prompt' }).press('Meta+Enter');
    await expect.poll(
      () => requests.filter(({ method, path }) => method === 'POST' && path === '/internal/jobs').length,
      { timeout: 2_000 },
    ).toBe(jobsPostsBeforeInput);

    const serializations = await readBrowserSerializations(offlinePage);
    const serialized = JSON.stringify(serializations);
    expect(serialized).not.toMatch(FORBIDDEN_SERIALIZED_SECRET);
    expect(serializations.cacheEntries.some(({ cacheName }) => cacheName === DERIVED_MEDIA_CACHE_NAME)).toBe(true);

    const authRequestsBeforeOnline = requests.filter(({ method, path }) =>
      method === 'GET' && path === '/internal/auth/status',
    ).length;
    const jobsRequestsBeforeOnline = requests.filter(({ method, path }) =>
      method === 'GET' && path === '/internal/jobs',
    ).length;
    await context.setOffline(false);
    await expect.poll(() => offlinePage!.evaluate(() => navigator.onLine), { timeout: 10_000 }).toBe(true);
    await expect(offlinePage.locator('.network-banner--online')).toBeVisible({ timeout: 10_000 });
    // Chromium can update navigator.onLine before delivering the page event
    // when the page was opened while offline; replay the browser lifecycle
    // signal once the context is online so auth and query retry handlers run.
    await offlinePage.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(
      () => requests.filter(({ method, path }) => method === 'GET' && path === '/internal/auth/status').length,
      { timeout: 15_000 },
    ).toBeGreaterThan(authRequestsBeforeOnline);
    await expect.poll(
      () => requests.filter(({ method, path }) => method === 'GET' && path === '/internal/jobs').length,
      { timeout: 15_000 },
    ).toBeGreaterThan(jobsRequestsBeforeOnline);
    await expect(restoredCard).toBeVisible();
    await assertNoHorizontalOverflow(offlinePage);
  } finally {
    await context.setOffline(false).catch(() => undefined);
    if (offlinePage !== null && !offlinePage.isClosed()) await offlinePage.close().catch(() => undefined);
    if (jobId !== null) {
      if (detail !== null) await deleteJobAndAssets(request, jobId, detail.assets);
      else {
        const cleanup = await request.get(`/internal/jobs/${encodeURIComponent(jobId)}`);
        if (cleanup.ok()) {
          const cleanupDetail = await cleanup.json() as JobDetailResponse;
          await deleteJobAndAssets(request, jobId, cleanupDetail.assets);
        }
      }
    }
  }
});

test('fails closed when an unknown offline marker has no gallery snapshot', async ({ page }) => {
  await waitForAppShell(page);
  await ensureServiceWorkerControl(page);
  await setUnknownOfflineMarker(page);
  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(page.getByText('Access check unavailable', { exact: true })).toBeVisible({ timeout: 15_000 });
  } finally {
    await page.context().setOffline(false);
  }
});

test('keeps the install CTA and standalone state semantically distinct', async ({ page }) => {
  await installStandaloneMediaQueryMock(page);
  await waitForAppShell(page, '/settings/pwa');
  const displayMode = page.locator('.setting-row').filter({ hasText: 'Display mode' });
  const installStatus = page.locator('.setting-row').filter({ hasText: 'Install status' });
  await expect(displayMode).toContainText('Browser');
  await expect(installStatus).toContainText('Unavailable');

  const eventResult = await page.evaluate(() => {
    let promptCalls = 0;
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.defineProperties(event, {
      platforms: { value: ['web'] },
      prompt: { value: async () => { promptCalls += 1; } },
      userChoice: { value: Promise.resolve({ outcome: 'accepted', platform: 'web' }) },
    });
    Object.defineProperty(window, '__pr7InstallPromptCalls', {
      configurable: true,
      value: () => promptCalls,
    });
    const dispatchResult = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatchResult };
  });
  expect(eventResult.defaultPrevented).toBe(true);
  expect(eventResult.dispatchResult).toBe(false);
  await expect(installStatus).toContainText('Ready');
  const install = page.getByRole('button', { name: 'Install app', exact: true });
  await expect(install).toBeVisible();
  await install.click();
  await expect.poll(() => page.evaluate(() => {
    const getter = (window as Window & { __pr7InstallPromptCalls?: () => number }).__pr7InstallPromptCalls;
    return getter?.() ?? 0;
  })).toBe(1);
  await expect(install).toBeHidden();
  await expect(installStatus).toContainText('Installed');

  await page.evaluate(() => {
    const setter = (window as Window & { __pr7SetStandalone?: (value: boolean) => void }).__pr7SetStandalone;
    setter?.(true);
  });
  await expect(displayMode).toContainText('Standalone');
  await expect(installStatus).toContainText('Installed');
  await assertNoHorizontalOverflow(page);
});

test('keeps offline App settings, update state, and touch layout inside every viewport', async ({
  page,
}, testInfo) => {
  await waitForAppShell(page, '/settings/pwa');
  await expect(page.getByRole('heading', { name: 'App', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Installation', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Updates', exact: true })).toBeVisible();
  await expect(page.locator('.setting-row').filter({ hasText: 'Application update' })).toContainText('Current');
  await assertNoHorizontalOverflow(page);

  await page.context().setOffline(true);
  try {
    await expect(page.locator('.network-banner--offline')).toBeVisible();
    await expect(page.locator('.setting-row').filter({ hasText: 'Network' })).toContainText('Offline');
    await expect(page.locator('.setting-row').filter({ hasText: 'Application update' })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('A fixed viewport is required for PR7 Settings checks.');
    const settings = await page.locator('.settings-page').boundingBox();
    if (!settings) throw new Error('The Settings page has no measurable box.');
    expect(settings.x).toBeGreaterThanOrEqual(0);
    expect(settings.x + settings.width).toBeLessThanOrEqual(viewport.width + 1);
    if (viewport.width <= 720) {
      await expect(page.locator('.mobile-header')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
    }
  } finally {
    await page.context().setOffline(false);
  }
  await capturePr7Screenshot(page, testInfo);
});

test('keeps Gallery long-press selection deterministic across touch and keyboard entry points', async ({
  page,
}, testInfo) => {
  test.skip(!/(mobile|tablet)/u.test(testInfo.project.name), 'Touch coverage runs in touch-enabled PR7 projects.');
  await page.addInitScript(() => {
    window.sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
  await waitForAppShell(page);

  const card = page.locator('[data-item-id="image-03"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-describedby', /media-card-status-image-03/u);
  await expect(card.locator('.media-card-status')).toContainText('Task status: completed.');
  await expect(card.locator('.media-card-status')).toContainText('Progress: 100%.');

  const viewport = page.viewportSize();
  const isCoarseTablet = viewport?.width === 834 || viewport?.width === 1024;
  if (isCoarseTablet) {
    const cardActions = card.locator('.media-card-actions');
    await expect(cardActions).toBeVisible();
    await expect(cardActions.getByRole('button', { name: 'Card actions', exact: true })).toBeVisible();
    await expect.poll(() => cardActions.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    expect(await cardActions.locator('.desktop-card-action').evaluateAll((buttons) =>
      buttons.every((button) => getComputedStyle(button).display === 'none'))).toBe(true);
    await expect(page.locator('.card-actions-popover')).toHaveCount(0);
  }

  await dispatchTouchSequence(page, card, 100);
  await closeViewerIfOpen(page);
  await expect(card).not.toHaveClass(/is-selected/u);

  await dispatchTouchSequence(page, card, 520, { contextmenu: true });
  await expect(card).toHaveClass(/is-selected/u);
  await expect(page.getByTestId('gallery-selection-announcement')).toContainText(/Selected/u);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();

  await dispatchTouchSequence(page, card, 700);
  await expect(card).toHaveClass(/is-selected/u);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await captureGalleryInteractionScreenshot(page, testInfo, 'selection');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();

  await dispatchTouchSequence(page, card, 700, { move: { x: 24, y: 0 } });
  await closeViewerIfOpen(page);
  await expect(card).not.toHaveClass(/is-selected/u);

  await dispatchTouchSequence(page, card, 700, { scroll: true });
  await closeViewerIfOpen(page);
  await expect(card).not.toHaveClass(/is-selected/u);
  await page.locator('.page-scroll').evaluate((element) => { element.scrollTop = 0; });

  const selectionToggle = card.locator('.selection-toggle');
  await selectionToggle.focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveClass(/is-selected/u);
  await page.keyboard.press('Space');
  await expect(card).not.toHaveClass(/is-selected/u);

  const menuTrigger = card.getByRole('button', { name: 'Card actions', exact: true });
  if (await menuTrigger.isVisible()) {
    await menuTrigger.click();
    const menu = page.locator('.card-actions-popover');
    await expect(menu).toBeVisible();
    await captureGalleryInteractionScreenshot(page, testInfo, 'menu');
    await menu.getByRole('button', { name: /^Select /u }).click();
    await expect(card).toHaveClass(/is-selected/u);
    await page.keyboard.press('Escape');
    await expect(page.locator('.card-actions-popover')).toHaveCount(0);
  }
});

test('captures a stable PR7 responsive workspace state at every required viewport', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
  await waitForAppShell(page);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();
  await expect(page.locator('[aria-label="Media gallery"]')).toBeVisible();
  await assertViewportLayout(page);
  await capturePr7Screenshot(page, testInfo);
});

test('keeps Viewer gestures bounded while preserving keyboard and button navigation', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
  await waitForAppShell(page);

  const trigger = page.locator('.media-card-open').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.viewer-metadata')).toContainText('Provider');
  await expect(page.locator('.viewer-metadata')).toContainText('Model');
  await expect(page.locator('.viewer-metadata')).toContainText('Size');
  await expect(page.locator('.viewer-metadata')).toContainText('Time');
  await captureViewerScreenshot(page, testInfo, 'image-viewer');

  const navigationButtons = page.locator('.viewer-nav');
  await expect(navigationButtons).toHaveCount(2);
  for (const button of await navigationButtons.all()) {
    const box = await button.boundingBox();
    if (!box) throw new Error('Viewer navigation buttons must have measurable boxes.');
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  const stage = page.locator('.viewer-stage');
  const stageBox = await stage.boundingBox();
  if (!stageBox) throw new Error('Viewer stage must have a measurable box.');
  const centerX = stageBox.x + stageBox.width / 2;
  const centerY = stageBox.y + stageBox.height / 2;
  const counter = page.locator('.viewer-counter');
  const counterBeforePinch = (await counter.textContent())?.trim();
  expect(counterBeforePinch).toBeTruthy();

  type TouchPoint = { readonly id: number; readonly x: number; readonly y: number };
  const cdp = await page.context().newCDPSession(page);
  const dispatchTouch = async (
    type: 'touchCancel' | 'touchEnd' | 'touchMove' | 'touchStart',
    touchPoints: readonly TouchPoint[],
  ) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: touchPoints.map((touchPoint) => ({
        ...touchPoint,
        force: 1,
        radiusX: 1,
        radiusY: 1,
      })),
    });
  };
  const tap = async (id: number, x = centerX, y = centerY) => {
    await dispatchTouch('touchStart', [{ id, x, y }]);
    await dispatchTouch('touchEnd', []);
  };

  try {
    await tap(1, centerX - 40, centerY);
    await tap(2, centerX - 40, centerY);
    await expect(stage).toHaveAttribute('data-viewer-scale', '2');
    await page.waitForTimeout(360);
    await tap(3, centerX - 40, centerY);
    await expect(stage).toHaveAttribute('data-viewer-scale', '2');
    await page.waitForTimeout(360);
    await tap(4, centerX - 40, centerY);
    await expect(stage).toHaveAttribute('data-viewer-scale', '2');
    await tap(5, centerX - 40, centerY);
    await expect(stage).toHaveAttribute('data-viewer-scale', '1');

    const pinchPoints = [
      { id: 6, x: centerX - 60, y: centerY },
      { id: 7, x: centerX + 60, y: centerY },
    ] as const;
    await dispatchTouch('touchStart', pinchPoints);
    await dispatchTouch('touchMove', [
      pinchPoints[0],
      { id: 7, x: centerX + 300, y: centerY },
    ]);
    await expect.poll(async () => Number(await stage.getAttribute('data-viewer-scale')))
      .toBeGreaterThanOrEqual(2.999);
    await expect(counter).toHaveText(counterBeforePinch!);

    await dispatchTouch('touchEnd', []);
    await dispatchTouch('touchStart', [{ id: 8, x: centerX, y: centerY }]);
    await expect(stage).toHaveAttribute('data-viewer-gesture', 'pan');
    await dispatchTouch('touchMove', [{ id: 8, x: centerX + 1000, y: centerY + 1000 }]);
    const clampedX = Number(await stage.getAttribute('data-position-x'));
    const clampedY = Number(await stage.getAttribute('data-position-y'));
    expect(Number.isFinite(clampedX)).toBe(true);
    expect(Number.isFinite(clampedY)).toBe(true);
    await dispatchTouch('touchEnd', []);

    const counterBeforeCancel = (await counter.textContent())?.trim();
    await dispatchTouch('touchStart', [{ id: 9, x: centerX, y: centerY }]);
    await dispatchTouch('touchCancel', []);
    await expect(counter).toHaveText(counterBeforeCancel!);

    await page.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await expect(stage).toHaveAttribute('data-viewer-scale', '1');
    await dispatchTouch('touchStart', [{ id: 10, x: centerX, y: centerY }]);
    await dispatchTouch('touchMove', [{ id: 10, x: centerX - 100, y: centerY }]);
    await dispatchTouch('touchEnd', []);
    await expect(counter).not.toHaveText(counterBeforePinch!);

    await page.getByRole('button', { name: 'Close viewer', exact: true }).click();
    await page.getByRole('button', { name: 'Videos', exact: true }).click();
    const videoCard = page.locator('[data-item-id="video-01"] .media-card-open');
    await expect(videoCard).toBeVisible();
    await videoCard.click();
    const videoCounter = (await counter.textContent())?.trim();
    const video = page.locator('video.viewer-media');
    await expect(video).toHaveCount(1);
    const videoBox = await video.boundingBox();
    if (!videoBox) throw new Error('Video Viewer must have a measurable media box.');
    await captureViewerScreenshot(page, testInfo, 'video-viewer');
    const videoCenterX = videoBox.x + videoBox.width / 2;
    const videoCenterY = videoBox.y + videoBox.height / 2;
    await dispatchTouch('touchStart', [{ id: 11, x: videoCenterX, y: videoCenterY }]);
    await dispatchTouch('touchMove', [{ id: 11, x: videoCenterX - 120, y: videoCenterY }]);
    await dispatchTouch('touchEnd', []);
    await expect(counter).toHaveText(videoCounter!);
    await expect(page.locator('.viewer-stage')).toHaveAttribute('data-viewer-scale', '1');
    await dispatchTouch('touchStart', [
      { id: 12, x: videoCenterX - 40, y: videoCenterY },
      { id: 13, x: videoCenterX + 40, y: videoCenterY },
    ]);
    await dispatchTouch('touchMove', [
      { id: 12, x: videoCenterX - 100, y: videoCenterY },
      { id: 13, x: videoCenterX + 100, y: videoCenterY },
    ]);
    await dispatchTouch('touchEnd', []);
    await expect(counter).toHaveText(videoCounter!);
    await expect(page.locator('.viewer-stage')).toHaveAttribute('data-viewer-scale', '1');
  } finally {
    await cdp.detach();
  }
});

test('keeps the mobile Composer inside safe areas while the visual viewport opens and closes the keyboard', async ({
  page,
}, testInfo) => {
  test.skip((page.viewportSize()?.width ?? 0) > 720, 'The visual viewport keyboard geometry runs on mobile.');
  await installVisualViewportMock(page);
  await installSafeAreaMock(page);
  await page.addInitScript(() => {
    window.sessionStorage.setItem('imagine.visual-fixtures', 'pr1-v1');
  });
  await waitForAppShell(page);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeVisible();

  const initial = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const header = document.querySelector('.mobile-header')?.getBoundingClientRect();
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      composer,
      header,
      safeBottom: root.getPropertyValue('--safe-area-bottom').trim(),
      safeLeft: root.getPropertyValue('--safe-area-left').trim(),
      safeRight: root.getPropertyValue('--safe-area-right').trim(),
      safeTop: root.getPropertyValue('--safe-area-top').trim(),
      headerPaddingTop: getComputedStyle(document.querySelector('.mobile-header')!).paddingTop,
    };
  });
  expect(initial.safeTop).toBe('24px');
  expect(initial.safeRight).toBe('18px');
  expect(initial.safeBottom).toBe('28px');
  expect(initial.safeLeft).toBe('16px');
  expect(Number.parseFloat(initial.headerPaddingTop)).toBeGreaterThanOrEqual(24);
  if (!initial.composer || !initial.header) throw new Error('Mobile shell geometry is unavailable.');
  expect(initial.composer.x).toBeGreaterThanOrEqual(16);
  expect(initial.composer.x + initial.composer.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) - 18 + 1);
  expect(initial.composer.y + initial.composer.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - 28 + 1);

  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const menu = await page.locator('.mobile-menu-content').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      box: element.getBoundingClientRect(),
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      paddingTop: style.paddingTop,
    };
  });
  expect(Number.parseFloat(menu.paddingTop)).toBeGreaterThanOrEqual(24);
  expect(Number.parseFloat(menu.paddingRight)).toBeGreaterThanOrEqual(18);
  expect(Number.parseFloat(menu.paddingBottom)).toBeGreaterThanOrEqual(28);
  expect(Number.parseFloat(menu.paddingLeft)).toBeGreaterThanOrEqual(16);
  await page.keyboard.press('Escape');

  const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await prompt.evaluate((element) => (element as HTMLTextAreaElement).focus({ preventScroll: true }));
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')).toBe('Prompt');

  const scrollBefore = await page.locator('.page-scroll').evaluate((element) => {
    element.scrollTop = Math.min(48, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  const keyboard = await page.evaluate(() => {
    const viewport = window.visualViewport as unknown as {
      setMetrics?: (next: { height: number; width: number; offsetLeft: number; offsetTop: number }) => void;
    };
    viewport.setMetrics?.({
      height: window.innerHeight - 260,
      width: window.innerWidth - 16,
      offsetLeft: 8,
      offsetTop: 12,
    });
    return {
      height: window.innerHeight - 260,
      keyboardOffset: 248,
      offsetLeft: 8,
      offsetTop: 12,
    };
  });
  await expect.poll(() => page.evaluate(() => ({
    height: getComputedStyle(document.documentElement).getPropertyValue('--visual-viewport-height').trim(),
    keyboardOffset: getComputedStyle(document.documentElement).getPropertyValue('--keyboard-offset').trim(),
    left: getComputedStyle(document.documentElement).getPropertyValue('--visual-viewport-offset-left').trim(),
    open: getComputedStyle(document.documentElement).getPropertyValue('--keyboard-open').trim(),
    top: getComputedStyle(document.documentElement).getPropertyValue('--visual-viewport-offset-top').trim(),
  }))).toEqual({
    height: `${keyboard.height}px`,
    keyboardOffset: `${keyboard.keyboardOffset}px`,
    left: `${keyboard.offsetLeft}px`,
    open: '1',
    top: `${keyboard.offsetTop}px`,
  });
  const keyboardGeometry = await page.evaluate(() => {
    const viewport = window.visualViewport!;
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    const prompt = document.querySelector('textarea[aria-label="Prompt"]')?.getBoundingClientRect();
    const generate = document.querySelector('button[aria-label="Generate"]')?.getBoundingClientRect();
    return {
      composer,
      generate,
      prompt,
      viewportBottom: viewport.offsetTop + viewport.height,
      viewportTop: viewport.offsetTop,
    };
  });
  for (const box of [keyboardGeometry.composer, keyboardGeometry.prompt, keyboardGeometry.generate]) {
    if (!box) throw new Error('Keyboard geometry is unavailable.');
    expect(box.y).toBeGreaterThanOrEqual(keyboardGeometry.viewportTop - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(keyboardGeometry.viewportBottom + 1);
  }
  await capturePr7KeyboardMockScreenshot(page, testInfo);
  expect(await page.locator('.page-scroll').evaluate((element) => element.scrollTop)).toBe(scrollBefore);

  await page.evaluate(() => {
    const viewport = window.visualViewport as unknown as {
      setMetrics?: (next: { height: number; width: number; offsetLeft: number; offsetTop: number }) => void;
    };
    viewport.setMetrics?.({
      height: window.innerHeight,
      width: window.innerWidth,
      offsetLeft: 0,
      offsetTop: 0,
    });
  });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--keyboard-open').trim())).toBe('0');
  const restored = await page.locator('.composer').boundingBox();
  if (!restored) throw new Error('The Composer has no measurable box after keyboard close.');
  expect(restored.y + restored.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - 28 + 1);
});
