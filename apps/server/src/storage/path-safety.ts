import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export class UnsafeStoragePathError extends Error {
  public override readonly name = 'UnsafeStoragePathError';
}

function assertContained(root: string, candidate: string): void {
  const relationship = relative(root, candidate);
  if (
    relationship === '' ||
    relationship === '..' ||
    relationship.startsWith(`..${sep}`) ||
    isAbsolute(relationship)
  ) {
    throw new UnsafeStoragePathError('Stored media path escapes the configured data directory.');
  }
}

export function resolveStoredPath(dataRoot: string, storedPath: string): string {
  if (
    storedPath.length === 0 ||
    storedPath.includes('\0') ||
    storedPath.includes('\\') ||
    isAbsolute(storedPath) ||
    win32.isAbsolute(storedPath)
  ) {
    throw new UnsafeStoragePathError('Stored media path must be a non-empty POSIX relative path.');
  }

  const segments = storedPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new UnsafeStoragePathError('Stored media path contains a forbidden segment.');
  }

  const root = resolve(dataRoot);
  const candidate = resolve(root, ...segments);
  assertContained(root, candidate);
  return candidate;
}

export function toStoredPath(dataRoot: string, absolutePath: string): string {
  const root = resolve(dataRoot);
  const candidate = resolve(absolutePath);
  assertContained(root, candidate);
  return relative(root, candidate).split(sep).join('/');
}

export async function assertNoSymlinkTraversal(
  dataRoot: string,
  absolutePath: string,
  allowMissingLeaf = true,
): Promise<void> {
  const root = resolve(dataRoot);
  const candidate = resolve(absolutePath);
  assertContained(root, candidate);

  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new UnsafeStoragePathError('The configured data directory cannot be a symbolic link.');
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) {
    throw new UnsafeStoragePathError('The configured data directory must use its canonical path.');
  }

  const segments = relative(root, candidate).split(sep);
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new UnsafeStoragePathError('Stored media path traverses a symbolic link.');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT' &&
        allowMissingLeaf
      ) {
        return;
      }
      throw error;
    }
  }
}

export async function openStoredFile(dataRoot: string, storedPath: string) {
  const absolutePath = resolveStoredPath(dataRoot, storedPath);
  await assertNoSymlinkTraversal(dataRoot, absolutePath, false);
  return open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
}
