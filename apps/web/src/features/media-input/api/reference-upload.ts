import { internalClient } from '../../../api/internal-client.js';
import type { ImageAssetInputDescriptor } from '../model/types.js';

export async function uploadReferenceImage(
  file: File,
  signal: AbortSignal,
  fixtureMode: boolean,
  preparedDescriptor: ImageAssetInputDescriptor | null = null,
): Promise<{ assetId: string; inputDescriptor: ImageAssetInputDescriptor | null }> {
  signal.throwIfAborted();
  if (fixtureMode) {
    await Promise.resolve();
    signal.throwIfAborted();
    return {
      assetId: `fixture-reference-${globalThis.crypto.randomUUID()}`,
      inputDescriptor: preparedDescriptor,
    };
  }
  const response = await internalClient.uploadAsset(file, { role: 'reference' }, { signal });
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
