import { Buffer } from 'node:buffer';

import type { SubmittedAsset } from '@imagine/provider-contract';
import { isCredentialLikeQueryName } from '../security/network-policy.js';
import { MAX_GENERATION_COUNT } from '@imagine/shared';

/**
 * These limits preserve the existing 64 MiB inline image contract and the
 * Gemini video adapter's 4 MiB inline result while keeping durable manifests
 * bounded before they reach SQLite or JSON.stringify.
 */
export const MAX_SUBMITTED_ASSETS = MAX_GENERATION_COUNT;
export const MAX_SUBMITTED_ASSET_STRING_LENGTH = 4_096;
export const MAX_SUBMITTED_BASE64_BYTES = 64 * 1024 * 1024;
export const MAX_SUBMITTED_TOTAL_BASE64_BYTES = 64 * 1024 * 1024;
export const MAX_SUBMITTED_METADATA_BYTES = 16 * 1024;
export const MAX_SUBMITTED_MANIFEST_BYTES = 96 * 1024 * 1024;

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_ARRAY_ITEMS = 32;
const MAX_METADATA_NODES = 512;
const CREDENTIAL_KEY = /(?:access[_-]?token|api[_-]?key|authorization|bearer|credential|cookie|password|secret|token)/iu;
const CREDENTIAL_VALUE = /(?:bearer|basic)\s+[^\s]+|(?:api[_-]?key|access[_-]?token|authorization|password|secret|token|credential)\s*[:=]\s*[^\s]+/iu;

export class SubmittedAssetValidationError extends Error {
  public override readonly name = 'SubmittedAssetValidationError';
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBoundedString(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly rejectCredential?: boolean } = {},
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > MAX_SUBMITTED_ASSET_STRING_LENGTH ||
    hasControlCharacters(value) ||
    (options.rejectCredential !== false && CREDENTIAL_VALUE.test(value))
  ) {
    throw new SubmittedAssetValidationError(label + ' is invalid or exceeds the safety limit.');
  }
}

function assertMimeType(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    hasControlCharacters(value)
  ) {
    throw new SubmittedAssetValidationError('Submitted asset MIME type is invalid.');
  }
}

function assertCanonicalBase64(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SubmittedAssetValidationError(label + ' must contain Base64 data.');
  }
  const maximumCharacters = Math.ceil(MAX_SUBMITTED_BASE64_BYTES / 3) * 4 + 4;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payload = padding === 0 ? value : value.slice(0, -padding);
  const hasOnlyTrailingPadding = padding === 0 || !value.slice(0, -padding).includes('=');
  const validPayloadLength = padding === 0
    ? payload.length % 4 === 0
    : (padding === 1 ? payload.length % 4 === 3 : payload.length % 4 === 2);
  if (
    value.length > maximumCharacters ||
    !hasOnlyTrailingPadding ||
    !validPayloadLength ||
    !/^[A-Za-z0-9+/]+$/u.test(payload)
  ) {
    throw new SubmittedAssetValidationError(label + ' is not canonical Base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > MAX_SUBMITTED_BASE64_BYTES ||
    decoded.toString('base64') !== value
  ) {
    throw new SubmittedAssetValidationError(label + ' is invalid or exceeds the safety limit.');
  }
}

function assertSafeUrl(value: unknown): asserts value is string {
  assertBoundedString(value, 'Submitted asset URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SubmittedAssetValidationError('Submitted asset URL is invalid.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new SubmittedAssetValidationError('Submitted asset URL must not contain credentials or fragments.');
  }
  for (const name of parsed.searchParams.keys()) {
    if (isCredentialLikeQueryName(name)) {
      throw new SubmittedAssetValidationError('Submitted asset URL contains credential-like query data.');
    }
  }
}

interface MetadataState {
  nodes: number;
}

function validateMetadata(value: unknown, depth: number, state: MetadataState): void {
  state.nodes += 1;
  if (state.nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
    throw new SubmittedAssetValidationError('Submitted asset metadata is too deep or large.');
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SubmittedAssetValidationError('Submitted asset metadata contains an invalid number.');
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 1_024 || hasControlCharacters(value) || CREDENTIAL_VALUE.test(value)) {
      throw new SubmittedAssetValidationError('Submitted asset metadata contains unsafe text.');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_ITEMS) {
      throw new SubmittedAssetValidationError('Submitted asset metadata contains too many array items.');
    }
    for (const item of value) validateMetadata(item, depth + 1, state);
    return;
  }
  if (!isPlainRecord(value)) {
    throw new SubmittedAssetValidationError('Submitted asset metadata must contain JSON values.');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new SubmittedAssetValidationError('Submitted asset metadata contains too many keys.');
  }
  for (const key of keys) {
    if (
      key.length === 0 ||
      key.length > 128 ||
      hasControlCharacters(key) ||
      CREDENTIAL_KEY.test(key)
    ) {
      throw new SubmittedAssetValidationError('Submitted asset metadata contains a sensitive key.');
    }
    validateMetadata(value[key], depth + 1, state);
  }
}

function assertMetadata(value: unknown): void {
  if (!isPlainRecord(value)) {
    throw new SubmittedAssetValidationError('Submitted asset metadata must be a JSON object.');
  }
  const state: MetadataState = { nodes: 0 };
  validateMetadata(value, 0, state);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SubmittedAssetValidationError('Submitted asset metadata is not serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SUBMITTED_METADATA_BYTES) {
    throw new SubmittedAssetValidationError('Submitted asset metadata exceeds the safety limit.');
  }
}

export function assertSubmittedMetadata(value: unknown): void {
  assertMetadata(value);
}

function assertKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new SubmittedAssetValidationError('Submitted asset contains unsupported fields.');
  }
}

function validateSubmittedAsset(value: unknown): SubmittedAsset {
  if (!isPlainRecord(value)) {
    throw new SubmittedAssetValidationError('Submitted asset must be a JSON object.');
  }
  if (value.type !== 'image' && value.type !== 'video') {
    throw new SubmittedAssetValidationError('Submitted asset type is invalid.');
  }
  assertMimeType(value.mimeType);
  if ('resultId' in value) assertBoundedString(value.resultId, 'Submitted asset result ID');
  if ('filename' in value) {
    assertBoundedString(value.filename, 'Submitted asset filename', { rejectCredential: false });
    if (value.filename.includes('/') || value.filename.includes('\\')) {
      throw new SubmittedAssetValidationError('Submitted asset filename must not contain a path.');
    }
  }
  if ('metadata' in value) assertMetadata(value.metadata);

  if (value.source === 'base64') {
    assertKeys(value, new Set(['type', 'mimeType', 'resultId', 'filename', 'metadata', 'source', 'base64']));
    assertCanonicalBase64(value.base64, 'Submitted asset Base64');
    return value as unknown as SubmittedAsset;
  }
  if (value.source === 'url') {
    assertKeys(value, new Set(['type', 'mimeType', 'resultId', 'filename', 'metadata', 'source', 'url']));
    assertSafeUrl(value.url);
    return value as unknown as SubmittedAsset;
  }
  if (value.source === 'provider') {
    assertKeys(value, new Set([
      'type',
      'mimeType',
      'resultId',
      'filename',
      'metadata',
      'source',
      'providerId',
      'remoteJobId',
      'variant',
    ]));
    assertBoundedString(value.providerId, 'Submitted asset provider ID');
    assertBoundedString(value.remoteJobId, 'Submitted asset remote job ID');
    if (value.variant !== 'video') {
      throw new SubmittedAssetValidationError('Submitted provider asset variant is invalid.');
    }
    return value as unknown as SubmittedAsset;
  }
  throw new SubmittedAssetValidationError('Submitted asset source is invalid.');
}

export interface SubmittedAssetValidationOptions {
  readonly allowEmpty?: boolean;
  readonly maxAssets?: number;
}

export function assertSubmittedManifestSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SubmittedAssetValidationError('Submitted asset manifest is not serializable.');
  }
  if (typeof serialized !== 'string') {
    throw new SubmittedAssetValidationError('Submitted asset manifest is not serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SUBMITTED_MANIFEST_BYTES) {
    throw new SubmittedAssetValidationError('Submitted asset manifest exceeds the safety limit.');
  }
}

export function validateSubmittedAssets(
  value: unknown,
  options: SubmittedAssetValidationOptions = {},
): readonly SubmittedAsset[] {
  if (!Array.isArray(value)) {
    throw new SubmittedAssetValidationError('Submitted asset manifest must be an array.');
  }
  const maxAssets = options.maxAssets ?? MAX_SUBMITTED_ASSETS;
  if (!Number.isSafeInteger(maxAssets) || maxAssets < 0 || maxAssets > MAX_SUBMITTED_ASSETS) {
    throw new SubmittedAssetValidationError('Submitted asset manifest count limit is invalid.');
  }
  if (value.length === 0 && options.allowEmpty !== true) {
    throw new SubmittedAssetValidationError('Submitted asset manifest must contain at least one asset.');
  }
  if (value.length > maxAssets) {
    throw new SubmittedAssetValidationError('Submitted asset manifest contains too many assets.');
  }
  const assets = value.map(validateSubmittedAsset);
  let totalBase64Bytes = 0;
  for (const asset of assets) {
    if (asset.source === 'base64') {
      totalBase64Bytes += Buffer.byteLength(asset.base64, 'base64');
      if (totalBase64Bytes > MAX_SUBMITTED_TOTAL_BASE64_BYTES) {
        throw new SubmittedAssetValidationError('Submitted asset Base64 data exceeds the total safety limit.');
      }
    }
  }
  assertSubmittedManifestSize(assets);
  return assets;
}

function isOutputLink(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes('slot') &&
    keys.includes('assetId') &&
    typeof value.slot === 'number' &&
    Number.isSafeInteger(value.slot) &&
    value.slot >= 0 &&
    (value.assetId === null || (
      typeof value.assetId === 'string' &&
      value.assetId.length > 0 &&
      value.assetId.length <= MAX_SUBMITTED_ASSET_STRING_LENGTH &&
      !hasControlCharacters(value.assetId)
    ))
  );
}

function isSafeMaterializedAsset(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const allowedKeys = new Set([
    'type', 'mimeType', 'filePath', 'thumbnailPath', 'posterPath', 'width', 'height',
    'durationMs', 'materializationKey', 'sourceFingerprint', 'fileSize', 'sha256', 'resultId',
    'filename', 'metadata',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.type !== 'image' && value.type !== 'video') return false;
  const requiredStrings = [value.mimeType, value.filePath, value.sha256];
  if (requiredStrings.some((candidate) =>
    typeof candidate !== 'string' || candidate.length === 0 ||
    candidate.length > MAX_SUBMITTED_ASSET_STRING_LENGTH || hasControlCharacters(candidate))) {
    return false;
  }
  const optionalStrings = [
    value.thumbnailPath,
    value.posterPath,
    value.materializationKey,
    value.sourceFingerprint,
    value.resultId,
    value.filename,
  ];
  if (optionalStrings.some((candidate) =>
    candidate !== undefined && candidate !== null &&
    (typeof candidate !== 'string' || candidate.length > MAX_SUBMITTED_ASSET_STRING_LENGTH || hasControlCharacters(candidate)))) {
    return false;
  }
  if (typeof value.fileSize !== 'number' || !Number.isSafeInteger(value.fileSize) || value.fileSize < 0) {
    return false;
  }
  for (const candidate of [value.width, value.height, value.durationMs]) {
    if (candidate !== undefined && candidate !== null &&
      (typeof candidate !== 'number' || !Number.isFinite(candidate))) return false;
  }
  if (value.metadata !== undefined) {
    try {
      assertMetadata(value.metadata);
    } catch {
      return false;
    }
  }
  return true;
}

function assertMaterializedManifest(
  value: unknown,
  label: string,
  maxAssets = MAX_SUBMITTED_ASSETS,
): void {
  if (!Array.isArray(value) || value.length > maxAssets || value.length > MAX_SUBMITTED_ASSETS ||
    value.some((asset) => !isSafeMaterializedAsset(asset))) {
    throw new SubmittedAssetValidationError(label + ' is invalid or exceeds the safety limit.');
  }
}

/**
 * Validates every durable manifest shape used by the runner, including the
 * database's completed output-link form. This is used before any JSON write.
 */
export function assertDurableResultManifest(
  value: unknown,
  maxAssets = MAX_SUBMITTED_ASSETS,
): void {
  assertSubmittedManifestSize(value);
  if (!Array.isArray(value)) {
    throw new SubmittedAssetValidationError('Submitted asset manifest must be an array.');
  }
  if (!Number.isSafeInteger(maxAssets) || maxAssets < 0 || maxAssets > MAX_SUBMITTED_ASSETS) {
    throw new SubmittedAssetValidationError('Submitted asset manifest count limit is invalid.');
  }
  if (value.length === 0) return;
  const envelope = value[0];
  if (isPlainRecord(envelope) && envelope.version === 1) {
    const allowed = new Set(['version', 'resultAssets', 'materializedAssets']);
    if (Object.keys(envelope).some((key) => !allowed.has(key))) {
      throw new SubmittedAssetValidationError('Submitted result manifest contains unsupported fields.');
    }
    if (envelope.resultAssets !== undefined) {
      validateSubmittedAssets(envelope.resultAssets, { allowEmpty: true, maxAssets });
    }
    if (envelope.materializedAssets !== undefined) {
      assertMaterializedManifest(envelope.materializedAssets, 'Submitted materialized manifest', maxAssets);
    }
    return;
  }
  if (value.length <= MAX_SUBMITTED_ASSETS && value.every(isOutputLink)) return;
  const resultAssets = value.filter((asset) => isPlainRecord(asset) && 'source' in asset);
  const materializedAssets = value.filter((asset) => isPlainRecord(asset) && !('source' in asset));
  if (resultAssets.length > 0) {
    validateSubmittedAssets(resultAssets, { maxAssets });
  }
  if (materializedAssets.length > 0) {
    assertMaterializedManifest(materializedAssets, 'Submitted materialized manifest', maxAssets);
  }
  if (resultAssets.length + materializedAssets.length !== value.length) {
    throw new SubmittedAssetValidationError('Submitted result manifest contains unsupported values.');
  }
}
