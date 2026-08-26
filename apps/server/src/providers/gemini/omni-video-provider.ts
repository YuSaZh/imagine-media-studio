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
import type { GeminiHttpRequest } from './types.js';
import {
  GEMINI_OMNI_VIDEO_PROFILE,
  GEMINI_VIDEO_DEFAULT_BASE_URL,
  GEMINI_VIDEO_MAX_OUTPUT_ASSETS,
  GEMINI_VIDEO_POLL_AFTER_MS,
  assertInteractionId,
  assertFileId,
  assertModelId,
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
  videoApiKey,
  videoBaseUrl,
  videoEndpoint,
  videoModelsUrl,
  videoRequestHeaders,
  validBase64,
  type GeminiVideoHttp,
  type GeminiVideoModelDefinition,
  type GeminiVideoProviderOptions,
  type GeminiVideoRuntimeContext,
} from './video-common.js';

export const GEMINI_OMNI_VIDEO_DEFAULT_BASE_URL = GEMINI_VIDEO_DEFAULT_BASE_URL;
export const GEMINI_OMNI_INTERACTIONS_VIDEO_PROFILE = GEMINI_OMNI_VIDEO_PROFILE;

const OMNI_MODELS = ['gemini-omni-flash-preview'] as const;
const OMNI_ASPECT_RATIOS = ['9:16', '16:9'] as const;
const OMNI_TASKS = ['text_to_video', 'image_to_video', 'reference_to_video'] as const;

interface OmniImagePart {
  readonly type: 'image';
  readonly data: string;
  readonly mime_type: string;
}

interface OmniTextPart {
  readonly type: 'text';
  readonly text: string;
}

interface OmniPayload {
  readonly model: string;
  readonly input: string | readonly (OmniImagePart | OmniTextPart)[];
  readonly response_format: { readonly type: 'video'; readonly delivery: 'uri'; readonly aspect_ratio?: string };
  readonly generation_config?: { readonly video_config: { readonly task: (typeof OMNI_TASKS)[number] } };
}

function definition(id: string, displayName: string, conservative = false): GeminiVideoModelDefinition {
  return {
    id,
    displayName,
    capabilities: modelCapabilities(
      conservative ? ['video.generate'] : ['video.generate', 'video.image_to_video', 'video.reference_to_video'],
      {
        aspectRatios: conservative ? undefined : OMNI_ASPECT_RATIOS,
        resolutions: undefined,
        durations: undefined,
        maxReferenceImages: conservative ? 0 : 3,
        supportsSeed: false,
        supportsAudio: !conservative,
        customFields: conservative
          ? { type: 'object', additionalProperties: false }
          : { type: 'object', additionalProperties: false },
      },
    ),
  };
}

const OMNI_DEFINITIONS = new Map<string, GeminiVideoModelDefinition>([
  [OMNI_MODELS[0], definition(OMNI_MODELS[0], 'Gemini Omni Flash')],
]);

function conservativeDefinition(id: string): GeminiVideoModelDefinition {
  return definition(id, `Gemini Interactions compatible (${id})`, true);
}

function modelDefinition(modelId: string): GeminiVideoModelDefinition {
  const id = assertModelId(modelId);
  return OMNI_DEFINITIONS.get(id) ?? (
    /^gemini-[A-Za-z0-9._:-]+$/u.test(id)
      ? conservativeDefinition(id)
      : (() => { throw new GeminiValidationError(`Gemini Omni model '${modelId}' is unsupported.`, 'gemini_model_unsupported'); })()
  );
}

function runtime(context: ProviderContext): GeminiVideoRuntimeContext {
  return context as GeminiVideoRuntimeContext;
}

function validateRequest(request: GenerationRequest, context: GeminiVideoRuntimeContext): {
  model: GeminiVideoModelDefinition;
  inputs: readonly ReturnType<typeof inputAssets>[number][];
  task: (typeof OMNI_TASKS)[number];
} {
  if (request.providerId !== context.providerId) throw new GeminiValidationError('Gemini request provider does not match the active provider.', 'gemini_provider_mismatch');
  if (typeof request.prompt !== 'string' || request.prompt.trim() === '' || request.prompt.length > 32_000) throw new GeminiValidationError('Gemini Omni prompt is invalid.', 'gemini_prompt_invalid');
  const model = modelDefinition(request.modelId);
  if (request.extra !== undefined && Object.keys(request.extra).length > 0) throw new GeminiValidationError('Gemini Omni does not support extra fields in this profile.', 'gemini_extra_fields_unsupported');
  if (request.aspectRatio !== undefined && !OMNI_ASPECT_RATIOS.includes(request.aspectRatio as (typeof OMNI_ASPECT_RATIOS)[number])) throw new GeminiValidationError('Gemini Omni aspect ratio must be 9:16 or 16:9.', 'gemini_aspect_ratio_unsupported');
  if (request.count !== undefined && request.count !== 1) throw new GeminiValidationError('Gemini Omni supports one video per request.', 'gemini_batch_unsupported');
  const unsupported: ReadonlyArray<[string, unknown]> = [
    ['negativePrompt', request.negativePrompt], ['width', request.width], ['height', request.height], ['resolution', request.resolution],
    ['durationSeconds', request.durationSeconds], ['fps', request.fps], ['quality', request.quality], ['format', request.format],
    ['seed', request.seed],
  ];
  const found = unsupported.find(([, value]) => value !== undefined);
  if (found) throw new GeminiValidationError(`Gemini Omni does not support ${found[0]}.`, 'gemini_option_unsupported');
  if (request.audio !== undefined && (request.audio !== true || model.capabilities.supportsAudio !== true)) throw new GeminiValidationError('Gemini Omni audio is generated by the model and cannot be disabled.', 'gemini_audio_unsupported');

  let task: (typeof OMNI_TASKS)[number];
  if (request.operation === 'video.generate') {
    if (request.inputs.length > 0) throw new GeminiValidationError('Gemini Omni text-to-video does not accept input images.', 'gemini_input_role_unsupported');
    task = 'text_to_video';
  } else if (request.operation === 'video.image_to_video') {
    if (request.inputs.length !== 1 || request.inputs[0]?.role !== 'first_frame') throw new GeminiValidationError('Gemini Omni image-to-video requires one first_frame image.', 'gemini_input_role_invalid');
    task = 'image_to_video';
  } else if (request.operation === 'video.reference_to_video') {
    if (request.inputs.length < 1 || request.inputs.length > 3 || request.inputs.some((input) => input.role !== 'reference')) throw new GeminiValidationError('Gemini Omni reference-to-video requires one to three reference images.', 'gemini_input_role_invalid');
    task = 'reference_to_video';
  } else {
    throw new GeminiValidationError('Gemini Omni edit, extend, and other operations are outside this profile scope.', 'gemini_operation_unsupported');
  }
  if (!model.capabilities.operations.includes(request.operation)) throw new GeminiValidationError(`Gemini Omni does not support ${request.operation} for this model.`, 'gemini_operation_unsupported');
  return { model, inputs: inputAssets(request.inputs, context), task };
}

function buildPayload(request: GenerationRequest, context: GeminiVideoRuntimeContext): OmniPayload {
  const validation = validateRequest(request, context);
  const input = validation.inputs.length === 0
    ? request.prompt.trim()
    : [
      ...validation.inputs.map((candidate) => {
        const inline = inputInlineData(candidate);
        return { type: 'image' as const, data: inline.data, mime_type: inline.mimeType };
      }),
      { type: 'text' as const, text: request.prompt.trim() },
    ];
  const payload: OmniPayload = {
    model: validation.model.id,
    input,
    response_format: { type: 'video', delivery: 'uri', ...(request.aspectRatio === undefined ? {} : { aspect_ratio: request.aspectRatio }) },
    ...(validation.task === 'text_to_video' ? {} : { generation_config: { video_config: { task: validation.task } } }),
  };
  assertOmniPayload(payload);
  return payload;
}

export function assertOmniPayload(value: unknown): asserts value is OmniPayload {
  const root = asRecord(value);
  if (!root || Object.keys(root).some((key) => !['model', 'input', 'response_format', 'generation_config'].includes(key)) || typeof root.model !== 'string' || root.model.length === 0 || (typeof root.input !== 'string' && !Array.isArray(root.input)) || (typeof root.input === 'string' && root.input.trim() === '')) throw new GeminiValidationError('Gemini Omni payload is invalid.', 'gemini_payload_invalid');
  if (Array.isArray(root.input)) {
    if (root.input.length < 2) throw new GeminiValidationError('Gemini Omni multimodal input is invalid.', 'gemini_payload_invalid');
    let textPart = false;
    for (const part of root.input) {
      const record = asRecord(part);
      if (!record || typeof record.type !== 'string') throw new GeminiValidationError('Gemini Omni input part is invalid.', 'gemini_payload_invalid');
      if (record.type === 'text') {
        if (Object.keys(record).some((key) => !['type', 'text'].includes(key)) || typeof record.text !== 'string' || record.text.length === 0) throw new GeminiValidationError('Gemini Omni text input is invalid.', 'gemini_payload_invalid');
        textPart = true;
      } else if (record.type === 'image') {
        if (Object.keys(record).some((key) => !['type', 'data', 'mime_type'].includes(key)) || typeof record.data !== 'string' || !validBase64(record.data, 20 * 1024 * 1024) || typeof record.mime_type !== 'string' || !['image/jpeg', 'image/png'].includes(record.mime_type)) throw new GeminiValidationError('Gemini Omni image input is invalid.', 'gemini_payload_invalid');
      } else throw new GeminiValidationError('Gemini Omni input type is unsupported.', 'gemini_payload_invalid');
    }
    if (!textPart) throw new GeminiValidationError('Gemini Omni multimodal input must contain a text prompt.', 'gemini_payload_invalid');
  }
  const format = asRecord(root.response_format);
  if (!format || Object.keys(format).some((key) => !['type', 'delivery', 'aspect_ratio'].includes(key)) || format.type !== 'video' || format.delivery !== 'uri' || (format.aspect_ratio !== undefined && !OMNI_ASPECT_RATIOS.includes(format.aspect_ratio as (typeof OMNI_ASPECT_RATIOS)[number]))) throw new GeminiValidationError('Gemini Omni response_format is invalid.', 'gemini_payload_invalid');
  if (root.generation_config !== undefined) {
    const config = asRecord(root.generation_config);
    const videoConfig = asRecord(config?.video_config);
    if (!config || Object.keys(config).length !== 1 || !videoConfig || Object.keys(videoConfig).length !== 1 || typeof videoConfig.task !== 'string' || !OMNI_TASKS.includes(videoConfig.task as (typeof OMNI_TASKS)[number])) throw new GeminiValidationError('Gemini Omni generation_config is invalid.', 'gemini_payload_invalid');
  }
}

interface ParsedInteraction {
  readonly id: string;
  readonly status: string;
  readonly progress?: number;
  readonly error?: ProviderError;
  readonly root: Record<string, unknown>;
  readonly resultExpiresAt?: Date;
}

function parseProgress(value: unknown): number | undefined {
  const raw = asRecord(value)?.progress ?? asRecord(value)?.progress_percent ?? value;
  if (raw === undefined) return undefined;
  const progress = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new GeminiResponseError('Gemini Omni progress is invalid.', 'gemini_progress_invalid');
  return Math.round(progress);
}

function parseInteraction(value: unknown, expectedId?: string): ParsedInteraction {
  const root = asRecord(value);
  if (!root) throw new GeminiResponseError('Gemini Omni interaction response is invalid.', 'gemini_interaction_invalid');
  const id = assertInteractionId(root.id ?? expectedId);
  if (expectedId !== undefined && id !== expectedId) throw new GeminiResponseError('Gemini Omni interaction id changed unexpectedly.', 'gemini_interaction_invalid');
  if (typeof root.status !== 'string' || root.status.trim() === '') throw new GeminiResponseError('Gemini Omni interaction status is invalid.', 'gemini_interaction_invalid');
  const status = root.status.toLowerCase();
  if (!['in_progress', 'queued', 'completed', 'failed', 'cancelled', 'requires_action', 'incomplete', 'budget_exceeded', 'error', 'expired'].includes(status)) throw new GeminiResponseError('Gemini Omni interaction status is unsupported.', 'gemini_interaction_invalid');
  if (root.error !== undefined && !asRecord(root.error)) throw new GeminiResponseError('Gemini Omni interaction error is invalid.', 'gemini_interaction_invalid');
  const error = root.error === undefined ? undefined : operationError(root.error);
  const progress = parseProgress(root.progress);
  const resultExpiresAt = parseResultExpiry(root.expires_at ?? root.expiresAt ?? root.expirationTime);
  return { id, status, ...(progress === undefined ? {} : { progress }), ...(error === undefined ? {} : { error }), ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }), root };
}

function outputVideos(root: Record<string, unknown>): readonly Record<string, unknown>[] {
  const outputs: Record<string, unknown>[] = [];
  const direct = asRecord(root.output_video);
  if (direct) outputs.push(direct);
  const output = asRecord(root.output);
  if (output) outputs.push(output);
  if (Array.isArray(root.output)) {
    for (const rawOutput of root.output) {
      const outputRecord = asRecord(rawOutput);
      if (outputRecord) outputs.push(outputRecord);
    }
  }
  if (Array.isArray(root.steps)) {
    for (const rawStep of root.steps) {
      const step = asRecord(rawStep);
      if (!step || !Array.isArray(step.content)) continue;
      for (const rawContent of step.content) {
        const content = asRecord(rawContent);
        if (content?.type === 'video') outputs.push(content);
      }
    }
  }
  if (outputs.length === 0) throw new GeminiResponseError('Gemini Omni response did not contain a video.', 'gemini_output_invalid');
  if (outputs.length > GEMINI_VIDEO_MAX_OUTPUT_ASSETS) throw new GeminiResponseError('Gemini Omni returned more videos than requested.', 'gemini_output_limit_exceeded');
  return outputs;
}

function completedAsset(context: GeminiVideoRuntimeContext, interaction: ParsedInteraction, model: string): SubmittedAsset {
  const candidate = outputVideos(interaction.root)[0];
  if (!candidate) throw new GeminiResponseError('Gemini Omni video output is missing.', 'gemini_output_invalid');
  const resultId = boundedResultId(interaction.id);
  const inline = resultInline(candidate);
  if (inline) return { ...inline, ...(resultId === undefined ? {} : { resultId }) };
  const uri = resultUri(candidate);
  if (!uri) throw new GeminiResponseError('Gemini Omni video has no inline data or URI.', 'gemini_output_invalid');
  const file = fileIdFromUri(uri);
  return providerVideoAsset(context, file === undefined ? `interaction:${interaction.id}` : `file:${file}`, model, resultId);
}

function completedUri(interaction: ParsedInteraction): string {
  const candidate = outputVideos(interaction.root)[0];
  if (!candidate) throw new GeminiResponseError('Gemini Omni video output is missing.', 'gemini_output_invalid');
  const uri = resultUri(candidate);
  if (!uri) throw new GeminiResponseError('Gemini Omni result is inline and cannot be resolved as a download target.', 'gemini_inline_result_not_resolvable');
  return uri;
}

function interactionId(remoteJobId: string): string {
  if (!remoteJobId.startsWith('interaction:')) throw new GeminiValidationError('Gemini Omni remote job id is invalid.', 'gemini_interaction_invalid');
  return assertInteractionId(remoteJobId.slice('interaction:'.length));
}

function resultFileId(remoteJobId: string): string {
  if (!remoteJobId.startsWith('file:')) throw new GeminiValidationError('Gemini Omni file result id is invalid.', 'gemini_file_invalid');
  return assertFileId(remoteJobId.slice('file:'.length));
}

function isPendingStatus(status: string): boolean {
  return status === 'in_progress' || status === 'queued';
}

export class GeminiOmniVideoProvider implements ProviderAdapter {
  public readonly type = GEMINI_OMNI_VIDEO_PROFILE;
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
    const ids = this.models ?? configuredVideoModels({}, runtimeContext, OMNI_MODELS);
    return { providerType: this.type, models: ids.map((id) => modelDefinition(id)) };
  }

  public async getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const runtimeContext = runtime(context);
    const transport = this.http ?? runtimeContext.http ?? runtimeContext.transport;
    if (!transport) return this.getCapabilities(runtimeContext);
    const body = await this.requestModels(runtimeContext, transport);
    const configured = this.models ?? configuredVideoModels({}, runtimeContext, OMNI_MODELS);
    const explicit = this.models !== undefined || Array.isArray(runtimeContext.config?.models);
    return {
      providerType: this.type,
      models: catalogModels(body, OMNI_DEFINITIONS, (entry) => {
        const id = canonicalModelId(String(entry.name));
        const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        const interactions = methods.length > 0 && methods.some((method) => typeof method === 'string' && ['interactions', 'generatecontent'].includes(method.toLowerCase()));
        return /^gemini-omni-/u.test(id) && interactions && (!explicit || configured.includes(id));
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
    videoBaseUrl(runtimeContext, this.baseUrl, ['/interactions']);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    const runtimeContext = runtime(context);
    const payload = buildPayload(request, runtimeContext);
    const key = videoApiKey(runtimeContext);
    const base = videoBaseUrl(runtimeContext, this.baseUrl, ['/interactions']);
    const response = await requestVideoJson(runtimeContext, this.http, {
      method: 'POST', url: videoEndpoint(base, '/interactions'), headers: videoRequestHeaders(runtimeContext, key, this.headers),
      body: JSON.stringify(payload), ...(runtimeContext.signal === undefined ? {} : { signal: runtimeContext.signal }),
    }, 'Omni interaction');
    const interaction = parseInteraction(response);
    if (interaction.error || (!isPendingStatus(interaction.status) && interaction.status !== 'completed')) {
      const error = interaction.error ?? operationError({ status: interaction.status, message: 'Gemini Omni interaction failed.' });
      throw new GeminiResponseError(error.message, error.code);
    }
    if (isPendingStatus(interaction.status)) return { state: 'pending', remoteJobId: `interaction:${interaction.id}`, pollAfterMs: GEMINI_VIDEO_POLL_AFTER_MS, ...(interaction.resultExpiresAt === undefined ? {} : { resultExpiresAt: interaction.resultExpiresAt }) };
    if (isExpired(interaction.resultExpiresAt)) throw new GeminiResponseError('Gemini Omni result expired.', 'gemini_video_result_expired');
    return { state: 'completed', assets: [completedAsset(runtimeContext, interaction, modelDefinition(request.modelId).id)], ...(interaction.resultExpiresAt === undefined ? {} : { resultExpiresAt: interaction.resultExpiresAt }) };
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    const runtimeContext = runtime(context);
    const id = interactionId(remoteJobId);
    const interaction = await this.getInteraction(runtimeContext, id);
    if (interaction.error || (!isPendingStatus(interaction.status) && interaction.status !== 'completed')) {
      return { state: 'failed', error: interaction.error ?? operationError({ status: interaction.status, message: 'Gemini Omni interaction failed.' }) };
    }
    if (isPendingStatus(interaction.status)) return { state: interaction.progress && interaction.progress > 0 ? 'remote_running' : 'remote_pending', ...(interaction.progress === undefined ? {} : { progress: interaction.progress }), pollAfterMs: GEMINI_VIDEO_POLL_AFTER_MS, ...(interaction.resultExpiresAt === undefined ? {} : { resultExpiresAt: interaction.resultExpiresAt }) };
    if (isExpired(interaction.resultExpiresAt)) return { state: 'failed', error: { code: 'gemini_video_result_expired', kind: 'expired', message: 'The Gemini Omni result expired.', retryable: false } };
    const model = runtimeContext.modelId ? modelDefinition(runtimeContext.modelId).id : OMNI_MODELS[0];
    return { state: 'completed', assets: [completedAsset(runtimeContext, interaction, model)], ...(interaction.resultExpiresAt === undefined ? {} : { resultExpiresAt: interaction.resultExpiresAt }) };
  }

  public async resolveResult(asset: ProviderAssetReference, context: ProviderContext): Promise<ProviderResultTarget> {
    const runtimeContext = runtime(context);
    if (asset.providerId !== runtimeContext.providerId || asset.type !== 'video' || asset.variant !== 'video') throw new GeminiValidationError('Gemini Omni result reference is invalid.', 'gemini_result_reference_invalid');
    const base = videoBaseUrl(runtimeContext, this.baseUrl, ['/interactions']);
    if (asset.remoteJobId.startsWith('file:')) {
      const id = resultFileId(asset.remoteJobId);
      const file = await this.getFile(runtimeContext, id);
      if (file === 'processing') throw new GeminiResponseError('Gemini video file is still processing.', 'gemini_video_file_pending');
      if (file === 'failed') throw new GeminiResponseError('Gemini video file failed.', 'gemini_video_file_failed');
      return fileDownloadTarget(runtimeContext, this.headers, base, id);
    }
    const id = interactionId(asset.remoteJobId);
    const interaction = await this.getInteraction(runtimeContext, id);
    if (interaction.error || interaction.status === 'expired') throw new GeminiResponseError(interaction.error?.message ?? 'Gemini Omni interaction expired.', interaction.error?.code ?? 'gemini_video_result_expired');
    if (isPendingStatus(interaction.status)) throw new GeminiTransportError('Gemini Omni result is not ready.');
    if (isExpired(interaction.resultExpiresAt)) throw new GeminiResponseError('Gemini Omni result expired.', 'gemini_video_result_expired');
    const uri = completedUri(interaction);
    const file = fileIdFromUri(uri);
    return file === undefined ? providerTarget(runtimeContext, this.headers, base, uri) : fileDownloadTarget(runtimeContext, this.headers, base, file);
  }

  public normalizeError(error: unknown): ProviderError {
    return normalizeGeminiVideoError(error);
  }

  private async getInteraction(context: GeminiVideoRuntimeContext, id: string): Promise<ParsedInteraction> {
    const key = videoApiKey(context);
    const base = videoBaseUrl(context, this.baseUrl, ['/interactions']);
    const response = await requestVideoJson(context, this.http, {
      method: 'GET', url: videoEndpoint(base, `/interactions/${encodeURIComponent(id)}`), headers: videoRequestHeaders(context, key, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }, 'Omni interaction');
    return parseInteraction(response, id);
  }

  private async getFile(context: GeminiVideoRuntimeContext, id: string): Promise<'processing' | 'active' | 'failed'> {
    const key = videoApiKey(context);
    const base = videoBaseUrl(context, this.baseUrl, ['/interactions']);
    const response = await requestVideoJson(context, this.http, {
      method: 'GET', url: videoEndpoint(base, `/files/${encodeURIComponent(assertFileId(id))}`), headers: videoRequestHeaders(context, key, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }, 'Omni file');
    const root = asRecord(response);
    const state = asRecord(root?.state);
    const status = String(state?.name ?? root?.state ?? root?.status ?? '').toLowerCase();
    if (status === 'processing') return 'processing';
    if (['failed', 'error'].includes(status)) return 'failed';
    if (['active', 'ready', 'completed'].includes(status)) return 'active';
    throw new GeminiResponseError('Gemini file response did not include a supported state.', 'gemini_file_invalid');
  }

  private async requestModels(context: GeminiVideoRuntimeContext, transport: GeminiVideoHttp): Promise<unknown> {
    const key = videoApiKey(context);
    const base = videoBaseUrl(context, this.baseUrl, ['/models']);
    const request: GeminiHttpRequest = {
      method: 'GET', url: videoModelsUrl(base), headers: videoRequestHeaders(context, key, this.headers),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    return requestVideoJson(context, transport, request, 'Omni models');
  }
}

export const GeminiOmniInteractionsVideoProvider = GeminiOmniVideoProvider;
export const GeminiOmniInteractionsVideoAdapter = GeminiOmniVideoProvider;
export default GeminiOmniVideoProvider;

export { buildPayload as buildOmniVideoPayload };
export type { OmniPayload };
