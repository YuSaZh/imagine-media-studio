import type { AssetInput, GenerationRequest, MediaOperation } from '@imagine/shared';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ImageInputConstraints {
  /** Normalized image MIME types accepted by the model. */
  mimeTypes?: readonly string[];
  maxBytes?: number;
  maxPixels?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface ModelCapabilities {
  operations: readonly MediaOperation[];
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  durations?: readonly number[] | { readonly min: number; readonly max: number };
  maxReferenceImages?: number;
  inputImageConstraints?: ImageInputConstraints;
  supportsMask?: boolean;
  supportsNegativePrompt?: boolean;
  supportsSeed?: boolean;
  supportsAudio?: boolean;
  supportsProgress?: boolean;
  supportsCancel?: boolean;
  supportsBatchCount?: boolean;
  maxBatchCount?: number;
  customFields?: JsonSchema;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  capabilities: ModelCapabilities;
}

export interface ProviderCapabilities {
  providerType: string;
  models: readonly ProviderModel[];
}

export interface ProviderInput {
  assetId: string;
  role: AssetInput['role'];
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Persisted relationship metadata verified by the input loader. */
  parentAssetId?: string | null;
  width?: number;
  height?: number;
  fileSize?: number;
  sha256?: string;
}

export interface ProviderContext {
  providerId: string;
  jobId?: string;
  /** Original request model, available to durable poll/recovery operations. */
  modelId?: string;
  idempotencyKey?: string;
  attempt?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  config?: Readonly<Record<string, unknown>>;
  inputs?: readonly ProviderInput[];
  secrets: Readonly<Record<string, string>>;
}

interface SubmittedAssetBase {
  type: 'image' | 'video';
  mimeType: string;
  resultId?: string;
  filename?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type SubmittedAsset =
  | (SubmittedAssetBase & {
      source: 'base64';
      base64: string;
    })
  | (SubmittedAssetBase & {
      source: 'url';
      url: string;
    })
  /**
   * A provider-owned result that must be resolved with the current provider
   * context before materialization. Credentials never belong in this value.
   */
  | (SubmittedAssetBase & {
      source: 'provider';
      providerId: string;
      remoteJobId: string;
      variant: 'video';
      /** Keeps legacy image-only source narrowing source-compatible. */
      url?: never;
    });

export type ProviderAssetReference = Extract<SubmittedAsset, { source: 'provider' }>;

/** Ephemeral target returned by an adapter; never persist this object. */
export interface ProviderResultTarget {
  url: string;
  headers?: Readonly<Record<string, string>>;
  claimedMimeType?: string;
}

export type SubmitResult =
  | {
      state: 'completed';
      assets: readonly SubmittedAsset[];
      resultExpiresAt?: Date;
    }
  | {
      state: 'pending';
      remoteJobId: string;
      pollAfterMs?: number;
      /** Provider result/download expiry, if supplied by the upstream API. */
      resultExpiresAt?: Date;
    };

export type PollResult =
  | {
      state: 'remote_pending' | 'remote_running';
      progress?: number;
      pollAfterMs?: number;
      resultExpiresAt?: Date;
    }
  | { state: 'completed'; assets: readonly SubmittedAsset[]; resultExpiresAt?: Date }
  | { state: 'failed'; error: ProviderError };

export type ProviderErrorKind = 'expired' | 'rejected' | 'transient' | 'unknown';

export interface ProviderError {
  code: string;
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ProviderAdapter {
  readonly type: string;

  getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  /** Verify endpoint and authentication without starting a media operation. */
  testConnection?(context: ProviderContext): Promise<void>;
  validate(request: GenerationRequest, context: ProviderContext): Promise<void>;
  submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult>;
  poll?(remoteJobId: string, context: ProviderContext): Promise<PollResult>;
  cancel?(remoteJobId: string, context: ProviderContext): Promise<void>;
  /** Resolve a provider-owned result into an ephemeral authenticated target. */
  resolveResult?(asset: ProviderAssetReference, context: ProviderContext): Promise<ProviderResultTarget>;
  normalizeError(error: unknown): ProviderError;
}
