import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  await Promise.all(
    [
      paths.root,
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
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }),
  );
}
