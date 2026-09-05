import { internalClient } from '../../../api/internal-client.js';
import type { ImageAssetInputDescriptor, ReferenceUploadRole } from '../model/types.js';

export async function uploadReferenceImage(
  file: File,
  signal: AbortSignal,
  role: ReferenceUploadRole = 'reference',
): Promise<{ assetId: string; inputDescriptor: ImageAssetInputDescriptor | null }> {
  signal.throwIfAborted();
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
