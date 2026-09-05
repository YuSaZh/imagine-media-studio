import { internalClient } from '../../../api/internal-client.js';
import { createBrowserId } from '../../../browser-id.js';
import type { ImageAssetInputDescriptor, ReferenceUploadRole } from '../model/types.js';

export async function uploadReferenceImage(
  file: File,
  signal: AbortSignal,
  fixtureMode: boolean,
  preparedDescriptor: ImageAssetInputDescriptor | null = null,
  role: ReferenceUploadRole = 'reference',
): Promise<{ assetId: string; inputDescriptor: ImageAssetInputDescriptor | null }> {
  signal.throwIfAborted();
  if (fixtureMode) {
    await Promise.resolve();
    signal.throwIfAborted();
    return {
      assetId: `fixture-${role}-${createBrowserId()}`,
      inputDescriptor: preparedDescriptor,
    };
  }
  const response = await internalClient.uploadAsset(file, { role }, { signal });
  return {
    assetId: response.asset.id,
    inputDescriptor: response.asset.type === 'image' &&
      response.asset.width !== null && response.asset.height !== null
      ? {
          fileSize: response.asset.fileSize,
          height: response.asset.height,
          mimeType: response.asset.mimeType,
          width: response.asset.width,
        }
      : null,
  };
}
