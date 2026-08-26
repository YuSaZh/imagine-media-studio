import { createHash } from 'node:crypto';

import type { GenerationRequest } from '@imagine/shared';
import type {
  PollResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderInput,
  SubmitResult,
} from '@imagine/provider-contract';

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const MOCK_VIDEO_MP4_BASE64_PARTS = [
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMRbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAA',
  'AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAgAAAjt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA',
  'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGz',
  'bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl',
  'b0hhbmRsZXIAAAABXm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA',
  'AQAAAR5zdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAA',
  'AAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAe/+EAGGdCwB7ZAo35MBEAAAMAAQAA',
  'AwACDxYuSAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAFaAAABWgAAAAGHN0dHMAAAAAAAAAAQAAAAEA',
  'AEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAArQAAAABAAAAFHN0Y28AAAAAAAAAAQAAA0EA',
  'AABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAd',
  'ZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAACvG1kYXQAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAt',
  'IGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0g',
  'aHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDow',
  'IGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVf',
  'cmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9',
  'MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MyBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9',
  'MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAg',
  'd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhl',
  'YWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9y',
  'YXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAPGWIhAV///8PRQABQt8nJycnJycnJydddddddddddddddddddddddddddddddddd',
  'ddddddddddddddddeA==',
] as const;

export const MOCK_VIDEO_PROFILE = 'mock-video-v1' as const;
export const MOCK_VIDEO_MP4_BASE64 = MOCK_VIDEO_MP4_BASE64_PARTS.join('');
export const MOCK_VIDEO_MP4_SHA256 = '4d240737eeba324e5b3efcdc82738ba9555386f6d383d9fa233c6fae1db47361';
export const MOCK_VIDEO_PENDING_MS = 50;
export const MOCK_VIDEO_RUNNING_MS = 250;
export const MOCK_VIDEO_TRANSIENT_RETRY_MS = 500;

export type MockVideoScenario = 'success' | 'failed' | 'transient' | 'expired';

export interface MockProviderOptions {
  readonly clock?: () => number;
  /** Test-only scenario injection; production registry uses the success default. */
  readonly videoScenario?: MockVideoScenario;
}

export class MockProviderValidationError extends Error {
  public override readonly name = 'MockProviderValidationError';
}

const VIDEO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_OPERATIONS = new Set<GenerationRequest['operation']>([
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
]);
const ALLOWED_VIDEO_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);
const ALLOWED_VIDEO_DURATIONS = new Set([1, 5, 10]);
const REMOTE_ID_PATTERN = /^mock-video-(success|failed|transient|expired)-([0-9a-z]+)-([a-f0-9]{32})$/;

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function abortIfRequested(context: ProviderContext): void {
  context.signal?.throwIfAborted();
}

function countRole(request: GenerationRequest, role: GenerationRequest['inputs'][number]['role']): number {
  return request.inputs.filter((input) => input.role === role).length;
}

function inputForRequest(context: ProviderContext, requested: GenerationRequest['inputs'][number]): ProviderInput {
  const input = context.inputs?.find(
    (candidate) => candidate.assetId === requested.assetId && candidate.role === requested.role,
  );
  if (!input) {
    throw new MockProviderValidationError(
      'Mock video input ' + requested.assetId + ' was not loaded for role ' + requested.role + '.',
    );
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new MockProviderValidationError('Mock video input ' + requested.assetId + ' is empty.');
  }
  if (!VIDEO_MIME_TYPES.has(normalizeMimeType(input.mimeType))) {
    throw new MockProviderValidationError('Mock video input ' + requested.assetId + ' has an unsupported MIME type.');
  }
  if (input.bytes.byteLength > 8 * 1024 * 1024) {
    throw new MockProviderValidationError('Mock video input ' + requested.assetId + ' is too large.');
  }
  return input;
}

function remoteDigest(context: ProviderContext): string {
  const seed = context.idempotencyKey ?? context.jobId ?? 'preview';
  return createHash('sha256').update('mock-video-v1\\0' + seed).digest('hex').slice(0, 32);
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MockProviderValidationError('Mock video clock must return a non-negative safe integer.');
  }
}

function parseRemoteId(remoteJobId: string): {
  createdAt: number;
  digest: string;
  scenario: MockVideoScenario;
} {
  if (remoteJobId.length > 128) {
    throw new MockProviderValidationError('Mock video remote job ID is too long.');
  }
  const match = REMOTE_ID_PATTERN.exec(remoteJobId);
  if (!match) throw new MockProviderValidationError('Mock video remote job ID is invalid.');
  const scenario = match[1];
  const createdAt = Number.parseInt(match[2] ?? '', 36);
  const digest = match[3];
  if (
    (scenario !== 'success' && scenario !== 'failed' && scenario !== 'transient' && scenario !== 'expired') ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    digest === undefined
  ) {
    throw new MockProviderValidationError('Mock video remote job ID is invalid.');
  }
  return { createdAt, digest, scenario };
}

function createRemoteId(
  scenario: MockVideoScenario,
  createdAt: number,
  context: ProviderContext,
): string {
  return 'mock-video-' + scenario + '-' + createdAt.toString(36) + '-' + remoteDigest(context);
}

function videoAsset(remoteJobId: string) {
  return {
    metadata: { fixtureSha256: MOCK_VIDEO_MP4_SHA256, provider: 'mock' },
    mimeType: 'video/mp4' as const,
    resultId: remoteJobId,
    source: 'base64' as const,
    base64: MOCK_VIDEO_MP4_BASE64,
    type: 'video' as const,
  };
}

export class MockProviderAdapter implements ProviderAdapter {
  public readonly type = 'mock';
  private readonly clock: () => number;
  private readonly videoScenario: MockVideoScenario;

  public constructor(options: MockProviderOptions = {}) {
    this.clock = options.clock ?? Date.now;
    const scenario = options.videoScenario ?? 'success';
    if (!['success', 'failed', 'transient', 'expired'].includes(scenario)) {
      throw new MockProviderValidationError('The Mock Provider video scenario is invalid.');
    }
    this.videoScenario = scenario;
  }

  public async testConnection(_context: ProviderContext): Promise<void> {
    // The mock has no upstream endpoint; this keeps its connection check explicit.
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return {
      providerType: this.type,
      models: [
        {
          id: 'mock-image-v1',
          displayName: 'Mock Image',
          capabilities: {
            operations: ['image.generate', 'image.edit'],
            aspectRatios: ['1:1'],
            maxReferenceImages: 4,
            supportsMask: true,
            supportsBatchCount: false,
            inputImageConstraints: {
              mimeTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
              maxBytes: 32 * 1024 * 1024,
              maxPixels: 100_000_000,
              maxWidth: 16_384,
              maxHeight: 16_384,
            },
          },
        },
        {
          id: MOCK_VIDEO_PROFILE,
          displayName: 'Mock Video',
          capabilities: {
            operations: ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
            aspectRatios: ['16:9', '9:16', '1:1'],
            resolutions: ['720p'],
            durations: [1, 5, 10],
            maxReferenceImages: 4,
            inputImageConstraints: {
              mimeTypes: [...VIDEO_MIME_TYPES],
              maxBytes: 8 * 1024 * 1024,
            },
            supportsProgress: true,
            supportsCancel: true,
            supportsBatchCount: false,
            maxBatchCount: 1,
          },
        },
      ],
    };
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    if (request.providerId !== 'mock') {
      throw new MockProviderValidationError('The Mock Provider requires providerId mock.');
    }
    if (request.modelId === 'mock-image-v1') {
      this.validateImage(request);
      return;
    }
    if (request.modelId !== MOCK_VIDEO_PROFILE || !VIDEO_OPERATIONS.has(request.operation)) {
      throw new MockProviderValidationError(
        'The Mock Provider only supports mock-image-v1 and mock-video-v1 requests.',
      );
    }
    this.validateVideo(request, context);
  }

  private validateImage(request: GenerationRequest): void {
    if (!['image.generate', 'image.edit'].includes(request.operation) || request.modelId !== 'mock-image-v1') {
      throw new MockProviderValidationError(
        'The Mock Provider only supports mock-image-v1 image.generate and image.edit requests.',
      );
    }
    if (countRole(request, 'reference') > 4) {
      throw new MockProviderValidationError('The Mock Provider accepts at most four references.');
    }
    if (request.operation === 'image.generate') {
      if (request.inputs.some((input) => input.role !== 'reference')) {
        throw new MockProviderValidationError('Mock image.generate only accepts reference inputs.');
      }
    } else if (
      countRole(request, 'source') !== 1 ||
      countRole(request, 'mask') > 1 ||
      countRole(request, 'first_frame') > 0 ||
      countRole(request, 'last_frame') > 0
    ) {
      throw new MockProviderValidationError(
        'Mock image.edit requires one source and accepts references plus one optional mask.',
      );
    }
    if (request.aspectRatio && request.aspectRatio !== '1:1') {
      throw new MockProviderValidationError('The Mock Provider only supports the 1:1 aspect ratio.');
    }
    if (request.count && request.count !== 1) {
      throw new MockProviderValidationError('The Mock Provider only supports one output.');
    }
    const unsupportedOptions: Array<[string, unknown]> = [
      ['negativePrompt', request.negativePrompt],
      ['width', request.width],
      ['height', request.height],
      ['resolution', request.resolution],
      ['durationSeconds', request.durationSeconds],
      ['fps', request.fps],
      ['quality', request.quality],
      ['format', request.format],
      ['seed', request.seed],
      ['audio', request.audio],
      ['extra', request.extra],
    ];
    const unsupported = unsupportedOptions.find(([, value]) => value !== undefined);
    if (unsupported) throw new MockProviderValidationError('The Mock Provider does not support ' + unsupported[0] + '.');
  }

  private validateVideo(request: GenerationRequest, context: ProviderContext): void {
    if ((context.inputs?.length ?? 0) !== request.inputs.length) {
      throw new MockProviderValidationError('Mock video loaded inputs do not match the request.');
    }
    if (request.operation === 'video.generate' && request.inputs.length > 0) {
      throw new MockProviderValidationError('Mock video.generate does not accept image inputs.');
    }
    if (
      request.operation === 'video.image_to_video' &&
      (request.inputs.length !== 1 || request.inputs[0]?.role !== 'first_frame')
    ) {
      throw new MockProviderValidationError('Mock video.image_to_video requires exactly one first_frame input.');
    }
    if (
      request.operation === 'video.reference_to_video' &&
      (request.inputs.length < 1 ||
        request.inputs.length > 4 ||
        request.inputs.some((input) => input.role !== 'reference'))
    ) {
      throw new MockProviderValidationError('Mock video.reference_to_video requires one to four reference inputs.');
    }
    if (request.aspectRatio !== undefined && !ALLOWED_VIDEO_ASPECT_RATIOS.has(request.aspectRatio)) {
      throw new MockProviderValidationError('Mock video aspectRatio is unsupported.');
    }
    if (request.resolution !== undefined && request.resolution !== '720p') {
      throw new MockProviderValidationError('Mock video only supports 720p resolution.');
    }
    if (
      request.durationSeconds !== undefined &&
      (!Number.isSafeInteger(request.durationSeconds) || !ALLOWED_VIDEO_DURATIONS.has(request.durationSeconds))
    ) {
      throw new MockProviderValidationError('Mock video durationSeconds must be 1, 5, or 10.');
    }
    if (request.count !== undefined && request.count !== 1) {
      throw new MockProviderValidationError('Mock video only supports one output.');
    }
    const unsupportedOptions: Array<[string, unknown]> = [
      ['negativePrompt', request.negativePrompt],
      ['width', request.width],
      ['height', request.height],
      ['fps', request.fps],
      ['quality', request.quality],
      ['format', request.format],
      ['seed', request.seed],
      ['audio', request.audio],
      ['extra', request.extra],
    ];
    const unsupported = unsupportedOptions.find(([, value]) => value !== undefined);
    if (unsupported) throw new MockProviderValidationError('The Mock Provider does not support ' + unsupported[0] + '.');
    for (const requested of request.inputs) inputForRequest(context, requested);
    abortIfRequested(context);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    await this.validate(request, context);
    abortIfRequested(context);
    if (request.modelId === 'mock-image-v1') {
      return {
        state: 'completed',
        assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: TRANSPARENT_PNG_BASE64 }],
      };
    }
    const createdAt = this.clock();
    assertTimestamp(createdAt);
    return {
      state: 'pending',
      remoteJobId: createRemoteId(this.videoScenario, createdAt, context),
      pollAfterMs: MOCK_VIDEO_PENDING_MS,
    };
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    abortIfRequested(context);
    const parsed = parseRemoteId(remoteJobId);
    if (parsed.digest !== remoteDigest(context)) {
      throw new MockProviderValidationError('Mock video remote job ID does not match the request context.');
    }
    const now = this.clock();
    assertTimestamp(now);
    const elapsed = Math.max(0, now - parsed.createdAt);
    if (elapsed < MOCK_VIDEO_PENDING_MS) {
      return { state: 'remote_pending', progress: 0, pollAfterMs: MOCK_VIDEO_PENDING_MS };
    }
    if (elapsed < MOCK_VIDEO_RUNNING_MS) {
      return { state: 'remote_running', progress: 50, pollAfterMs: MOCK_VIDEO_PENDING_MS };
    }
    if (parsed.scenario === 'failed') {
      return {
        state: 'failed',
        error: { code: 'mock_video_failed', kind: 'rejected', message: 'Mock video generation failed.', retryable: false },
      };
    }
    if (parsed.scenario === 'expired') {
      return {
        state: 'failed',
        error: { code: 'mock_video_expired', kind: 'expired', message: 'Mock video result expired.', retryable: false },
      };
    }
    if (parsed.scenario === 'transient' && elapsed < MOCK_VIDEO_TRANSIENT_RETRY_MS) {
      return {
        state: 'failed',
        error: {
          code: 'mock_video_transient',
          kind: 'transient',
          message: 'Mock video upstream is temporarily unavailable.',
          retryable: true,
          retryAfterMs: MOCK_VIDEO_PENDING_MS,
        },
      };
    }
    return { state: 'completed', assets: [videoAsset(remoteJobId)] };
  }

  public async cancel(remoteJobId: string, context: ProviderContext): Promise<void> {
    abortIfRequested(context);
    const parsed = parseRemoteId(remoteJobId);
    if (parsed.digest !== remoteDigest(context)) {
      throw new MockProviderValidationError('Mock video remote job ID does not match the request context.');
    }
    // JobRunner owns local cancellation; the deterministic mock has no upstream process.
  }

  public normalizeError(error: unknown): ProviderError {
    return {
      code: error instanceof MockProviderValidationError ? 'mock_validation_error' : 'mock_provider_error',
      kind: error instanceof MockProviderValidationError ? 'rejected' : 'unknown',
      message: error instanceof Error ? error.message : 'Unknown Mock Provider error',
      retryable: false,
    };
  }
}
