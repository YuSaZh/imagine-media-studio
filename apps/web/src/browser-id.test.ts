import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserId } from './browser-id.js';
import { acquireImageFiles } from './features/media-input/model/acquisition.js';

afterEach(() => vi.unstubAllGlobals());

describe('browser identifiers on HTTP test origins', () => {
  it('uses the native UUID API when available', () => {
    const randomUUID = vi.fn(() => 'native-id');
    vi.stubGlobal('crypto', { randomUUID });
    expect(createBrowserId()).toBe('native-id');
  });

  it('accepts uploaded files and creates distinct IDs without secure-context APIs', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const result = acquireImageFiles([
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
    ], { maxItems: 2 });
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    expect(createBrowserId()).toMatch(/^[a-f0-9]{32}$/);
    expect(new Set(Array.from({ length: 100 }, createBrowserId)).size).toBe(100);
  });
});
