import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_EXCLUDED_PATHS,
  DATA_ARCHIVE_FORMAT,
  DATA_ARCHIVE_VERSION,
  DataArchiveFormatError,
  createDataArchiveManifest,
  parseDataArchiveManifest,
  serializeDataArchiveManifest,
} from './archive-format.js';

const CREATED_AT = new Date('2026-08-29T00:00:00.000Z');
const DATABASE_HASH = createHash('sha256').update('database').digest('hex');

function manifest() {
  return createDataArchiveManifest({
    createdAt: CREATED_AT,
    entries: [{ path: 'database/app.db', size: 8, sha256: DATABASE_HASH }],
  });
}

describe('data archive format', () => {
  it('serializes a strict deterministic manifest and sorts entries', () => {
    const value = createDataArchiveManifest({
      createdAt: CREATED_AT,
      entries: [
        { path: 'media/uploads/upload.bin', size: 6, sha256: createHash('sha256').update('upload').digest('hex') },
        { path: 'database/app.db', size: 8, sha256: DATABASE_HASH },
      ],
    });
    expect(value).toMatchObject({ format: DATA_ARCHIVE_FORMAT, version: DATA_ARCHIVE_VERSION });
    expect(value.entries.map((entry) => entry.path)).toEqual([
      'database/app.db',
      'media/uploads/upload.bin',
    ]);
    expect(value.excluded).toEqual([...ARCHIVE_EXCLUDED_PATHS]);
    const bytes = serializeDataArchiveManifest(value);
    expect(parseDataArchiveManifest(bytes)).toEqual(value);
    expect(Buffer.from(bytes).toString('utf8')).toBe(Buffer.from(serializeDataArchiveManifest(value)).toString('utf8'));
  });

  it('uses the same UTF-16 ordering for punctuation-adjacent names', () => {
    const value = createDataArchiveManifest({
      createdAt: CREATED_AT,
      entries: [
        { path: 'media/uploads/a.bin', size: 1, sha256: '1'.repeat(64) },
        { path: 'media/uploads/a-bin', size: 1, sha256: '2'.repeat(64) },
        { path: 'database/app.db', size: 1, sha256: DATABASE_HASH },
      ],
    });
    expect(value.entries.map((entry) => entry.path)).toEqual([
      'database/app.db',
      'media/uploads/a-bin',
      'media/uploads/a.bin',
    ]);
  });

  it('rejects unknown fields, traversal, duplicate paths, and missing database', () => {
    const base = manifest();
    const databaseEntry = base.entries[0]!;
    const unknown = JSON.parse(Buffer.from(serializeDataArchiveManifest(base)).toString('utf8')) as Record<string, unknown>;
    unknown.unexpected = true;
    expect(() => parseDataArchiveManifest(new TextEncoder().encode(JSON.stringify(unknown)))).toThrow(DataArchiveFormatError);

    const traversal = { ...base, entries: [{ ...databaseEntry, path: 'media/../secret' }] };
    expect(() => serializeDataArchiveManifest(traversal)).toThrow(DataArchiveFormatError);

    const duplicate = { ...base, entries: [databaseEntry, databaseEntry] };
    expect(() => serializeDataArchiveManifest(duplicate)).toThrow(DataArchiveFormatError);

    const noDatabase = { ...base, entries: [{ path: 'media/uploads/file.bin', size: 1, sha256: '0'.repeat(64) }] };
    expect(() => serializeDataArchiveManifest(noDatabase)).toThrow(DataArchiveFormatError);
  });

  it('rejects a changed exclusion list and oversized payload declarations', () => {
    const base = manifest();
    const databaseEntry = base.entries[0]!;
    const changed = { ...base, excluded: [...base.excluded.slice(1), base.excluded[0]!] };
    expect(() => serializeDataArchiveManifest(changed)).toThrow(DataArchiveFormatError);
    const oversized = { ...base, entries: [{ ...databaseEntry, size: Number.MAX_SAFE_INTEGER }] };
    expect(() => serializeDataArchiveManifest(oversized)).toThrow(DataArchiveFormatError);
  });

  it('rejects semantically equivalent but non-canonical JSON', () => {
    const value = manifest();
    const canonical = new TextDecoder().decode(serializeDataArchiveManifest(value));
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = JSON.stringify({
      excluded: parsed.excluded,
      entries: parsed.entries,
      createdAt: parsed.createdAt,
      version: parsed.version,
      format: parsed.format,
    });
    expect(() => parseDataArchiveManifest(new TextEncoder().encode(`${reordered}\n`))).toThrow(DataArchiveFormatError);
  });
});
