import type { Readable } from 'node:stream';

export type MediaKind = 'image' | 'video';
export type AssetRole = 'first_frame' | 'last_frame' | 'mask' | 'output' | 'reference' | 'upload';

export interface ImageMediaMetadata {
  format: string;
  height: number;
  pages: number;
  width: number;
}

export interface VideoMediaMetadata {
  codec: string;
  durationMs: number;
  format: string;
  height: number;
  width: number;
}

export interface AssetMediaRecord {
  createdAt: Date;
  deletedAt: Date | null;
  durationMs: number | null;
  filePath: string;
  fileSize: number;
  height: number | null;
  id: string;
  jobId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  mimeType: string;
  originalFilename: string | null;
  parentAssetId: string | null;
  posterPath: string | null;
  role: AssetRole;
  sha256: string;
  thumbnailPath: string | null;
  type: MediaKind;
  width: number | null;
}

export type NewAssetMediaRecord = Omit<AssetMediaRecord, 'createdAt' | 'deletedAt' | 'id'>;

export interface AssetMediaRepositoryPort {
  create(input: NewAssetMediaRecord): AssetMediaRecord | Promise<AssetMediaRecord>;
  get(id: string): AssetMediaRecord | null | Promise<AssetMediaRecord | null>;
  listForMaintenance(): readonly AssetMediaRecord[] | Promise<readonly AssetMediaRecord[]>;
  softDelete(id: string): boolean | Promise<boolean>;
}

export interface MediaSourceInput {
  claimedMimeType?: string;
  expectedKind?: MediaKind;
  jobId?: string | null;
  originalFilename?: string | null;
  parentAssetId?: string | null;
  role: AssetRole;
  signal?: AbortSignal;
}

export interface UploadMediaInput extends MediaSourceInput {
  source: Readable;
}

export interface Base64MediaInput extends MediaSourceInput {
  base64: string;
}

export interface UrlMediaInput extends MediaSourceInput {
  headers?: Readonly<Record<string, string>>;
  url: string;
}

export type AssetVariant = 'content' | 'poster' | 'thumbnail';

export interface AssetDelivery {
  absolutePath: string;
  asset: AssetMediaRecord;
  etag: string;
  fileSize: number;
  lastModified: Date;
  mimeType: string;
  variant: AssetVariant;
}
