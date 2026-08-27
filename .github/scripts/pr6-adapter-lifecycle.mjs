import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const baseUrl = process.env.BASE_URL;
const appPassword = process.env.APP_PASSWORD ?? '';
const customSecret = 'pr6-custom-http-static-secret';
const fixtureDirectory = resolve(process.cwd(), 'fixtures/adapters/trusted-fixture-v1');
const trustedManifestText = await readFile(resolve(fixtureDirectory, 'manifest.json'), 'utf8');
const trustedSourceText = await readFile(resolve(fixtureDirectory, 'adapter.mjs'), 'utf8');
const authHeader = `Basic ${Buffer.from(`studio:${appPassword}`).toString('base64')}`;

function withAuth(options = {}) {
  const headers = new globalThis.Headers(options.headers);
  headers.set('authorization', authHeader);
  headers.set('origin', baseUrl);
  return { ...options, headers };
}

async function request(path, options = {}, expectedStatus = 200) {
  const response = await globalThis.fetch(baseUrl + path, withAuth({
    ...options,
    signal: options.signal ?? globalThis.AbortSignal.timeout(10_000),
  }));
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${options.method ?? 'GET'} ${path}: expected ${expectedStatus}, received ${response.status}: ${text}`);
  for (const [label, value] of [
    ['custom provider secret', customSecret],
    ['application password', appPassword],
    ['trusted adapter source', trustedSourceText],
  ]) {
    assert.equal(text.includes(value), false, `${path} leaked the ${label}.`);
  }
  return { response, text };
}

async function json(path, options = {}, expectedStatus = 200) {
  return JSON.parse((await request(path, options, expectedStatus)).text);
}

function trustedForm() {
  const form = new globalThis.FormData();
  form.append('manifest', trustedManifestText);
  form.append(
    'source',
    new globalThis.Blob([new globalThis.TextEncoder().encode(trustedSourceText)], { type: 'application/javascript' }),
    'adapter.mjs',
  );
  return form;
}

const trustedAdapterId = process.env.TRUSTED_ADAPTER_ID;
const trustedProviderId = process.env.TRUSTED_PROVIDER_ID;
const trustedVersion = process.env.TRUSTED_VERSION;
const trustedDigest = process.env.TRUSTED_DIGEST;
const trustedPath = `/internal/providers/${encodeURIComponent(trustedProviderId)}/adapter/trusted-javascript`;
const customPath = `/internal/providers/${encodeURIComponent(process.env.CUSTOM_PROVIDER_ID)}/adapter`;

assert.ok(trustedAdapterId && trustedProviderId && trustedVersion && trustedDigest);
assert.ok(process.env.CUSTOM_PROVIDER_ID && process.env.CUSTOM_ADAPTER_ID && process.env.CUSTOM_V2 && process.env.CUSTOM_DIGEST_V2);

const customCurrent = (await json(customPath)).definition;
assert.equal(customCurrent.ref.kind, 'declarative-http');
assert.equal(customCurrent.ref.adapterId, process.env.CUSTOM_ADAPTER_ID);
assert.equal(customCurrent.ref.version, process.env.CUSTOM_V2);
assert.equal(customCurrent.ref.digest, process.env.CUSTOM_DIGEST_V2);
assert.equal(customCurrent.isCurrent, true);

const customHistory = await json(`${customPath}/revisions?limit=100`);
assert.deepEqual(customHistory.items.map((item) => item.ref.version).sort(), ['1.0.0', '2.0.0']);
const historical = await json(`${customPath}/revisions?kind=declarative-http&adapterId=${encodeURIComponent(process.env.CUSTOM_ADAPTER_ID)}&version=${encodeURIComponent(process.env.CUSTOM_V1)}&digest=${process.env.CUSTOM_DIGEST_V1}`);
assert.equal(historical.items.length, 1);
assert.equal(historical.items[0].ref.digest, process.env.CUSTOM_DIGEST_V1);
const historicalExport = await request(`${customPath}/export?kind=declarative-http&adapterId=${encodeURIComponent(process.env.CUSTOM_ADAPTER_ID)}&version=${encodeURIComponent(process.env.CUSTOM_V1)}&digest=${process.env.CUSTOM_DIGEST_V1}&format=json`);
assert.equal(JSON.parse(historicalExport.text).version, process.env.CUSTOM_V1);

const customJob = await json(`/internal/jobs/${encodeURIComponent(process.env.CUSTOM_JOB_ID)}`);
assert.equal(customJob.job.id, process.env.CUSTOM_JOB_ID);
assert.equal(customJob.job.providerId, process.env.CUSTOM_PROVIDER_ID);
assert.equal(customJob.job.request.providerId, process.env.CUSTOM_PROVIDER_ID);

const trustedCurrent = (await json(trustedPath)).binding;
assert.equal(trustedCurrent.providerId, trustedProviderId);
assert.equal(trustedCurrent.isCurrent, true);
assert.equal(trustedCurrent.disabled, false);
assert.equal(trustedCurrent.adapter.ref.kind, 'trusted-javascript');
assert.equal(trustedCurrent.adapter.ref.adapterId, trustedAdapterId);
assert.equal(trustedCurrent.adapter.ref.version, trustedVersion);
assert.equal(trustedCurrent.adapter.ref.digest, trustedDigest);
assert.equal(Object.hasOwn(trustedCurrent.adapter, 'source'), false);

const trustedHistory = await json(`${trustedPath}/revisions?limit=100`);
assert.ok(trustedHistory.items.some((item) => item.adapter.ref.adapterId === trustedAdapterId));
const disabled = (await json(`${trustedPath}/disable`, { method: 'POST' })).binding;
assert.equal(disabled.disabled, true);
assert.equal(disabled.isCurrent, false);

const trustedQuery = new globalThis.URLSearchParams({
  kind: 'trusted-javascript',
  adapterId: trustedAdapterId,
  version: trustedVersion,
  digest: trustedDigest,
});
await request(`${trustedPath}?${trustedQuery}`, { method: 'DELETE' }, 204);
await request(trustedPath, {}, 404);
await request(`/internal/adapters/${encodeURIComponent(trustedAdapterId)}`, { method: 'DELETE' }, 204);
await request(`/internal/adapters/${encodeURIComponent(trustedAdapterId)}`, {}, 404);

const tombstoned = await request('/internal/adapters/trusted-javascript', {
  method: 'POST',
  body: trustedForm(),
}, 409);
assert.equal(JSON.parse(tombstoned.text).error, 'tombstoned');
