import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockGenerationRequest } from '@imagine/testkit';
import { createDatabase, type DatabaseClient } from '../database/client.js';
import { AssetRepository } from '../database/assets.js';
import { JobRepository } from '../database/jobs.js';
import { ProviderRepository } from '../database/providers.js';
import { TemporaryVideoFrames } from './temporary-video-frames.js';
const roots: string[] = [], databases: DatabaseClient[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.sqlite.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'imagine-temporary-frames-')); roots.push(root);
  const db = createDatabase(join(root, 'app.db'), fileURLToPath(new URL('../../migrations', import.meta.url))); databases.push(db);
  const assets = new AssetRepository(db.orm), jobs = new JobRepository(db.orm), provider = new ProviderRepository(db.orm).create({ name: 'Fixture', type: 'mock' });
  await mkdir(join(root, 'media'));
  const create = async (name: string, extra = {}) => { await writeFile(join(root, 'media', name), 'fixture'); return assets.create({ type: 'image', role: 'reference', filePath: `media/${name}`, mimeType: 'image/png', fileSize: 7, sha256: name, ...extra }); };
  const video = await create('video.mp4', { type: 'video', role: 'upload', mimeType: 'video/mp4' });
  const frame = await create('frame.png', { parentAssetId: video.id, metadata: { temporaryVideoFrame: true } });
  const mask = await create('mask.png', { role: 'mask', parentAssetId: frame.id });
  const cleaner = new TemporaryVideoFrames(assets, root, vi.fn());
  const job = () => jobs.create(createMockGenerationRequest({ providerId: provider.id, operation: 'image.edit', inputs: [{ assetId: frame.id, role: 'source' }, { assetId: mask.id, role: 'mask' }] }));
  return { root, db, assets, video, frame, mask, cleaner, create, job };
}
it('hides temporary inputs immediately and retains files until every sharing job ends', async () => {
  const f = await setup();
  expect(f.assets.page().items.map(asset => asset.id)).toEqual([f.video.id]);
  expect(f.assets.get(f.mask.id)?.metadata.temporaryVideoFrame).toBe(true);
  const first = f.job(), second = f.job();
  f.db.sqlite.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(first.id);
  await f.cleaner.run(); await expect(access(join(f.root, f.frame.filePath))).resolves.toBeUndefined();
  f.db.sqlite.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(second.id);
  // A new service instance discovers terminal inputs from persisted state after restart.
  await new TemporaryVideoFrames(new AssetRepository(f.db.orm), f.root, vi.fn()).run();
  for (const asset of [f.frame, f.mask]) { expect(f.assets.get(asset.id)).toBeNull(); await expect(access(join(f.root, asset.filePath))).rejects.toThrow(); expect(f.assets.get(asset.id, true)?.metadata.temporaryPurged).toBe(true); }
  await expect(access(join(f.root, f.video.filePath))).resolves.toBeUndefined();
  await f.cleaner.run();
});
it('expires abandoned frames, preserves ordinary references, and does not traverse symlinks', async () => {
  const f = await setup(); const ordinary = await f.create('ordinary.png', { parentAssetId: f.video.id });
  await f.cleaner.run(); expect(f.assets.get(f.frame.id)).not.toBeNull();
  await rm(join(f.root, f.mask.filePath)); await symlink(join(f.root, ordinary.filePath), join(f.root, f.mask.filePath));
  await f.cleaner.run(Date.now() + 25 * 60 * 60 * 1000);
  expect(f.assets.get(f.mask.id, true)?.metadata.temporaryPurged).not.toBe(true);
  await expect(access(join(f.root, ordinary.filePath))).resolves.toBeUndefined();
  await rm(join(f.root, f.mask.filePath));
  await f.cleaner.run(); expect(f.assets.get(f.mask.id, true)?.metadata.temporaryPurged).toBe(true);
  expect(f.assets.get(ordinary.id)).not.toBeNull();
});
