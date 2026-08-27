import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomAdapterRefSchema } from '@imagine/shared';

import {
  flattenCustomAdapterRevisionPages,
  loadCustomAdapterData,
  loadCustomAdapterExportData,
  loadCustomAdapterRevisionData,
  loadCustomAdapterRevisionsData,
  loadMoreCustomAdapterRevisions,
  readExportedYamlEnvelopeVersion,
  loadTrustedAdapterData,
  loadTrustedAdaptersData,
  loadTrustedBindingData,
  loadTrustedBindingsData,
  loadMoreTrustedBindings,
  customAdapterRevisionsQueryKey,
  previewCustomAdapterCapabilitiesData,
  trustedBindingQueryKey,
  trustedBindingsQueryKey,
  testCustomAdapterPathData,
} from './adapter-query.js';
import { adapterQueryKeys } from '../../../api/query-keys.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const customRef = {
  kind: 'declarative-http' as const,
  adapterId: 'studio-custom-http',
  version: '1.0.0',
  digest: 'b'.repeat(64),
};

describe('adapter query fixture mode', () => {
  it('reads version only from a top-level exported YAML envelope', () => {
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  id: adapter\n')).toBe('2.0.0');
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\ndefinition:\n  version: nested\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion:\ndefinition:\n  id: adapter\n')).toBeUndefined();
  });

  it('returns deterministic source-free trusted/current/revision/export fixtures without fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const trusted = await loadTrustedAdaptersData(true);
    const trustedItem = await loadTrustedAdapterData(true, trusted.items[0]!.ref.adapterId);
    const binding = await loadTrustedBindingData(true, 'provider-studio-mock');
    const bindings = await loadTrustedBindingsData(true, 'provider-studio-mock', { limit: 1 });
    const moreBindings = await loadMoreTrustedBindings(true, 'provider-studio-mock', { limit: 1 }, bindings.nextCursor!);
    const exactBinding = await loadTrustedBindingData(true, 'provider-studio-mock', bindings.items[0]!.adapter.ref);
    const current = await loadCustomAdapterData(true, 'provider-studio-mock');
    const revisions = await loadCustomAdapterRevisionsData(true, 'provider-studio-mock', { limit: 1 });
    const more = await loadMoreCustomAdapterRevisions(true, 'provider-studio-mock', { limit: 1 }, revisions.nextCursor!);
    const exact = await loadCustomAdapterRevisionData(true, 'provider-studio-mock', customRef);
    const exported = await loadCustomAdapterExportData(true, 'provider-studio-mock', { ref: customRef });

    expect(trusted.items[0]).not.toHaveProperty('source');
    expect(trustedItem).toMatchObject({ adapter: { ref: trusted.items[0]!.ref } });
    expect(binding).toMatchObject({ binding: { providerId: 'provider-studio-mock', isCurrent: true } });
    expect(bindings.items).toHaveLength(1);
    expect(moreBindings.items).toHaveLength(1);
    expect(exactBinding).toMatchObject({ binding: { adapter: { ref: bindings.items[0]!.adapter.ref } } });
    expect(bindings.items[0]).not.toHaveProperty('source');
    expect(bindings.items[0]!.adapter).not.toHaveProperty('source');
    expect(current).toMatchObject({ definition: { providerId: 'provider-studio-mock', ref: customRef } });
    expect(revisions.items).toHaveLength(1);
    expect(more.items).toHaveLength(1);
    expect(exact).toMatchObject({ definition: { ref: customRef } });
    expect(exported).toMatchObject({ filename: 'adapter-studio-custom-http-1.0.0.json' });
    expect(exported.text).not.toContain('secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps provider and immutable ref in trusted binding keys', () => {
    const key = trustedBindingQueryKey(false, 'provider-1', customRef);
    const historyKey = trustedBindingsQueryKey(false, 'provider-1', customRef);
    expect(key).toEqual([
      'internal', 'adapters', 'trusted-bindings', 'current', 'provider-1',
      customRef.kind, customRef.adapterId, customRef.version, customRef.digest, 'live',
    ]);
    expect(historyKey).toEqual([
      'internal', 'adapters', 'trusted-bindings', 'revisions', 'provider-1',
      customRef.kind, customRef.adapterId, customRef.version, customRef.digest, 50, 'live',
    ]);
  });

  it('keeps exact revision keys and infinite-page flattening stable', () => {
    const key = adapterQueryKeys.customRevision('provider-studio-mock', customRef);
    expect(key).toEqual([
      'internal',
      'adapters',
      'custom',
      'revision',
      'provider-studio-mock',
      customRef.kind,
      customRef.adapterId,
      customRef.version,
      customRef.digest,
    ]);
    expect(flattenCustomAdapterRevisionPages({
      pages: [
        { items: [{ id: 'one' } as never], nextCursor: 'cursor' },
        { items: [{ id: 'two' } as never], nextCursor: null },
      ],
      pageParams: [undefined, 'cursor'],
    })).toEqual([{ id: 'one' }, { id: 'two' }]);
  });

  it('validates fixture tool inputs with shared schemas and keeps path output safe', async () => {
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/data/0/id',
      json: { data: [{ id: 'fixture-result' }] },
    })).resolves.toEqual({ path: '/data/0/id', found: true, value: 'fixture-result' });
    await expect(previewCustomAdapterCapabilitiesData(true, 'provider-studio-mock')).resolves.toMatchObject({
      capabilities: { providerType: 'custom-http-v1' },
    });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: 'data',
      json: {},
    })).rejects.toThrow();
    await expect(loadCustomAdapterRevisionsData(true, 'provider-studio-mock', {
      kind: 'declarative-http',
      adapterId: 'only-half-an-exact-ref',
    })).rejects.toThrow();
    expect(CustomAdapterRefSchema.safeParse(customRef).success).toBe(true);
  });

  it('matches live path source priority and redacts credential-like values in fixtures', async () => {
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/chosen',
      document: { chosen: 'document', fallback: 'ignored' },
      json: { chosen: 'json' },
      response: { status: 200, json: { chosen: 'response' } },
    })).resolves.toEqual({ path: '/chosen', found: true, value: 'document' });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/chosen',
      response: { status: 200, json: { chosen: 'response' }, text: '{"chosen":"text"}' },
      json: { chosen: 'json' },
    })).resolves.toEqual({ path: '/chosen', found: true, value: 'response' });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/chosen',
      text: '{"chosen":"text"}',
    })).resolves.toEqual({ path: '/chosen', found: true, value: 'text' });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/apiKey',
      json: { apiKey: 'fixture-secret' },
    })).resolves.toEqual({ path: '/apiKey', found: true, value: '[REDACTED]' });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/data/3/id',
      json: { data: [{ id: 'only-item' }] },
    })).resolves.toEqual({ path: '/data/3/id', found: false });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/missing/key',
      json: { present: true },
    })).resolves.toEqual({ path: '/missing/key', found: false });
    await expect(testCustomAdapterPathData(true, 'provider-studio-mock', {
      path: '/constructor/value',
      json: { constructor: { value: 'unsafe' } },
    })).rejects.toThrow();
  });
});

describe('adapter query live mode', () => {
  it('passes cursor/ref filters to the client and does not silently drop pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );

    await loadCustomAdapterRevisionsData(false, 'provider-1', { ref: customRef, limit: 25, cursor: 'next page' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/internal/providers/provider-1/adapter/revisions?kind=declarative-http&adapterId=studio-custom-http&version=1.0.0&digest=${customRef.digest}&limit=25&cursor=next+page`);
  });

  it('passes React Query cancellation signals through revision loaders and isolates page sizes in keys', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }),
    );
    const signal = new AbortController().signal;
    await loadCustomAdapterRevisionsData(false, 'provider-1', { limit: 10 }, { signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(customAdapterRevisionsQueryKey(false, 'provider-1', customRef, 10)).not.toEqual(
      customAdapterRevisionsQueryKey(false, 'provider-1', customRef, 50),
    );
  });
});
