import type { GenerationRequest, MediaOperation } from '@imagine/shared';

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface ModelCapabilities {
  operations: readonly MediaOperation[];
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  durations?: readonly number[] | { readonly min: number; readonly max: number };
  maxReferenceImages?: number;
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

export interface ProviderContext {
  providerId: string;
  signal?: AbortSignal;
  secrets: Readonly<Record<string, string>>;
}

interface SubmittedAssetBase {
  type: 'image' | 'video';
  mimeType: string;
}

export type SubmittedAsset =
  | (SubmittedAssetBase & {
      source: 'base64';
      base64: string;
    })
  | (SubmittedAssetBase & {
      source: 'url';
      url: string;
    });

export type SubmitResult =
  | {
      state: 'completed';
      assets: readonly SubmittedAsset[];
    }
  | {
      state: 'pending';
      remoteJobId: string;
    };

export type PollResult =
  | { state: 'pending'; progress?: number }
  | { state: 'completed'; assets: readonly SubmittedAsset[] }
  | { state: 'failed'; error: ProviderError };

export interface ProviderError {
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

export interface ProviderAdapter {
  readonly type: string;

  getCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  validate(request: GenerationRequest, context: ProviderContext): Promise<void>;
  submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult>;
  poll?(remoteJobId: string, context: ProviderContext): Promise<PollResult>;
  cancel?(remoteJobId: string, context: ProviderContext): Promise<void>;
  normalizeError(error: unknown): ProviderError;
}
