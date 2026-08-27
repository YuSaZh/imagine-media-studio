import { z } from 'zod';

import {
  AdapterCapabilitiesSchema,
  type AdapterCapabilities,
  type AdapterManifest,
  type AdapterResourceLimits,
} from './manifest.js';
import { isCredentialLikeQueryName as isCredentialLikeQueryNameShared } from '../security/network-policy.js';

export const MAX_PROVIDER_ID_BYTES = 255;
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_INPUT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_HTTP_HEADERS = 128;
export const MAX_HTTP_HEADER_BYTES = 8 * 1024;
export const MAX_REMOTE_ID_BYTES = 255;
export const MAX_ERROR_BYTES = 4 * 1024;
export const MAX_ERROR_REDACTION_INPUT_BYTES = MAX_ERROR_BYTES + 16_384;
export const MAX_ASSETS = 16;

// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SAFE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SECRET_LIKE_KEY_PATTERN = /(?:^|[-_.])(?:api[-_.]?key|authorization|cookie|password|secret|token|credential|headers?)(?:$|[-_.])/iu;

export type AdapterCall = 'capabilities' | 'submit' | 'poll' | 'cancel' | 'normalizeError';

export interface AdapterProviderView {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface AdapterFileView {
  readonly assetId: string;
  readonly role: string;
  readonly filename?: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface AdapterInvocation {
  readonly provider?: AdapterProviderView;
  readonly request?: unknown;
  readonly files?: readonly AdapterFileView[];
  readonly remoteJobId?: string;
  readonly error?: AdapterErrorView;
}

export interface AdapterErrorView {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
}

export interface AdapterHttpRequest {
  readonly method: (typeof SAFE_METHODS)[number];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface AdapterHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface AdapterHttpValidationOptions {
  /** Protocols allowed by the installed adapter manifest. */
  readonly allowedProtocols?: readonly ('http:' | 'https:' | 'http' | 'https')[];
  /** Effective TCP ports allowed by the installed adapter manifest. */
  readonly allowedPorts?: readonly number[];
  /** Provider base URLs may opt into a non-default port before request checks. */
  readonly allowNonDefaultPort?: boolean;
}

export interface SafeHttpPort {
  /** The host implementation must re-check redirect targets before following any redirect. */
  request(request: AdapterHttpRequest, signal: AbortSignal): Promise<AdapterHttpResponse>;
  /** Optional provider-port facade hook for per-manifest response limits. */
  requestWithLimit?(
    request: AdapterHttpRequest,
    signal: AbortSignal,
    maxResponseBodyBytes: number,
  ): Promise<AdapterHttpResponse>;
}

export interface AdapterWorkerData {
  readonly source: string;
  readonly call: AdapterCall;
  readonly requestId: string;
  readonly provider?: AdapterProviderView;
  readonly request?: unknown;
  readonly files?: readonly AdapterFileView[];
  readonly remoteJobId?: string;
  readonly error?: AdapterErrorView;
}

export interface AdapterHttpMessage {
  readonly kind: 'http-request';
  readonly requestId: string;
  readonly input: AdapterHttpRequest;
}

export interface AdapterHttpResultMessage {
  readonly kind: 'http-result';
  readonly requestId: string;
  readonly ok: boolean;
  readonly value?: AdapterHttpResponse;
  readonly error?: AdapterErrorView;
}

export interface AdapterResultMessage {
  readonly kind: 'result';
  readonly requestId: string;
  /** Result expiry crosses the worker boundary as an ISO-8601 string; the central adapter wrapper converts it to Date. */
  readonly value: unknown;
}

export interface AdapterErrorMessage {
  readonly kind: 'error';
  readonly requestId: string;
  readonly error: AdapterErrorView;
}

export type AdapterWorkerMessage = AdapterHttpMessage | AdapterResultMessage | AdapterErrorMessage;
export type AdapterHostMessage = AdapterHttpResultMessage;

export class AdapterProtocolError extends Error {
  public override readonly name: string = 'AdapterProtocolError';
}

export class AdapterHttpRequestError extends AdapterProtocolError {
  public override readonly name: string = 'AdapterHttpRequestError';
}

export class AdapterWorkerFailure extends Error {
  public override readonly name: string = 'AdapterWorkerFailure';
  public constructor(message: string, public readonly code = 'adapter_worker_failed', _options?: ErrorOptions) {
    // Never attach ErrorOptions/cause: adapter errors cross a public boundary
    // and raw causes may contain provider credentials or request bodies.
    super(message);
  }
}

export class AdapterWorkerTimeoutError extends AdapterWorkerFailure {
  public override readonly name: string = 'AdapterWorkerTimeoutError';
  public constructor(message = 'Adapter execution timed out.') {
    super(message, 'adapter_timeout');
  }
}

export class AdapterWorkerAbortError extends AdapterWorkerFailure {
  public override readonly name: string = 'AdapterWorkerAbortError';
  public constructor(message = 'Adapter execution was aborted.') {
    super(message, 'adapter_aborted');
  }
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || CONTROL_PATTERN.test(value)) {
    throw new AdapterProtocolError(`${label} is invalid.`);
  }
  return value;
}

function effectiveUrlPort(parsed: URL): number {
  if (parsed.port !== '') return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

function safeUrl(
  value: unknown,
  label: string,
  options: AdapterHttpValidationOptions = {},
): string {
  const text = boundedText(value, 4_096, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new AdapterProtocolError(`${label} is not an absolute URL.`);
  }
  const allowedProtocols = (options.allowedProtocols ?? ['https:']).map((protocol) =>
    protocol.endsWith(':') ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`,
  );
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new AdapterProtocolError(`${label} uses a protocol that is not allowed by the adapter manifest.`);
  }
  const port = effectiveUrlPort(parsed);
  const allowedPorts = options.allowedPorts ?? (options.allowNonDefaultPort === true ? undefined : [parsed.protocol === 'https:' ? 443 : 80]);
  if (allowedPorts !== undefined && !allowedPorts.includes(port)) {
    throw new AdapterProtocolError(`${label} uses a port that is not allowed by the adapter manifest.`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new AdapterProtocolError(`${label} must not contain credentials or fragments.`);
  }
  for (const key of parsed.searchParams.keys()) if (isCredentialQueryName(key)) throw new AdapterProtocolError(`${label} contains a credential query parameter.`);
  return text;
}

function safeHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdapterHttpRequestError('HTTP headers must be an object.');
  const output = Object.create(null) as Record<string, string>;
  const entries = Object.entries(value);
  if (entries.length > MAX_HTTP_HEADERS) throw new AdapterHttpRequestError('Too many HTTP headers.');
  let totalBytes = 0;
  const normalizedNames = new Set<string>();
  for (const [name, rawValue] of entries) {
    const normalizedName = name.toLowerCase();
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      name === '__proto__' ||
      name === 'constructor' ||
      name === 'prototype' ||
      HOP_BY_HOP_HEADERS.has(normalizedName) ||
      normalizedNames.has(normalizedName)
    ) throw new AdapterHttpRequestError('HTTP header name is not allowed.');
    normalizedNames.add(normalizedName);
    const headerValue = boundedText(rawValue, MAX_HTTP_HEADER_BYTES, `HTTP header ${name}`);
    totalBytes += name.length + headerValue.length;
    if (totalBytes > MAX_HTTP_HEADERS * MAX_HTTP_HEADER_BYTES) throw new AdapterHttpRequestError('HTTP headers are too large.');
    output[name] = headerValue;
  }
  return output;
}

function safeResponseHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdapterHttpRequestError('HTTP response headers must be an object.');
  const output = Object.create(null) as Record<string, string>;
  const entries = Object.entries(value);
  if (entries.length > MAX_HTTP_HEADERS) throw new AdapterHttpRequestError('Too many HTTP response headers.');
  const normalizedNames = new Set<string>();
  let totalBytes = 0;
  for (const [name, rawValue] of entries) {
    const normalizedName = name.toLowerCase();
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      name === '__proto__' ||
      name === 'constructor' ||
      name === 'prototype' ||
      normalizedNames.has(normalizedName)
    ) throw new AdapterHttpRequestError('HTTP response header name is invalid.');
    normalizedNames.add(normalizedName);
    const headerValue = boundedText(rawValue, MAX_HTTP_HEADER_BYTES, `HTTP response header ${name}`);
    totalBytes += name.length + headerValue.length;
    if (totalBytes > MAX_HTTP_HEADERS * MAX_HTTP_HEADER_BYTES) throw new AdapterHttpRequestError('HTTP response headers are too large.');
    output[name] = headerValue;
  }
  return output;
}

export function validateHttpRequest(
  value: unknown,
  options: AdapterHttpValidationOptions = {},
): AdapterHttpRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdapterHttpRequestError('HTTP request must be an object.');
  const input = value as Record<string, unknown>;
  if (typeof input.method !== 'string' || !SAFE_METHODS.includes(input.method as (typeof SAFE_METHODS)[number])) {
    throw new AdapterHttpRequestError('HTTP method is not allowed.');
  }
  const headers = safeHeaders(input.headers);
  let body: Uint8Array | undefined;
  if (input.body !== undefined) {
    if (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_HTTP_BODY_BYTES) throw new AdapterHttpRequestError('HTTP body is too large or invalid.');
    body = Uint8Array.from(input.body);
  }
  return {
    method: input.method as (typeof SAFE_METHODS)[number],
    url: safeUrl(input.url, 'HTTP URL', options),
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

export function validateHttpResponse(value: unknown, maxBodyBytes = MAX_HTTP_BODY_BYTES): AdapterHttpResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdapterHttpRequestError('HTTP response must be an object.');
  const input = value as Record<string, unknown>;
  if (typeof input.status !== 'number' || !Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new AdapterHttpRequestError('HTTP response status is invalid.');
  }
  const headers = safeResponseHeaders(input.headers);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_HTTP_BODY_BYTES) {
    throw new AdapterHttpRequestError('HTTP response body limit is invalid.');
  }
  if (!(input.body instanceof Uint8Array) || input.body.byteLength > maxBodyBytes) throw new AdapterHttpRequestError('HTTP response body is too large or invalid.');
  return { status: input.status, headers, body: Uint8Array.from(input.body) };
}

function assertJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 10) throw new AdapterProtocolError('Adapter data is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && (value.length > 1_000_000 || CONTROL_PATTERN.test(value))) throw new AdapterProtocolError('Adapter data contains an invalid string.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdapterProtocolError('Adapter data contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new AdapterProtocolError('Adapter data contains an unsupported value.');
  if (seen.has(value)) throw new AdapterProtocolError('Adapter data contains a cycle.');
  seen.add(value);
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_INPUT_FILE_BYTES) throw new AdapterProtocolError('Adapter bytes are too large.');
  } else if (Array.isArray(value)) {
    if (value.length > 256) throw new AdapterProtocolError('Adapter array is too large.');
    for (const item of value) assertJson(item, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new AdapterProtocolError('Adapter data must be JSON objects.');
    const entries = Object.entries(value);
    if (entries.length > 256) throw new AdapterProtocolError('Adapter object is too large.');
    for (const [key, item] of entries) {
      if (key.length > 256 || CONTROL_PATTERN.test(key) || key === '__proto__' || key === 'constructor' || key === 'prototype' || SECRET_LIKE_KEY_PATTERN.test(key)) {
        throw new AdapterProtocolError('Adapter key is invalid or secret-like.');
      }
      if (SECRET_LIKE_KEY_PATTERN.test(key)) throw new AdapterProtocolError('Adapter data contains a secret-like key.');
      assertJson(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function assertNoSecretValues(value: unknown, secrets: readonly string[], seen = new WeakSet<object>()): void {
  if (secrets.length === 0 || value === null || typeof value !== 'object') {
    if (typeof value === 'string' && secrets.some((secret) => secret.length > 0 && value.includes(secret))) {
      throw new AdapterProtocolError('Adapter data contains a provider secret.');
    }
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value) || value instanceof Uint8Array) {
    for (const item of value) assertNoSecretValues(item, secrets, seen);
  } else {
    for (const item of Object.values(value)) assertNoSecretValues(item, secrets, seen);
  }
}

export function assertBoundedAdapterData(value: unknown, maxBytes: number, secrets: readonly string[] = []): void {
  assertJson(value);
  assertNoSecretValues(value, secrets);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '';
  } catch {
    throw new AdapterProtocolError('Adapter output is not serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) throw new AdapterProtocolError('Adapter output exceeds its size limit.');
}

function safeResultUrl(value: unknown): string {
  return safeUrl(value, 'result URL');
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.toString('base64') === value;
}

function isSafeResultUrl(value: string): boolean {
  try {
    safeResultUrl(value);
    return true;
  } catch {
    return false;
  }
}

const AssetBaseSchema = z.object({
  type: z.enum(['image', 'video']),
  mimeType: z.string().min(1).max(128).refine((value) => !CONTROL_PATTERN.test(value)),
  resultId: z.string().min(1).max(255).optional(),
  filename: z.string().min(1).max(255).refine((value) => !CONTROL_PATTERN.test(value)).optional(),
  metadata: z.record(z.string().max(128), z.unknown()).optional(),
}).strict();

const AssetSchema = z.union([
  AssetBaseSchema.extend({ source: z.literal('base64'), base64: z.string().min(1).max(16 * 1024 * 1024).refine(isBase64) }).strict(),
  AssetBaseSchema.extend({ source: z.literal('url'), url: z.string().min(1).max(4_096).refine(isSafeResultUrl) }).strict(),
  AssetBaseSchema.extend({
    source: z.literal('provider'),
    providerId: z.string().min(1).max(255),
    remoteJobId: z.string().min(1).max(MAX_REMOTE_ID_BYTES),
    variant: z.literal('video'),
  }).strict(),
]);

const ResultExpiresAtSchema = z.string().datetime({ offset: true }).max(128).optional();
const SubmitSchema = z.union([
  z.object({ state: z.literal('completed'), assets: z.array(AssetSchema).min(1).max(MAX_ASSETS), resultExpiresAt: ResultExpiresAtSchema }).strict(),
  z.object({
    state: z.literal('pending'),
    remoteJobId: z.string().min(1).max(MAX_REMOTE_ID_BYTES),
    pollAfterMs: z.number().int().min(0).max(86_400_000).optional(),
    resultExpiresAt: ResultExpiresAtSchema,
  }).strict(),
]);
const ProviderErrorSchema = z.object({
  code: z.string().min(1).max(128).refine((value) => !CONTROL_PATTERN.test(value)),
  kind: z.enum(['expired', 'rejected', 'transient', 'unknown']),
  message: z.string().min(1).max(512).refine((value) => !CONTROL_PATTERN.test(value)),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(0).max(86_400_000).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
}).strict();
const PollSchema = z.union([
  z.object({ state: z.enum(['remote_pending', 'remote_running']), progress: z.number().min(0).max(100).optional(), pollAfterMs: z.number().int().min(0).max(86_400_000).optional(), resultExpiresAt: ResultExpiresAtSchema }).strict(),
  z.object({ state: z.literal('completed'), assets: z.array(AssetSchema).min(1).max(MAX_ASSETS), resultExpiresAt: ResultExpiresAtSchema }).strict(),
  z.object({ state: z.literal('failed'), error: ProviderErrorSchema }).strict(),
]);

function assertStringArraySubset(
  returned: readonly string[] | undefined,
  declared: readonly string[] | undefined,
  label: string,
): void {
  if (returned === undefined) return;
  if (declared === undefined || returned.some((item) => !declared.includes(item))) {
    throw new AdapterProtocolError(`Capabilities returned undeclared ${label}.`);
  }
}

function assertDurationSubset(
  returned: AdapterCapabilities['models'][number]['capabilities']['durations'] | undefined,
  declared: AdapterCapabilities['models'][number]['capabilities']['durations'] | undefined,
): void {
  if (returned === undefined) return;
  if (declared === undefined) throw new AdapterProtocolError('Capabilities returned undeclared durations.');
  if (Array.isArray(returned)) {
    if (Array.isArray(declared)) {
      if (returned.some((item) => !declared.includes(item))) throw new AdapterProtocolError('Capabilities returned undeclared durations.');
    } else if (returned.some((item) => item < declared.min || item > declared.max)) {
      throw new AdapterProtocolError('Capabilities returned durations outside the manifest range.');
    }
    return;
  }
  if (Array.isArray(declared) || returned.min < declared.min || returned.max > declared.max) {
    throw new AdapterProtocolError('Capabilities returned a duration range outside the manifest.');
  }
}

function assertImageInputConstraintsSubset(
  returned: AdapterCapabilities['models'][number]['capabilities']['inputImageConstraints'] | undefined,
  declared: AdapterCapabilities['models'][number]['capabilities']['inputImageConstraints'] | undefined,
): void {
  if (returned === undefined) return;
  if (declared === undefined) throw new AdapterProtocolError('Capabilities returned undeclared input image constraints.');
  assertStringArraySubset(returned.mimeTypes, declared.mimeTypes, 'input image MIME types');
  for (const key of ['maxBytes', 'maxPixels', 'maxWidth', 'maxHeight'] as const) {
    const returnedValue = returned[key];
    const declaredValue = declared[key];
    if (returnedValue !== undefined && (declaredValue === undefined || returnedValue > declaredValue)) {
      throw new AdapterProtocolError(`Capabilities returned an undeclared input image ${key} limit.`);
    }
  }
}

function assertModelCapabilitiesSubset(
  returned: AdapterCapabilities['models'][number]['capabilities'],
  declared: AdapterCapabilities['models'][number]['capabilities'],
): void {
  for (const key of ['supportsMask', 'supportsNegativePrompt', 'supportsSeed', 'supportsAudio', 'supportsProgress', 'supportsCancel', 'supportsBatchCount'] as const) {
    if (returned[key] === true && declared[key] !== true) {
      throw new AdapterProtocolError(`Capabilities returned undeclared ${key}.`);
    }
  }
  for (const key of ['maxReferenceImages', 'maxBatchCount'] as const) {
    if (returned[key] !== undefined && (declared[key] === undefined || returned[key] > declared[key])) {
      throw new AdapterProtocolError(`Capabilities returned an undeclared ${key} limit.`);
    }
  }
  assertStringArraySubset(returned.aspectRatios, declared.aspectRatios, 'aspect ratios');
  assertStringArraySubset(returned.resolutions, declared.resolutions, 'resolutions');
  assertDurationSubset(returned.durations, declared.durations);
  assertImageInputConstraintsSubset(returned.inputImageConstraints, declared.inputImageConstraints);
  if (returned.customFields !== undefined) {
    if (declared.customFields === undefined) throw new AdapterProtocolError('Capabilities returned undeclared custom fields.');
    for (const key of Object.keys(returned.customFields)) {
      if (!Object.prototype.hasOwnProperty.call(declared.customFields, key)) {
        throw new AdapterProtocolError('Capabilities returned undeclared custom fields.');
      }
    }
  }
}

function assertCapabilitiesSubset(value: AdapterCapabilities, manifest: Pick<AdapterManifest, 'capabilities' | 'operations'>): void {
  if (value.providerType !== manifest.capabilities.providerType) {
    throw new AdapterProtocolError('Capabilities providerType is not declared by the adapter manifest.');
  }
  const declaredModels = new Map(manifest.capabilities.models.map((model) => [model.id, model]));
  const returnedModelIds = new Set<string>();
  for (const model of value.models) {
    if (returnedModelIds.has(model.id)) throw new AdapterProtocolError('Capabilities must not contain duplicate model ids.');
    returnedModelIds.add(model.id);
    const declaredModel = declaredModels.get(model.id);
    if (declaredModel === undefined) throw new AdapterProtocolError('Capabilities returned an undeclared model.');
    const declaredOperations = new Set(declaredModel.capabilities.operations);
    for (const operation of model.capabilities.operations) {
      if (!manifest.operations.includes(operation) || !declaredOperations.has(operation)) {
        throw new AdapterProtocolError('Capabilities returned an undeclared model operation.');
      }
    }
    assertModelCapabilitiesSubset(model.capabilities, declaredModel.capabilities);
  }
}

export function validateAdapterResult(
  call: AdapterCall,
  value: unknown,
  maxBytes: number,
  secrets: readonly string[] = [],
  manifest?: Pick<AdapterManifest, 'capabilities' | 'operations'>,
): unknown {
  if (call === 'cancel') {
    if (value !== undefined && value !== null) throw new AdapterProtocolError('Cancel result must be empty.');
    return undefined;
  }
  assertBoundedAdapterData(value, maxBytes, secrets);
  if (call === 'capabilities') {
    const parsed = AdapterCapabilitiesSchema.safeParse(value);
    if (!parsed.success) throw new AdapterProtocolError(`Invalid capabilities result: ${parsed.error.message}`);
    if (manifest !== undefined) assertCapabilitiesSubset(parsed.data, manifest);
    return parsed.data;
  }
  if (call === 'submit') {
    const parsed = SubmitSchema.safeParse(value);
    if (!parsed.success) throw new AdapterProtocolError(`Invalid submit result: ${parsed.error.message}`);
    return parsed.data;
  }
  if (call === 'poll') {
    const parsed = PollSchema.safeParse(value);
    if (!parsed.success) throw new AdapterProtocolError(`Invalid poll result: ${parsed.error.message}`);
    return parsed.data;
  }
  if (call === 'normalizeError') {
    const parsed = ProviderErrorSchema.safeParse(value);
    if (!parsed.success) throw new AdapterProtocolError(`Invalid normalized error: ${parsed.error.message}`);
    return parsed.data;
  }
  throw new AdapterProtocolError('Unknown adapter call result.');
}

export function validateAdapterProvider(
  provider: AdapterProviderView | undefined,
  httpOptions: AdapterHttpValidationOptions = {},
): AdapterProviderView | undefined {
  if (provider === undefined) return undefined;
  const providerId = boundedText(provider.providerId, MAX_PROVIDER_ID_BYTES, 'providerId');
  let baseUrl: string | undefined;
  if (provider.baseUrl !== undefined) {
    baseUrl = safeUrl(provider.baseUrl, 'provider base URL', httpOptions);
  }
  assertJson(provider.config);
  assertBoundedAdapterData(provider.config, MAX_REQUEST_BYTES);
  const secrets = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(provider.secrets)) {
    if (key.length > 128 || typeof value !== 'string' || value.length > 16_384 || CONTROL_PATTERN.test(value)) {
      throw new AdapterProtocolError('Provider secret view is invalid.');
    }
    secrets[key] = value;
  }
  return { providerId, ...(baseUrl === undefined ? {} : { baseUrl }), config: provider.config, secrets };
}

export function isCredentialQueryName(value: string): boolean {
  return isCredentialLikeQueryNameShared(value);
}

export type AdapterWorkerLimits = AdapterResourceLimits;

export function messageBytes(value: unknown): number {
  try {
    const seen = new Set<object>();
    let nodeCount = 0;
    const measure = (current: unknown): number => {
      if (current instanceof Uint8Array) return current.byteLength;
      if (current === undefined) return 0;
      if (current === null) return 4;
      if (typeof current === 'string') return new TextEncoder().encode(JSON.stringify(current)).byteLength;
      if (typeof current === 'boolean') return current ? 4 : 5;
      if (typeof current === 'number') return Number.isFinite(current) ? String(current).length : Number.POSITIVE_INFINITY;
      if (typeof current !== 'object' || seen.has(current)) return Number.POSITIVE_INFINITY;
      nodeCount += 1;
      if (nodeCount > 100_000) return Number.POSITIVE_INFINITY;
      seen.add(current);
      let total = Array.isArray(current) ? 2 : 2;
      if (Array.isArray(current)) {
        for (const item of current) total += measure(item) + 1;
      } else {
        for (const [key, item] of Object.entries(current)) {
          total += new TextEncoder().encode(JSON.stringify(key)).byteLength + 1 + measure(item) + 1;
        }
      }
      seen.delete(current);
      return total;
    };
    return measure(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function sanitizeError(error: unknown, secrets: readonly string[] = []): AdapterErrorView {
  const raw = error instanceof Error
    ? error.message
    : error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
  // Redact a bounded complete prefix before truncating the public error.
  // Context secrets are bounded to 16 KiB, so this prevents a long secret
  // crossing the output boundary from exposing its unredacted prefix.
  let message = raw.slice(0, MAX_ERROR_REDACTION_INPUT_BYTES);
  for (const secret of secrets) {
    if (secret.length > 0) message = message.split(secret).join('[REDACTED]');
  }
  message = message
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api[-_]?key|x[-_]?api[-_]?key|authorization|proxy[-_]?authorization|access[-_]?token|oauth[-_]?token|token|secret|password|credential|credentials|signature|sig|idempotency[-_]?key|auth|cookie|set-cookie)\s*[:=]\s*[^\s,;"']+/giu, '[REDACTED]');
  return { name: error instanceof Error ? error.name.slice(0, 128) : 'Error', message: message.slice(0, MAX_ERROR_BYTES) };
}

export function isSafeHeaderName(value: string): boolean {
  return HEADER_NAME_PATTERN.test(value) && !HOP_BY_HOP_HEADERS.has(value.toLowerCase());
}
