import { randomUUID } from 'node:crypto';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  commitStagedFile,
  discardStagedFile,
  stageBuffer,
  stageReadable,
  type StagedFile,
} from '../storage/atomic-file.js';
import { assertNoSymlinkTraversal, resolveStoredPath, toStoredPath } from '../storage/path-safety.js';
import type { StoragePaths } from '../storage/paths.js';
import type { RemoteMediaDownloader } from '../security/remote-download.js';
import type { SharpImageProcessor } from './image-processor.js';
import { detectAllowedMedia, mimeTypeForDerivedVariant, type AllowedMediaType } from './mime.js';
import type {
  AssetDelivery,
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  AssetVariant,
  Base64MediaInput,
  MediaSourceInput,
  NewAssetMediaRecord,
  UploadMediaInput,
  UrlMediaInput,
} from './types.js';
import type { VideoProcessor } from './video-processor.js';

export class InvalidBase64MediaError extends Error {
  public override readonly name = 'InvalidBase64MediaError';
}

export interface AssetMediaServiceOptions {
  imageProcessor: SharpImageProcessor;
  maxBytes?: number;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  paths: StoragePaths;
  remoteDownloader?: RemoteMediaDownloader;
  repository: AssetMediaRepositoryPort;
  videoProcessor: VideoProcessor;
}

interface PreparedMedia {
  mediaType: AllowedMediaType;
  staged: StagedFile;
}

function parseBase64(input: string, maxBytes: number): { bytes: Buffer; claimedMimeType?: string } {
  let value = input;
  let claimedMimeType: string | undefined;
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(input);
  if (dataUrl !== null) {
    claimedMimeType = dataUrl[1];
    value = dataUrl[2] ?? '';
  }
  if (
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new InvalidBase64MediaError('Media payload is not valid canonical Base64.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new InvalidBase64MediaError(`Media payload exceeds the ${maxBytes} byte limit.`);
  }
  return claimedMimeType === undefined ? { bytes } : { bytes, claimedMimeType };
}

function targetDirectory(paths: StoragePaths, input: MediaSourceInput): string {
  if (input.role === 'output') return paths.originals;
  if (input.role === 'mask') return paths.masks;
  return paths.uploads;
}

async function removeIfPresent(path: string | null): Promise<void> {
  if (path !== null) await unlink(path).catch(() => undefined);
}

export class AssetMediaService {
  private readonly imageProcessor: SharpImageProcessor;
  private readonly maxImageBytes: number;
  private readonly maxVideoBytes: number;
  private readonly paths: StoragePaths;
  private readonly remoteDownloader: RemoteMediaDownloader | undefined;
  private readonly repository: AssetMediaRepositoryPort;
  private readonly videoProcessor: VideoProcessor;

  public constructor(options: AssetMediaServiceOptions) {
    this.imageProcessor = options.imageProcessor;
    const defaultMaxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.maxImageBytes = options.maxImageBytes ?? defaultMaxBytes;
    this.maxVideoBytes = options.maxVideoBytes ?? defaultMaxBytes;
    this.paths = options.paths;
    this.remoteDownloader = options.remoteDownloader;
    this.repository = options.repository;
    this.videoProcessor = options.videoProcessor;
  }

  public async materializeUpload(input: UploadMediaInput): Promise<AssetMediaRecord> {
    const staged = await stageReadable({
      dataRoot: this.paths.root,
      maxBytes: this.maximumBytes,
      source: input.source,
      temporaryDirectory: this.paths.temporary,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return this.finalize(input, {
      mediaType: await this.detectOrDiscard(staged, input),
      staged,
    });
  }

  public async materializeBase64(input: Base64MediaInput): Promise<AssetMediaRecord> {
    const parsed = parseBase64(input.base64, this.maximumBytes);
    const staged = await stageBuffer({
      bytes: parsed.bytes,
      dataRoot: this.paths.root,
      maxBytes: this.maximumBytes,
      temporaryDirectory: this.paths.temporary,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const claimedMimeType = input.claimedMimeType ?? parsed.claimedMimeType;
    return this.finalize(input, {
      mediaType: await this.detectOrDiscard(staged, {
        ...input,
        ...(claimedMimeType === undefined ? {} : { claimedMimeType }),
      }),
      staged,
    });
  }

  public async materializeUrl(input: UrlMediaInput): Promise<AssetMediaRecord> {
    if (this.remoteDownloader === undefined) {
      throw new Error('Remote media download is not configured.');
    }
    const downloaded = await this.remoteDownloader.download({
      dataRoot: this.paths.root,
      maxBytes: input.expectedKind === undefined
        ? this.maximumBytes
        : this.maxBytesFor(input.expectedKind),
      temporaryDirectory: this.paths.temporary,
      url: input.url,
      ...(input.claimedMimeType === undefined ? {} : { claimedMimeType: input.claimedMimeType }),
      ...(input.expectedKind === undefined ? {} : { expectedKind: input.expectedKind }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return this.finalize(input, { mediaType: downloaded.mediaType, staged: downloaded.staged });
  }

  public async getDelivery(id: string, variant: AssetVariant): Promise<AssetDelivery | null> {
    const asset = await this.repository.get(id);
    if (asset === null || asset.deletedAt !== null) return null;
    const storedPath =
      variant === 'content'
        ? asset.filePath
        : variant === 'thumbnail'
          ? asset.thumbnailPath
          : asset.posterPath;
    if (storedPath === null) return null;
    const absolutePath = resolveStoredPath(this.paths.root, storedPath);
    let file;
    try {
      await assertNoSymlinkTraversal(this.paths.root, absolutePath, false);
      file = await stat(absolutePath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (!file.isFile()) return null;
    return {
      absolutePath,
      asset,
      etag: `"${asset.sha256}-${variant}"`,
      fileSize: file.size,
      lastModified: file.mtime,
      mimeType: variant === 'content' ? asset.mimeType : mimeTypeForDerivedVariant(variant),
      variant,
    };
  }

  public async softDelete(id: string): Promise<boolean> {
    return this.repository.softDelete(id);
  }

  private async detectOrDiscard(staged: StagedFile, input: MediaSourceInput) {
    try {
      return await detectAllowedMedia(staged.prefix, {
        ...(input.claimedMimeType === undefined ? {} : { claimedMimeType: input.claimedMimeType }),
        ...(input.expectedKind === undefined ? {} : { expectedKind: input.expectedKind }),
      });
    } catch (error) {
      await discardStagedFile(staged);
      throw error;
    }
  }

  private async finalize(
    input: MediaSourceInput,
    prepared: PreparedMedia,
  ): Promise<AssetMediaRecord> {
    const mediaMaxBytes = this.maxBytesFor(prepared.mediaType.kind);
    if (prepared.staged.bytes > mediaMaxBytes) {
      await discardStagedFile(prepared.staged);
      throw new Error(
        `${prepared.mediaType.kind} media exceeds the ${mediaMaxBytes} byte limit.`,
      );
    }
    const basename = randomUUID();
    const contentPath = join(targetDirectory(this.paths, input), `${basename}.${prepared.mediaType.extension}`);
    const thumbnailPath =
      prepared.mediaType.kind === 'image' ? join(this.paths.thumbnails, `${basename}.webp`) : null;
    const posterPath =
      prepared.mediaType.kind === 'video' ? join(this.paths.posters, `${basename}.jpg`) : null;
    let committedContent = false;
    try {
      await commitStagedFile(this.paths.root, prepared.staged, contentPath);
      committedContent = true;
      if (prepared.mediaType.kind === 'image') {
        const metadata = await this.imageProcessor.inspect(contentPath);
        if (metadata.mimeType !== prepared.mediaType.mimeType) {
          throw new Error('Image decoder format does not match the detected media signature.');
        }
        await this.imageProcessor.createThumbnail({
          dataRoot: this.paths.root,
          destinationPath: thumbnailPath!,
          inputPath: contentPath,
          temporaryDirectory: this.paths.temporary,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return await this.repository.create(
          this.recordInput(input, prepared, contentPath, {
            durationMs: null,
            height: metadata.height,
            metadata: { format: metadata.format, pages: metadata.pages },
            posterPath: null,
            thumbnailPath,
            width: metadata.width,
          }),
        );
      }

      const metadata = await this.videoProcessor.probe(contentPath, input.signal);
      await this.videoProcessor.createPoster({
        dataRoot: this.paths.root,
        destinationPath: posterPath!,
        inputPath: contentPath,
        metadata,
        temporaryDirectory: this.paths.temporary,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return await this.repository.create(
        this.recordInput(input, prepared, contentPath, {
          durationMs: metadata.durationMs,
          height: metadata.height,
          metadata: { codec: metadata.codec, format: metadata.format },
          posterPath,
          thumbnailPath: null,
          width: metadata.width,
        }),
      );
    } catch (error) {
      if (!committedContent) await discardStagedFile(prepared.staged);
      await Promise.all([
        removeIfPresent(committedContent ? contentPath : null),
        removeIfPresent(thumbnailPath),
        removeIfPresent(posterPath),
      ]);
      throw error;
    }
  }

  private get maximumBytes(): number {
    return Math.max(this.maxImageBytes, this.maxVideoBytes);
  }

  private maxBytesFor(kind: 'image' | 'video'): number {
    return kind === 'image' ? this.maxImageBytes : this.maxVideoBytes;
  }

  private recordInput(
    input: MediaSourceInput,
    prepared: PreparedMedia,
    contentPath: string,
    derived: Pick<
      NewAssetMediaRecord,
      'durationMs' | 'height' | 'metadata' | 'posterPath' | 'thumbnailPath' | 'width'
    >,
  ): NewAssetMediaRecord {
    return {
      ...derived,
      filePath: toStoredPath(this.paths.root, contentPath),
      fileSize: prepared.staged.bytes,
      jobId: input.jobId ?? null,
      mimeType: prepared.mediaType.mimeType,
      originalFilename: input.originalFilename ?? null,
      parentAssetId: input.parentAssetId ?? null,
      posterPath:
        derived.posterPath === null ? null : toStoredPath(this.paths.root, derived.posterPath),
      role: input.role,
      sha256: prepared.staged.sha256,
      thumbnailPath:
        derived.thumbnailPath === null
          ? null
          : toStoredPath(this.paths.root, derived.thumbnailPath),
      type: prepared.mediaType.kind,
    };
  }
}
