import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CustomAdapterDefinitionResponseSchema,
  CustomAdapterErrorResponseSchema,
  CustomAdapterExportEnvelopeSchema,
  CustomAdapterRevisionListResponseSchema,
  TrustedAdapterResponseSchema,
  type TrustedAdapterResponse,
} from '../packages/shared/src/internal-api.js';
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from './fixtures.js';

import { E2E_PASSWORD, basicAuthorizationHeader } from './runtime.js';

test.setTimeout(120_000);
test.describe.configure({ mode: 'serial' });

const SOURCE_PATH = resolve('apps/server/src/providers/custom-js/fixtures/trusted-fixture.mjs');
const MANIFEST_PATH = resolve('apps/server/src/providers/custom-js/fixtures/trusted-fixture-manifest.json');
const FULL_HTTP_PROJECTS = new Set(['pr6-desktop-1440x900', 'pr6-mobile-390x844']);
const TRUSTED_PROJECTS = new Set([
  'pr6-desktop-1280x800',
  'pr6-tablet-834x1112',
  'pr6-mobile-430x932',
]);
const SCREENSHOT_PROJECTS = new Set([
  'pr6-desktop-1920x1080',
  'pr6-desktop-1440x900',
  'pr6-desktop-1280x800',
  'pr6-tablet-1024x1366',
  'pr6-tablet-834x1112',
  'pr6-mobile-430x932',
  'pr6-mobile-390x844',
  'pr6-mobile-360x800',
]);
const API_SECRET = 'pr6-api-key-not-rendered';
const PROFILE_PROVIDER_NAME = 'PR6 UI Custom';
const RESPONSIVE_PROVIDER_NAME = 'PR6 Responsive';
const HTTP_PROVIDER_NAME = 'PR6 Custom HTTP';
const TRUSTED_PROVIDER_NAME = 'PR6 Trusted JS';
const TRUSTED_ADAPTER_ID = 'pr6-trusted-fixture';
const TRUSTED_DISPLAY_NAME = 'PR6 Trusted Fixture';
const SCREENSHOT_NAMES: Readonly<Record<string, string>> = {
  'pr6-desktop-1920x1080': 'desktop-1920x1080.png',
  'pr6-desktop-1440x900': 'desktop-1440x900.png',
  'pr6-desktop-1280x800': 'desktop-1280x800.png',
  'pr6-tablet-1024x1366': 'tablet-1024x1366.png',
  'pr6-tablet-834x1112': 'tablet-834x1112.png',
  'pr6-mobile-430x932': 'mobile-430x932.png',
  'pr6-mobile-390x844': 'mobile-390x844.png',
  'pr6-mobile-360x800': 'mobile-360x800.png',
};

const CUSTOM_HTTP_SPEC = {
  schemaVersion: 1,
  id: 'pr6-safe-sync-image',
  name: 'PR6 Safe Sync Image',
  operations: ['image.generate'],
  models: [{
    id: 'pr6-image-model',
    displayName: 'PR6 Image Model',
    capabilities: {
      operations: ['image.generate'],
      supportsBatchCount: false,
      maxBatchCount: 1,
    },
  }],
  submit: {
    method: 'POST',
    path: '/v1/images',
    auth: { type: 'bearer', secretRef: 'apiKey', location: 'header' },
    body: {
      type: 'json',
      value: {
        model: '{{ request.modelId }}',
        prompt: '{{ request.prompt }}',
      },
    },
    expectedStatus: [200],
    extract: {
      resultBase64Path: '/data/0/b64_json',
      resultMimeType: 'image/png',
      resultType: 'image',
      resultIdPath: '/data/0/id',
    },
  },
} as const;

interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface AdapterRef {
  readonly kind: 'declarative-http' | 'trusted-javascript';
  readonly adapterId: string;
  readonly version: string;
  readonly digest: string;
}

interface AdapterDefinitionResponse {
  readonly definition: { readonly ref: AdapterRef };
}

interface TrustedManifest extends Record<string, unknown> {
  id: string;
  displayName: string;
  sha256: string;
}

interface HttpFixture {
  readonly jsonEnvelope: string;
  readonly yamlEnvelope: string;
  readonly initialRef: AdapterRef;
  readonly provider: ProviderRecord;
}

interface CleanupTask {
  readonly label: string;
  readonly run: () => Promise<void>;
}

function executionKey(testInfo: TestInfo): string {
  return `${testInfo.project.name}-retry-${testInfo.retry}`;
}

function scopedProviderName(baseName: string, testInfo: TestInfo): string {
  return `${baseName} [${executionKey(testInfo)}]`;
}

function scopedTrustedAdapterId(baseId: string, testInfo: TestInfo): string {
  return `${baseId}-${testInfo.project.name}-r${testInfo.retry}`;
}

async function finalizeTestCleanup(
  testFailed: boolean,
  testError: unknown,
  tasks: readonly CleanupTask[],
): Promise<void> {
  const cleanupErrors: Error[] = [];
  for (const task of tasks) {
    try {
      await task.run();
    } catch (error) {
      cleanupErrors.push(new Error(`Cleanup failed: ${task.label}`, { cause: error }));
    }
  }

  if (testFailed) {
    if (cleanupErrors.length === 0) throw testError;
    throw new AggregateError(
      [testError, ...cleanupErrors],
      'The PR6 test failed and one or more cleanup tasks also failed.',
      { cause: testError },
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'One or more PR6 cleanup tasks failed.');
  }
}

function authHeaders(): Readonly<Record<string, string>> {
  return { Authorization: basicAuthorizationHeader() };
}

async function loginIfRequired(page: Page): Promise<void> {
  const password = page.locator('input[name="password"]');
  if (await password.isVisible({ timeout: 2_000 }).catch(() => false)) {
    if (E2E_PASSWORD.length === 0) throw new Error('The E2E server requires a password, but none is configured.');
    await password.fill(E2E_PASSWORD);
    await page.getByRole('button', { name: 'Unlock workspace', exact: true }).click();
  }
}

async function gotoProviders(page: Page): Promise<void> {
  await page.goto('/settings/providers');
  await loginIfRequired(page);
  await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
}

async function createProvider(
  request: APIRequestContext,
  type: 'custom-http-v1' | 'custom-js-v1',
  name: string,
  baseUrl: string | null,
): Promise<ProviderRecord> {
  const response = await request.post('/internal/providers', {
    data: {
      name,
      type,
      baseUrl,
      ...(type === 'custom-http-v1' ? { apiKey: API_SECRET } : {}),
      config: {},
      enabled: true,
      isDefault: false,
    },
    headers: authHeaders(),
  });
  expect(response.status()).toBe(201);
  const body = await response.json() as { readonly provider: ProviderRecord };
  expect(body.provider).toMatchObject({ name, type });
  return body.provider;
}

async function getProviderByName(
  request: APIRequestContext,
  name: string,
): Promise<ProviderRecord> {
  const listResponse = await request.get('/internal/providers?limit=100', {
    headers: authHeaders(),
  });
  expect(listResponse.status()).toBe(200);
  const list = await listResponse.json() as {
    readonly items: readonly ProviderRecord[];
    readonly nextCursor?: string | null;
  };
  const matches = list.items.filter((provider) => provider.name === name);
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (match === undefined) throw new Error(`Provider ${name} was not found after creation.`);

  const getResponse = await request.get(`/internal/providers/${encodeURIComponent(match.id)}`, {
    headers: authHeaders(),
  });
  expect(getResponse.status()).toBe(200);
  const body = await getResponse.json() as { readonly provider: ProviderRecord };
  expect(body.provider).toMatchObject({ id: match.id, name });
  return body.provider;
}

async function putCustomSpec(
  request: APIRequestContext,
  providerId: string,
  version: string,
): Promise<AdapterRef> {
  const response = await request.put(
    `/internal/providers/${encodeURIComponent(providerId)}/adapter?version=${encodeURIComponent(version)}`,
    {
      data: JSON.stringify(CUSTOM_HTTP_SPEC),
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
    },
  );
  expect(response.status()).toBe(200);
  const body = await response.json() as AdapterDefinitionResponse;
  expect(body.definition.ref.version).toBe(version);
  return body.definition.ref;
}

async function getCurrentCustomAdapter(
  request: APIRequestContext,
  providerId: string,
): Promise<AdapterDefinitionResponse> {
  const response = await request.get(
    `/internal/providers/${encodeURIComponent(providerId)}/adapter`,
    { headers: authHeaders() },
  );
  expect(response.status()).toBe(200);
  return CustomAdapterDefinitionResponseSchema.parse(await response.json());
}

async function getExactCustomAdapter(
  request: APIRequestContext,
  providerId: string,
  ref: AdapterRef,
): Promise<AdapterDefinitionResponse> {
  const query = new URLSearchParams({
    kind: ref.kind,
    adapterId: ref.adapterId,
    version: ref.version,
    digest: ref.digest,
    limit: '1',
  });
  const response = await request.get(
    `/internal/providers/${encodeURIComponent(providerId)}/adapter/revisions?${query.toString()}`,
    { headers: authHeaders() },
  );
  expect(response.status()).toBe(200);
  const body = CustomAdapterRevisionListResponseSchema.parse(await response.json());
  expect(body.items).toHaveLength(1);
  const definition = body.items[0];
  if (definition === undefined) throw new Error('The exact adapter revision was not returned.');
  return { definition };
}

async function exportEnvelope(
  request: APIRequestContext,
  providerId: string,
  format: 'json' | 'yaml',
  ref?: AdapterRef,
): Promise<string> {
  const query = new URLSearchParams({ format });
  if (ref !== undefined) {
    query.set('kind', ref.kind);
    query.set('adapterId', ref.adapterId);
    query.set('version', ref.version);
    query.set('digest', ref.digest);
  }
  const response = await request.get(
    `/internal/providers/${encodeURIComponent(providerId)}/adapter/export?${query.toString()}`,
    { headers: authHeaders() },
  );
  expect(response.status()).toBe(200);
  expect(response.headers()['content-disposition']).toContain(`adapter-${CUSTOM_HTTP_SPEC.id}`);
  return response.text();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function prepareHttpFixture(
  request: APIRequestContext,
  testInfo: TestInfo,
): Promise<HttpFixture> {
  let provider: ProviderRecord | null = null;
  try {
    provider = await createProvider(
      request,
      'custom-http-v1',
      scopedProviderName(HTTP_PROVIDER_NAME, testInfo),
      'https://api.example.test/v1',
    );
    const initialRef = await putCustomSpec(request, provider.id, '1.0.0');
    const jsonEnvelope = await exportEnvelope(request, provider.id, 'json', initialRef);
    const yamlEnvelope = await exportEnvelope(request, provider.id, 'yaml', initialRef);
    const parsedEnvelope = CustomAdapterExportEnvelopeSchema.parse(JSON.parse(jsonEnvelope));
    expect(parsedEnvelope).toMatchObject({
      schemaVersion: 1,
      version: '1.0.0',
      definition: { id: CUSTOM_HTTP_SPEC.id },
    });
    const canonical = canonicalJson(parsedEnvelope.definition);
    expect(createHash('sha256').update(canonical, 'utf8').digest('hex')).toBe(initialRef.digest);
    expect(yamlEnvelope).toContain('schemaVersion: 1');
    expect(yamlEnvelope).toContain('version: 1.0.0');

    // Keep enough immutable revisions to exercise the real cursor and the UI's
    // load-more path without sharing state between parallel browser projects.
    for (let index = 10; index < 60; index += 1) {
      await putCustomSpec(request, provider.id, `1.0.${index}`);
    }
    return { initialRef, jsonEnvelope, provider, yamlEnvelope };
  } catch (error) {
    await finalizeTestCleanup(true, error, [{
      label: 'remove partially prepared HTTP provider',
      run: async () => {
        if (provider !== null) await removeProvider(request, provider.id);
      },
    }]);
    throw error; // Unreachable: finalizeTestCleanup rethrows the setup failure.
  }
}

async function removeProvider(request: APIRequestContext, providerId: string): Promise<void> {
  const response = await request.delete(`/internal/providers/${encodeURIComponent(providerId)}`, {
    headers: authHeaders(),
  });
  expect([204, 404]).toContain(response.status());
}

async function removeTrustedAdapter(request: APIRequestContext, adapterId: string): Promise<void> {
  const response = await request.delete(`/internal/adapters/${encodeURIComponent(adapterId)}`, {
    headers: authHeaders(),
  });
  expect([204, 404]).toContain(response.status());
}

async function openWorkspace(page: Page, provider: ProviderRecord) {
  const card = page.locator('.provider-card').filter({ hasText: provider.name });
  await expect(card).toBeVisible();
  const manage = card.getByRole('button', {
    name: `Manage adapter for ${provider.name}`,
    exact: true,
  });
  await manage.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('custom-adapter-workspace')).toBeVisible();
  return { card, dialog, manage };
}

async function assertWorkspaceGeometry(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  const dialog = page.locator('.custom-adapter-dialog-content');
  const body = page.locator('.custom-adapter-dialog-body');
  if (viewport === null) throw new Error('A fixed viewport is required for PR6 visual checks.');
  const dialogBox = await dialog.boundingBox();
  if (dialogBox === null) throw new Error('The adapter dialog has no measurable box.');
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.y).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 1);

  const scrollGeometry = await body.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(scrollGeometry.scrollHeight).toBeGreaterThan(scrollGeometry.clientHeight);

  const smallButtons = await page.locator('.custom-adapter-dialog-content button:visible').evaluateAll((buttons) =>
    buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { height: box.height, label: button.getAttribute('aria-label'), width: box.width };
    }).filter(({ height, width }) => height < 44 || width < 44),
  );
  expect(smallButtons).toEqual([]);

  const revisionSection = page.locator('section[aria-labelledby="adapter-revisions-heading"]');
  const wrapping = await revisionSection.evaluate((section) => {
    const candidate = Array.from(section.querySelectorAll('span')).find((element) => /[a-f0-9]{64}/u.test(element.textContent ?? ''));
    if (candidate === undefined) return null;
    const box = candidate.getBoundingClientRect();
    const parent = section.getBoundingClientRect();
    return {
      overflowWrap: getComputedStyle(candidate).overflowWrap,
      right: box.right,
      sectionRight: parent.right,
    };
  });
  expect(wrapping).not.toBeNull();
  expect(wrapping?.overflowWrap).toMatch(/anywhere|break-word/u);
  expect(wrapping?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((wrapping?.sectionRight ?? 0) + 1);

  if (viewport.width <= 720) {
    const mobileHeader = page.locator('.custom-adapter-dialog-header');
    const mobileFooter = page.locator('.custom-adapter-dialog-footer');
    const style = await dialog.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        bottom: computed.bottom,
        position: computed.position,
        topLeftRadius: computed.borderTopLeftRadius,
      };
    });
    expect(style.position).toBe('fixed');
    expect(style.bottom).toBe('0px');
    expect(style.topLeftRadius).not.toBe('0px');
    await body.evaluate((element) => { element.scrollTop = 280; });
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const headerBox = await mobileHeader.boundingBox();
    const footerBox = await mobileFooter.boundingBox();
    if (headerBox === null || footerBox === null) throw new Error('Mobile adapter chrome has no measurable box.');
    expect(headerBox.y).toBeGreaterThanOrEqual(0);
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewport.height + 1);
    await body.evaluate((element) => { element.scrollTop = 0; });
  }
}

async function capturePr6Screenshot(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  if (!SCREENSHOT_PROJECTS.has(testInfo.project.name)) return;
  const directory = resolve('artifacts/visual/pr6');
  await mkdir(directory, { recursive: true });
  const viewportName = SCREENSHOT_NAMES[testInfo.project.name];
  if (viewportName === undefined) throw new Error(`No PR6 screenshot filename is registered for ${testInfo.project.name}.`);
  const filename = state === 'responsive' ? viewportName : `${state}-${viewportName}`;
  const dynamicProviderIdentifier = page.locator('input[aria-label="Provider id for trusted adapter"]');
  const mask = await dynamicProviderIdentifier.count() > 0 ? [dynamicProviderIdentifier] : [];
  await page.screenshot({
    animations: 'disabled',
    mask: mask as Locator[],
    maskColor: '#ffffff',
    path: resolve(directory, filename),
  });
}

async function runWorkspaceAction(
  page: Page,
  workspace: ReturnType<Page['getByTestId']>,
  providerId: string,
  action: string,
  endpoint: string,
  completion: string,
  method = 'POST',
): Promise<void> {
  const expectedPath = endpoint === 'adapter'
    ? `/internal/providers/${encodeURIComponent(providerId)}/adapter`
    : `/internal/providers/${encodeURIComponent(providerId)}/adapter/${endpoint}`;
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === method && new URL(response.url()).pathname === expectedPath,
  );
  await workspace.getByRole('button', { name: action, exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(workspace.locator('[aria-label="Adapter command feedback"]')).toContainText(completion);
}

async function findRevisionLoadButton(revisions: Locator, ref: AdapterRef): Promise<Locator> {
  const target = revisions
    .getByText(`${ref.version} / ${ref.digest}`, { exact: true })
    .locator('..')
    .locator('..')
    .getByRole('button', { name: `Load revision ${ref.version}`, exact: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await target.count() > 0) {
      await expect(target).toHaveCount(1);
      return target;
    }
    const loadMore = revisions.getByRole('button', { name: 'Load more revisions', exact: true });
    if (await loadMore.count() === 0) break;
    await loadMore.click();
    await expect.poll(() => target.count()).toBeGreaterThan(0);
  }
  await expect(target).toHaveCount(1);
  return target;
}

async function loadExactRevision(
  page: Page,
  request: APIRequestContext,
  revisions: Locator,
  providerId: string,
  ref: AdapterRef,
): Promise<AdapterRef> {
  const expectedPath = `/internal/providers/${encodeURIComponent(providerId)}/adapter/revisions`;
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== 'GET') return false;
    const url = new URL(response.url());
    return url.pathname === expectedPath &&
      url.searchParams.get('kind') === ref.kind &&
      url.searchParams.get('adapterId') === ref.adapterId &&
      url.searchParams.get('version') === ref.version &&
      url.searchParams.get('digest') === ref.digest &&
      url.searchParams.get('limit') === '1';
  });
  const loadButton = await findRevisionLoadButton(revisions, ref);
  await loadButton.click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  // Browser Response bodies are backed by CDP and can disappear after the
  // keyed workspace remount. Read the strict response through the API client.
  const loaded = await getExactCustomAdapter(request, providerId, ref);
  expect(loaded.definition.ref).toEqual(ref);
  return loaded.definition.ref;
}

function acceptNextConfirm(page: Page): void {
  page.once('dialog', (dialog) => { void dialog.accept(); });
}

async function installTrustedFixture(
  page: Page,
  request: APIRequestContext,
  workspace: ReturnType<Page['getByTestId']>,
  manifest: TrustedManifest,
  source: Buffer,
): Promise<{ readonly installed: TrustedAdapterResponse; readonly ref: AdapterRef }> {
  await workspace.getByTestId('trusted-js-manifest').fill(JSON.stringify(manifest, null, 2));
  await workspace.locator('input[aria-label="Trusted JavaScript source file"]').setInputFiles({
    buffer: source,
    mimeType: 'text/javascript',
    name: 'trusted-fixture.mjs',
  });
  await expect(workspace.locator('input[aria-label="Trusted JavaScript source file"]')).toHaveAttribute('data-source-selected', 'true');
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && response.url().endsWith('/internal/adapters/trusted-javascript'),
  );
  await workspace.getByRole('button', { name: 'Install trusted adapter', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);

  const managementResponse = await request.get(`/internal/adapters/${encodeURIComponent(manifest.id)}`, {
    headers: authHeaders(),
  });
  expect(managementResponse.status()).toBe(200);
  const responseText = await managementResponse.text();
  expect(responseText).not.toContain('parentPort');
  expect(responseText).not.toContain(source.toString('utf8'));
  expect(responseText).not.toContain('export const capabilities');
  const installed = TrustedAdapterResponseSchema.parse(JSON.parse(responseText));
  expect(installed.adapter.ref.adapterId).toBe(manifest.id);
  expect(installed.adapter.ref.version).toBe(manifest.version);
  expect(installed.adapter.ref.digest).toBe(manifest.sha256);
  await expect(workspace).toContainText(manifest.id);
  return { installed, ref: installed.adapter.ref };
}

async function installViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = new Set<(event: Event) => void>();
    const viewport = {
      height: window.innerHeight,
      offsetTop: 0,
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
      setHeight(nextHeight: number) {
        this.height = nextHeight;
        this.dispatchEvent(new Event('resize'));
      },
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
  });
}

test('exposes both PR6 custom Provider profiles and opens Manage after creation', async ({ page, request }, testInfo) => {
  await gotoProviders(page);
  await page.getByRole('button', { name: 'Add provider', exact: true }).click();
  const editor = page.getByRole('dialog');
  const profile = editor.getByRole('combobox', { name: 'Provider profile', exact: true });
  await expect(profile.locator('option[value="custom-http-v1"]')).toHaveCount(1);
  await expect(profile.locator('option[value="custom-js-v1"]')).toHaveCount(1);
  await expect(profile.locator('option[value="custom-http-v1"]')).toHaveText('Custom HTTP Adapter');
  await expect(profile.locator('option[value="custom-js-v1"]')).toHaveText('Trusted JavaScript Adapter');
  const providerName = scopedProviderName(PROFILE_PROVIDER_NAME, testInfo);
  let providerId: string | null = null;
  let testFailed = false;
  let testError: unknown;
  try {
    await editor.getByLabel('Name', { exact: true }).fill(providerName);
    await profile.selectOption('custom-http-v1');
    await editor.getByLabel('Base URL (required)', { exact: true }).fill('https://api.example.test/v1');
    await editor.getByLabel('API key', { exact: true }).fill(API_SECRET);
    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/internal/providers',
    );
    await editor.getByRole('button', { name: 'Save provider', exact: true }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(201);
    const created = await getProviderByName(request, providerName);
    providerId = created.id;

    const workspace = page.getByTestId('custom-adapter-workspace');
    await expect(workspace).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText(providerName);
    const card = page.locator('.provider-card').filter({ hasText: providerName });
    await expect(card).toContainText('API key stored');
    await expect(page.locator('body')).not.toContainText(API_SECRET);
    await page.getByRole('dialog').locator('.custom-adapter-dialog-close').click();
    await expect(page.getByTestId('custom-adapter-workspace')).toBeHidden();
  } catch (error) {
    testFailed = true;
    testError = error;
  }
  await finalizeTestCleanup(testFailed, testError, [{
    label: 'remove UI-created custom provider',
    run: async () => {
      if (providerId !== null) await removeProvider(request, providerId);
    },
  }]);
});

test('keeps the custom adapter workspace usable across desktop, tablet, and mobile viewports', async ({
  page,
  request,
}, testInfo) => {
  await installViewportMock(page);
  const provider = await createProvider(
    request,
    'custom-http-v1',
    scopedProviderName(RESPONSIVE_PROVIDER_NAME, testInfo),
    'https://api.example.test/v1',
  );
  let testFailed = false;
  let testError: unknown;
  try {
    await putCustomSpec(request, provider.id, '1.0.0');
    await gotoProviders(page);
    const { dialog, manage } = await openWorkspace(page, provider);
    const workspace = dialog.getByTestId('custom-adapter-workspace');
    await expect(workspace.locator('section[aria-labelledby="adapter-revisions-heading"]')).toContainText(/[a-f0-9]{64}/u);
    await assertWorkspaceGeometry(page);
    await capturePr6Screenshot(page, testInfo, 'responsive');

    if ((page.viewportSize()?.width ?? 0) <= 720) {
      await page.evaluate(() => {
        const viewport = window.visualViewport as unknown as { setHeight?: (height: number) => void };
        viewport.setHeight?.(Math.max(320, window.innerHeight - 260));
      });
      const keyboardOffset = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--keyboard-offset').trim());
      expect(keyboardOffset).toBe(`${260}px`);
      const dialogBox = await page.locator('.custom-adapter-dialog-content').boundingBox();
      if (dialogBox === null) throw new Error('The mobile adapter sheet has no measurable box after keyboard resize.');
      expect(dialogBox.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - 259);
    }

    const closeButton = dialog.locator('.custom-adapter-dialog-close');
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(manage).toBeFocused();
    await manage.click();
    const reopenedDialog = page.getByRole('dialog');
    const reopenedWorkspace = reopenedDialog.getByTestId('custom-adapter-workspace');
    const documentField = reopenedWorkspace.getByTestId('custom-http-document');
    const originalDocument = await documentField.inputValue();
    await documentField.fill(`${originalDocument}\n `);
    await expect(reopenedDialog.getByText('Unsaved changes', { exact: true })).toBeVisible();

    await page.context().setOffline(true);
    try {
      await expect(reopenedWorkspace.locator('[data-state="offline"]')).toBeVisible();
      await expect(reopenedWorkspace.getByRole('button', { name: 'Validate', exact: true })).toBeDisabled();
      await expect(reopenedWorkspace.getByRole('button', { name: 'Dry run', exact: true })).toBeDisabled();
      await expect(documentField).toHaveValue(`${originalDocument}\n `);
    } finally {
      await page.context().setOffline(false);
    }
    await expect(reopenedWorkspace.locator('[data-state="offline"]')).toBeHidden();

    page.once('dialog', (nativeDialog) => { void nativeDialog.dismiss(); });
    await reopenedDialog.locator('.custom-adapter-dialog-footer-close').click();
    await expect(reopenedDialog).toBeVisible();
    await expect(reopenedDialog.getByText('Unsaved changes', { exact: true })).toBeVisible();
    page.once('dialog', (nativeDialog) => { void nativeDialog.accept(); });
    await reopenedDialog.locator('.custom-adapter-dialog-footer-close').click();
    await expect(reopenedDialog).toBeHidden();
    await expect(manage).toBeFocused();
  } catch (error) {
    testFailed = true;
    testError = error;
  }
  await finalizeTestCleanup(testFailed, testError, [
    { label: 'restore browser network state', run: () => page.context().setOffline(false) },
    { label: 'remove responsive custom provider', run: () => removeProvider(request, provider.id) },
  ]);
});

test('manages JSON/YAML revisions, safe previews, simulation tools, and exact history', async ({
  page,
  request,
}, testInfo) => {
  test.skip(!FULL_HTTP_PROJECTS.has(testInfo.project.name), 'The complete HTTP management flow runs on desktop and mobile representatives.');
  const fixture = await prepareHttpFixture(request, testInfo);
  let testFailed = false;
  let testError: unknown;
  try {
    await gotoProviders(page);
    const { dialog } = await openWorkspace(page, fixture.provider);
    const workspace = dialog.getByTestId('custom-adapter-workspace');
    const documentField = workspace.getByTestId('custom-http-document');
    const versionField = workspace.getByRole('textbox', { name: 'Adapter version', exact: true });
    await workspace.locator('input[aria-label="Import JSON or YAML document"]').setInputFiles({
      buffer: Buffer.from(fixture.jsonEnvelope),
      mimeType: 'application/json',
      name: 'pr6-export.json',
    });
    await expect(workspace.getByTestId('custom-http-import-state')).toHaveAttribute('data-import-state', 'complete');
    await expect(workspace).toHaveAttribute('data-import-pending', 'false');
    await expect(documentField).toHaveValue(/pr6-safe-sync-image/u);
    await expect(workspace.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(versionField).toHaveValue('1.0.0');
    await versionField.fill('1.0.1');
    await workspace.getByRole('textbox', { name: 'Generation request JSON', exact: true }).fill(JSON.stringify({
      operation: 'image.generate',
      providerId: fixture.provider.id,
      modelId: 'pr6-image-model',
      prompt: 'A safe red kite',
      inputs: [],
    }, null, 2));

    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Validate', 'validate', 'Validate complete.');
    const dryRunResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().endsWith('/adapter/dry-run'),
    );
    await workspace.getByRole('button', { name: 'Dry run', exact: true }).click();
    const dryRunResponse = await dryRunResponsePromise;
    expect(dryRunResponse.status()).toBe(200);
    await expect(workspace.locator('[data-network="false"]')).toBeVisible();
    await expect(workspace.locator('[data-network="false"]')).toContainText('No network request performed');
    await expect(workspace.locator('[data-network="false"]')).toContainText('"network": false');

    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Preview request', 'preview', 'Preview complete.');
    const preview = workspace.locator('[aria-label="Redacted request preview"]');
    await expect(preview).toBeVisible();
    const previewText = await preview.textContent();
    expect(previewText).not.toContain(API_SECRET);
    expect(previewText).not.toContain('authorization: Bearer');

    await workspace.getByRole('textbox', { name: 'Simulation response JSON', exact: true }).fill(JSON.stringify({
      data: [{ b64_json: 'aGVsbG8=', id: 'simulated-image' }],
    }, null, 2));
    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Simulate response', 'simulate', 'Simulate complete.');
    await expect(workspace.locator('pre[aria-label="Simulation result"]')).toContainText('simulated-image');

    await workspace.getByRole('textbox', { name: 'JSON Pointer path', exact: true }).fill('/data/0/id');
    await workspace.getByRole('textbox', { name: 'Path test response JSON', exact: true }).fill(JSON.stringify({
      data: [{ id: 'path-image' }],
    }, null, 2));
    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Test path', 'path-test', 'Path test complete.');
    await expect(workspace.locator('pre[aria-label="Path test result"]')).toContainText('"found": true');

    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Preview capabilities', 'capabilities-preview', 'Capability preview complete.');
    await expect(workspace.locator('section[aria-labelledby="adapter-capabilities-heading"]')).toContainText('pr6-image-model');

    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Save revision', 'adapter', 'Save complete.', 'PUT');
    const jsonSaved = await getCurrentCustomAdapter(request, fixture.provider.id);
    expect(jsonSaved.definition.ref.digest).toBe(fixture.initialRef.digest);
    expect(jsonSaved.definition.ref.version).toBe('1.0.1');
    const exactJsonSaved = await getExactCustomAdapter(request, fixture.provider.id, jsonSaved.definition.ref);
    expect(exactJsonSaved.definition.ref.digest).toBe(fixture.initialRef.digest);
    expect(exactJsonSaved.definition.ref.version).toBe('1.0.1');
    expect(exactJsonSaved.definition.ref).toEqual(jsonSaved.definition.ref);
    await expect(workspace.locator('section[aria-labelledby="adapter-revisions-heading"]')).toContainText('1.0.1 /');

    await workspace.locator('input[aria-label="Import JSON or YAML document"]').setInputFiles({
      buffer: Buffer.from(fixture.yamlEnvelope),
      mimeType: 'application/yaml',
      name: 'pr6-export.yaml',
    });
    await expect(workspace.getByTestId('custom-http-import-state')).toHaveAttribute('data-import-state', 'complete');
    await expect(workspace).toHaveAttribute('data-import-pending', 'false');
    await expect(workspace.getByRole('button', { name: 'YAML', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(versionField).toHaveValue('1.0.0');
    await runWorkspaceAction(page, workspace, fixture.provider.id, 'Save revision', 'adapter', 'Save complete.', 'PUT');
    const yamlSaved = await getCurrentCustomAdapter(request, fixture.provider.id);
    expect(yamlSaved.definition.ref.digest).toBe(fixture.initialRef.digest);
    expect(yamlSaved.definition.ref.version).toBe('1.0.0');
    const exactYamlSaved = await getExactCustomAdapter(request, fixture.provider.id, yamlSaved.definition.ref);
    expect(exactYamlSaved.definition.ref.digest).toBe(fixture.initialRef.digest);
    expect(exactYamlSaved.definition.ref.version).toBe('1.0.0');
    expect(exactYamlSaved.definition.ref).toEqual(yamlSaved.definition.ref);
    const revisions = workspace.locator('section[aria-labelledby="adapter-revisions-heading"]');
    await expect(revisions).toContainText('1.0.1 /');

    const loadButtons = revisions.locator('button[aria-label^="Load revision "]');
    const firstPageCount = await loadButtons.count();
    expect(firstPageCount).toBeGreaterThan(0);
    expect(firstPageCount).toBeLessThan(53);
    await revisions.getByRole('button', { name: 'Load more revisions', exact: true }).click();
    await expect.poll(() => loadButtons.count()).toBeGreaterThan(firstPageCount);

    const exactExport = revisions.getByRole('button', { name: 'Export JSON revision 1.0.0', exact: true });
    await expect(exactExport).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), exactExport.click()]);
    expect(download.suggestedFilename()).toBe(`adapter-${CUSTOM_HTTP_SPEC.id}-1.0.0.json`);
    const downloadPath = await download.path();
    if (downloadPath === null) throw new Error('The exact JSON export did not produce a file.');
    const downloadedEnvelope = CustomAdapterExportEnvelopeSchema.parse(
      JSON.parse(await readFile(downloadPath, 'utf8')),
    );
    expect(downloadedEnvelope).toMatchObject({
      schemaVersion: 1,
      version: '1.0.0',
      definition: { id: CUSTOM_HTTP_SPEC.id },
    });

    const validateRoute = `**/internal/providers/${fixture.provider.id}/adapter/validate`;
    await page.route(validateRoute, async (route) => {
      const response = CustomAdapterErrorResponseSchema.parse({
        error: 'administrator_required',
        message: 'Administrator authorization is required.',
      });
      await route.fulfill({
        body: JSON.stringify(response),
        contentType: 'application/json',
        status: 403,
      });
    });
    await workspace.getByRole('button', { name: 'Validate', exact: true }).click();
    await expect(workspace.locator('[data-state="admin-unavailable"]')).toBeVisible();
    await expect(workspace).toContainText('Administrator authorization is required for trusted adapter installation and lifecycle actions.');
    await expect(workspace.getByRole('button', { name: 'Validate', exact: true })).toBeDisabled();
    await page.unroute(validateRoute);

    await dialog.locator('.custom-adapter-dialog-close').click();
    await expect(dialog).toBeHidden();
    const reopened = await openWorkspace(page, fixture.provider);
    const reopenedWorkspace = reopened.dialog.getByTestId('custom-adapter-workspace');
    await expect(reopenedWorkspace.locator('[data-state="admin-unavailable"]')).toBeHidden();
    await expect(reopenedWorkspace.getByRole('button', { name: 'Validate', exact: true })).toBeEnabled();
    await capturePr6Screenshot(page, testInfo, 'http-management');

    const reopenedRevisions = reopenedWorkspace.locator('section[aria-labelledby="adapter-revisions-heading"]');
    const localBaseUrl = 'https://local-load.example.test';
    const localRequestJson = JSON.stringify({ prompt: 'keep across revision load' }, null, 2);
    const localSimulationJson = JSON.stringify({ status: 'local-pending' }, null, 2);
    const localPathTestJson = JSON.stringify({ data: [{ id: 'local-path-value' }] }, null, 2);
    await reopenedWorkspace.getByRole('textbox', { name: 'Base URL', exact: true }).fill(localBaseUrl);
    await reopenedWorkspace.getByRole('textbox', { name: 'Generation request JSON', exact: true }).fill(localRequestJson);
    await reopenedWorkspace.getByLabel('Simulation HTTP status', { exact: true }).fill('202');
    await reopenedWorkspace.getByRole('textbox', { name: 'Simulation response JSON', exact: true }).fill(localSimulationJson);
    await reopenedWorkspace.getByRole('textbox', { name: 'JSON Pointer path', exact: true }).fill('/data/0/id');
    await reopenedWorkspace.getByRole('textbox', { name: 'Path test response JSON', exact: true }).fill(localPathTestJson);
    await expect(reopened.dialog.getByText('Unsaved changes', { exact: true })).toBeVisible();

    // Loading a revision must request the full immutable ref. The container
    // intentionally keeps local request/simulation/path inputs across the
    // keyed server-document remount.
    acceptNextConfirm(page);
    const loadedRef = await loadExactRevision(page, request, reopenedRevisions, fixture.provider.id, jsonSaved.definition.ref);
    expect(loadedRef).toEqual(jsonSaved.definition.ref);
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Adapter version', exact: true })).toHaveValue('1.0.1');
    await expect(reopenedWorkspace.getByTestId('custom-http-document')).toHaveValue(/pr6-safe-sync-image/u);
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Base URL', exact: true })).toHaveValue(localBaseUrl);
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Generation request JSON', exact: true })).toHaveValue(localRequestJson);
    await expect(reopenedWorkspace.getByLabel('Simulation HTTP status', { exact: true })).toHaveValue('202');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Simulation response JSON', exact: true })).toHaveValue(localSimulationJson);
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'JSON Pointer path', exact: true })).toHaveValue('/data/0/id');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Path test response JSON', exact: true })).toHaveValue(localPathTestJson);
    await expect(reopenedWorkspace.getByTestId('custom-adapter-revision-loading')).toHaveCount(0);
    await expect(reopenedWorkspace.getByTestId('custom-adapter-revision-error')).toHaveCount(0);
    await expect(reopenedWorkspace).not.toContainText('Select Retry');

    // The Provider API deletes only its current revision; historical exact
    // revisions remain visible and addressable after the current is removed.
    const deleteButton = reopenedRevisions.getByRole('button', { name: 'Delete revision 1.0.0', exact: true });
    await expect(deleteButton).toHaveCount(1);
    const deleteResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `/internal/providers/${encodeURIComponent(fixture.provider.id)}/adapter`,
    );
    acceptNextConfirm(page);
    await deleteButton.click();
    const deleteResponse = await deleteResponsePromise;
    expect(deleteResponse.status()).toBe(204);

    await expect(reopenedWorkspace.locator('[data-state="success"]')).toBeVisible();
    await expect(reopenedRevisions).not.toContainText('(current)');
    await expect(reopenedWorkspace).not.toContainText('Select Retry');
    await expect(reopenedWorkspace.getByTestId('custom-adapter-revision-loading')).toHaveCount(0);
    await expect(reopenedWorkspace.getByTestId('custom-adapter-revision-error')).toHaveCount(0);
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Adapter version', exact: true })).toHaveValue('1.0.0');
    await expect(reopenedWorkspace.getByTestId('custom-http-document')).toHaveValue(/"id": "custom-adapter"/u);
    await expect(reopenedWorkspace.getByTestId('custom-http-document')).not.toHaveValue(/pr6-safe-sync-image/u);
    await expect(reopenedWorkspace.getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Base URL', exact: true })).toHaveValue('');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Generation request JSON', exact: true })).toHaveValue(JSON.stringify({ prompt: 'A test prompt' }, null, 2));
    await expect(reopenedWorkspace.getByLabel('Simulation HTTP status', { exact: true })).toHaveValue('200');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Simulation response JSON', exact: true })).toHaveValue(JSON.stringify({ status: 'completed' }, null, 2));
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'JSON Pointer path', exact: true })).toHaveValue('/status');
    await expect(reopenedWorkspace.getByRole('textbox', { name: 'Path test response JSON', exact: true })).toHaveValue(JSON.stringify({ status: 'completed' }, null, 2));
    await expect(reopened.dialog.getByText('Unsaved changes', { exact: true })).toBeHidden();

    const currentAfterDelete = await request.get(`/internal/providers/${encodeURIComponent(fixture.provider.id)}/adapter`, {
      headers: authHeaders(),
    });
    expect(currentAfterDelete.status()).toBe(404);
    const revisionsAfterDelete = await request.get(
      `/internal/providers/${encodeURIComponent(fixture.provider.id)}/adapter/revisions?limit=100`,
      { headers: authHeaders() },
    );
    expect(revisionsAfterDelete.status()).toBe(200);
    const remainingRevisions = CustomAdapterRevisionListResponseSchema.parse(await revisionsAfterDelete.json());
    expect(remainingRevisions.items).not.toHaveLength(0);
    expect(remainingRevisions.items.some((item) => item.isCurrent)).toBe(false);
  } catch (error) {
    testFailed = true;
    testError = error;
  }
  await finalizeTestCleanup(testFailed, testError, [
    {
      label: 'remove HTTP validation route override',
      run: () => page.unroute(`**/internal/providers/${fixture.provider.id}/adapter/validate`),
    },
    { label: 'remove HTTP management provider', run: () => removeProvider(request, fixture.provider.id) },
  ]);
});

test('installs, binds, disables, unbinds, and removes a trusted adapter without exposing source', async ({
  page,
  request,
}, testInfo) => {
  test.skip(!TRUSTED_PROJECTS.has(testInfo.project.name), 'Trusted JavaScript lifecycle runs on desktop, tablet, and mobile representatives.');
  const source = await readFile(SOURCE_PATH);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as TrustedManifest;
  manifest.id = scopedTrustedAdapterId(TRUSTED_ADAPTER_ID, testInfo);
  manifest.displayName = scopedProviderName(TRUSTED_DISPLAY_NAME, testInfo);
  const provider = await createProvider(
    request,
    'custom-js-v1',
    scopedProviderName(TRUSTED_PROVIDER_NAME, testInfo),
    null,
  );
  let testFailed = false;
  let testError: unknown;
  try {
    await gotoProviders(page);
    const { dialog } = await openWorkspace(page, provider);
    const workspace = dialog.getByTestId('custom-adapter-workspace');
    await expect(workspace).toHaveAttribute('data-mode', 'trusted-js');
    manifest.sha256 = createHash('sha256').update(source).digest('hex');
    const installResult = await installTrustedFixture(page, request, workspace, manifest, source);
    expect(installResult.ref.digest).toBe(manifest.sha256);
    expect(installResult.installed.adapter.ref).toEqual(installResult.ref);
    await expect(page.locator('body')).not.toContainText('parentPort');

    const adapterSelect = workspace.getByRole('combobox', { name: 'Installed trusted adapter', exact: true });
    await expect(adapterSelect.locator(`option[value="${manifest.id}"]`)).toHaveCount(1);
    await adapterSelect.selectOption(manifest.id);
    await expect(workspace.getByRole('textbox', { name: 'Provider id for trusted adapter', exact: true })).toHaveValue(provider.id);
    const bindResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/internal/providers/${provider.id}/adapter/trusted-javascript`),
    );
    await workspace.getByRole('button', { name: 'Bind adapter to provider', exact: true }).click();
    const bindResponse = await bindResponsePromise;
    expect(bindResponse.status()).toBe(201);
    await expect(workspace).toContainText(`Current binding: ${manifest.displayName}`);
    await expect(workspace.locator('section[aria-labelledby="trusted-js-history-heading"]')).toContainText(manifest.sha256);
    await capturePr6Screenshot(page, testInfo, 'trusted-lifecycle');

    acceptNextConfirm(page);
    await workspace.getByRole('button', { name: 'Disable provider binding', exact: true }).click();
    await expect(workspace.locator('section[aria-labelledby="trusted-js-bind-heading"]')).toContainText('Disabled binding:');
    await expect(workspace).toContainText('Disabled');
    await expect(workspace.getByRole('button', { name: 'Unbind provider', exact: true })).toBeEnabled();
    await expect(workspace.getByRole('button', { name: `Remove trusted adapter ${manifest.id}`, exact: true })).toBeEnabled();

    acceptNextConfirm(page);
    await workspace.getByRole('button', { name: 'Unbind provider', exact: true }).click();
    await expect(workspace).toContainText('No adapter is currently bound to this provider.');

    const removeResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'DELETE' && response.url().endsWith(`/internal/adapters/${manifest.id}`),
    );
    acceptNextConfirm(page);
    await workspace.getByRole('button', { name: `Remove trusted adapter ${manifest.id}`, exact: true }).click();
    const removeResponse = await removeResponsePromise;
    expect(removeResponse.status()).toBe(204);
    await expect(workspace).toContainText('No trusted adapters installed.');
    await expect(page.locator('body')).not.toContainText(source.toString('utf8'));

    const globalList = await request.get('/internal/adapters', { headers: authHeaders() });
    expect(globalList.status()).toBe(200);
    const globalListText = await globalList.text();
    expect(globalListText).not.toContain(manifest.id);
    expect(globalListText).not.toContain('export const capabilities');
    const removed = await request.get(`/internal/adapters/${encodeURIComponent(manifest.id)}`, { headers: authHeaders() });
    expect(removed.status()).toBe(404);
  } catch (error) {
    testFailed = true;
    testError = error;
  }
  await finalizeTestCleanup(testFailed, testError, [
    { label: 'remove trusted provider', run: () => removeProvider(request, provider.id) },
    { label: 'remove trusted adapter', run: () => removeTrustedAdapter(request, manifest.id) },
  ]);
});
