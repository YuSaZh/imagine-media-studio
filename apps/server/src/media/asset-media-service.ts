import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

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
import {
  allowedMediaType,
  detectAllowedMedia,
  mimeTypeForDerivedVariant,
  normalizeMimeType,
  type AllowedMediaType,
} from './mime.js';
import type {
  AssetDelivery,
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  AssetVariant,
  Base64MediaInput,
  MediaSourceInput,
  NewAssetMediaRecord,
  ProviderOutputBase64Input,
  ProviderOutputMediaInput,
  ProviderOutputMediaRecord,
  ProviderOutputUrlInput,
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

const PROVIDER_OUTPUT_EXTENSIONS = ['avif', 'gif', 'jpg', 'mov', 'mp4', 'png', 'webm', 'webp'] as const;

const ProviderOutputManifestSchema = z.object({
  version: z.literal(1),
  durationMs: z.number().int().nonnegative().nullable(),
  filePath: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  height: z.number().int().positive().nullable(),
  materializationKey: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  mimeType: z.string().min(1),
  originalFilename: z.string().nullable(),
  posterPath: z.string().nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  thumbnailPath: z.string().nullable(),
  type: z.enum(['image', 'video']),
  width: z.number().int().positive().nullable(),
}).strict();

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function providerJobKey(jobId: string): string {
  return sha256Text(`imagine-provider-output-v1\0${jobId}`);
}

function assertOutputSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new RangeError('Provider output slot must be a non-negative safe integer.');
  }
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

  public async materializeProviderBase64(
    input: ProviderOutputBase64Input,
  ): Promise<ProviderOutputMediaRecord> {
    assertOutputSlot(input.outputSlot);
    const parsed = parseBase64(input.base64, this.maxBytesFor(input.expectedKind));
    const claimedMimeType = input.claimedMimeType ?? parsed.claimedMimeType;
    const sourceFingerprint = this.providerSourceFingerprint(input, sha256Text(input.base64));
    const reusable = await this.readReusableProviderOutput(
      input,
      sourceFingerprint,
      claimedMimeType,
    );
    if (reusable !== null) return reusable;
    const staged = await stageBuffer({
      bytes: parsed.bytes,
      dataRoot: this.paths.root,
      maxBytes: this.maxBytesFor(input.expectedKind),
      temporaryDirectory: this.paths.temporary,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const prepared = {
      mediaType: await this.detectOrDiscard(staged, {
        role: 'output',
        expectedKind: input.expectedKind,
        ...(claimedMimeType === undefined ? {} : { claimedMimeType }),
      }),
      staged,
    };
    return this.finalizeProviderOutput(input, prepared, sourceFingerprint);
  }

  public async materializeProviderUrl(
    input: ProviderOutputUrlInput,
  ): Promise<ProviderOutputMediaRecord> {
    assertOutputSlot(input.outputSlot);
    const sourceFingerprint = this.providerSourceFingerprint(input, sha256Text(input.url));
    const reusable = await this.readReusableProviderOutput(
      input,
      sourceFingerprint,
      input.claimedMimeType,
    );
    if (reusable !== null) return reusable;
    if (this.remoteDownloader === undefined) {
      throw new Error('Remote media download is not configured.');
    }
    const downloaded = await this.remoteDownloader.download({
      dataRoot: this.paths.root,
      maxBytes: this.maxBytesFor(input.expectedKind),
      temporaryDirectory: this.paths.temporary,
      url: input.url,
      ...(input.claimedMimeType === undefined ? {} : { claimedMimeType: input.claimedMimeType }),
      expectedKind: input.expectedKind,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return this.finalizeProviderOutput(
      input,
      { mediaType: downloaded.mediaType, staged: downloaded.staged },
      sourceFingerprint,
    );
  }

  public async validateProviderOutputs(
    jobId: string,
    records: readonly ProviderOutputMediaRecord[],
  ): Promise<boolean> {
    for (const [slot, record] of records.entries()) {
      if (!await this.isReusableProviderOutput(jobId, slot, record)) return false;
    }
    return records.length > 0;
  }

  public async cleanupProviderOutputs(jobId: string, outputCount: number): Promise<void> {
    if (!Number.isSafeInteger(outputCount) || outputCount < 0) {
      throw new RangeError('Provider output count must be a non-negative safe integer.');
    }
    await Promise.all(
      Array.from({ length: outputCount }, (_, slot) => this.cleanupProviderOutputSlot(jobId, slot)),
    );
  }

  public async releaseProviderOutputs(jobId: string, outputCount: number): Promise<void> {
    if (!Number.isSafeInteger(outputCount) || outputCount < 0) {
      throw new RangeError('Provider output count must be a non-negative safe integer.');
    }
    await Promise.all(
      Array.from({ length: outputCount }, (_, slot) =>
        unlink(this.providerManifestPath(jobId, slot)).catch(() => undefined),
      ),
    );
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

  private providerSourceFingerprint(input: ProviderOutputMediaInput, sourceHash: string): string {
    return sha256Text(JSON.stringify({
      version: 1,
      expectedKind: input.expectedKind,
      claimedMimeType: input.claimedMimeType ?? null,
      resultId: input.resultId ?? null,
      sourceHash,
    }));
  }

  private providerBasename(jobId: string, slot: number): string {
    assertOutputSlot(slot);
    return `job-${providerJobKey(jobId)}-slot-${String(slot).padStart(4, '0')}`;
  }

  private providerManifestPath(jobId: string, slot: number): string {
    return join(
      this.paths.temporary,
      'provider-results',
      providerJobKey(jobId),
      `slot-${String(slot).padStart(4, '0')}.json`,
    );
  }

  private providerOutputPaths(jobId: string, slot: number, extension: string) {
    const basename = this.providerBasename(jobId, slot);
    return {
      contentPath: join(this.paths.originals, `${basename}.${extension}`),
      posterPath: join(this.paths.posters, `${basename}.jpg`),
      thumbnailPath: join(this.paths.thumbnails, `${basename}.webp`),
    };
  }

  private async readReusableProviderOutput(
    input: ProviderOutputMediaInput,
    sourceFingerprint: string,
    claimedMimeType: string | undefined,
  ): Promise<ProviderOutputMediaRecord | null> {
    const manifestPath = this.providerManifestPath(input.jobId, input.outputSlot);
    try {
      await assertNoSymlinkTraversal(this.paths.root, manifestPath, false);
      const parsed = ProviderOutputManifestSchema.parse(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      if (
        parsed.sourceFingerprint !== sourceFingerprint ||
        parsed.type !== input.expectedKind ||
        !this.claimedTypeMatches(claimedMimeType, parsed.mimeType) ||
        !await this.isReusableProviderOutput(input.jobId, input.outputSlot, parsed)
      ) {
        await this.cleanupProviderOutputSlot(input.jobId, input.outputSlot);
        return null;
      }
      const { version: _version, ...record } = parsed;
      return record;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      await this.cleanupProviderOutputSlot(input.jobId, input.outputSlot);
      return null;
    }
  }

  private claimedTypeMatches(claimedMimeType: string | undefined, actualMimeType: string): boolean {
    if (claimedMimeType === undefined) return true;
    const claimed = normalizeMimeType(claimedMimeType);
    return claimed === 'application/octet-stream' || claimed === actualMimeType;
  }

  private async isReusableProviderOutput(
    jobId: string,
    slot: number,
    record: ProviderOutputMediaRecord,
  ): Promise<boolean> {
    const allowed = allowedMediaType(record.mimeType);
    if (!allowed || allowed.kind !== record.type) return false;
    const paths = this.providerOutputPaths(jobId, slot, allowed.extension);
    if (
      record.materializationKey !== `${providerJobKey(jobId)}:${slot}` ||
      record.filePath !== toStoredPath(this.paths.root, paths.contentPath) ||
      record.thumbnailPath !== (record.type === 'image'
        ? toStoredPath(this.paths.root, paths.thumbnailPath)
        : null) ||
      record.posterPath !== (record.type === 'video'
        ? toStoredPath(this.paths.root, paths.posterPath)
        : null)
    ) {
      return false;
    }
    try {
      await assertNoSymlinkTraversal(this.paths.root, paths.contentPath, false);
      const content = await stat(paths.contentPath);
      if (!content.isFile() || content.size !== record.fileSize) return false;
      if (await sha256File(paths.contentPath) !== record.sha256) return false;
      const derivedPath = record.type === 'image' ? paths.thumbnailPath : paths.posterPath;
      await assertNoSymlinkTraversal(this.paths.root, derivedPath, false);
      const derived = await stat(derivedPath);
      return derived.isFile();
    } catch {
      return false;
    }
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

  private async finalizeProviderOutput(
    input: ProviderOutputMediaInput,
    prepared: PreparedMedia,
    sourceFingerprint: string,
  ): Promise<ProviderOutputMediaRecord> {
    const paths = this.providerOutputPaths(
      input.jobId,
      input.outputSlot,
      prepared.mediaType.extension,
    );
    await this.cleanupProviderOutputSlot(input.jobId, input.outputSlot);
    let committedContent = false;
    try {
      input.signal?.throwIfAborted();
      await commitStagedFile(this.paths.root, prepared.staged, paths.contentPath);
      committedContent = true;
      let record: ProviderOutputMediaRecord;
      if (prepared.mediaType.kind === 'image') {
        const metadata = await this.imageProcessor.inspect(paths.contentPath);
        if (metadata.mimeType !== prepared.mediaType.mimeType) {
          throw new Error('Image decoder format does not match the detected media signature.');
        }
        await this.imageProcessor.createThumbnail({
          dataRoot: this.paths.root,
          destinationPath: paths.thumbnailPath,
          inputPath: paths.contentPath,
          temporaryDirectory: this.paths.temporary,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        record = {
          durationMs: null,
          filePath: toStoredPath(this.paths.root, paths.contentPath),
          fileSize: prepared.staged.bytes,
          height: metadata.height,
          materializationKey: `${providerJobKey(input.jobId)}:${input.outputSlot}`,
          metadata: { format: metadata.format, pages: metadata.pages },
          mimeType: prepared.mediaType.mimeType,
          originalFilename: input.originalFilename ?? null,
          posterPath: null,
          sha256: prepared.staged.sha256,
          sourceFingerprint,
          thumbnailPath: toStoredPath(this.paths.root, paths.thumbnailPath),
          type: 'image',
          width: metadata.width,
        };
      } else {
        const metadata = await this.videoProcessor.probe(paths.contentPath, input.signal);
        await this.videoProcessor.createPoster({
          dataRoot: this.paths.root,
          destinationPath: paths.posterPath,
          inputPath: paths.contentPath,
          metadata,
          temporaryDirectory: this.paths.temporary,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        record = {
          durationMs: metadata.durationMs,
          filePath: toStoredPath(this.paths.root, paths.contentPath),
          fileSize: prepared.staged.bytes,
          height: metadata.height,
          materializationKey: `${providerJobKey(input.jobId)}:${input.outputSlot}`,
          metadata: { codec: metadata.codec, format: metadata.format },
          mimeType: prepared.mediaType.mimeType,
          originalFilename: input.originalFilename ?? null,
          posterPath: toStoredPath(this.paths.root, paths.posterPath),
          sha256: prepared.staged.sha256,
          sourceFingerprint,
          thumbnailPath: null,
          type: 'video',
          width: metadata.width,
        };
      }
      await this.writeProviderManifest(input.jobId, input.outputSlot, record);
      return record;
    } catch (error) {
      if (!committedContent) await discardStagedFile(prepared.staged).catch(() => undefined);
      await this.cleanupProviderOutputSlot(input.jobId, input.outputSlot);
      throw error;
    }
  }

  private async writeProviderManifest(
    jobId: string,
    slot: number,
    record: ProviderOutputMediaRecord,
  ): Promise<void> {
    const manifestPath = this.providerManifestPath(jobId, slot);
    const manifestDirectory = join(
      this.paths.temporary,
      'provider-results',
      providerJobKey(jobId),
    );
    await assertNoSymlinkTraversal(this.paths.root, manifestDirectory, true);
    await mkdir(manifestDirectory, {
      recursive: true,
      mode: 0o700,
    });
    await assertNoSymlinkTraversal(this.paths.root, manifestDirectory, false);
    await assertNoSymlinkTraversal(this.paths.root, manifestPath, true);
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, ...record }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
  }

  private async cleanupProviderOutputSlot(jobId: string, slot: number): Promise<void> {
    const basename = this.providerBasename(jobId, slot);
    await Promise.all([
      ...PROVIDER_OUTPUT_EXTENSIONS.map((extension) =>
        unlink(join(this.paths.originals, `${basename}.${extension}`)).catch(() => undefined),
      ),
      unlink(join(this.paths.thumbnails, `${basename}.webp`)).catch(() => undefined),
      unlink(join(this.paths.posters, `${basename}.jpg`)).catch(() => undefined),
      unlink(this.providerManifestPath(jobId, slot)).catch(() => undefined),
    ]);
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
