import {
  validateImageInputs,
  type AssetInput,
  type ImageInputPolicy,
} from '@imagine/shared';

import type { ImageAssetInputDescriptor } from './types.js';

export type StoredInputAvailability = 'checking' | 'incompatible' | 'missing' | 'ready';

export interface StoredImageInputCandidate {
  readonly inputDescriptor: ImageAssetInputDescriptor | null;
  readonly persistedAsset: boolean;
}

export function imageDescriptorMatchesPolicy(
  descriptor: ImageAssetInputDescriptor,
  policy: ImageInputPolicy,
): boolean {
  try {
    validateImageInputs([{
      bytes: descriptor.fileSize,
      height: descriptor.height,
      mimeType: descriptor.mimeType,
      width: descriptor.width,
    }], policy);
    return true;
  } catch {
    return false;
  }
}

export function descriptorsExceedingTotalBytes(
  descriptors: readonly (ImageAssetInputDescriptor | null)[],
  policy: ImageInputPolicy,
): ReadonlySet<number> {
  const exceeding = new Set<number>();
  let totalBytes = 0;
  for (const [index, descriptor] of descriptors.entries()) {
    if (!descriptor) continue;
    if (totalBytes > policy.maxTotalBytes - descriptor.fileSize) {
      exceeding.add(index);
    } else {
      totalBytes += descriptor.fileSize;
    }
  }
  return exceeding;
}

export function storedInputAvailability(
  candidate: StoredImageInputCandidate | undefined,
  policy: ImageInputPolicy,
  inventorySettled: boolean,
): StoredInputAvailability {
  if (!candidate) return inventorySettled ? 'missing' : 'checking';
  if (!candidate.persistedAsset || candidate.inputDescriptor === null) return 'incompatible';
  return imageDescriptorMatchesPolicy(candidate.inputDescriptor, policy)
    ? 'ready'
    : 'incompatible';
}

export function hasExclusiveVideoInputConflict(
  mode: 'image' | 'video',
  inputs: readonly AssetInput[],
  pendingReferenceCount = 0,
): boolean {
  if (mode !== 'video') return false;
  const hasFirstFrame = inputs.some((input) => input.role === 'first_frame');
  const referenceCount = inputs.filter((input) => input.role === 'reference').length;
  return hasFirstFrame && referenceCount + pendingReferenceCount > 0;
}
