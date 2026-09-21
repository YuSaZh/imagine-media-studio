import type { AssetDto, JobDto } from '@imagine/shared';
import { mapMedia, type MediaItem } from './data';

export function selectionKey(item: MediaItem): string {
  return item.asset?.series ? `series:${item.asset.series.id}` : `asset:${item.id}`;
}

/** Resolve complete series before enabling a bulk action; never accept truncated membership. */
export async function resolveGallerySelection(items: readonly MediaItem[], fetch: (id: string) => Promise<{ assets: AssetDto[]; jobs: JobDto[]; truncated: boolean }>): Promise<MediaItem[]> {
  const resolved = new Map<string, MediaItem>();
  const seen = new Set<string>();
  for (const item of items) {
    const key = selectionKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!item.asset?.series) { resolved.set(item.id, item); continue; }
    const family = await fetch(item.id);
    if (family.truncated) throw new Error('这个系列过大，无法完整读取；请关闭系列显示后分批选择。');
    if (!family.assets.length) throw new Error('系列作品已变化，请刷新后重新选择。');
    for (const asset of family.assets) resolved.set(asset.id, mapMedia({ ...asset, series: item.asset.series }, family.jobs.find(job => job.id === asset.jobId)));
  }
  return [...resolved.values()];
}
