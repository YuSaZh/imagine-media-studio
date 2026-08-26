import type { GenerationRequest } from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderAssetReference,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderResultTarget,
  PollResult,
  SubmitResult,
  SubmittedAsset,
} from '@imagine/provider-contract';

import { GeminiResponseError, GeminiTransportError, GeminiValidationError } from './errors.js';
import {
  GEMINI_VIDEO_DEFAULT_BASE_URL,
  GEMINI_VIDEO_MAX_OUTPUT_ASSETS,
  GEMINI_VIDEO_POLL_AFTER_MS,
  GEMINI_VEO_PROFILE,
  assertModelId,
  assertOperationName,
  asRecord,
  boundedResultId,
  canonicalModelId,
  catalogModels,
  configuredVideoModels,
  fileDownloadTarget,
  fileIdFromUri,
  inputAssets,
  inputInlineData,
  isExpired,
  modelCapabilities,
  normalizeGeminiVideoError,
  operationError,
  providerTarget,
  providerVideoAsset,
  requestVideoJson,
  resolveVideoTransport,
  resultInline,
  resultUri,
  parseResultExpiry,
  validBase64,
  videoApiKey,
  videoBaseUrl,
  videoEndpoint,
  videoModelsUrl,
  videoRequestHeaders,
  type GeminiVideoModelDefinition,
  type GeminiVideoProviderOptions,
  type GeminiVideoRuntimeContext,
  type GeminiVideoHttp,
} from './video-common.js';
import type { GeminiHttpRequest } from './types.js';

export const GEMINI_VEO_DEFAULT_BASE_URL = GEMINI_VIDEO_DEFAULT_BASE_URL;
export const GEMINI_VEO_OPERATION_PROFILE = GEMINI_VEO_PROFILE;
/** Google documents generated Veo videos as retained for two days. */
export const GEMINI_VEO_RESULT_RETENTION_MS = 2 * 24 * 60 * 60 * 1_000;

const VEO_MODELS = [
  'veo-3.1-generate-preview',
  'veo-3.1-fast-generate-preview',
  'veo-3.1-lite-generate-preview',
] as const;
const VEO_ASPECT_RATIOS = ['16:9', '9:16'] as const;
const VEO_DURATIONS = [4, 6, 8] as const;
const VEO_RESOLUTIONS = ['720p', '1080p', '4k'] as const;
const VEO_LITE_RESOLUTIONS = ['720p', '1080p'] as const;
const VEO_PERSON_GENERATION = new Set(['allow_adult', 'dont_allow', 'allow_all']);

interface VeoInlineData {
  readonly inlineData: { readonly mimeType: string; readonly data: string };
}

interface VeoReferenceImage {
  readonly image: VeoInlineData;
  readonly referenceType: 'asset';
}

interface VeoPayload {
  readonly instances: readonly [{
    readonly prompt: string;
    readonly image?: VeoInlineData;
    readonly referenceImages?: readonly VeoReferenceImage[];
  }];
  readonly parameters: Readonly<Record<string, unknown>>;
}

function definition(
  id: string,
  displayName: string,
  operations: ProviderCapabilities['models'][number]['capabilities']['operations'],
  resolutions: readonly string[],
  maxReferenceImages: number,
  conservative = false,
): GeminiVideoModelDefinition {
  return {
    id,
    displayName,
    capabilities: modelCapabilities(operations, {
      aspectRatios: conservative ? undefined : VEO_ASPECT_RATIOS,
      durations: conservative ? [8] : VEO_DURATIONS,
      resolutions: conservative ? ['720p'] : resolutions,
      maxReferenceImages,
      supportsSeed: !conservative,
      supportsAudio: !conservative,
      customFields: conservative
        ? { type: 'object', additionalProperties: false }
        : {
          type: 'object',
          properties: { personGeneration: { enum: [...VEO_PERSON_GENERATION] } },
          additionalProperties: false,
        },
    }),
  };
}

const VEO_DEFINITIONS = new Map<string, GeminiVideoModelDefinition>([
  [VEO_MODELS[0], definition(VEO_MODELS[0], 'Veo 3.1', ['video.generate', 'video.image_to_video', 'video.reference_to_video'], VEO_RESOLUTIONS, 3)],
  [VEO_MODELS[1], definition(VEO_MODELS[1], 'Veo 3.1 Fast', ['video.generate', 'video.image_to_video', 'video.reference_to_video'], VEO_RESOLUTIONS, 3)],
  [VEO_MODELS[2], definition(VEO_MODELS[2], 'Veo 3.1 Lite', ['video.generate', 'video.image_to_video'], VEO_LITE_RESOLUTIONS, 0)],
]);

function conservativeDefinition(id: string): GeminiVideoModelDefinition {
  return definition(id, `Veo compatible (${id})`, ['video.generate'], ['720p'], 0, true);
}

function modelDefinition(modelId: string): GeminiVideoModelDefinition {
  const id = assertModelId(modelId);
  return VEO_DEFINITIONS.get(id) ?? (
    /^veo-[A-Za-z0-9._:-]+$/u.test(id)
      ? conservativeDefinition(id)
      : (() => { throw new GeminiValidationError(`Gemini Veo model '${modelId}' is unsupported.`, 'gemini_model_unsupported'); })()
  );
}

function runtime(context: ProviderContext): GeminiVideoRuntimeContext {
  return context as GeminiVideoRuntimeContext;
}

function assertExtra(request: GenerationRequest): { personGeneration?: string } {
  if (request.extra === undefined) return {};
  const extra = request.extra;
  const keys = Object.keys(extra);
  for (const key of keys) {
    if (key !== 'personGeneration') throw new GeminiValidationError(`Gemini Veo extra.${key} is unsupported.`, 'gemini_extra_fields_unsupported');
  }
  const value = extra.personGeneration;
  if (value === undefined) return {};
  if (typeof value !== 'string' || !VEO_PERSON_GENERATION.has(value)) {
    throw new GeminiValidationError('Gemini Veo personGeneration is invalid.', 'gemini_extra_fields_unsupported');
  }
  return { personGeneration: value };
}

function validateOptions(request: GenerationRequest, model: GeminiVideoModelDefinition): {
  duration: number;
  resolution?: string;
  personGeneration?: string;
} {
  if (request.aspectRatio !== undefined && !VEO_ASPECT_RATIOS.includes(request.aspectRatio as (typeof VEO_ASPECT_RATIOS)[number])) {
    throw new GeminiValidationError('Gemini Veo aspect ratio must be 16:9 or 9:16.', 'gemini_aspect_ratio_unsupported');
  }
  if (request.resolution !== undefined && !model.capabilities.resolutions?.includes(request.resolution)) {
    throw new GeminiValidationError('Gemini Veo resolution is unsupported by the selected model.', 'gemini_resolution_unsupported');
  }
  const duration = request.durationSeconds ?? 8;
  const durations = Array.isArray(model.capabilities.durations) ? model.capabilities.durations : undefined;
  if (!Number.isSafeInteger(duration) || !durations || !durations.includes(duration)) {
    throw new GeminiValidationError('Gemini Veo duration must be a supported whole number of seconds.', 'gemini_duration_unsupported');
  }
  const resolution = request.resolution;
  if (resolution !== undefined && resolution !== '720p' && duration !== 8) {
    throw new GeminiValidationError('Veo 1080p and 4k output requires an 8 second duration.', 'gemini_resolution_duration_invalid');
  }
  if (request.count !== undefined && request.count !== 1) {
    throw new GeminiValidationError('Gemini Veo supports one video per request.', 'gemini_batch_unsupported');
  }
  const unsupported: ReadonlyArray<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt], ['width', request.width], ['height', request.height],
    ['fps', request.fps], ['quality', request.quality], ['format', request.format],
  ];
  const found = unsupported.find(([, value]) => value !== undefined);
  if (found) throw new GeminiValidationError(`Gemini Veo does not support ${found[0]}.`, 'gemini_option_unsupported');
  if (request.audio !== undefined && (request.audio !== true || model.capabilities.supportsAudio !== true)) {
    throw new GeminiValidationError('Gemini Veo audio is always on and cannot be disabled.', 'gemini_audio_unsupported');
  }
  return { duration, ...(resolution === undefined ? {} : { resolution }), ...assertExtra(request) };
}

function validateRequest(request: GenerationRequest, context: GeminiVideoRuntimeContext): {
  model: GeminiVideoModelDefinition;
  inputs: readonly ReturnType<typeof inputAssets>[number][];
  options: ReturnType<typeof validateOptions>;
} {
  if (request.providerId !== context.providerId) throw new GeminiValidationError('Gemini request provider does not match the active provider.', 'gemini_provider_mismatch');
  const prompt = request.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > 32_000) throw new GeminiValidationError('Gemini Veo prompt is invalid.', 'gemini_prompt_invalid');
  const model = modelDefinition(request.modelId);
  const options = validateOptions(request, model);
  const supported = model.capabilities.operations;
  if (!supported.includes(request.operation)) throw new GeminiValidationError(`Gemini Veo does not support ${request.operation} for this model.`, 'gemini_operation_unsupported');
  if (options.personGeneration !== undefined) {
    const expected = request.operation === 'video.generate' ? 'allow_all' : 'allow_adult';
    if (options.personGeneration !== expected) {
      throw new GeminiValidationError(`Veo ${request.operation} only supports personGeneration '${expected}'.`, 'gemini_person_generation_unsupported');
    }
  }
  if (request.operation === 'video.generate' && request.inputs.length > 0) {
    throw new GeminiValidationError('Veo video.generate does not accept input images.', 'gemini_input_role_unsupported');
  }
  if (request.operation === 'video.image_to_video' && (request.inputs.length !== 1 || request.inputs[0]?.role !== 'first_frame')) {
    throw new GeminiValidationError('Veo image-to-video requires exactly one first_frame image.', 'gemini_input_role_invalid');
  }
  if (request.operation === 'video.reference_to_video') {
    if (request.inputs.length < 1 || request.inputs.some((input) => input.role !== 'reference')) {
      throw new GeminiValidationError('Veo reference-to-video requires reference images only.', 'gemini_input_role_invalid');
    }
    if (request.inputs.length > (model.capabilities.maxReferenceImages ?? 0)) {
      throw new GeminiValidationError('The selected Veo model accepts at most three reference images.', 'gemini_reference_limit_exceeded');
    }
    if (options.duration !== 8) throw new GeminiValidationError('Veo reference images require an 8 second duration.', 'gemini_reference_duration_invalid');
  }
  if (request.operation !== 'video.generate' && request.operation !== 'video.image_to_video' && request.operation !== 'video.reference_to_video') {
    throw new GeminiValidationError('Veo edit, extend, and last-frame operations are not enabled by this profile.', 'gemini_operation_unsupported');
  }
  const inputs = inputAssets(request.inputs, context);
  return { model, inputs, options };
}

function buildPayload(request: GenerationRequest, context: GeminiVideoRuntimeContext): VeoPayload {
  const validation = validateRequest(request, context);
  const instance: {
    prompt: string;
    image?: VeoInlineData;
    referenceImages?: readonly VeoReferenceImage[];
  } = { prompt: request.prompt.trim() };
  if (request.operation === 'video.image_to_video') {
    const input = validation.inputs[0];
    if (!input) throw new GeminiValidationError('Veo first frame is missing.', 'gemini_input_unresolved');
    instance.image = { inlineData: inputInlineData(input) };
  }
  if (request.operation === 'video.reference_to_video') {
    instance.referenceImages = validation.inputs.map((input) => ({
      image: { inlineData: inputInlineData(input) }, referenceType: 'asset' as const,
    }));
  }
  const parameters: Record<string, unknown> = {};
  if (request.aspectRatio !== undefined) parameters.aspectRatio = request.aspectRatio;
  if (request.durationSeconds !== undefined) parameters.durationSeconds = String(validation.options.duration);
  if (validation.options.resolution !== undefined) parameters.resolution = validation.options.resolution;
  if (request.count !== undefined) parameters.numberOfVideos = request.count;
  if (request.seed !== undefined) {
    if (!Number.isSafeInteger(request.seed) || request.seed < 0) throw new GeminiValidationError('Gemini Veo seed is invalid.', 'gemini_seed_invalid');
    if (!validation.model.capabilities.supportsSeed) throw new GeminiValidationError('The selected Veo model does not support seed.', 'gemini_option_unsupported');
    parameters.seed = request.seed;
  }
  if (validation.options.personGeneration !== undefined) parameters.personGeneration = validation.options.personGeneration;
  const payload: VeoPayload = { instances: [instance], parameters };
  assertVeoPayload(payload);
  return payload;
}

function assertVeoPayload(value: unknown): asserts value is VeoPayload {
  const root = asRecord(value);
  if (!root || Object.keys(root).some((key) => !['instances', 'parameters'].includes(key)) || !Array.isArray(root.instances) || root.instances.length !== 1 || !asRecord(root.instances[0])) {
    throw new GeminiValidationError('Gemini Veo payload is invalid.', 'gemini_payload_invalid');
  }
  const instance = root.instances[0] as Record<string, unknown>;
  if (Object.keys(instance).some((key) => !['prompt', 'image', 'referenceImages'].includes(key)) || typeof instance.prompt !== 'string' || instance.prompt.length === 0) {
    throw new GeminiValidationError('Gemini Veo instance is invalid.', 'gemini_payload_invalid');
  }
  if (instance.image !== undefined && instance.referenceImages !== undefined) {
    throw new GeminiValidationError('Gemini Veo image and referenceImages cannot be combined.', 'gemini_payload_invalid');
  }
  if (instance.image !== undefined) assertInlineData(instance.image);
  if (instance.referenceImages !== undefined) {
    if (!Array.isArray(instance.referenceImages) || instance.referenceImages.length < 1 || instance.referenceImages.length > 3) throw new GeminiValidationError('Gemini Veo referenceImages is invalid.', 'gemini_payload_invalid');
    for (const reference of instance.referenceImages) {
      const record = asRecord(reference);
      if (!record || Object.keys(record).some((key) => !['image', 'referenceType'].includes(key)) || record.referenceType !== 'asset') throw new GeminiValidationError('Gemini Veo reference image is invalid.', 'gemini_payload_invalid');
      assertInlineData(record.image);
    }
  }
  const parameters = asRecord(root.parameters);
  if (!parameters || Object.keys(parameters).some((key) => !['aspectRatio', 'durationSeconds', 'resolution', 'numberOfVideos', 'seed', 'personGeneration'].includes(key))) throw new GeminiValidationError('Gemini Veo parameters are invalid.', 'gemini_payload_invalid');
  if (parameters.aspectRatio !== undefined && !VEO_ASPECT_RATIOS.includes(parameters.aspectRatio as (typeof VEO_ASPECT_RATIOS)[number])) throw new GeminiValidationError('Gemini Veo aspectRatio is invalid.', 'gemini_payload_invalid');
  if (parameters.durationSeconds !== undefined && !['4', '6', '8'].includes(String(parameters.durationSeconds))) throw new GeminiValidationError('Gemini Veo durationSeconds is invalid.', 'gemini_payload_invalid');
  if (parameters.resolution !== undefined && !VEO_RESOLUTIONS.includes(parameters.resolution as (typeof VEO_RESOLUTIONS)[number])) throw new GeminiValidationError('Gemini Veo resolution is invalid.', 'gemini_payload_invalid');
  if (parameters.numberOfVideos !== undefined && parameters.numberOfVideos !== 1) throw new GeminiValidationError('Gemini Veo numberOfVideos must be one.', 'gemini_payload_invalid');
  if (parameters.seed !== undefined && (!Number.isSafeInteger(parameters.seed) || (parameters.seed as number) < 0)) throw new GeminiValidationError('Gemini Veo seed is invalid.', 'gemini_payload_invalid');
  if (parameters.personGeneration !== undefined && (typeof parameters.personGeneration !== 'string' || !VEO_PERSON_GENERATION.has(parameters.personGeneration))) throw new GeminiValidationError('Gemini Veo personGeneration is invalid.', 'gemini_payload_invalid');
}

function assertInlineData(value: unknown): asserts value is VeoInlineData {
  const root = asRecord(value);
  const inline = asRecord(root?.inlineData);
  if (!inline || Object.keys(root ?? {}).some((key) => key !== 'inlineData') || typeof inline.mimeType !== 'string' || !['image/jpeg', 'image/png'].includes(inline.mimeType) || typeof inline.data !== 'string' || !validBase64(inline.data, 20 * 1024 * 1024)) {
    throw new GeminiValidationError('Gemini Veo inline image is invalid.', 'gemini_payload_invalid');
  }
}

interface ParsedOperation {
  readonly name: string;
  readonly done: boolean;
  readonly progress?: number;
  readonly error?: ProviderError;
  readonly response?: Record<string, unknown>;
  readonly resultExpiresAt?: Date;
}

function parseProgress(value: unknown): number | undefined {
  const metadata = asRecord(value);
  const raw = metadata?.progressPercent ?? metadata?.progress;
  if (raw === undefined) return undefined;
  const number = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw new GeminiResponseError('Gemini Veo operation progress is invalid.', 'gemini_progress_invalid');
  return Math.round(number);
}

function parseOperation(value: unknown, expectedName?: string): ParsedOperation {
  const root = asRecord(value);
  if (!root) throw new GeminiResponseError('Gemini Veo operation response is invalid.', 'gemini_operation_invalid');
  const name = assertOperationName(root.name ?? expectedName);
  if (expectedName !== undefined && name !== expectedName) throw new GeminiResponseError('Gemini Veo operation name changed unexpectedly.', 'gemini_operation_invalid');
  if (root.done !== true && root.done !== false) throw new GeminiResponseError('Gemini Veo operation done state is invalid.', 'gemini_operation_invalid');
  if (root.error !== undefined && !asRecord(root.error)) throw new GeminiResponseError('Gemini Veo operation error is invalid.', 'gemini_operation_invalid');
  const error = root.error === undefined ? undefined : operationError(root.error);
  const response = asRecord(root.response);
  const progress = parseProgress(root.metadata);
  const resultExpiresAt = parseResultExpiry(root.expireTime ?? root.expiresAt ?? root.expirationTime);
  return {
    name,
    done: root.done === true,
    ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }),
    ...(response === undefined ? {} : { response }),
    ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }),
  };
}

function outputVideo(response: Record<string, unknown>): Record<string, unknown> {
  const generation = asRecord(response.generateVideoResponse);
  const samples = generation?.generatedSamples;
  const sdkSamples = response.generatedVideos;
  const list = Array.isArray(samples) ? samples : Array.isArray(sdkSamples) ? sdkSamples : undefined;
  if (!list || list.length === 0 || list.length > GEMINI_VIDEO_MAX_OUTPUT_ASSETS) throw new GeminiResponseError('Gemini Veo response did not contain exactly one video.', 'gemini_output_invalid');
  const first = asRecord(list[0]);
  const video = asRecord(first?.video ?? first);
  if (!video) throw new GeminiResponseError('Gemini Veo returned a malformed video.', 'gemini_output_invalid');
  return video;
}

function completedAsset(context: GeminiVideoRuntimeContext, operation: ParsedOperation, model: string): SubmittedAsset {
  if (!operation.response) throw new GeminiResponseError('Gemini Veo completed operation has no response.', 'gemini_output_invalid');
  const video = outputVideo(operation.response);
  const resultId = boundedResultId(operation.name);
  const inline = resultInline(video);
  if (inline) return { ...inline, ...(resultId === undefined ? {} : { resultId }) };
  const uri = resultUri(video);
  if (!uri) throw new GeminiResponseError('Gemini Veo video has no inline data or URI.', 'gemini_output_invalid');
  const fileId = fileIdFromUri(uri);
  return providerVideoAsset(context, fileId === undefined ? `operation:${operation.name}` : `file:${fileId}`, model, resultId);
}

function remoteResultExpiry(operation: ParsedOperation): Date | undefined {
  if (!operation.response) return undefined;
  const video = outputVideo(operation.response);
  if (resultUri(video) === undefined) return undefined;
  const retentionCap = Date.now() + GEMINI_VEO_RESULT_RETENTION_MS;
  if (operation.resultExpiresAt === undefined) return new Date(retentionCap);
  return new Date(Math.min(operation.resultExpiresAt.getTime(), retentionCap));
}

function uriFromCompleted(operation: ParsedOperation): string {
  if (!operation.response) throw new GeminiResponseError('Gemini Veo completed operation has no response.', 'gemini_output_invalid');
  const video = outputVideo(operation.response);
  const uri = resultUri(video);
  if (!uri) throw new GeminiResponseError('Gemini Veo result is inline and cannot be resolved as a download target.', 'gemini_inline_result_not_resolvable');
  return uri;
}

function operationId(remoteJobId: string): string {
  if (!remoteJobId.startsWith('operation:')) throw new GeminiValidationError('Gemini Veo remote job id is invalid.', 'gemini_operation_invalid');
  return assertOperationName(remoteJobId.slice('operation:'.length));
}

function fileId(remoteJobId: string): string {
  if (!remoteJobId.startsWith('file:')) throw new GeminiValidationError('Gemini Veo file result id is invalid.', 'gemini_file_invalid');
  const value = remoteJobId.slice('file:'.length);
  if (!value) throw new GeminiValidationError('Gemini Veo file result id is invalid.', 'gemini_file_invalid');
  return value;
}

export class GeminiVeoProvider implements ProviderAdapter {
  public readonly type = GEMINI_VEO_PROFILE;
  private readonly http: GeminiVideoHttp | undefined;
  private readonly baseUrl: string | undefined;
  private readonly headers: Readonly<Record<string, string>> | undefined;
  private readonly models: readonly string[] | undefined;

  public constructor(options: GeminiVideoProviderOptions = {}) {
    this.http = options.http ?? options.transport;
    this.baseUrl = options.baseUrl;
    this.headers = options.headers;
    this.models = options.models;
  }

  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtimeContext = runtime(context);
    const ids = this.models ?? configuredVideoModels({}, runtimeContext, VEO_MODELS);
    return { providerType: this.type, models: ids.map((id) => modelDefinition(id)) };
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtimeContext = runtime(context);
    const transport = this.http ?? runtimeContext.http ?? runtimeContext.transport;
    if (!transport) return this.getCapabilities(runtimeContext);
    const body = await this.requestModels(runtimeContext, transport);
    const configured = this.models ?? configuredVideoModels({}, runtimeContext, VEO_MODELS);
    const explicit = this.models !== undefined || Array.isArray(runtimeContext.config?.models);
    const known = VEO_DEFINITIONS;
    return {
      providerType: this.type,
      models: catalogModels(body, known, (entry) => {
        const id = canonicalModelId(String(entry.name));
        const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        return /^veo-/u.test(id) && methods.some((method) => typeof method === 'string' && method.toLowerCase() === 'predictlongrunning') && (!explicit || configured.includes(id));
      }, conservativeDefinition),
    };
  }

  public async testConnection(context: ProviderContext): Promise<void> {
    const runtimeContext = runtime(context);
    await this.requestModels(runtimeContext, resolveVideoTransport(runtimeContext, this.http));
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    const runtimeContext = runtime(context);
    videoApiKey(runtimeContext);
    buildPayload(request, runtimeContext);
    videoBaseUrl(runtimeContext, this.baseUrl, [`/models/${canonicalModelId(request.modelId)}:predictLongRunning`]);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtimeContext = runtime(context);
    const payload = buildPayload(request, runtimeContext);
    const model = modelDefinition(request.modelId);
    const key = videoApiKey(runtimeContext);
    const base = videoBaseUrl(runtimeContext, this.baseUrl, [`/models/${canonicalModelId(request.modelId)}:predictLongRunning`]);
    const response = await requestVideoJson(runtimeContext, this.http, {
      method: 'POST',
      url: videoEndpoint(base, `/models/${encodeURIComponent(model.id)}:predictLongRunning`),
      headers: videoRequestHeaders(runtimeContext, key, this.headers),
      body: JSON.stringify(payload),
      ...(runtimeContext.signal === undefined ? {} : { signal: runtimeContext.signal }),
    }, 'Veo submit');
    const operation = parseOperation(response);
    if (operation.error) throw new GeminiResponseError(operation.error.message, operation.error.code);
    if (!operation.done) return { state: 'pending', remoteJobId: `operation:${operation.name}`, pollAfterMs: GEMINI_VIDEO_POLL_AFTER_MS, ...(operation.resultExpiresAt === undefined ? {} : { resultExpiresAt: operation.resultExpiresAt }) };
    const resultExpiresAt = remoteResultExpiry(operation);
    if (isExpired(resultExpiresAt)) throw new GeminiResponseError('Gemini Veo result expired.', 'gemini_video_result_expired');
    return { state: 'completed', assets: [completedAsset(runtimeContext, operation, model.id)], ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }) };
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    const runtimeContext = runtime(context);
    const operation = operationId(remoteJobId);
    const key = videoApiKey(runtimeContext);
    const base = videoBaseUrl(runtimeContext, this.baseUrl, ['/operations']);
    const response = await requestVideoJson(runtimeContext, this.http, {
      method: 'GET', url: videoEndpoint(base, operation), headers: videoRequestHeaders(runtimeContext, key, this.headers),
      ...(runtimeContext.signal === undefined ? {} : { signal: runtimeContext.signal }),
    }, 'Veo operation');
    const parsed = parseOperation(response, operation);
    if (parsed.error) return { state: 'failed', error: parsed.error };
    if (!parsed.done) return { state: parsed.progress && parsed.progress > 0 ? 'remote_running' : 'remote_pending', ...(parsed.progress === undefined ? {} : { progress: parsed.progress }), pollAfterMs: GEMINI_VIDEO_POLL_AFTER_MS, ...(parsed.resultExpiresAt === undefined ? {} : { resultExpiresAt: parsed.resultExpiresAt }) };
    const resultExpiresAt = remoteResultExpiry(parsed);
    if (isExpired(resultExpiresAt)) return { state: 'failed', error: { code: 'gemini_video_result_expired', kind: 'expired', message: 'The Gemini Veo result expired.', retryable: false } };
    const model = runtimeContext.modelId ? modelDefinition(runtimeContext.modelId).id : VEO_MODELS[0];
    return { state: 'completed', assets: [completedAsset(runtimeContext, parsed, model)], ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }) };
  }

  public async resolveResult(asset: ProviderAssetReference, context: ProviderContext): Promise<ProviderResultTarget> {
    const runtimeContext = runtime(context);
    if (asset.providerId !== runtimeContext.providerId || asset.type !== 'video' || asset.variant !== 'video') throw new GeminiValidationError('Gemini Veo result reference is invalid.', 'gemini_result_reference_invalid');
    const base = videoBaseUrl(runtimeContext, this.baseUrl, ['/operations']);
    if (asset.remoteJobId.startsWith('file:')) return fileDownloadTarget(runtimeContext, this.headers, base, fileId(asset.remoteJobId));
    const operation = operationId(asset.remoteJobId);
    const key = videoApiKey(runtimeContext);
    const response = await requestVideoJson(runtimeContext, this.http, {
      method: 'GET', url: videoEndpoint(base, operation), headers: videoRequestHeaders(runtimeContext, key, this.headers),
      ...(runtimeContext.signal === undefined ? {} : { signal: runtimeContext.signal }),
    }, 'Veo result');
    const parsed = parseOperation(response, operation);
    if (!parsed.done) throw new GeminiTransportError('Gemini Veo result is not ready.');
    if (parsed.error) throw new GeminiResponseError(parsed.error.message, parsed.error.code);
    const uri = uriFromCompleted(parsed);
    const resultExpiresAt = remoteResultExpiry(parsed);
    if (isExpired(resultExpiresAt)) throw new GeminiResponseError('Gemini Veo result expired.', 'gemini_video_result_expired');
    const file = fileIdFromUri(uri);
    return file === undefined ? providerTarget(runtimeContext, this.headers, base, uri) : fileDownloadTarget(runtimeContext, this.headers, base, file);
  }

  public normalizeError(error: unknown): ProviderError {
    return normalizeGeminiVideoError(error);
  }

  private async requestModels(context: GeminiVideoRuntimeContext, transport: GeminiVideoHttp): Promise<unknown> {
    const key = videoApiKey(context);
    const base = videoBaseUrl(context, this.baseUrl, ['/models']);
    const request: GeminiHttpRequest = {
      method: 'GET', url: videoModelsUrl(base), headers: videoRequestHeaders(context, key, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    return requestVideoJson(context, transport, request, 'Veo models');
  }
}

export const GeminiVeoOperationProvider = GeminiVeoProvider;
export const GeminiVeoOperationAdapter = GeminiVeoProvider;
export default GeminiVeoProvider;

export { assertVeoPayload, buildPayload as buildVeoPayload };
export type { VeoPayload };
