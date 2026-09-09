import { assertNoSymlinkTraversal, UnsafeStoragePathError } from './path-safety.js';
import { chmod, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface StoragePaths {
  root: string;
  database: string;
  originals: string;
  thumbnails: string;
  posters: string;
  uploads: string;
  masks: string;
  temporary: string;
  adapters: string;
  backups: string;
  logs: string;
}

export function getStoragePaths(dataDir: string): StoragePaths {
  const media = join(dataDir, 'media');

  return {
    root: dataDir,
    database: join(dataDir, 'app.db'),
    originals: join(media, 'originals'),
    thumbnails: join(media, 'thumbnails'),
    posters: join(media, 'posters'),
    uploads: join(media, 'uploads'),
    masks: join(media, 'masks'),
    temporary: join(media, 'temp'),
    adapters: join(dataDir, 'adapters'),
    backups: join(dataDir, 'backups'),
    logs: join(dataDir, 'logs'),
  };
}

export async function ensureStorage(paths: StoragePaths): Promise<void> {
  // Validate ordinary storage paths independently of application lifecycle.
  let ancestor = resolve(paths.root);
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new UnsafeStoragePathError('Data root must use a canonical directory path.');
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await Promise.all(
    [
      paths.originals,
      paths.thumbnails,
      paths.posters,
      paths.uploads,
      paths.masks,
      paths.temporary,
      paths.adapters,
      paths.backups,
      paths.logs,
    ].map(async (directory) => {
      await assertNoSymlinkTraversal(paths.root, directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
}
