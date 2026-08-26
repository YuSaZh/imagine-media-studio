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
  get(id: string, includeDeleted?: boolean): AssetMediaRecord | null | Promise<AssetMediaRecord | null>;
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

export interface ProviderOutputMediaInput {
  claimedMimeType?: string;
  expectedKind: MediaKind;
  jobId: string;
  originalFilename?: string | null;
  outputSlot: number;
  resultId?: string;
  signal?: AbortSignal;
}

export interface ProviderOutputBase64Input extends ProviderOutputMediaInput {
  base64: string;
}

export interface ProviderOutputUrlInput extends ProviderOutputMediaInput {
  headers?: Readonly<Record<string, string>>;
  /** Selects the provider-scoped NetworkPolicy instead of public media policy. */
  providerOwned?: boolean;
  url: string;
}

export interface ProviderOutputMediaRecord {
  durationMs: number | null;
  filePath: string;
  fileSize: number;
  height: number | null;
  materializationKey: string;
  metadata: Readonly<Record<string, unknown>>;
  mimeType: string;
  originalFilename: string | null;
  posterPath: string | null;
  sha256: string;
  sourceFingerprint: string;
  thumbnailPath: string | null;
  type: MediaKind;
  width: number | null;
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
