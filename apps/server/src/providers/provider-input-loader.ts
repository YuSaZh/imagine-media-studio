import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import type { ProviderInput } from '@imagine/provider-contract';
import type { GenerationRequest } from '@imagine/shared';

import type { AssetRecord } from '../database/assets.js';
import { openStoredFile } from '../storage/path-safety.js';
import type { PublicInputLinks } from '../security/public-input-links.js';

export type ProviderInputLoaderErrorCode =
  | 'provider_input_changed'
  | 'provider_input_invalid'
  | 'provider_input_missing'
  | 'provider_input_too_large';

export class ProviderInputLoaderError extends Error {
  public override readonly name = 'ProviderInputLoaderError';

  public constructor(
    public readonly code: ProviderInputLoaderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ProviderInputAssetLookup {
  get(id: string): AssetRecord | null;
}

export interface ProviderInputLoaderOptions {
  publicLinks?: PublicInputLinks;
  assets: ProviderInputAssetLookup;
  dataRoot: string;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
}

function safeFilename(asset: AssetRecord): string | undefined {
  const filename = asset.originalFilename
    ?.replace(/[\r\n\\/]/g, '_')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('')
    .trim();
  return filename ? filename.slice(0, 255) : undefined;
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  const chunkSize = Math.min(64 * 1024, maxBytes + 1);
  for (;;) {
    const buffer = Buffer.allocUnsafe(chunkSize);
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    if (total > maxBytes) {
      throw new ProviderInputLoaderError(
        'provider_input_changed',
        'Provider input changed after validation.',
      );
    }
    chunks.push(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return Buffer.concat(chunks, total);
}

export class ProviderInputLoader {
  private readonly publicLinks: PublicInputLinks | undefined;
  private readonly assets: ProviderInputAssetLookup;
  private readonly dataRoot: string;
  private readonly maxBytesPerFile: number;
  private readonly maxTotalBytes: number;

  public constructor(options: ProviderInputLoaderOptions) {
    this.publicLinks = options.publicLinks;
    assertPositiveLimit(options.maxBytesPerFile, 'maxBytesPerFile');
    assertPositiveLimit(options.maxTotalBytes, 'maxTotalBytes');
    if (options.maxBytesPerFile > options.maxTotalBytes) {
      throw new RangeError('maxBytesPerFile cannot exceed maxTotalBytes.');
    }
    this.assets = options.assets;
    this.dataRoot = options.dataRoot;
    this.maxBytesPerFile = options.maxBytesPerFile;
    this.maxTotalBytes = options.maxTotalBytes;
  }

  public async load(
    request: GenerationRequest,
    signal?: AbortSignal,
  ): Promise<readonly ProviderInput[]> {
    this.validateOperationInputs(request);
    let totalBytes = 0;
    const inputs: ProviderInput[] = [];
    for (const input of request.inputs) {
      signal?.throwIfAborted();
      const asset = this.assets.get(input.assetId);
      if (asset === null) {
        throw new ProviderInputLoaderError(
          'provider_input_missing',
          `Provider input Asset ${input.assetId} is unavailable.`,
        );
      }
      const expectedType = 'image';
      if (asset.deletedAt !== null || asset.type !== expectedType || asset.fileSize < 1) {
        throw new ProviderInputLoaderError(
          'provider_input_invalid',
          `Provider input Asset ${input.assetId} is not a valid ${expectedType}.`,
        );
      }
      if (asset.fileSize > this.maxBytesPerFile || totalBytes + asset.fileSize > this.maxTotalBytes) {
        throw new ProviderInputLoaderError(
          'provider_input_too_large',
          'Provider inputs exceed the configured byte limit.',
        );
      }

      const handle = await openStoredFile(this.dataRoot, asset.filePath).catch((error: unknown) => {
        throw new ProviderInputLoaderError(
          'provider_input_missing',
          `Provider input Asset ${input.assetId} could not be opened.`,
          { cause: error },
        );
      });
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== asset.fileSize || stat.size > this.maxBytesPerFile) {
          throw new ProviderInputLoaderError(
            'provider_input_changed',
            `Provider input Asset ${input.assetId} changed after validation.`,
          );
        }
        const bytes = await readBounded(handle, this.maxBytesPerFile);
        signal?.throwIfAborted();
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (bytes.byteLength !== asset.fileSize || digest !== asset.sha256) {
          throw new ProviderInputLoaderError(
            'provider_input_changed',
            `Provider input Asset ${input.assetId} changed after validation.`,
          );
        }
        totalBytes += bytes.byteLength;
        const filename = safeFilename(asset);
        inputs.push({
          assetId: input.assetId,
          role: input.role,
          mimeType: asset.mimeType,
          bytes,
          ...(this.publicLinks?.enabled ? { publicUrl: this.publicLinks.create(asset) } : {}),
          ...(filename === undefined ? {} : { filename }),
          parentAssetId: asset.parentAssetId,
          ...(asset.width === null ? {} : { width: asset.width }),
          ...(asset.height === null ? {} : { height: asset.height }),
          fileSize: asset.fileSize,
          sha256: asset.sha256,
        });
      } finally {
        await handle.close();
      }
    }
    return inputs;
  }

  private validateOperationInputs(request: GenerationRequest): void {
    const roles = request.inputs.map((input) => input.role);
    const count = (role: typeof roles[number]) => roles.filter((candidate) => candidate === role).length;
    if (request.operation === 'video.generate' && request.inputs.length > 0) {
      throw new ProviderInputLoaderError(
        'provider_input_invalid',
        'video.generate does not accept provider input assets.',
      );
    }
    if (request.operation === 'video.image_to_video' &&
      (request.inputs.length !== 1 || count('first_frame') !== 1)) {
      throw new ProviderInputLoaderError(
        'provider_input_invalid',
        'video.image_to_video requires exactly one first_frame image.',
      );
    }
    if (request.operation === 'video.reference_to_video' &&
      (request.inputs.length < 1 || request.inputs.some((input) => input.role !== 'reference'))) {
      throw new ProviderInputLoaderError(
        'provider_input_invalid',
        'video.reference_to_video requires reference image assets only.',
      );
    }
    if (request.operation === 'video.edit' || request.operation === 'video.extend') {
      throw new ProviderInputLoaderError(
        'provider_input_invalid',
        `${request.operation} is not supported by the current video input runtime.`,
      );
    }
  }
}
