import {
  GenerationRequestSchema,
  ModelCapabilitiesSchema,
  CustomAdapterRefSchema,
  type GenerationRequest,
} from '@imagine/shared';
import type {
  PollResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  ProviderInput,
  ProviderModel,
  SubmitResult,
} from '@imagine/provider-contract';

import type { AdapterManifest, AdapterCapabilities as WorkerCapabilities } from '../../adapters/manifest.js';
import type {
  AdapterErrorView,
  AdapterFileView,
  AdapterInvocation,
} from '../../adapters/worker-protocol.js';
import {
  assertBoundedAdapterData,
  MAX_INPUT_FILE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_TOTAL_INPUT_BYTES,
  validateAdapterResult,
} from '../../adapters/worker-protocol.js';
import type { AdapterRuntimeReference } from '../../adapters/store.js';
import type { AdapterProviderContext, AdapterWorkerHost } from '../../adapters/worker-host.js';
import { validateSubmittedAssets } from '../../jobs/submitted-asset-validator.js';

export const CUSTOM_JS_ADAPTER_TYPE = 'custom-js-v1' as const;
export const TRUSTED_JAVASCRIPT_ADAPTER_TYPE = CUSTOM_JS_ADAPTER_TYPE;
export const CUSTOM_JAVASCRIPT_ADAPTER_TYPE = CUSTOM_JS_ADAPTER_TYPE;

/** A deliberately broad but finite range for provider-declared result expiry. */
export const MIN_RESULT_EXPIRY_MS = Date.UTC(2000, 0, 1);
export const MAX_RESULT_EXPIRY_MS = Date.UTC(2100, 0, 1) - 1;

const MAX_ADAPTER_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_TEXT_LENGTH = 16_384;
const MAX_ID_LENGTH = 255;
const MAX_INPUTS = 32;
const MAX_CAPABILITY_MODELS = 64;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const GENERIC_PROVIDER_ERROR = 'Trusted JavaScript provider operation failed.';

type ManifestContract = Pick<AdapterManifest, 'capabilities' | 'operations'> & {
  readonly requiredSecrets?: readonly string[];
};

/**
 * AdapterWorkerHost is the production implementation. Keeping this narrow
 * port structural also makes the wrapper contract-testable without starting a
 * worker or a server.
 */
export interface TrustedJavaScriptWorkerHost {
  capabilities(reference: AdapterRuntimeReference, context: AdapterProviderContext, signal?: AbortSignal): Promise<unknown>;
  submit(reference: AdapterRuntimeReference, context: AdapterProviderContext, invocation: AdapterInvocation, signal?: AbortSignal): Promise<unknown>;
  poll(reference: AdapterRuntimeReference, context: AdapterProviderContext, remoteJobId: string, signal?: AbortSignal): Promise<unknown>;
  cancel(reference: AdapterRuntimeReference, context: AdapterProviderContext, remoteJobId: string, signal?: AbortSignal): Promise<unknown>;
  normalizeError(reference: AdapterRuntimeReference, context: AdapterProviderContext, error: AdapterErrorView, signal?: AbortSignal): Promise<unknown> | unknown;
}

export interface TrustedJavaScriptAdapterOptions {
  /** Optional contract for fake hosts; production AdapterWorkerHost checks it from the runtime record. */
  readonly manifest?: ManifestContract;
}

type TrustedJavaScriptAdapterContract = TrustedJavaScriptAdapterOptions | ManifestContract;

export class TrustedJavaScriptAdapterError extends Error {
  public override readonly name = 'TrustedJavaScriptAdapterError';

  public constructor(
    public readonly code:
      | 'invalid_reference'
      | 'invalid_request'
      | 'invalid_input'
      | 'invalid_capabilities'
      | 'invalid_submit_result'
      | 'invalid_poll_result'
      | 'invalid_cancel_result',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function invalidResult(
  code: TrustedJavaScriptAdapterError['code'],
  operation: string,
  cause?: unknown,
): TrustedJavaScriptAdapterError {
  return new TrustedJavaScriptAdapterError(
    code,
    `Trusted JavaScript adapter returned an invalid ${operation} result.`,
    cause === undefined ? undefined : { cause },
  );
}

function boundedString(value: unknown, label: string, max = MAX_REQUEST_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL_PATTERN.test(value)) {
    throw new TrustedJavaScriptAdapterError('invalid_request', `${label} is invalid.`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string, max = MAX_REQUEST_TEXT_LENGTH): void {
  if (value !== undefined) boundedString(value, label, max);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function resultExpiry(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 128) throw new Error('invalid result expiry');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp < MIN_RESULT_EXPIRY_MS || timestamp > MAX_RESULT_EXPIRY_MS) {
    throw new Error('invalid result expiry');
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid result expiry');
  return date;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value) ? value : undefined;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|access[-_]?token|oauth[-_]?token|token|secret|password|credential|credentials|signature|sig|idempotency[-_]?key|auth|cookie|set-cookie)\s*[:=]\s*[^\s,;"']+/giu, '[REDACTED]')
    .replace(/\r|\n/gu, ' ')
    .slice(0, 512);
}

function safeProviderError(value: unknown, secrets: readonly string[] = []): ProviderError {
  if (!isRecord(value)) {
    return { code: 'provider_unknown', kind: 'unknown', message: GENERIC_PROVIDER_ERROR, retryable: false };
  }
  const code = safeErrorCode(value.code) ?? 'provider_unknown';
  const kind = value.kind === 'expired' || value.kind === 'rejected' || value.kind === 'transient' || value.kind === 'unknown'
    ? value.kind
    : 'unknown';
  let rawMessage = typeof value.message === 'string' ? redactText(value.message) : '';
  for (const secret of secrets) if (secret.length > 0) rawMessage = rawMessage.split(secret).join('[REDACTED]');
  const message = rawMessage.length > 0 ? rawMessage : GENERIC_PROVIDER_ERROR;
  const retryable = typeof value.retryable === 'boolean' ? value.retryable : false;
  const retryAfterMs = typeof value.retryAfterMs === 'number' && Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 86_400_000
    ? value.retryAfterMs
    : undefined;
  const statusCode = typeof value.statusCode === 'number' && Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599
    ? value.statusCode
    : undefined;
  return {
    code,
    kind,
    message,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function safeWorkerError(error: unknown): AdapterErrorView {
  // The worker only needs a bounded discriminator. Never forward a raw cause.
  const candidate = isRecord(error) ? error : undefined;
  const status = candidate?.status ?? candidate?.statusCode;
  const code = safeErrorCode(candidate?.code);
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(error.name) ? error.name : 'Error';
  const metadata = [
    name === 'Error' ? undefined : `name=${name}`,
    code === undefined ? undefined : `code=${code}`,
    typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `status=${status}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    name,
    message: metadata.length === 0 ? GENERIC_PROVIDER_ERROR : `${GENERIC_PROVIDER_ERROR} (${metadata.join(', ')})`,
    ...(code === undefined ? {} : { code }),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
  };
}

function workerContext(
  context: ProviderContext,
  requiredSecrets?: readonly string[],
): AdapterProviderContext {
  boundedString(context.providerId, 'Provider id', MAX_ID_LENGTH);
  if (context.baseUrl !== undefined) boundedString(context.baseUrl, 'Provider base URL', 4_096);
  const config = context.config ?? {};
  const secrets = Object.create(null) as Record<string, string>;
  const names = requiredSecrets ?? Object.keys(context.secrets);
  for (const name of names) {
    const value = context.secrets[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REQUEST_TEXT_LENGTH || CONTROL_PATTERN.test(value)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Provider secret view is invalid.');
    }
    secrets[name] = value;
  }
  assertBoundedAdapterData(config, MAX_REQUEST_BYTES, Object.values(secrets));
  return {
    providerId: context.providerId,
    ...(context.baseUrl === undefined ? {} : { baseUrl: context.baseUrl }),
    config,
    secrets,
  };
}

function validateRequestShape(request: GenerationRequest, context: ProviderContext): GenerationRequest {
  const parsed = GenerationRequestSchema.safeParse(request);
  if (!parsed.success) throw new TrustedJavaScriptAdapterError('invalid_request', 'Generation request is invalid.');
  const value = parsed.data;
  assertBoundedAdapterData(value, MAX_REQUEST_BYTES, Object.values(context.secrets));
  boundedString(value.providerId, 'Provider id', MAX_ID_LENGTH);
  boundedString(value.modelId, 'Model id', MAX_ID_LENGTH);
  boundedString(value.prompt, 'Prompt');
  optionalBoundedString(value.negativePrompt, 'Negative prompt');
  optionalBoundedString(value.aspectRatio, 'Aspect ratio');
  optionalBoundedString(value.resolution, 'Resolution');
  optionalBoundedString(value.quality, 'Quality');
  optionalBoundedString(value.format, 'Format');
  if (value.inputs.length > MAX_INPUTS) throw new TrustedJavaScriptAdapterError('invalid_input', 'Too many generation inputs.');
  for (const input of value.inputs) {
    boundedString(input.assetId, 'Input asset id', MAX_ID_LENGTH);
    boundedString(input.role, 'Input role', 128);
  }
  if (value.providerId !== context.providerId) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'Generation request Provider does not match its context.');
  }
  return value;
}

function validateCapabilityOptions(
  request: GenerationRequest,
  capabilities: ReturnType<typeof ModelCapabilitiesSchema.parse>,
): void {
  if (request.count !== undefined) {
    if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 32) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested batch count is outside the safety limit.');
    }
    if (capabilities.supportsBatchCount !== true && request.count > 1) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'This model does not support batch generation.');
    }
    if (capabilities.maxBatchCount !== undefined && request.count > capabilities.maxBatchCount) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested batch count exceeds the model capability.');
    }
  }
  if (request.aspectRatio !== undefined && (capabilities.aspectRatios === undefined || !capabilities.aspectRatios.includes(request.aspectRatio))) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested aspect ratio is not supported by this model.');
  }
  if (request.resolution !== undefined && (capabilities.resolutions === undefined || !capabilities.resolutions.includes(request.resolution))) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested resolution is not supported by this model.');
  }
  if (request.width !== undefined || request.height !== undefined) {
    if (request.width === undefined || request.height === undefined || !Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Width and height must be supplied together as safe integers.');
    }
    if (capabilities.resolutions === undefined || !capabilities.resolutions.includes(`${request.width}x${request.height}`)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested dimensions are not supported by this model.');
    }
  }
  if (request.durationSeconds !== undefined) {
    const durations = capabilities.durations;
    if (!Number.isFinite(request.durationSeconds) || request.durationSeconds <= 0 || durations === undefined) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested duration is not supported by this model.');
    }
    if (Array.isArray(durations) && !durations.includes(request.durationSeconds)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested duration is not supported by this model.');
    }
    if (!Array.isArray(durations) && (request.durationSeconds < durations.min || request.durationSeconds > durations.max)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested duration is outside the model range.');
    }
  }
  if (request.negativePrompt !== undefined && capabilities.supportsNegativePrompt !== true) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'This model does not support negative prompts.');
  }
  if (request.seed !== undefined && capabilities.supportsSeed !== true) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'This model does not support seeds.');
  }
  if (request.audio !== undefined && capabilities.supportsAudio !== true) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'This model does not support audio.');
  }
  if (request.extra !== undefined) validateExtraFields(request.extra, capabilities.customFields);
}

function validateExtraFields(value: Record<string, unknown>, customFields: Record<string, unknown> | undefined): void {
  if (customFields === undefined || customFields.type !== 'object' || customFields.additionalProperties !== false) {
    throw new TrustedJavaScriptAdapterError('invalid_request', 'This model does not declare extra request parameters.');
  }
  const properties = isRecord(customFields.properties) ? customFields.properties : {};
  const required = Array.isArray(customFields.required) ? customFields.required : [];
  if (required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key))) {
    throw new TrustedJavaScriptAdapterError('invalid_capabilities', 'The adapter extra request schema is invalid.');
  }
  const visit = (schemaValue: unknown, requestValue: unknown, path: string, depth: number): void => {
    if (!isRecord(schemaValue) || depth > 12 || typeof schemaValue.type !== 'string') {
      throw new TrustedJavaScriptAdapterError('invalid_capabilities', 'The adapter extra request schema is invalid.');
    }
    if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((candidate) => Object.is(candidate, requestValue))) {
      throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is outside the declared enum.`);
    }
    if (schemaValue.type === 'object') {
      if (!isRecord(requestValue) || schemaValue.additionalProperties !== false) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is invalid.`);
      const childProperties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
      const childRequired = Array.isArray(schemaValue.required) ? schemaValue.required : [];
      for (const key of childRequired) if (typeof key !== 'string' || !Object.hasOwn(requestValue, key)) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request parameter '${path}${key}' is required.`);
      for (const [key, child] of Object.entries(requestValue)) {
        const childSchema = childProperties[key];
        if (childSchema === undefined) throw new TrustedJavaScriptAdapterError('invalid_request', `Unknown extra request parameter '${path}${key}'.`);
        visit(childSchema, child, `${path}${key}.`, depth + 1);
      }
      return;
    }
    if (schemaValue.type === 'string') {
      if (typeof requestValue !== 'string' || requestValue.length > MAX_REQUEST_TEXT_LENGTH) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is invalid.`);
      if (typeof schemaValue.minLength === 'number' && requestValue.length < schemaValue.minLength) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is too short.`);
      if (typeof schemaValue.maxLength === 'number' && requestValue.length > schemaValue.maxLength) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is too long.`);
      return;
    }
    if (schemaValue.type === 'number' || schemaValue.type === 'integer') {
      if (typeof requestValue !== 'number' || !Number.isFinite(requestValue) || (schemaValue.type === 'integer' && !Number.isSafeInteger(requestValue))) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is invalid.`);
      if (typeof schemaValue.min === 'number' && requestValue < schemaValue.min) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is below the minimum.`);
      if (typeof schemaValue.max === 'number' && requestValue > schemaValue.max) throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is above the maximum.`);
      return;
    }
    if (schemaValue.type !== 'boolean' || typeof requestValue !== 'boolean') throw new TrustedJavaScriptAdapterError('invalid_request', `Extra request value at ${path} is invalid.`);
  };
  visit(customFields, value, '', 0);
}

function validateOperationInputs(
  request: GenerationRequest,
  capabilities: ReturnType<typeof ModelCapabilitiesSchema.parse>,
): void {
  const count = (role: GenerationRequest['inputs'][number]['role']): number => request.inputs.filter((input) => input.role === role).length;
  if (new Set(request.inputs.map((input) => input.assetId)).size !== request.inputs.length) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'An input asset may only appear once.');
  }
  if (count('reference') > (capabilities.maxReferenceImages ?? 0)) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'The request contains too many reference images.');
  }
  if (request.operation === 'image.generate' && request.inputs.some((input) => input.role !== 'reference')) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'image.generate only accepts reference inputs.');
  }
  if (request.operation === 'video.generate' && request.inputs.length > 0) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'video.generate does not accept input assets.');
  }
  if (request.operation === 'video.image_to_video' && (count('first_frame') !== 1 || request.inputs.some((input) => input.role !== 'first_frame'))) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'video.image_to_video requires exactly one first_frame input.');
  }
  if (request.operation === 'video.reference_to_video' && (count('reference') < 1 || request.inputs.some((input) => input.role !== 'reference'))) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'video.reference_to_video requires reference inputs only.');
  }
  if (request.operation === 'image.edit') {
    if (count('source') !== 1 || count('first_frame') > 0 || count('last_frame') > 0) {
      throw new TrustedJavaScriptAdapterError('invalid_input', 'image.edit requires one source and no frame inputs.');
    }
    if (count('mask') > 1 || (count('mask') > 0 && capabilities.supportsMask !== true)) {
      throw new TrustedJavaScriptAdapterError('invalid_input', 'image.edit mask inputs are not supported by this model.');
    }
  }
  if (request.operation === 'video.edit' || request.operation === 'video.extend') {
    throw new TrustedJavaScriptAdapterError('invalid_input', `Operation ${request.operation} is not supported by the current input runtime.`);
  }
}

function boundedInputFile(input: ProviderInput): AdapterFileView {
  boundedString(input.assetId, 'Input asset id', MAX_ID_LENGTH);
  boundedString(input.role, 'Input role', 128);
  boundedString(input.mimeType, 'Input MIME type', 128);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_INPUT_FILE_BYTES) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input bytes are invalid.');
  }
  const mimeType = normalizeMimeType(input.mimeType);
  if (!mimeType.startsWith('image/')) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider inputs must be validated images.');
  if (input.filename !== undefined && (typeof input.filename !== 'string' || input.filename.length === 0 || input.filename.length > 255 || input.filename.includes('/') || input.filename.includes('\\') || CONTROL_PATTERN.test(input.filename))) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input filename is invalid.');
  }
  if (input.fileSize !== undefined && (!Number.isSafeInteger(input.fileSize) || input.fileSize !== input.bytes.byteLength)) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input file size is invalid.');
  }
  for (const [label, value] of [['width', input.width], ['height', input.height]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 100_000)) {
      throw new TrustedJavaScriptAdapterError('invalid_input', `Provider input ${label} is invalid.`);
    }
  }
  if (input.width === undefined || input.height === undefined || !Number.isSafeInteger(input.width * input.height)) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input dimensions are invalid.');
  }
  if (input.parentAssetId !== undefined && input.parentAssetId !== null) boundedString(input.parentAssetId, 'Input parent asset id', MAX_ID_LENGTH);
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !SAFE_SHA256.test(input.sha256))) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input digest is invalid.');
  }
  return {
    assetId: input.assetId,
    role: input.role,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    mimeType: input.mimeType,
    bytes: Uint8Array.from(input.bytes),
  };
}

function filesForRequest(
  request: GenerationRequest,
  context: ProviderContext,
  capabilities: ReturnType<typeof ModelCapabilitiesSchema.parse>,
): readonly AdapterFileView[] {
  const loaded = context.inputs ?? [];
  if (loaded.length > MAX_INPUTS || loaded.length !== request.inputs.length) {
    throw new TrustedJavaScriptAdapterError('invalid_input', 'Loaded provider inputs do not match the request.');
  }
  let total = 0;
  const files = request.inputs.map((requested) => {
    const candidate = loaded.find((input) => input.assetId === requested.assetId && input.role === requested.role);
    if (candidate === undefined) throw new TrustedJavaScriptAdapterError('invalid_input', 'Loaded provider inputs do not match the request.');
    const file = boundedInputFile(candidate);
    total += file.bytes.byteLength;
    if (total > MAX_TOTAL_INPUT_BYTES) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider inputs exceed the total byte limit.');
    const constraints = capabilities.inputImageConstraints;
    const mime = normalizeMimeType(candidate.mimeType);
    if (constraints?.mimeTypes !== undefined && !constraints.mimeTypes.some((value) => normalizeMimeType(value) === mime)) {
      throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input MIME type is not supported.');
    }
    if (constraints?.maxBytes !== undefined && file.bytes.byteLength > constraints.maxBytes) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input exceeds the byte limit.');
    if (constraints?.maxWidth !== undefined && (candidate.width === undefined || candidate.width > constraints.maxWidth)) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input exceeds the width limit.');
    if (constraints?.maxHeight !== undefined && (candidate.height === undefined || candidate.height > constraints.maxHeight)) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input exceeds the height limit.');
    if (constraints?.maxPixels !== undefined && (candidate.width === undefined || candidate.height === undefined || candidate.width * candidate.height > constraints.maxPixels)) throw new TrustedJavaScriptAdapterError('invalid_input', 'Provider input exceeds the pixel limit.');
    return file;
  });
  if (request.operation === 'image.edit') {
    const source = loaded.find((input) => input.assetId === request.inputs.find((item) => item.role === 'source')?.assetId);
    const mask = loaded.find((input) => input.assetId === request.inputs.find((item) => item.role === 'mask')?.assetId);
    if (mask !== undefined && (source === undefined || normalizeMimeType(mask.mimeType) !== 'image/png' || mask.parentAssetId !== source.assetId || mask.width !== source.width || mask.height !== source.height)) {
      throw new TrustedJavaScriptAdapterError('invalid_input', 'Mask must match the source image relationship and dimensions.');
    }
  }
  return files;
}

function mapCapabilities(value: unknown, manifest?: ManifestContract, secrets: readonly string[] = []): ProviderCapabilities {
  let parsed: WorkerCapabilities;
  try {
    parsed = validateAdapterResult('capabilities', value, MAX_ADAPTER_RESULT_BYTES, secrets, manifest) as WorkerCapabilities;
    if (!Array.isArray(parsed.models) || parsed.models.length > MAX_CAPABILITY_MODELS) throw new Error('models');
    const modelIds = new Set<string>();
    for (const model of parsed.models) {
      if (modelIds.has(model.id)) throw new Error('duplicate model');
      modelIds.add(model.id);
      const shared = ModelCapabilitiesSchema.safeParse(model.capabilities);
      if (!shared.success) throw new Error('model capabilities');
    }
  } catch (error) {
    throw invalidResult('invalid_capabilities', 'capabilities', error);
  }
  return {
    // Do not compare this to CUSTOM_JS_ADAPTER_TYPE: the manifest may expose
    // a provider-specific type while the runtime adapter remains custom-js-v1.
    providerType: parsed.providerType,
    models: parsed.models.map((model): ProviderModel => ({
      id: model.id,
      displayName: model.displayName,
      capabilities: ModelCapabilitiesSchema.parse(model.capabilities) as ProviderModel['capabilities'],
    })),
  };
}

function mapSubmit(value: unknown, secrets: readonly string[] = [], maxAssets = 32): SubmitResult {
  try {
    const parsed = validateAdapterResult('submit', value, MAX_ADAPTER_RESULT_BYTES, secrets) as Readonly<Record<string, unknown>>;
    if (parsed.state === 'pending') {
      const expiry = resultExpiry(parsed.resultExpiresAt);
      return {
        state: 'pending',
        remoteJobId: parsed.remoteJobId as string,
        ...(parsed.pollAfterMs === undefined ? {} : { pollAfterMs: parsed.pollAfterMs as number }),
        ...(expiry === undefined ? {} : { resultExpiresAt: expiry }),
      };
    }
    const expiry = resultExpiry(parsed.resultExpiresAt);
    const assets = validateSubmittedAssets(parsed.assets, { maxAssets });
    return {
      state: 'completed',
      assets,
      ...(expiry === undefined ? {} : { resultExpiresAt: expiry }),
    };
  } catch (error) {
    throw invalidResult('invalid_submit_result', 'submit', error);
  }
}

function mapPoll(value: unknown, secrets: readonly string[] = [], maxAssets = 32): PollResult {
  try {
    const parsed = validateAdapterResult('poll', value, MAX_ADAPTER_RESULT_BYTES, secrets) as Readonly<Record<string, unknown>>;
    if (parsed.state === 'failed') return { state: 'failed', error: safeProviderError(parsed.error, secrets) };
    const expiry = resultExpiry(parsed.resultExpiresAt);
    if (parsed.state === 'completed') {
      const assets = validateSubmittedAssets(parsed.assets, { maxAssets });
      return {
        state: 'completed',
        assets,
        ...(expiry === undefined ? {} : { resultExpiresAt: expiry }),
      };
    }
    return {
      state: parsed.state as 'remote_pending' | 'remote_running',
      ...(parsed.progress === undefined ? {} : { progress: parsed.progress as number }),
      ...(parsed.pollAfterMs === undefined ? {} : { pollAfterMs: parsed.pollAfterMs as number }),
      ...(expiry === undefined ? {} : { resultExpiresAt: expiry }),
    };
  } catch (error) {
    throw invalidResult('invalid_poll_result', 'poll', error);
  }
}

function validateRemoteJobId(value: string): string {
  return boundedString(value, 'Remote job id', MAX_ID_LENGTH);
}

export class TrustedJavaScriptAdapter implements ProviderAdapter {
  public readonly type = CUSTOM_JS_ADAPTER_TYPE;
  public readonly reference: AdapterRuntimeReference;

  private readonly host: TrustedJavaScriptWorkerHost;
  private readonly manifest: ManifestContract | undefined;

  public constructor(
    reference: AdapterRuntimeReference,
    host: AdapterWorkerHost | TrustedJavaScriptWorkerHost,
    options: TrustedJavaScriptAdapterContract = {},
  ) {
    const parsed = CustomAdapterRefSchema.safeParse(reference);
    if (!parsed.success || parsed.data.kind !== 'trusted-javascript') {
      throw new TrustedJavaScriptAdapterError('invalid_reference', 'Trusted JavaScript adapter reference is invalid.');
    }
    this.reference = reference;
    this.host = host;
    this.manifest = 'operations' in options && 'capabilities' in options
      ? options
      : options.manifest;
  }

  public async getCapabilities(context: ProviderContext): Promise<ProviderCapabilities> {
    const value = await this.host.capabilities(this.reference, workerContext(context, this.manifestRequiredSecrets()), context.signal);
    context.signal?.throwIfAborted();
    return mapCapabilities(value, this.manifest, Object.values(context.secrets));
  }

  public async validate(request: GenerationRequest, context: ProviderContext): Promise<void> {
    context.signal?.throwIfAborted();
    const parsed = validateRequestShape(request, context);
    const capabilities = await this.getCapabilities(context);
    const model = capabilities.models.find((candidate) => candidate.id === parsed.modelId);
    if (model === undefined) throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested model is not declared by the adapter.');
    if (!model.capabilities.operations.includes(parsed.operation)) throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested operation is not supported by the model.');
    const shared = ModelCapabilitiesSchema.safeParse(model.capabilities);
    if (!shared.success) throw new TrustedJavaScriptAdapterError('invalid_capabilities', 'Adapter model capabilities are invalid.');
    validateCapabilityOptions(parsed, shared.data);
    validateOperationInputs(parsed, shared.data);
    filesForRequest(parsed, context, shared.data);
  }

  public async submit(request: GenerationRequest, context: ProviderContext): Promise<SubmitResult> {
    context.signal?.throwIfAborted();
    const parsed = validateRequestShape(request, context);
    const capabilities = await this.getCapabilities(context);
    const model = capabilities.models.find((candidate) => candidate.id === parsed.modelId);
    if (model === undefined || !model.capabilities.operations.includes(parsed.operation)) {
      throw new TrustedJavaScriptAdapterError('invalid_request', 'Requested model or operation is not supported by the adapter.');
    }
    const shared = ModelCapabilitiesSchema.parse(model.capabilities);
    validateCapabilityOptions(parsed, shared);
    validateOperationInputs(parsed, shared);
    const files = filesForRequest(parsed, context, shared);
    const value = await this.host.submit(
      this.reference,
      workerContext(context, this.manifestRequiredSecrets()),
      { request: parsed, files },
      context.signal,
    );
    context.signal?.throwIfAborted();
    return mapSubmit(value, Object.values(context.secrets), parsed.count ?? 1);
  }

  public async poll(remoteJobId: string, context: ProviderContext): Promise<PollResult> {
    context.signal?.throwIfAborted();
    const value = await this.host.poll(this.reference, workerContext(context, this.manifestRequiredSecrets()), validateRemoteJobId(remoteJobId), context.signal);
    context.signal?.throwIfAborted();
    return mapPoll(value, Object.values(context.secrets));
  }

  public async cancel(remoteJobId: string, context: ProviderContext): Promise<void> {
    context.signal?.throwIfAborted();
    const value = await this.host.cancel(this.reference, workerContext(context, this.manifestRequiredSecrets()), validateRemoteJobId(remoteJobId), context.signal);
    context.signal?.throwIfAborted();
    try {
      if (value !== undefined && value !== null) throw new Error('cancel result');
    } catch (error) {
      throw invalidResult('invalid_cancel_result', 'cancel', error);
    }
  }

  public async normalizeError(error: unknown): Promise<ProviderError> {
    try {
      const value = await this.host.normalizeError(
        this.reference,
        { providerId: CUSTOM_JS_ADAPTER_TYPE, config: {}, secrets: {} },
        safeWorkerError(error),
      );
      const parsed = validateAdapterResult('normalizeError', value, MAX_ADAPTER_RESULT_BYTES);
      return safeProviderError(parsed);
    } catch {
      return { code: 'provider_unknown', kind: 'unknown', message: GENERIC_PROVIDER_ERROR, retryable: false };
    }
  }

  private manifestRequiredSecrets(): readonly string[] | undefined {
    return this.manifest?.requiredSecrets;
  }
}

export { TrustedJavaScriptAdapter as CustomJavaScriptAdapter };
export { TrustedJavaScriptAdapter as CustomJsAdapter };
export { TrustedJavaScriptAdapter as CustomJavaScriptProviderAdapter };
export { TrustedJavaScriptAdapter as TrustedJavaScriptProviderAdapter };
export { TrustedJavaScriptAdapter as CustomJsProviderAdapter };
export { TrustedJavaScriptAdapter as JavaScriptAdapter };
