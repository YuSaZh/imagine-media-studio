import { unlink } from 'node:fs/promises';
import type { AssetRepository } from '../database/assets.js';
import { assertNoSymlinkTraversal, resolveStoredPath } from '../storage/path-safety.js';

/** Durable metadata and job links keep cleanup independent of the browser lifetime. */
export class TemporaryVideoFrames {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly assets: AssetRepository, private readonly root: string, private readonly publish: () => void) {}
  run(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.clean(now).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async clean(now: number): Promise<void> {
    const claimed = this.assets.claimTemporaryFrames(now);
    this.publish();
    for (const asset of claimed) {
      let complete = true;
      for (const stored of [asset.filePath, asset.thumbnailPath, asset.posterPath]) {
        if (!stored) continue;
        try {
          const path = resolveStoredPath(this.root, stored);
          await assertNoSymlinkTraversal(this.root, path);
          await unlink(path).catch(error => { if (error?.code !== 'ENOENT') throw error; });
        } catch { complete = false; }
      }
      if (complete) this.assets.markTemporaryPurged(asset.id);
    }
  }
  start(): void { this.timer = setInterval(() => { void this.run().catch(() => undefined); }, 2000); this.timer.unref(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.running; }
}
