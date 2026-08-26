import type { AssetInput } from '@imagine/shared';

export type ComposerInputRole = AssetInput['role'];
export type ReferenceUploadRole = Extract<AssetInput['role'], 'reference' | 'first_frame'>;
export type UploadStatus = 'error' | 'preprocessing' | 'queued' | 'ready' | 'uploading';

export interface AcquiredImage {
  clientId: string;
  file: File;
  fingerprint: string;
}

export interface ImageAssetInputDescriptor {
  readonly fileSize: number;
  readonly height: number;
  readonly mimeType: string;
  readonly width: number;
}

export type AcquisitionRejectReason =
  | 'directory'
  | 'duplicate'
  | 'empty'
  | 'file_too_large'
  | 'item_limit'
  | 'normalized_type_unsupported'
  | 'preview_failed'
  | 'total_too_large'
  | 'unsupported_type';

export interface AcquisitionRejection {
  name: string;
  reason: AcquisitionRejectReason;
}

export interface UploadEntry extends AcquiredImage {
  assetId: string | null;
  attempt: number;
  error: string | null;
  inputDescriptor: ImageAssetInputDescriptor | null;
  previewUrl: string;
  role: ReferenceUploadRole;
  status: UploadStatus;
}

export interface MediaInputState {
  entries: readonly UploadEntry[];
  rejections: readonly AcquisitionRejection[];
}
