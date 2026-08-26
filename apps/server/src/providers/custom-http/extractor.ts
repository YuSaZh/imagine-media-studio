import { Buffer } from 'node:buffer';

import type { ProviderError, SubmittedAsset } from '@imagine/provider-contract';

import {
  MAX_BASE64_BYTES,
  MAX_ERROR_LENGTH,
  MAX_REMOTE_ID_LENGTH,
  MAX_RESPONSE_ARRAY_ITEMS,
  MAX_RESPONSE_DEPTH,
  MAX_RESPONSE_JSON_BYTES,
  MAX_RESPONSE_KEYS,
  MAX_RESPONSE_NODES,
  MAX_RESULT_URL_LENGTH,
  isCredentialLikeQueryName,
  type DeclarativeEndpoint,
  type DeclarativeExtract,
} from './schema.js';
import { parseBoundedJsonDocument, type ParseLimits } from './parser.js';
import { isDangerousKey } from './schema.js';

export interface DeclarativeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly json?: unknown;
  readonly text?: string;
  readonly body?: unknown;
}

export type DeclarativeResponsePhase = 'submit' | 'poll' | 'cancel' | 'connection' | 'catalog';

export type DeclarativeExtractedResponse =
  | {
      readonly state: 'pending';
      readonly remoteJobId?: string;
      readonly progress?: number;
      readonly status?: string;
      readonly resultExpiresAt?: Date;
    }
  | { readonly state: 'completed'; readonly assets: readonly SubmittedAsset[]; readonly resultExpiresAt?: Date }
  | { readonly state: 'failed'; readonly error: ProviderError };

export class DeclarativeResponseError extends Error {
  public override readonly name = 'DeclarativeResponseError';
  public constructor(
    public readonly code: 'invalid_response' | 'response_too_large' | 'unsupported_result',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResponseBudget {
  depth: number;
  nodes: number;
  keys: number;
  arrays: number;
}

const RESPONSE_PARSE_LIMITS: ParseLimits = {
  maxArrayItems: MAX_RESPONSE_ARRAY_ITEMS,
  maxDepth: MAX_RESPONSE_DEPTH,
  maxKeys: MAX_RESPONSE_KEYS,
  maxNodes: MAX_RESPONSE_NODES,
  maxStringLength: MAX_RESPONSE_JSON_BYTES,
  maxTotalStringLength: MAX_RESPONSE_JSON_BYTES,
};
const MAX_PROVIDER_SECRET_LENGTH = 16 * 1024;
const MAX_ERROR_REDACTION_INPUT_LENGTH = MAX_ERROR_LENGTH + MAX_PROVIDER_SECRET_LENGTH;

function fail(code: DeclarativeResponseError['code'], message: string, options?: ErrorOptions): never {
  throw new DeclarativeResponseError(code, message, options);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function boundedString(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || hasControlCharacters(value)) {
    fail('invalid_response', `${label} is invalid.`);
  }
  return value;
}

function redactText(value: string, sensitiveValues: readonly string[] = []): string {
  let redacted = value;
  for (const secret of sensitiveValues) if (secret.length > 0) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password|signature|authorization|auth|credential(?:s)?|idempotency[-_]?key|cookie|set-cookie)\s*[=:]\s*[^\s,;]+/giu, '[REDACTED]');
}

function safeErrorCode(value: unknown, fallback: string, sensitiveValues: readonly string[] = []): string {
  if (typeof value !== 'string') return fallback;
  const sanitized = redactText(value, sensitiveValues);
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(sanitized) ? sanitized : fallback;
}

function safeErrorMessage(value: unknown, fallback: string, sensitiveValues: readonly string[] = []): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  // Inspect enough bounded input to cover the longest accepted provider secret
  // before applying the public error length cap.
  return redactText(value.slice(0, MAX_ERROR_REDACTION_INPUT_LENGTH), sensitiveValues).slice(0, MAX_ERROR_LENGTH);
}

function responseHeader(headers: DeclarativeResponse['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

function retryAfterMs(headers: DeclarativeResponse['headers']): number | undefined {
  const raw = responseHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1_000), 86_400_000);
    return undefined;
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), 86_400_000);
}

function cloneResponseValue(value: unknown, state: ResponseBudget, depth: number, seen = new WeakSet<object>()): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_RESPONSE_NODES || depth > MAX_RESPONSE_DEPTH) fail('response_too_large', 'Provider response is too deeply nested or contains too many nodes.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_RESPONSE_JSON_BYTES || hasControlCharacters(value)) fail('invalid_response', 'Provider response contains an invalid string.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_response', 'Provider response contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) fail('invalid_response', 'Provider response contains a cyclic value.');
    seen.add(value);
    state.arrays += 1;
    if (value.length > MAX_RESPONSE_ARRAY_ITEMS || state.arrays > MAX_RESPONSE_ARRAY_ITEMS) fail('response_too_large', 'Provider response contains an oversized array.');
    const result = value.map((item) => cloneResponseValue(item, state, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  if (value instanceof Uint8Array) fail('invalid_response', 'Binary response must be declared as a JSON document.');
  if (typeof value !== 'object') fail('invalid_response', 'Provider response contains an unsupported value.');
  if (seen.has(value)) fail('invalid_response', 'Provider response contains a cyclic value.');
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_response', 'Provider response object is not a plain object.');
  const entries = Object.entries(value as Record<string, unknown>);
  state.keys += entries.length;
  if (entries.length > MAX_RESPONSE_KEYS || state.keys > MAX_RESPONSE_KEYS) fail('response_too_large', 'Provider response contains too many object keys.');
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of entries) {
    if (isDangerousKey(key)) fail('invalid_response', 'Provider response contains a prototype-related key.');
    result[key] = cloneResponseValue(child, state, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function responseDocument(response: DeclarativeResponse, responseType: DeclarativeEndpoint['responseType']): unknown {
  const boundedObject = (value: unknown): unknown => {
    const cloned = cloneResponseValue(value, { arrays: 0, depth: 0, keys: 0, nodes: 0 }, 0);
    let encoded: string;
    try {
      encoded = JSON.stringify(cloned);
    } catch (error) {
      fail('invalid_response', 'Provider response cannot be serialized.', { cause: error });
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_JSON_BYTES) fail('response_too_large', 'Provider response is too large.');
    return cloned;
  };
  if (responseType === 'text') {
    if (typeof response.text !== 'string') fail('invalid_response', 'Provider response did not contain text.');
    if (Buffer.byteLength(response.text, 'utf8') > MAX_RESPONSE_JSON_BYTES) fail('response_too_large', 'Provider response is too large.');
    return response.text;
  }
  if (response.json !== undefined) return boundedObject(response.json);
  if (response.body instanceof Uint8Array) {
    if (response.body.byteLength > MAX_RESPONSE_JSON_BYTES) fail('response_too_large', 'Provider response is too large.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    } catch (error) {
      fail('invalid_response', 'Provider response is not valid UTF-8.', { cause: error });
    }
    try {
      return boundedObject(parseBoundedJsonDocument(text, RESPONSE_PARSE_LIMITS));
    } catch (error) {
      if (error instanceof DeclarativeResponseError) throw error;
      fail('invalid_response', 'Provider response JSON is invalid.', { cause: error });
    }
  }
  if (response.body !== undefined) return boundedObject(response.body);
  if (response.text !== undefined) {
    if (Buffer.byteLength(response.text, 'utf8') > MAX_RESPONSE_JSON_BYTES) fail('response_too_large', 'Provider response is too large.');
    try {
      return boundedObject(parseBoundedJsonDocument(response.text, RESPONSE_PARSE_LIMITS));
    } catch (error) {
      if (error instanceof DeclarativeResponseError) throw error;
      fail('invalid_response', 'Provider response JSON is invalid.', { cause: error });
    }
  }
  fail('invalid_response', 'Provider response body is empty.');
}

export function readJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) fail('invalid_response', 'Response path is not an RFC 6901 JSON Pointer.');
  const parts = pointer.slice(1).split('/');
  if (parts.length > 32) fail('invalid_response', 'Response path contains too many segments.');
  let value: unknown = document;
  for (const raw of parts) {
    if (/~(?![01])/u.test(raw)) fail('invalid_response', 'Response path is not an RFC 6901 JSON Pointer.');
    const part = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (isDangerousKey(part)) fail('invalid_response', 'Response path contains a prototype-related key.');
    if (Array.isArray(value)) {
      if (!/^0$|^[1-9][0-9]*$/u.test(part)) return undefined;
      value = value[Number(part)];
    } else if (value !== null && typeof value === 'object') {
      value = Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    } else {
      return undefined;
    }
  }
  return value;
}

function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 === 1 || value.length > Math.ceil(MAX_BASE64_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength > 0 && decoded.byteLength <= MAX_BASE64_BYTES && decoded.toString('base64') === value;
}

function resultMime(extract: DeclarativeExtract, document: unknown): string {
  const value = extract.resultMimeTypePath === undefined ? extract.resultMimeType : readJsonPointer(document, extract.resultMimeTypePath);
  const rawMime = boundedString(value, 255, 'Result MIME type');
  const mime = rawMime?.toLowerCase();
  const allowed = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);
  if (mime === undefined || !allowed.has(mime)) fail('unsupported_result', 'Result MIME type is not an allowed image or video type.');
  if (extract.resultType !== undefined && !mime.startsWith(`${extract.resultType}/`)) fail('unsupported_result', 'Result MIME type does not match resultType.');
  return mime;
}

function extractAssets(extract: DeclarativeExtract, document: unknown): readonly SubmittedAsset[] {
  if (extract.resultUrlPath !== undefined && extract.resultBase64Path !== undefined) fail('unsupported_result', 'Response declares both URL and Base64 result paths.');
  if (extract.resultUrlPath === undefined && extract.resultBase64Path === undefined) return [];
  if (extract.resultType === undefined) fail('unsupported_result', 'Result extraction requires resultType.');
  const mimeType = resultMime(extract, document);
  const resultId = boundedString(extract.resultIdPath === undefined ? undefined : readJsonPointer(document, extract.resultIdPath), 255, 'Result ID');
  const filename = boundedString(extract.filenamePath === undefined ? undefined : readJsonPointer(document, extract.filenamePath), 255, 'Result filename');
  if (filename !== undefined && /[\\/\r\n]/u.test(filename)) fail('invalid_response', 'Result filename is invalid.');
  if (extract.resultUrlPath !== undefined) {
    const rawUrl = boundedString(readJsonPointer(document, extract.resultUrlPath), MAX_RESULT_URL_LENGTH, 'Result URL');
    if (rawUrl === undefined) fail('invalid_response', 'Result URL is missing.');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      fail('invalid_response', 'Result URL is invalid.', { cause: error });
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) fail('unsupported_result', 'Result URL contains unsafe URL components.');
    for (const [name] of url.searchParams) if (isCredentialLikeQueryName(name)) fail('unsupported_result', 'Result URL contains credential-like query data.');
    return [{ type: extract.resultType, mimeType, source: 'url', url: rawUrl, ...(resultId === undefined ? {} : { resultId }), ...(filename === undefined ? {} : { filename }) }];
  }
  const base64 = boundedString(readJsonPointer(document, extract.resultBase64Path!), Math.ceil(MAX_BASE64_BYTES / 3) * 4 + 4, 'Result Base64');
  if (base64 === undefined || !validBase64(base64)) fail('unsupported_result', 'Result Base64 is invalid or too large.');
  return [{ type: extract.resultType, mimeType, source: 'base64', base64, ...(resultId === undefined ? {} : { resultId }), ...(filename === undefined ? {} : { filename }) }];
}

function remoteIdPath(extract: DeclarativeExtract): string | undefined {
  return extract.remoteIdPath ?? extract.remoteJobIdPath;
}

function failureValues(extract: DeclarativeExtract): readonly string[] {
  return extract.failureValues ?? extract.failedValues ?? [];
}

function statusError(response: DeclarativeResponse, document: unknown, extract: DeclarativeExtract, sensitiveValues: readonly string[] = []): ProviderError {
  const status = response.status;
  const transient = status === 408 || status === 429 || status >= 500;
  const message = safeErrorMessage(extract.errorPath === undefined ? undefined : readJsonPointer(document, extract.errorPath), 'Provider request failed.', sensitiveValues);
  const code = safeErrorCode(extract.errorCodePath === undefined ? undefined : readJsonPointer(document, extract.errorCodePath), `http_${status}`, sensitiveValues);
  const retryAfter = retryAfterMs(response.headers);
  return { code, kind: transient ? 'transient' : 'rejected', message, retryable: transient, statusCode: status, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) };
}

function extractedError(
  extract: DeclarativeExtract,
  document: unknown,
  kind: ProviderError['kind'],
  code: string,
  message: string,
  sensitiveValues: readonly string[] = [],
): ProviderError {
  const errorMessage = safeErrorMessage(extract.errorPath === undefined ? undefined : readJsonPointer(document, extract.errorPath), message, sensitiveValues);
  return { code: safeErrorCode(code, 'provider_error', sensitiveValues), kind, message: errorMessage, retryable: kind === 'transient' };
}

export function extractDeclarativeResponse(
  endpoint: DeclarativeEndpoint,
  response: DeclarativeResponse,
  phase: DeclarativeResponsePhase,
  sensitiveValues: readonly string[] = [],
  expectedRemoteJobId?: string,
): DeclarativeExtractedResponse {
  if (!endpoint.expectedStatus.includes(response.status)) {
    let document: unknown = null;
    try {
      document = responseDocument(response, endpoint.responseType);
    } catch {
      // Status is retained even when an upstream error body is empty or malformed.
    }
    return { state: 'failed', error: statusError(response, document, endpoint.extract, sensitiveValues) };
  }
  if (phase === 'connection' || phase === 'cancel') return { state: 'completed', assets: [] };
  const document = responseDocument(response, endpoint.responseType);
  const status = endpoint.extract.statusPath === undefined ? undefined : boundedString(readJsonPointer(document, endpoint.extract.statusPath), 255, 'Provider status');
  if (endpoint.extract.statusPath !== undefined && status === undefined) fail('invalid_response', 'Provider response status is missing.');
  const progressValue = endpoint.extract.progressPath === undefined ? undefined : readJsonPointer(document, endpoint.extract.progressPath);
  let progress: number | undefined;
  if (progressValue !== undefined) {
    if (typeof progressValue !== 'number' || !Number.isFinite(progressValue) || progressValue < 0 || progressValue > 100) fail('invalid_response', 'Provider progress must be a finite number from 0 through 100.');
    progress = progressValue;
  }
  const idPath = remoteIdPath(endpoint.extract);
  const responseRemoteJobId = idPath === undefined ? undefined : boundedString(readJsonPointer(document, idPath), MAX_REMOTE_ID_LENGTH, 'Remote job ID');
  if (phase === 'poll' && idPath !== undefined && expectedRemoteJobId !== undefined && responseRemoteJobId !== expectedRemoteJobId) fail('invalid_response', 'Provider response remote job ID does not match the requested job.');
  const remoteJobId = responseRemoteJobId ?? (phase === 'poll' ? expectedRemoteJobId : undefined);
  let resultExpiresAt: Date | undefined;
  if (endpoint.extract.resultExpiresAtPath !== undefined) {
    const rawExpiry = boundedString(readJsonPointer(document, endpoint.extract.resultExpiresAtPath), 64, 'Result expiry');
    if (rawExpiry === undefined || !Number.isFinite(Date.parse(rawExpiry))) fail('invalid_response', 'Result expiry is invalid.');
    resultExpiresAt = new Date(rawExpiry);
  }
  const pendingValues = endpoint.extract.pendingValues ?? [];
  const runningValues = endpoint.extract.runningValues ?? [];
  const successValues = endpoint.extract.successValues ?? [];
  const expiredValues = endpoint.extract.expiredValues ?? [];
  const failedValues = failureValues(endpoint.extract);
  let statusIsSuccess = status === undefined;
  if (status !== undefined) {
    const matches = [
      pendingValues.includes(status),
      runningValues.includes(status),
      successValues.includes(status),
      failedValues.includes(status),
      expiredValues.includes(status),
    ].filter(Boolean).length;
    if (matches !== 1) fail('invalid_response', 'Provider response contains an unknown or ambiguous status.');
    if (expiredValues.includes(status)) return { state: 'failed', error: extractedError(endpoint.extract, document, 'expired', 'provider_result_expired', 'Provider result expired.', sensitiveValues) };
    if (failedValues.includes(status)) return { state: 'failed', error: extractedError(endpoint.extract, document, 'rejected', 'provider_failed', 'Provider request failed.', sensitiveValues) };
    statusIsSuccess = successValues.includes(status);
    if (pendingValues.includes(status) || runningValues.includes(status)) {
      if (remoteJobId === undefined) return { state: 'failed', error: extractedError(endpoint.extract, document, 'rejected', 'provider_remote_id_missing', 'Provider pending response did not contain a remote job ID.', sensitiveValues) };
      return { state: 'pending', remoteJobId, ...(progress === undefined ? {} : { progress }), status, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }) };
    }
  } else if (phase === 'poll') {
    fail('invalid_response', 'Poll response must contain an explicit status.');
  }
  const assets = extractAssets(endpoint.extract, document);
  if (assets.length > 0) {
    if (remoteJobId !== undefined && phase === 'submit') fail('unsupported_result', 'Response ambiguously contains both remote job ID and completed result.');
    return { state: 'completed', assets, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }) };
  }
  // Some async APIs return only a remote id from submit. In that shape the
  // absence of a status field is itself the pending signal; poll remains
  // strict and requires an explicit mapped status.
  if (remoteJobId !== undefined && phase === 'submit' && (status === undefined || !statusIsSuccess)) return { state: 'pending', remoteJobId, ...(resultExpiresAt === undefined ? {} : { resultExpiresAt }) };
  if (phase === 'poll') return { state: 'failed', error: extractedError(endpoint.extract, document, 'rejected', 'provider_result_missing', 'Provider completed without a result.', sensitiveValues) };
  return { state: 'failed', error: extractedError(endpoint.extract, document, 'rejected', 'provider_response_invalid', 'Provider response did not contain a result or remote job ID.', sensitiveValues) };
}

export function extractCatalog(
  endpoint: DeclarativeEndpoint,
  response: DeclarativeResponse,
  allowlist?: ReadonlySet<string>,
): readonly { id: string; displayName: string }[] {
  if (!endpoint.expectedStatus.includes(response.status)) fail('invalid_response', 'Provider catalog returned an unexpected status.');
  const document = responseDocument(response, endpoint.responseType);
  const root = endpoint.extract.modelsPath === undefined ? document : readJsonPointer(document, endpoint.extract.modelsPath);
  if (!Array.isArray(root) || root.length > 200) fail('invalid_response', 'Provider catalog is invalid or too large.');
  const result: { id: string; displayName: string }[] = [];
  for (const item of root) {
    const id = boundedString(endpoint.extract.modelIdPath === undefined ? item : readJsonPointer(item, endpoint.extract.modelIdPath), 255, 'Catalog model ID');
    if (id === undefined) fail('invalid_response', 'Catalog model ID is missing.');
    const displayName = boundedString(endpoint.extract.modelNamePath === undefined ? id : readJsonPointer(item, endpoint.extract.modelNamePath), 255, 'Catalog model name') ?? id;
    if (allowlist === undefined || allowlist.has(id)) result.push({ displayName, id });
  }
  return result;
}
