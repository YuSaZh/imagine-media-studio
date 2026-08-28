import sharp from 'sharp';

import {
  assertUsableMaskCoverage,
  classifyMaskRgba,
  type MaskCoverage,
} from '@imagine/shared';

import {
  commitStagedFile,
  discardStagedFile,
  stageBuffer,
  type StagedFile,
} from '../storage/atomic-file.js';
import type { ImageMediaMetadata } from './types.js';

const SHARP_FORMAT_TO_MIME = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

export class InvalidImageError extends Error {
  public override readonly name = 'InvalidImageError';
}

export interface ImageProcessorOptions {
  maxInputPixels?: number;
  maxPages?: number;
  thumbnailSize?: number;
}

export interface DecodedMaskMetadata {
  coverage: MaskCoverage;
  height: number;
  width: number;
}

export class SharpImageProcessor {
  private readonly maxInputPixels: number;
  private readonly maxPages: number;
  private readonly thumbnailSize: number;

  public constructor(options: ImageProcessorOptions = {}) {
    this.maxInputPixels = options.maxInputPixels ?? 100_000_000;
    this.maxPages = options.maxPages ?? 100;
    this.thumbnailSize = options.thumbnailSize ?? 512;
  }

  public async inspect(filePath: string): Promise<ImageMediaMetadata & { mimeType: string }> {
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      metadata = await sharp(filePath, {
        failOn: 'warning',
        limitInputPixels: this.maxInputPixels,
        sequentialRead: true,
      }).metadata();
    } catch (error) {
      throw new InvalidImageError(error instanceof Error ? error.message : 'Image cannot be decoded.');
    }

    const mimeType = SHARP_FORMAT_TO_MIME[metadata.format as keyof typeof SHARP_FORMAT_TO_MIME];
    const width = metadata.autoOrient.width;
    const height = metadata.autoOrient.height;
    const pages = metadata.pages ?? 1;
    if (!mimeType || width <= 0 || height <= 0 || pages <= 0 || pages > this.maxPages) {
      throw new InvalidImageError('Image metadata is unsupported or exceeds safety limits.');
    }
    return { format: metadata.format, height, mimeType, pages, width };
  }

  public async createThumbnail(options: {
    dataRoot: string;
    destinationPath: string;
    inputPath: string;
    signal?: AbortSignal;
    temporaryDirectory: string;
  }): Promise<StagedFile> {
    options.signal?.throwIfAborted();
    const output = await sharp(options.inputPath, {
      autoOrient: true,
      failOn: 'warning',
      limitInputPixels: this.maxInputPixels,
      pages: 1,
      sequentialRead: true,
    })
      .resize(this.thumbnailSize, this.thumbnailSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ effort: 4, quality: 82 })
      .toBuffer();
    options.signal?.throwIfAborted();
    const staged = await stageBuffer({
      bytes: output,
      dataRoot: options.dataRoot,
      maxBytes: 16 * 1024 * 1024,
      temporaryDirectory: options.temporaryDirectory,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      options.signal?.throwIfAborted();
      await commitStagedFile(options.dataRoot, staged, options.destinationPath, options.signal);
      return staged;
    } catch (error) {
      await discardStagedFile(staged);
      throw error;
    }
  }

  public async inspectMask(filePath: string): Promise<DecodedMaskMetadata> {
    let decoded: Awaited<
      ReturnType<ReturnType<ReturnType<ReturnType<typeof sharp>['ensureAlpha']>['raw']>['toBuffer']>
    >;
    try {
      decoded = await sharp(filePath, {
        autoOrient: true,
        failOn: 'warning',
        limitInputPixels: this.maxInputPixels,
        pages: 1,
        sequentialRead: true,
      })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new InvalidImageError(error instanceof Error ? error.message : 'Mask cannot be decoded.');
    }

    const coverage = classifyMaskRgba(decoded.data);
    assertUsableMaskCoverage(coverage);
    return {
      coverage,
      height: decoded.info.height,
      width: decoded.info.width,
    };
  }
}
