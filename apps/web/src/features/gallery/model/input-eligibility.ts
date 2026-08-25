import type { FixtureGalleryItem } from './types.js';

export function canContinueWithImageInput(item: FixtureGalleryItem): boolean {
  return item.kind === 'image' && item.persistedAsset && item.inputDescriptor !== null;
}
