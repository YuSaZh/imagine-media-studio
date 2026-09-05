import { afterEach, describe, expect, it, vi } from 'vitest';


import {
  flattenCustomAdapterRevisionPages,
  loadCustomAdapterRevisionsData,
  readExportedYamlEnvelopeVersion,
  customAdapterRevisionsQueryKey,
  trustedBindingQueryKey,
  trustedBindingsQueryKey,
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

describe('adapter queries', () => {
  it('reads version only from a top-level exported YAML envelope', () => {
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  id: adapter\n')).toBe('2.0.0');
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\ndefinition:\n  version: nested\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion:\ndefinition:\n  id: adapter\n')).toBeUndefined();
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
