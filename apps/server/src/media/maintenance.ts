import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, opendir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { assertNoSymlinkTraversal, resolveStoredPath, toStoredPath } from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';
import type { AssetMediaRepositoryPort } from './types.js';

const TEMPORARY_NAME = /^ims-[0-9a-f-]{36}\.(?:part|poster\.jpg)$/i;

export interface TemporaryCleanupResult {
  removed: readonly string[];
  skipped: readonly string[];
}

export interface MediaConsistencyIssue {
  assetId: string | null;
  kind: 'hash_mismatch' | 'missing' | 'orphan' | 'size_mismatch' | 'unsafe';
  storedPath: string;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function cleanupTemporaryMedia(options: {
  dataRoot: string;
  maxAgeMs: number;
  now?: Date;
  temporaryDirectory: string;
}): Promise<TemporaryCleanupResult> {
  if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 0) {
    throw new RangeError('maxAgeMs must be a non-negative safe integer.');
  }
  await assertNoSymlinkTraversal(options.dataRoot, options.temporaryDirectory, false);
  const directory = await opendir(options.temporaryDirectory);
  const removed: string[] = [];
  const skipped: string[] = [];
  const threshold = (options.now ?? new Date()).getTime() - options.maxAgeMs;
  for await (const entry of directory) {
    if (!TEMPORARY_NAME.test(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const path = join(options.temporaryDirectory, entry.name);
    const entryStat = await lstat(path);
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || entryStat.mtimeMs > threshold) {
      skipped.push(entry.name);
      continue;
    }
    await rm(path, { force: true });
    removed.push(entry.name);
  }
  return { removed, skipped };
}

async function listManagedFiles(
  dataRoot: string,
  directoryPath: string,
): Promise<{ files: string[]; unsafe: string[] }> {
  await assertNoSymlinkTraversal(dataRoot, directoryPath, false);
  const files: string[] = [];
  const unsafe: string[] = [];
  const pending = [directoryPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        unsafe.push(toStoredPath(dataRoot, path));
        continue;
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(toStoredPath(dataRoot, path));
    }
  }
  return { files, unsafe };
}

export async function auditMediaConsistency(options: {
  paths: StoragePaths;
  repository: AssetMediaRepositoryPort;
}): Promise<readonly MediaConsistencyIssue[]> {
  const assets = await options.repository.listForMaintenance();
  const issues: MediaConsistencyIssue[] = [];
  const expected = new Set<string>();

  for (const asset of assets) {
    const paths = [asset.filePath, asset.thumbnailPath, asset.posterPath].filter(
      (value): value is string => value !== null,
    );
    for (const storedPath of paths) expected.add(storedPath);
    for (const storedPath of paths) {
      let absolutePath: string;
      try {
        absolutePath = resolveStoredPath(options.paths.root, storedPath);
        await assertNoSymlinkTraversal(options.paths.root, absolutePath, false);
      } catch {
        issues.push({ assetId: asset.id, kind: 'unsafe', storedPath });
        continue;
      }
      let file;
      try {
        file = await stat(absolutePath);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          issues.push({ assetId: asset.id, kind: 'missing', storedPath });
          continue;
        }
        throw error;
      }
      if (!file.isFile()) {
        issues.push({ assetId: asset.id, kind: 'missing', storedPath });
        continue;
      }
      if (storedPath === asset.filePath) {
        if (file.size !== asset.fileSize) {
          issues.push({ assetId: asset.id, kind: 'size_mismatch', storedPath });
        }
        if ((await sha256File(absolutePath)) !== asset.sha256) {
          issues.push({ assetId: asset.id, kind: 'hash_mismatch', storedPath });
        }
      }
    }
  }

  const managedDirectories = [
    options.paths.originals,
    options.paths.thumbnails,
    options.paths.posters,
    options.paths.uploads,
    options.paths.masks,
  ];
  for (const directory of managedDirectories) {
    const listed = await listManagedFiles(options.paths.root, directory);
    for (const storedPath of listed.unsafe) {
      issues.push({ assetId: null, kind: 'unsafe', storedPath });
    }
    for (const storedPath of listed.files) {
      if (!expected.has(storedPath)) issues.push({ assetId: null, kind: 'orphan', storedPath });
    }
  }
  return issues;
}
