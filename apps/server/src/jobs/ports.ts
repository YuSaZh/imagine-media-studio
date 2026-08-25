import type {
  ProviderAdapter,
  ProviderError,
  SubmittedAsset,
} from '@imagine/provider-contract';
import type { GenerationRequest, JobStatus } from '@imagine/shared';

export interface RunnerJob {
  id: string;
  request: GenerationRequest;
  status: JobStatus;
  stage: string;
  progress: number | null;
  revision: number;
  idempotencyKey: string;
  attempt: number;
  remoteJobId: string | null;
  pollAfterAt: Date | null;
  resultAssets: readonly SubmittedAsset[];
  materializedAssets: readonly MaterializedAsset[];
  error: ProviderError | null;
}

export interface MaterializedAsset {
  type: 'image' | 'video';
  mimeType: string;
  filePath: string;
  thumbnailPath?: string | null;
  posterPath?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  materializationKey?: string;
  sourceFingerprint?: string;
  fileSize: number;
  sha256: string;
  resultId?: string;
  filename?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RunnerEvent {
  id: number | string;
  aggregateType: 'job';
  aggregateId: string;
  eventType: string;
  revision: number;
  payload: Readonly<Record<string, unknown>>;
}

export interface JobTransitionCommit {
  job: RunnerJob;
  /** This event must already be committed durably with the job mutation. */
  event: RunnerEvent;
}

export interface JobTransitionInput {
  expectedStatuses: readonly JobStatus[];
  expectedRevision: number;
  status: JobStatus;
  stage: string;
  progress?: number | null;
  remoteJobId?: string | null;
  pollAfterAt?: Date | null;
  resultAssets?: readonly SubmittedAsset[];
  materializedAssets?: readonly MaterializedAsset[];
  error?: ProviderError | null;
  incrementAttempt?: boolean;
}

export interface RunnerJobPort {
  get(jobId: string): Promise<RunnerJob | null>;
  listRecoverable(): Promise<readonly RunnerJob[]>;
  claimQueued(jobId: string, expectedRevision: number): Promise<JobTransitionCommit | null>;
  transition(jobId: string, input: JobTransitionInput): Promise<JobTransitionCommit | null>;
}

export interface RunnerAssetPort {
  outputsConsistent(jobId: string): Promise<boolean>;
  /**
   * Persist assets and CAS the job from processing to completed in one transaction.
   * The returned event must be part of that same transaction.
   */
  finalize(
    jobId: string,
    expectedRevision: number,
    assets: readonly MaterializedAsset[],
  ): Promise<JobTransitionCommit | null>;
}

export interface RunnerEventPort {
  /** Notify live subscribers after the durable event transaction commits. */
  publish(event: RunnerEvent): Promise<void> | void;
}

export interface ProviderRegistration {
  adapter: ProviderAdapter;
  secrets: Readonly<Record<string, string>>;
  /** True only when repeating submit with the same idempotency key is supported. */
  submitReplaySafe: boolean;
}

export interface ProviderRegistryPort {
  resolve(providerId: string): Promise<ProviderRegistration> | ProviderRegistration;
}

export interface MediaMaterializerPort {
  /** Resolve both base64 and remote URL results into durable originals. */
  materialize(
    job: RunnerJob,
    assets: readonly SubmittedAsset[],
    signal: AbortSignal,
  ): Promise<readonly MaterializedAsset[]>;
  /** Generate any derived media while keeping the originals immutable. */
  process(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
    signal: AbortSignal,
  ): Promise<readonly MaterializedAsset[]>;
  /** Delete provisional files after cancellation, failed CAS, or partial materialization. */
  discard?(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void>;
  /** Release provisional markers after the Asset transaction commits. */
  finalized?(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void>;
}

export interface RunnerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface JobRunnerOptions {
  jobs: RunnerJobPort;
  assets: RunnerAssetPort;
  events: RunnerEventPort;
  providers: ProviderRegistryPort;
  media: MediaMaterializerPort;
  clock?: RunnerClock;
  concurrency?: {
    imageSubmit?: number;
    videoSubmit?: number;
    poll?: number;
    download?: number;
    process?: number;
  };
  maxAttempts?: number;
  defaultPollAfterMs?: number;
  defaultRetryAfterMs?: number;
}
