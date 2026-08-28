import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
      return;
    }
    await page.waitForTimeout(200);
  }
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
    '# PR7 visual diff report\n\nScreenshots are captured at the approved PR7 viewports with animations disabled. The responsive gallery state uses the fixed PR1 Mock fixture; the production cold-offline and unknown-marker checks run at every PR7 viewport. No pixel comparison was run locally.\n\n| Viewport | State | Baseline / diff |\n| --- | --- | --- |\n| desktop-1920x1080 | gallery | CI artifact only |\n| desktop-1440x900 | gallery | CI artifact only |\n| desktop-1280x800 | gallery | CI artifact only |\n| tablet-1024x1366 | gallery | CI artifact only |\n| tablet-834x1194 | gallery | CI artifact only |\n| mobile-430x932 | gallery | CI artifact only |\n| mobile-390x844 | gallery | CI artifact only |\n| mobile-360x800 | gallery | CI artifact only |\n',
    'utf8',
  );
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, `${testInfo.project.name.replace(/^pr7-/, '')}.png`),
  });
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
