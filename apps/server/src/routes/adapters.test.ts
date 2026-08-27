import { readFileSync } from 'node:fs';

import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { digestAdapterSource } from '../adapters/index.js';
import { CustomAdapterServiceError } from '../services/custom-adapter-service.js';
import { TrustedAdapterServiceError } from '../services/trusted-adapter-service.js';
import { registerAdapterRoutes } from './adapters.js';

const trustedFixture = new URL('../providers/custom-js/fixtures/trusted-fixture-manifest.json', import.meta.url);
const trustedManifest = JSON.parse(readFileSync(trustedFixture, 'utf8')) as Record<string, unknown>;
const trustedSource = Buffer.from('export async function createProvider() { return { getCapabilities: async () => ({ providerType: "fixture", models: [] }) }; }');
const trustedRef = {
  adapterId: trustedManifest.id as string,
  digest: trustedManifest.sha256 as string,
  kind: 'trusted-javascript' as const,
  version: trustedManifest.version as string,
};
const now = new Date('2026-08-27T00:00:00.000Z');
const customRef = {
  adapterId: 'declarative',
  digest: 'a'.repeat(64),
  kind: 'declarative-http' as const,
  version: '1.0.0',
};
const customRecord = {
  providerId: 'provider-1',
  ref: customRef,
  definition: { schemaVersion: 1, id: 'declarative' },
  isCurrent: true,
  disabled: false,
  createdAt: now,
  updatedAt: now,
};

function multipart(
  parts: readonly { name: string; value?: string; filename?: string; contentType?: string; bytes?: Uint8Array }[],
  boundary = '----adapter-route-test',
  close = true,
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/javascript'}\r\n\r\n`,
      ));
      chunks.push(Buffer.from(part.bytes ?? []));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${part.value ?? ''}\r\n`,
      ));
    }
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function validManifest(): Record<string, unknown> {
  return {
    ...trustedManifest,
    sha256: digestAdapterSource(trustedSource),
  };
}

function customTools() {
  const capabilities = { providerType: 'custom-http-v1', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate' as const] } }] };
  const compiled = { method: 'POST' as const, relativePath: '/v1', query: {}, headers: {}, body: { type: 'none' as const }, url: 'https://example.test/v1', endpoint: 'submit' as const };
  return {
    capabilities: vi.fn(async () => ({ capabilities })),
    delete: vi.fn(async () => true),
    disable: vi.fn(async () => customRecord),
    dryRun: vi.fn(async () => ({ network: false as const, performed: false as const, endpoint: 'submit' as const, request: { ...compiled, capabilities }, preview: { ...compiled, capabilities }, capabilities })),
    export: vi.fn(() => ({ content: '{"schemaVersion":1}', document: '{"schemaVersion":1}', format: 'json' as const, ref: customRef })),
    get: vi.fn(() => customRecord),
    list: vi.fn(() => [customRecord]),
    preview: vi.fn(async () => ({ ...compiled, capabilities })),
    replace: vi.fn(async () => customRecord),
    simulateResponse: vi.fn(() => ({ state: 'pending', remoteJobId: 'remote-1' })),
    testPath: vi.fn(() => ({ path: '/data/0', found: true, value: 'ok' })),
    validate: vi.fn(() => ({ valid: true, adapterId: 'declarative', canonical: '{}', spec: { id: 'declarative' } })),
  };
}

function trustedTools() {
  return {
    bind: vi.fn(async () => ({ manifest: validManifest(), ref: { ...trustedRef, digest: digestAdapterSource(trustedSource) }, createdAt: now, updatedAt: now })),
    get: vi.fn(async () => ({ manifest: validManifest(), ref: { ...trustedRef, digest: digestAdapterSource(trustedSource) }, createdAt: now, updatedAt: now })),
    install: vi.fn(async () => ({ manifest: validManifest(), ref: { ...trustedRef, digest: digestAdapterSource(trustedSource) }, createdAt: now, updatedAt: now })),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
  };
}

async function createRouteApp(
  trusted = trustedTools(),
  custom = customTools(),
) {
  const app = Fastify({ logger: false });
  await app.register(fastifyMultipart, { limits: { fields: 8, files: 2, parts: 8 } });
  app.addContentTypeParser(['application/yaml', 'application/x-yaml', 'text/yaml'], { parseAs: 'string' }, (_request, payload, done) => done(null, payload));
  await registerAdapterRoutes(app, { trusted, custom } as never);
  return { app, trusted, custom };
}

afterEach(() => vi.restoreAllMocks());

describe('adapter management routes', () => {
  it('maps administrator denial to 403 without accepting an admin flag', async () => {
    const trusted = trustedTools();
    trusted.list.mockRejectedValue(new TrustedAdapterServiceError('administrator_required'));
    const { app } = await createRouteApp(trusted);
    try {
      const response = await app.inject({ method: 'GET', url: '/internal/adapters?adminEnabled=true' });
      expect(response.statusCode).toBe(400);
      const allowed = await app.inject({ method: 'GET', url: '/internal/adapters' });
      expect(allowed.statusCode).toBe(403);
      expect(allowed.json()).toEqual({
        error: 'administrator_required',
        message: 'Administrator authorization is required for adapter management.',
      });
    } finally {
      await app.close();
    }
  });

  it('accepts manifest/source in either multipart order and never returns source bytes', async () => {
    const trusted = trustedTools();
    const { app } = await createRouteApp(trusted);
    const payload = multipart([
      { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
      { name: 'manifest', value: JSON.stringify(validManifest()) },
      { name: 'providerId', value: 'provider-1' },
    ]);
    try {
      const response = await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': payload.contentType }, payload: payload.body });
      expect(response.statusCode).toBe(201);
      expect(trusted.install).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-1', source: expect.any(Uint8Array) }));
      expect(response.body).not.toContain(trustedSource.toString('utf8'));
    } finally {
      await app.close();
    }
  });

  it('rejects multipart extras, truncation, invalid UTF-8 marker, and oversized parts safely', async () => {
    const trusted = trustedTools();
    const { app } = await createRouteApp(trusted);
    try {
      const extra = multipart([
        { name: 'manifest', value: JSON.stringify(validManifest()) },
        { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
        { name: 'unexpected', value: 'nope' },
      ]);
      expect((await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': extra.contentType }, payload: extra.body })).statusCode).toBe(400);

      const unknownFile = multipart([
        { name: 'manifest', value: JSON.stringify(validManifest()) },
        { name: 'unexpected-file', filename: 'ignored.mjs', bytes: Buffer.from('should be drained') },
        { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
      ]);
      expect((await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': unknownFile.contentType }, payload: unknownFile.body })).statusCode).toBe(400);

      const manifestTooLarge = multipart([
        { name: 'manifest', value: 'x'.repeat(128 * 1024 + 1) },
        { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
      ]);
      expect((await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': manifestTooLarge.contentType }, payload: manifestTooLarge.body })).statusCode).toBe(413);

      const sourceTooLarge = multipart([
        { name: 'manifest', value: JSON.stringify(validManifest()) },
        { name: 'source', filename: 'adapter.mjs', bytes: Buffer.alloc(1 * 1024 * 1024 + 1) },
      ]);
      const oversized = await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': sourceTooLarge.contentType }, payload: sourceTooLarge.body });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.body).not.toContain('adapter.mjs');

      const invalidProvider = multipart([
        { name: 'manifest', value: JSON.stringify(validManifest()) },
        { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
        { name: 'providerId', value: 'provider\nid' },
      ]);
      expect((await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': invalidProvider.contentType }, payload: invalidProvider.body })).statusCode).toBe(400);

      const truncated = multipart([
        { name: 'manifest', value: JSON.stringify(validManifest()) },
        { name: 'source', filename: 'adapter.mjs', bytes: trustedSource },
      ], '----adapter-route-truncated', false);
      expect((await app.inject({ method: 'POST', url: '/internal/adapters/trusted-javascript', headers: { 'content-type': truncated.contentType }, payload: truncated.body })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('passes raw JSON and YAML PUT documents with strict query and no secret fields', async () => {
    const custom = customTools();
    const { app } = await createRouteApp(trustedTools(), custom);
    try {
      const json = await app.inject({
        method: 'PUT',
        url: '/internal/providers/provider-1/adapter',
        headers: { 'content-type': 'application/json' },
        payload: { schemaVersion: 1, version: '1.0.0', definition: { schemaVersion: 1, id: 'declarative' } },
      });
      expect(json.statusCode).toBe(200);
      expect(custom.replace).toHaveBeenCalledWith(expect.objectContaining({ format: 'json', document: { schemaVersion: 1, version: '1.0.0', definition: { schemaVersion: 1, id: 'declarative' } }, providerId: 'provider-1' }));

      const yaml = await app.inject({
        method: 'PUT',
        url: '/internal/providers/provider-1/adapter',
        headers: { 'content-type': 'application/yaml' },
        payload: 'schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  schemaVersion: 1\n  id: declarative\n',
      });
      expect(yaml.statusCode).toBe(200);
      expect(custom.replace).toHaveBeenCalledWith(expect.objectContaining({ format: 'yaml', document: 'schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  schemaVersion: 1\n  id: declarative\n' }));

      const secret = await app.inject({
        method: 'POST',
        url: '/internal/providers/provider-1/adapter/preview',
        headers: { 'content-type': 'application/json' },
        payload: { secrets: { apiKey: 'must-not-enter-route' } },
      });
      expect(secret.statusCode).toBe(400);
      expect(custom.preview).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns safe export headers and dispatches every custom tool', async () => {
    const custom = customTools();
    const { app } = await createRouteApp(trustedTools(), custom);
    const request = { operation: 'image.generate', providerId: 'provider-1', modelId: 'model', prompt: 'preview', inputs: [] };
    try {
      const exported = await app.inject({ method: 'GET', url: '/internal/providers/provider-1/adapter/export?format=json' });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('application/json');
      expect(exported.headers['content-disposition']).toBe('attachment; filename="adapter-declarative-1.0.0.json"');
      expect(exported.headers['x-content-type-options']).toBe('nosniff');

      const calls = [
        ['validate', { document: { schemaVersion: 1, id: 'declarative' } }],
        ['preview', { request }],
        ['dry-run', { request }],
        ['simulate', { response: { status: 200, json: {} } }],
        ['path-test', { path: '/data/0', json: { data: ['x'] } }],
        ['capabilities-preview', {}],
      ] as const;
      for (const [tool, payload] of calls) {
        const response = await app.inject({ method: 'POST', url: `/internal/providers/provider-1/adapter/${tool}`, headers: { 'content-type': 'application/json' }, payload });
        expect(response.statusCode).toBe(200);
      }
      expect(custom.validate).toHaveBeenCalledTimes(1);
      expect(custom.preview).toHaveBeenCalledTimes(1);
      expect(custom.dryRun).toHaveBeenCalledTimes(1);
      expect(custom.simulateResponse).toHaveBeenCalledTimes(1);
      expect(custom.testPath).toHaveBeenCalledTimes(1);
      expect(custom.capabilities).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns safe 500 for an extracted simulation DTO that contains source or secrets', async () => {
    const custom = customTools();
    custom.simulateResponse.mockReturnValue({
      state: 'completed',
      source: 'secret-source',
      assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aW1hZ2U=' }],
    } as never);
    const { app } = await createRouteApp(trustedTools(), custom);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/providers/provider-1/adapter/simulate',
        headers: { 'content-type': 'application/json' },
        payload: { response: { status: 200, json: {} } },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret-source');
      expect(response.body).not.toContain('base64');
    } finally {
      await app.close();
    }
  });

  it('lists historical revisions and exports a complete exact reference', async () => {
    const custom = customTools();
    const oldRef = { ...customRef, version: '0.9.0', digest: 'b'.repeat(64) };
    custom.list.mockReturnValue([
      { ...customRecord, ref: oldRef, isCurrent: false },
      customRecord,
    ]);
    const { app } = await createRouteApp(trustedTools(), custom);
    try {
      const revisions = await app.inject({ method: 'GET', url: '/internal/providers/provider-1/adapter/revisions' });
      expect(revisions.statusCode).toBe(200);
      expect(revisions.json<{ items: unknown[] }>().items).toHaveLength(2);
      const exported = await app.inject({
        method: 'GET',
        url: `/internal/providers/provider-1/adapter/export?kind=declarative-http&adapterId=declarative&version=0.9.0&digest=${oldRef.digest}`,
      });
      expect(exported.statusCode).toBe(200);
      expect(custom.export).toHaveBeenCalledWith({ providerId: 'provider-1', ref: oldRef });
    } finally {
      await app.close();
    }
  });

  it('paginates revisions with stable opaque cursors, exact filtering, and tamper rejection', async () => {
    const custom = customTools();
    const makeRevision = (adapterId: string, version: string, digest: string, createdAt: string) => ({
      ...customRecord,
      ref: { kind: 'declarative-http' as const, adapterId, version, digest },
      definition: { schemaVersion: 1, id: adapterId },
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
    const rows = [
      makeRevision('revision-a', '1.0.0', 'a'.repeat(64), '2026-08-27T00:04:00.000Z'),
      makeRevision('revision-b', '1.0.0', 'b'.repeat(64), '2026-08-27T00:03:00.000Z'),
      makeRevision('revision-c', '1.0.0', 'c'.repeat(64), '2026-08-27T00:02:00.000Z'),
      makeRevision('revision-d', '1.0.0', 'd'.repeat(64), '2026-08-27T00:01:00.000Z'),
    ];
    custom.list.mockImplementation(() => rows);
    const { app } = await createRouteApp(trustedTools(), custom);
    try {
      const first = await app.inject({ method: 'GET', url: '/internal/providers/provider-1/adapter/revisions?limit=2' });
      expect(first.statusCode).toBe(200);
      const firstJson = first.json<{ items: { ref: { adapterId: string } }[]; nextCursor: string | null }>();
      expect(firstJson.items.map((item) => item.ref.adapterId)).toEqual(['revision-a', 'revision-b']);
      expect(firstJson.nextCursor).toBeTruthy();

      const second = await app.inject({ method: 'GET', url: `/internal/providers/provider-1/adapter/revisions?limit=2&cursor=${encodeURIComponent(firstJson.nextCursor!)}` });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ items: { ref: { adapterId: string } }[]; nextCursor: string | null }>().items.map((item) => item.ref.adapterId)).toEqual(['revision-c', 'revision-d']);

      rows.unshift(makeRevision('revision-new', '1.0.0', 'e'.repeat(64), '2026-08-27T00:05:00.000Z'));
      const stableSecond = await app.inject({ method: 'GET', url: `/internal/providers/provider-1/adapter/revisions?limit=2&cursor=${encodeURIComponent(firstJson.nextCursor!)}` });
      expect(stableSecond.statusCode).toBe(200);
      expect(stableSecond.json<{ items: { ref: { adapterId: string } }[] }>().items.map((item) => item.ref.adapterId)).toEqual(['revision-c', 'revision-d']);

      const exact = await app.inject({ method: 'GET', url: `/internal/providers/provider-1/adapter/revisions?kind=declarative-http&adapterId=revision-c&version=1.0.0&digest=${'c'.repeat(64)}` });
      expect(exact.statusCode).toBe(200);
      expect(exact.json<{ items: { ref: { adapterId: string } }[] }>().items.map((item) => item.ref.adapterId)).toEqual(['revision-c']);

      const forged = Buffer.from(JSON.stringify([Date.parse('2026-08-27T00:04:00.000Z'), JSON.stringify(['declarative-http', 'missing', '1.0.0', 'f'.repeat(64)])]), 'utf8').toString('base64url');
      const invalid = await app.inject({ method: 'GET', url: `/internal/providers/provider-1/adapter/revisions?cursor=${forged}` });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('maps service statuses and enforces no-body operations', async () => {
    const custom = customTools();
    custom.get.mockImplementation(() => { throw new CustomAdapterServiceError('provider_not_found', 'raw provider detail'); });
    const { app } = await createRouteApp(trustedTools(), custom);
    try {
      const bodyOnGet = await app.inject({ method: 'GET', url: '/internal/providers/provider-1/adapter', headers: { 'content-type': 'application/json' }, payload: {} });
      expect(bodyOnGet.statusCode).toBe(400);
      const missing = await app.inject({ method: 'GET', url: '/internal/providers/provider-1/adapter' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'provider_not_found', message: 'The Provider was not found.' });
      const invalidQuery = await app.inject({ method: 'GET', url: '/internal/adapters/anything?unexpected=true' });
      expect(invalidQuery.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('rejects mutation query injection before invoking any management service', async () => {
    const trusted = trustedTools();
    const custom = customTools();
    const { app } = await createRouteApp(trusted, custom);
    try {
      const requests = [
        { method: 'POST' as const, url: '/internal/adapters/trusted-javascript?adminEnabled=true' },
        { method: 'POST' as const, url: '/internal/providers/provider-1/adapter/trusted-javascript?adminEnabled=true', payload: { ref: trustedRef } },
        { method: 'PUT' as const, url: '/internal/providers/provider-1/adapter?adminEnabled=true', headers: { 'content-type': 'application/json' }, payload: {} },
        { method: 'DELETE' as const, url: '/internal/adapters/trusted-js-fixture?adminEnabled=true' },
        { method: 'DELETE' as const, url: '/internal/providers/provider-1/adapter?adminEnabled=true' },
        { method: 'POST' as const, url: '/internal/providers/provider-1/adapter/disable?adminEnabled=true' },
      ];
      for (const request of requests) expect((await app.inject(request)).statusCode).toBe(400);
      expect(trusted.install).not.toHaveBeenCalled();
      expect(trusted.bind).not.toHaveBeenCalled();
      expect(trusted.remove).not.toHaveBeenCalled();
      expect(custom.replace).not.toHaveBeenCalled();
      expect(custom.delete).not.toHaveBeenCalled();
      expect(custom.disable).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('passes bind references without accepting source or admin controls', async () => {
    const trusted = trustedTools();
    const { app } = await createRouteApp(trusted);
    try {
      const invalid = await app.inject({
        method: 'POST',
        url: '/internal/providers/provider-1/adapter/trusted-javascript',
        headers: { 'content-type': 'application/json' },
        payload: { ref: trustedRef, source: 'secret', adminEnabled: true },
      });
      expect(invalid.statusCode).toBe(400);
      const bound = await app.inject({
        method: 'POST',
        url: '/internal/providers/provider-1/adapter/trusted-javascript',
        headers: { 'content-type': 'application/json' },
        payload: { ref: trustedRef },
      });
      expect(bound.statusCode).toBe(201);
      expect(trusted.bind).toHaveBeenCalledWith({ providerId: 'provider-1', ref: trustedRef });
    } finally {
      await app.close();
    }
  });
});
