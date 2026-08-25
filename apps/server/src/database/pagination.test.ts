import { describe, expect, it } from 'vitest';

import {
  decodePageCursor,
  encodePageCursor,
  InvalidPageCursorError,
  normalizePageRequest,
  toCursorPage,
} from './pagination.js';

describe('cursor pagination', () => {
  it('round trips stable timestamp and ID cursors', () => {
    const cursor = { timestampMs: 1_700_000_000_000, id: 'record-1' };
    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed cursors and invalid limits', () => {
    expect(() => decodePageCursor('not-json')).toThrow(InvalidPageCursorError);
    expect(() => normalizePageRequest({ limit: 0 })).toThrow(RangeError);
    expect(() => normalizePageRequest({ limit: 101 })).toThrow(RangeError);
  });

  it('emits a next cursor only when a lookahead row exists', () => {
    const rows = [
      { id: 'three', at: 3 },
      { id: 'two', at: 2 },
      { id: 'one', at: 1 },
    ];
    const page = toCursorPage(rows, 2, (row) => ({ timestampMs: row.at, id: row.id }));
    expect(page.items.map((row) => row.id)).toEqual(['three', 'two']);
    expect(page.nextCursor).not.toBeNull();
    expect(decodePageCursor(page.nextCursor ?? '')).toEqual({ timestampMs: 2, id: 'two' });
    expect(toCursorPage(rows.slice(0, 2), 2, (row) => ({ timestampMs: row.at, id: row.id })).nextCursor).toBeNull();
  });
});
