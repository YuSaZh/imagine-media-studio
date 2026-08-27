import type {
  ProviderAdapter,
  ProviderInput,
  ProviderError,
  ProviderHttpClientPort,
  ProviderResultTarget,
  SubmittedAsset,
} from '@imagine/provider-contract';
import type { CustomAdapterRef, GenerationRequest, JobStatus } from '@imagine/shared';

import type { StageRetryCounts } from './retry-budget.js';
export type { RetriableWorkKind, StageRetryCounts } from './retry-budget.js';

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
  /** Local maximum polling deadline persisted with the job. */
  remoteDeadlineAt: Date | null;
  /** Provider-declared downloadable result expiry persisted with the job. */
  resultExpiresAt: Date | null;
  pollAfterAt: Date | null;
  cancelRequestedAt: Date | null;
  resultAssets: readonly SubmittedAsset[];
  materializedAssets: readonly MaterializedAsset[];
  error: ProviderError | null;
  stageRetryCounts: StageRetryCounts;
  /** Immutable provider adapter definition snapshot captured at job creation. */
  adapterRef?: CustomAdapterRef | null;
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
  remoteDeadlineAt?: Date | null;
  resultExpiresAt?: Date | null;
  pollAfterAt?: Date | null;
  resultAssets?: readonly SubmittedAsset[];
  materializedAssets?: readonly MaterializedAsset[];
  error?: ProviderError | null;
  stageRetryCounts?: StageRetryCounts;
  incrementAttempt?: boolean;
}

export interface RunnerJobPort {
  get(jobId: string): Promise<RunnerJob | null>;
  listRecoverable(): Promise<readonly RunnerJob[]>;
  recoverCancellation(
    jobId: string,
    expectedRevision: number,
  ): Promise<JobTransitionCommit | null>;
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
  /**
   * The immutable adapter revision used to create this registration. Built-in
   * Provider profiles have no custom revision and use null.
   *
   * Optional for the legacy in-process test/PR0 adapter ports; production
   * registries should always return the normalized nullable value.
   */
  adapterRef?: CustomAdapterRef | null;
  /** Persisted provider endpoint, forwarded to every adapter operation. */
  baseUrl?: string;
  /** Persisted non-secret provider settings. Never contains decrypted credentials. */
  config?: Readonly<Record<string, unknown>>;
  /** Application-owned policy-checked HTTP port injected into the adapter context. */
  http?: ProviderHttpClientPort;
  /** True only when repeating submit with the same idempotency key is supported. */
  submitReplaySafe: boolean;
}

export interface ProviderRegistryPort {
  /**
   * Without a ref, resolve the Provider's current adapter for management and
   * new-job validation. A supplied ref is an exact durable Job snapshot and
   * must never fall back to the current revision.
   */
  resolve(
    providerId: string,
    adapterRef?: CustomAdapterRef | null,
  ): Promise<ProviderRegistration> | ProviderRegistration;
}

export interface ProviderInputLoaderPort {
  load(
    request: RunnerJob['request'],
    signal?: AbortSignal,
  ): Promise<readonly ProviderInput[]>;
}

export interface MediaMaterializerPort {
  /** Resolve both base64 and remote URL results into durable originals. */
  materialize(
    job: RunnerJob,
    assets: readonly SubmittedAsset[],
    signal: AbortSignal,
    resolveProviderAsset?: ProviderResultResolver,
  ): Promise<readonly MaterializedAsset[]>;
  /** Generate any derived media while keeping the originals immutable. */
  process(
    job: RunnerJob,
    assets: readonly MaterializedAsset[],
    signal: AbortSignal,
    resolveProviderAsset?: ProviderResultResolver,
  ): Promise<readonly MaterializedAsset[]>;
  /** Delete provisional files after cancellation, failed CAS, or partial materialization. */
  discard?(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void>;
  /** Release provisional markers after the Asset transaction commits. */
  finalized?(job: RunnerJob, assets: readonly MaterializedAsset[]): Promise<void>;
}

export type ProviderResultResolver = (
  asset: Extract<SubmittedAsset, { source: 'provider' }>,
  signal: AbortSignal,
) => Promise<ProviderResultTarget>;

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
  /** Loads and verifies persisted input bytes immediately before submit. */
  inputLoader?: ProviderInputLoaderPort;
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
  /** Local maximum polling deadline assigned to each pending remote job. */
  defaultRemoteDeadlineMs?: number;
}
