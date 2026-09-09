import { mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ensureStorage, getStoragePaths } from './paths.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('creates private storage directories without a runtime gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imagine-storage-')); roots.push(root);
  const paths = getStoragePaths(join(root, 'new-data')); await ensureStorage(paths);
  expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.uploads)).isDirectory()).toBe(true);
  await expect(stat(join(paths.root, '.offline-maintenance.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects symlinked roots and parents before creating or chmodding target storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imagine-storage-links-')); roots.push(root);
  const target = join(root, 'target'); await mkdir(target, { mode: 0o755 }); await symlink(target, join(root, 'linked'));
  await expect(ensureStorage(getStoragePaths(join(root, 'linked')))).rejects.toThrow('canonical');
  await expect(ensureStorage(getStoragePaths(join(root, 'linked', 'child')))).rejects.toThrow('canonical');
  expect((await stat(target)).mode & 0o777).toBe(0o755);
  await expect(stat(join(target, 'child'))).rejects.toMatchObject({ code: 'ENOENT' });
});
