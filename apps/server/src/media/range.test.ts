import { describe, expect, it } from 'vitest';

import { planMediaResponse } from './range.js';

describe('planMediaResponse', () => {
  it('plans full GET and HEAD responses', () => {
    expect(planMediaResponse({ etag: '"sha"', method: 'GET', size: 10 })).toMatchObject({
      body: true,
      start: 0,
      end: 9,
      statusCode: 200,
    });
    expect(planMediaResponse({ etag: '"sha"', method: 'HEAD', size: 10 })).toMatchObject({
      body: false,
      statusCode: 200,
    });
  });

  it('supports one normal, open-ended, or suffix range', () => {
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'bytes=2-5', size: 10 }),
    ).toMatchObject({ start: 2, end: 5, statusCode: 206 });
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'bytes=7-', size: 10 }),
    ).toMatchObject({ start: 7, end: 9, statusCode: 206 });
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'bytes=-3', size: 10 }),
    ).toMatchObject({ start: 7, end: 9, statusCode: 206 });
  });

  it('returns 416 for unsatisfiable ranges and ignores malformed or multipart ranges', () => {
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'bytes=20-', size: 10 }),
    ).toMatchObject({ statusCode: 416, headers: { 'content-range': 'bytes */10' } });
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'not-a-range', size: 10 }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      planMediaResponse({ etag: '"sha"', method: 'GET', range: 'bytes=0-1,3-4', size: 10 }),
    ).toMatchObject({ statusCode: 200 });
  });

  it('serves the full representation when If-Range does not match', () => {
    expect(
      planMediaResponse({
        etag: '"current"',
        ifRange: '"old"',
        method: 'GET',
        range: 'bytes=2-5',
        size: 10,
      }),
    ).toMatchObject({ statusCode: 200 });
  });

  it('accepts a fresh If-Range date and rejects a stale or weak validator', () => {
    const lastModified = new Date('2026-01-01T00:00:00.500Z');
    expect(
      planMediaResponse({
        etag: '"current"',
        ifRange: 'Thu, 01 Jan 2026 00:00:01 GMT',
        lastModified,
        method: 'GET',
        range: 'bytes=0-1',
        size: 10,
      }),
    ).toMatchObject({ statusCode: 206 });
    for (const ifRange of ['Wed, 31 Dec 2025 23:59:59 GMT', 'W/"current"']) {
      expect(
        planMediaResponse({
          etag: '"current"',
          ifRange,
          lastModified,
          method: 'GET',
          range: 'bytes=0-1',
          size: 10,
        }),
      ).toMatchObject({ statusCode: 200 });
    }
  });
});
