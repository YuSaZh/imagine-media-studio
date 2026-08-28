import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTemporaryMedia } from '../media/maintenance.js';
import {
  AtomicFileTooLargeError,
  commitStagedFile,
  stageReadable,
} from './atomic-file.js';
import {
  assertNoSymlinkTraversal,
  resolveStoredPath,
  UnsafeStoragePathError,
} from './path-safety.js';
import { ensureStorage, getStoragePaths } from './paths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ims-media-storage-'));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  return paths;
}

describe('media storage safety', () => {
  it('rejects traversal, absolute paths, Windows paths, and symlink traversal', async () => {
    const paths = await storageFixture();
    expect(() => resolveStoredPath(paths.root, '../secret')).toThrow(UnsafeStoragePathError);
    expect(() => resolveStoredPath(paths.root, '/etc/passwd')).toThrow(UnsafeStoragePathError);
    expect(() => resolveStoredPath(paths.root, 'C:\\Windows\\system.ini')).toThrow(
      UnsafeStoragePathError,
    );
    const outside = await mkdtemp(join(tmpdir(), 'ims-outside-'));
    temporaryDirectories.push(outside);
    await symlink(outside, join(paths.uploads, 'escape'));
    await expect(
      assertNoSymlinkTraversal(paths.root, join(paths.uploads, 'escape', 'file.png')),
    ).rejects.toThrow(UnsafeStoragePathError);
  });

  it('streams to a 0600 temporary file, hashes it, and atomically commits without overwrite', async () => {
    const paths = await storageFixture();
    const payload = Buffer.from('atomic media fixture');
    const staged = await stageReadable({
      dataRoot: paths.root,
      maxBytes: 1024,
      source: Readable.from([payload.subarray(0, 6), payload.subarray(6)]),
      temporaryDirectory: paths.temporary,
    });
    expect(staged.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect((await lstat(staged.temporaryPath)).mode & 0o777).toBe(0o600);

    const destination = join(paths.uploads, 'fixture.bin');
    await commitStagedFile(paths.root, staged, destination);
    expect(await readFile(destination)).toEqual(payload);
    await expect(
      commitStagedFile(
        paths.root,
        await stageReadable({
          dataRoot: paths.root,
          maxBytes: 1024,
          source: Readable.from(['other']),
          temporaryDirectory: paths.temporary,
        }),
        destination,
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('aborts at the final publication guard without publishing and cleans the staged file', async () => {
    const paths = await storageFixture();
    const staged = await stageReadable({
      dataRoot: paths.root,
      maxBytes: 1024,
      source: Readable.from(['deadline payload']),
      temporaryDirectory: paths.temporary,
    });
    const destination = join(paths.uploads, 'deadline.bin');
    const controller = new AbortController();
    let checks = 0;
    const signal = {
      get aborted() {
        return controller.signal.aborted;
      },
      throwIfAborted() {
        checks += 1;
        if (checks === 5) controller.abort();
        controller.signal.throwIfAborted();
      },
    } as AbortSignal;

    await expect(commitStagedFile(paths.root, staged, destination, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(checks).toBe(5);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(staged.temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces the byte limit and removes partial files', async () => {
    const paths = await storageFixture();
    await expect(
      stageReadable({
        dataRoot: paths.root,
        maxBytes: 3,
        source: Readable.from(['four']),
        temporaryDirectory: paths.temporary,
      }),
    ).rejects.toThrow(AtomicFileTooLargeError);
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(paths.temporary));
    expect(entries).toEqual([]);
  });

  it('cleans only old service-owned temporary files', async () => {
    const paths = await storageFixture();
    const oldPart = join(paths.temporary, 'ims-00000000-0000-4000-8000-000000000000.part');
    const keep = join(paths.temporary, 'user-file.part');
    await writeFile(oldPart, 'old');
    await writeFile(keep, 'keep');
    await chmod(oldPart, 0o600);
    const { utimes } = await import('node:fs/promises');
    await utimes(oldPart, new Date(0), new Date(0));
    const result = await cleanupTemporaryMedia({
      dataRoot: paths.root,
      maxAgeMs: 1_000,
      now: new Date(10_000),
      temporaryDirectory: paths.temporary,
    });
    expect(result.removed).toEqual([oldPart.split('/').at(-1)]);
    expect(await readFile(keep, 'utf8')).toBe('keep');
  });
});
