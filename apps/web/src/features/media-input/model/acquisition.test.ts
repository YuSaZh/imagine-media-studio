import { describe, expect, it } from 'vitest';

import {
  acquireImageFiles,
  fileFingerprint,
  filesFromClipboard,
  filesFromDataTransfer,
} from './acquisition.js';

function image(name: string, size = 4, type = 'image/png', lastModified = 1): File {
  return new File([new Uint8Array(size)], name, { lastModified, type });
}

describe('media input acquisition', () => {
  it('accepts supported unique images within count and byte limits', () => {
    const first = image('first.png', 4);
    const second = image('second.webp', 6, 'image/webp');
    const result = acquireImageFiles([first, second], {
      createId: () => `id-${Math.random()}`,
      maxFileBytes: 10,
      maxItems: 2,
      maxTotalBytes: 10,
    });
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it('rejects source formats whose normalized output is unsupported by the model', () => {
    const result = acquireImageFiles([image('reference.webp', 6, 'image/webp')], {
      allowedMimeTypes: ['image/jpeg'],
      maxItems: 1,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{
      name: 'reference.webp',
      reason: 'normalized_type_unsupported',
    }]);
  });

  it('allows duplicate fingerprints only when the caller explicitly opts in', () => {
    const duplicate = image('fixture.png', 4, 'image/png', 10);
    const result = acquireImageFiles([duplicate, duplicate], {
      allowDuplicateFingerprints: true,
      createId: () => globalThis.crypto.randomUUID(),
      maxItems: 2,
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toEqual([]);
  });

  it('rejects empty, MIME, per-file, duplicate, count, and total-byte violations', () => {
    const duplicate = image('same.png', 2, 'image/png', 10);
    const result = acquireImageFiles(
      [
        image('empty.png', 0),
        image('text.txt', 2, 'text/plain'),
        image('large.png', 11),
        duplicate,
        image('count.png', 1),
        image('total.png', 9),
      ],
      {
        createId: () => 'accepted',
        existingFingerprints: new Set([fileFingerprint(duplicate)]),
        existingCount: 0,
        maxFileBytes: 10,
        maxItems: 1,
        maxTotalBytes: 5,
      },
    );
    expect(result.accepted).toEqual([{ clientId: 'accepted', file: result.accepted[0]?.file, fingerprint: result.accepted[0]?.fingerprint }]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      'empty',
      'unsupported_type',
      'file_too_large',
      'duplicate',
      'item_limit',
    ]);
  });

  it('rejects total bytes independently of the item limit', () => {
    const result = acquireImageFiles([image('one.png', 4), image('two.png', 4)], {
      createId: () => globalThis.crypto.randomUUID(),
      maxItems: 4,
      maxTotalBytes: 6,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'two.png', reason: 'total_too_large' }]);
  });

  it('extracts dropped files, rejects directories, and preserves mixed clipboard text', () => {
    const dropped = image('drop.png');
    const directoryItem = {
      kind: 'file',
      getAsFile: () => null,
      webkitGetAsEntry: () => ({ isDirectory: true }),
    };
    const fileItem = { kind: 'file', getAsFile: () => dropped, webkitGetAsEntry: () => null };
    const transfer = {
      files: [],
      items: [directoryItem, fileItem],
    } as unknown as DataTransfer;
    expect(filesFromDataTransfer(transfer)).toEqual({
      files: [dropped],
      rejected: [{ name: 'Folder', reason: 'directory' }],
    });

    const clipboard = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => dropped },
      ],
    } as unknown as DataTransfer;
    expect(filesFromClipboard(clipboard)).toEqual({
      files: [dropped],
      hasText: true,
      rejected: [],
    });

    const fallback = {
      files: [dropped],
      items: [{ kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => null }],
    } as unknown as DataTransfer;
    expect(filesFromDataTransfer(fallback).files).toEqual([dropped]);
  });
});
