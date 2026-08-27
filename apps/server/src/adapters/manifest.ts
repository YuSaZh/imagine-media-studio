import { isIP } from 'node:net';

import { z } from 'zod';

export const ADAPTER_MANIFEST_VERSION = 1 as const;
export const MAX_ADAPTER_SOURCE_BYTES = 1 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 128 * 1024;
export const MAX_ADAPTER_ID_LENGTH = 63;
const MAX_MANIFEST_NODES = 10_000;
const MAX_MANIFEST_KEYS = 512;
const MAX_MANIFEST_ARRAY_ITEMS = 128;
const MAX_MANIFEST_STRING_LENGTH = 16_384;
const MAX_MANIFEST_DEPTH = 12;

const MAX_CAPABILITY_MODELS = 64;
const MAX_CAPABILITY_OPERATIONS = 16;
const MAX_CAPABILITY_ARRAY = 32;

// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/u;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REQUEST_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'min',
  'max',
  'minLength',
  'maxLength',
]);
const REQUEST_SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean']);
const CREDENTIAL_METADATA_WORDS = new Set([
  'access',
  'api',
  'apikey',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'header',
  'headers',
  'idempotency',
  'key',
  'oauth',
  'password',
  'secret',
  'signature',
  'sig',
  'token',
]);

const OPERATIONS = [
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
] as const;

const CapabilityOperationSchema = z.enum(OPERATIONS);
const BoundedCapabilityString = z.string().min(1).max(255).refine(
  (value) => !TEXT_CONTROL_PATTERN.test(value),
  'capability strings must not contain control characters',
);
const BoundedCapabilityArray = z.array(BoundedCapabilityString).max(MAX_CAPABILITY_ARRAY);

const ImageInputConstraintsSchema = z.object({
  mimeTypes: BoundedCapabilityArray.optional(),
  maxBytes: z.number().int().positive().max(128 * 1024 * 1024).optional(),
  maxPixels: z.number().int().positive().max(200_000_000).optional(),
  maxWidth: z.number().int().positive().max(100_000).optional(),
  maxHeight: z.number().int().positive().max(100_000).optional(),
}).strict();

const DurationSchema = z.union([
  z.array(z.number().int().positive().max(86_400)).min(1).max(MAX_CAPABILITY_ARRAY),
  z.object({
    min: z.number().int().positive().max(86_400),
    max: z.number().int().positive().max(86_400),
  }).strict().refine((value) => value.min <= value.max, 'duration min must not exceed max'),
]);

const ModelCapabilitySchema = z.object({
  operations: z.array(CapabilityOperationSchema).min(1).max(MAX_CAPABILITY_OPERATIONS),
  aspectRatios: BoundedCapabilityArray.optional(),
  resolutions: BoundedCapabilityArray.optional(),
  durations: DurationSchema.optional(),
  maxReferenceImages: z.number().int().min(0).max(128).optional(),
  inputImageConstraints: ImageInputConstraintsSchema.optional(),
  supportsMask: z.boolean().optional(),
  supportsNegativePrompt: z.boolean().optional(),
  supportsSeed: z.boolean().optional(),
  supportsAudio: z.boolean().optional(),
  supportsProgress: z.boolean().optional(),
  supportsCancel: z.boolean().optional(),
  supportsBatchCount: z.boolean().optional(),
  maxBatchCount: z.number().int().positive().max(128).optional(),
  customFields: z.record(z.string().max(128), z.unknown()).optional(),
}).strict();

const ModelSchema = z.object({
  id: BoundedCapabilityString,
  displayName: BoundedCapabilityString,
  capabilities: ModelCapabilitySchema,
}).strict();

export const AdapterCapabilitiesSchema = z.object({
  providerType: BoundedCapabilityString,
  models: z.array(ModelSchema).min(1).max(MAX_CAPABILITY_MODELS),
}).strict();

const ResourceLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().max(10 * 60 * 1000),
  maxMessageBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxOutputBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxLogBytes: z.number().int().positive().max(4 * 1024 * 1024),
  maxOldGenerationSizeMb: z.number().int().positive().max(512),
  maxYoungGenerationSizeMb: z.number().int().positive().max(128),
  stackSizeMb: z.number().int().positive().max(16),
}).strict();

const ManifestSchema = z.object({
  schemaVersion: z.literal(ADAPTER_MANIFEST_VERSION),
  id: z.string().min(1).max(MAX_ADAPTER_ID_LENGTH).regex(ID_PATTERN),
  version: z.string().min(1).max(64).regex(SAFE_VERSION_PATTERN),
  displayName: z.string().min(1).max(120).refine(
    (value) => !TEXT_CONTROL_PATTERN.test(value),
    'displayName must not contain control characters',
  ),
  sha256: z.string().regex(SHA256_PATTERN),
  operations: z.array(CapabilityOperationSchema).min(1).max(MAX_CAPABILITY_OPERATIONS),
  capabilities: AdapterCapabilitiesSchema,
  allowedHosts: z.array(z.string().min(1).max(253)).min(1).max(32),
  requiredSecrets: z.array(z.string().min(1).max(64).regex(SECRET_NAME_PATTERN)).max(16),
  resourceLimits: ResourceLimitsSchema,
}).strict();

export type AdapterOperation = (typeof OPERATIONS)[number];
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;
export type AdapterResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type AdapterManifest = z.infer<typeof ManifestSchema> & {
  readonly allowedHosts: readonly string[];
  readonly requiredSecrets: readonly string[];
};

export class AdapterManifestError extends Error {
  public override readonly name = 'AdapterManifestError';
}

export class AdapterSourcePolicyError extends Error {
  public override readonly name = 'AdapterSourcePolicyError';
}

function normalizeHost(value: string): string {
  if (
    TEXT_CONTROL_PATTERN.test(value)
    || /[\s*:/?#@]/u.test(value)
    || value.includes('[')
    || value.includes(']')
    || value.includes('://')
    || value.length > 253
  ) {
    throw new AdapterManifestError('allowedHosts must contain exact hostnames without URL syntax.');
  }

  const normalized = value.toLowerCase().replace(/\.$/u, '');
  if (normalized.length === 0 || isIP(normalized) !== 0) {
    throw new AdapterManifestError('allowedHosts must not contain IP addresses.');
  }

  const labels = normalized.split('.');
  if (labels.some((label) => label.length === 0 || !HOST_LABEL_PATTERN.test(label))) {
    throw new AdapterManifestError('allowedHosts contains an invalid hostname.');
  }
  return normalized;
}

function assertBoundedJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 8) throw new AdapterManifestError('manifest JSON is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string' && (value.length > 16_384 || TEXT_CONTROL_PATTERN.test(value))) {
      throw new AdapterManifestError('manifest JSON contains an invalid string.');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AdapterManifestError('manifest JSON contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new AdapterManifestError('manifest JSON contains an unsupported value.');
  if (seen.has(value)) throw new AdapterManifestError('manifest JSON must not contain cycles.');
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new AdapterManifestError('manifest JSON must contain plain objects.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 128) throw new AdapterManifestError('manifest JSON array is too large.');
    for (const item of value) assertBoundedJson(item, depth + 1, seen);
  } else {
    const entries = Object.entries(value);
    if (entries.length > 128) throw new AdapterManifestError('manifest JSON object is too large.');
    for (const [key, item] of entries) {
      if (
        key.length > 128 ||
        TEXT_CONTROL_PATTERN.test(key) ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) throw new AdapterManifestError('manifest JSON key is invalid.');
      assertBoundedJson(item, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function metadataKeyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function isCredentialMetadataKey(key: string): boolean {
  return metadataKeyWords(key).some((word) => CREDENTIAL_METADATA_WORDS.has(word));
}

function startsWithSecretNamespace(expression: string): boolean {
  const trimmed = expression.trimStart();
  if (!trimmed.startsWith('secret')) return false;
  const boundary = [...trimmed.slice('secret'.length)][0];
  if (boundary === undefined) return true;
  // Keep ordinary roots such as `secretary` distinct. Non-ASCII identifier
  // characters are rejected conservatively because the adapter template
  // grammar only permits ASCII identifiers.
  if (/^[A-Za-z0-9_$]/u.test(boundary)) return false;
  return true;
}

function containsSecretTemplate(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const open = value.indexOf('{{', offset);
    if (open < 0) return false;
    const expressionStart = open + 2;
    const close = value.indexOf('}}', expressionStart);
    const expression = value.slice(expressionStart, close < 0 ? value.length : close);
    if (startsWithSecretNamespace(expression)) return true;
    if (close < 0) return false;
    // Advance past the opening marker rather than the closing marker so a
    // malformed outer token cannot hide a nested secret expression.
    offset = open + 2;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isStructuredRequestSchema(value: unknown, depth = 0): boolean {
  if (!isPlainRecord(value) || depth > 12) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !REQUEST_SCHEMA_KEYS.has(key))) return false;
  if (typeof value.type !== 'string' || !REQUEST_SCHEMA_TYPES.has(value.type)) return false;
  const properties = value.properties;
  if (value.type === 'object') {
    if (value.additionalProperties !== false || !isPlainRecord(properties)) return false;
    const required = value.required;
    if (required !== undefined && (!Array.isArray(required) || required.some((key) => typeof key !== 'string') || new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(properties, key)))) return false;
    return Object.values(properties).every((child) => isStructuredRequestSchema(child, depth + 1));
  }
  if (properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.some((item) =>
    (value.type === 'string' && typeof item !== 'string') ||
    ((value.type === 'number' || value.type === 'integer') && typeof item !== 'number') ||
    (value.type === 'boolean' && typeof item !== 'boolean')))) return false;
  if (value.type === 'string' && (value.min !== undefined || value.max !== undefined)) return false;
  if (value.type !== 'string' && (value.minLength !== undefined || value.maxLength !== undefined)) return false;
  if (value.type !== 'number' && value.type !== 'integer' && (value.min !== undefined || value.max !== undefined)) return false;
  if (value.type === 'integer' && Array.isArray(value.enum) && value.enum.some((item) => !Number.isSafeInteger(item))) return false;
  if (typeof value.min === 'number' && typeof value.max === 'number' && value.max < value.min) return false;
  if (typeof value.minLength === 'number' && typeof value.maxLength === 'number' && value.maxLength < value.minLength) return false;
  return true;
}

function assertStructuredRequestSchemaCredentialValues(value: Readonly<Record<string, unknown>>): void {
  const properties = value.properties;
  if (value.type !== 'object' || !isPlainRecord(properties)) return;
  for (const [name, child] of Object.entries(properties)) {
    if (isCredentialMetadataKey(name) && isPlainRecord(child) && child.enum !== undefined) {
      throw new AdapterManifestError('Manifest request schema contains a credential value.');
    }
    if (isPlainRecord(child) && child.type === 'object') assertStructuredRequestSchemaCredentialValues(child);
  }
}

function assertNoManifestSecretTemplates(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 12) throw new AdapterManifestError('Manifest customFields are too deeply nested.');
  if (typeof value === 'string') {
    if (containsSecretTemplate(value)) throw new AdapterManifestError('Manifest customFields may not contain secret templates.');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new AdapterManifestError('Manifest customFields contain a cycle.');
  seen.add(value);
  for (const child of Object.values(value)) assertNoManifestSecretTemplates(child, depth + 1, seen);
  seen.delete(value);
}

/**
 * Manifest capability metadata is sent to the worker/browser boundary. A
 * strict request schema may use credential-like field names as property names,
 * but free-form metadata may not contain credential values or templates.
 */
export function assertSafeManifestCustomFields(value: unknown): void {
  if (!isPlainRecord(value)) throw new AdapterManifestError('Manifest customFields must be a JSON object.');
  assertNoManifestSecretTemplates(value);
  if (isStructuredRequestSchema(value)) {
    assertStructuredRequestSchemaCredentialValues(value);
    return;
  }
  const seen = new Set<object>();
  const visit = (node: unknown, credentialScope = false, depth = 0): void => {
    if (depth > 12) throw new AdapterManifestError('Manifest customFields are too deeply nested.');
    if (typeof node === 'string') {
      if (credentialScope && node.length > 0) throw new AdapterManifestError('Manifest customFields contain a credential value.');
      return;
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'number') {
      if (credentialScope && node !== null) throw new AdapterManifestError('Manifest customFields contain a credential value.');
      return;
    }
    if (!isPlainRecord(node) && !Array.isArray(node)) throw new AdapterManifestError('Manifest customFields contain an unsupported value.');
    if (seen.has(node)) throw new AdapterManifestError('Manifest customFields contain a cycle.');
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child, credentialScope, depth + 1);
    } else {
      for (const [key, child] of Object.entries(node)) {
        const credential = isCredentialMetadataKey(key);
        if (credential && child !== null && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')) {
          throw new AdapterManifestError('Manifest customFields contain a credential value.');
        }
        visit(child, credentialScope || credential, depth + 1);
      }
    }
    seen.delete(node);
  };
  visit(value);
}

export function parseAdapterManifest(value: unknown): AdapterManifest {
  assertBoundedJson(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AdapterManifestError('Manifest JSON is not serializable.');
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_MANIFEST_BYTES) {
    throw new AdapterManifestError('Manifest JSON exceeds the size limit.');
  }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) throw new AdapterManifestError(`Invalid adapter manifest: ${parsed.error.message}`);
  assertBoundedJson(parsed.data);

  const allowedHosts = [...new Set(parsed.data.allowedHosts.map(normalizeHost))];
  if (allowedHosts.length === 0) throw new AdapterManifestError('allowedHosts must not be empty.');
  if (new Set(parsed.data.requiredSecrets).size !== parsed.data.requiredSecrets.length) {
    throw new AdapterManifestError('requiredSecrets must not contain duplicates.');
  }
  const requiredSecrets = [...new Set(parsed.data.requiredSecrets)];
  if (new Set(parsed.data.operations).size !== parsed.data.operations.length) {
    throw new AdapterManifestError('operations must not contain duplicates.');
  }
  const declaredOperations = new Set(parsed.data.operations);
  const modelIds = new Set<string>();
  for (const model of parsed.data.capabilities.models) {
    if (modelIds.has(model.id)) throw new AdapterManifestError('capabilities.models must not contain duplicate ids.');
    modelIds.add(model.id);
    for (const operation of model.capabilities.operations) {
      if (!declaredOperations.has(operation)) throw new AdapterManifestError('Model capabilities must be declared by operations.');
    }
    if (model.capabilities.customFields !== undefined) {
      assertSafeManifestCustomFields(model.capabilities.customFields);
    }
  }
  if (requiredSecrets.some((name) => {
    const normalized = name.toUpperCase();
    return normalized === 'APP_SECRET' || normalized === 'NODE_OPTIONS' || normalized.startsWith('ENV:') || normalized.startsWith('ENV_');
  })) {
    throw new AdapterManifestError('requiredSecrets may not request process-level secrets.');
  }

  return {
    ...parsed.data,
    allowedHosts,
    requiredSecrets,
  };
}

const FORBIDDEN_SOURCE_PATTERNS: readonly [RegExp, string][] = [
  [/\bimport\s*\(/u, 'dynamic import'],
  [/(?:^|[^\w$])import\s+(?:[^;\n]+?\s+from\s+)?["']/mu, 'static import'],
  [/(?:^|[^\w$])require\s*\(/u, 'require'],
  [/(?:^|[^\w$])(?:eval|Function)\s*\(/u, 'eval or Function'],
  [/(?:^|[^\w$])WebAssembly\b/u, 'WebAssembly'],
  [/(?:^|[^\w$])(?:process|globalThis|global)\b/u, 'process/global access'],
  [/(?:^|[^\w$])node:[A-Za-z0-9_./-]+/u, 'Node builtin token'],
  [/(?:^|[^\w$])fetch\s*\(/u, 'fetch'],
  [/(?:^|[^\w$])(?:new\s+)?WebSocket\s*\(/u, 'WebSocket'],
  [/(?:^|[^\w$])(?:new\s+)?EventSource\s*\(/u, 'EventSource'],
  [/(?:^|[^\w$])(?:new\s+)?XMLHttpRequest\s*\(/u, 'XMLHttpRequest'],
  [/(?:^|[^\w$])navigator\s*\.\s*sendBeacon\s*\(/u, 'navigator.sendBeacon'],
];

export function validateAdapterSource(source: Uint8Array): string {
  if (source.byteLength === 0 || source.byteLength > MAX_ADAPTER_SOURCE_BYTES) {
    throw new AdapterSourcePolicyError('adapter.mjs exceeds the source size limit.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new AdapterSourcePolicyError('adapter.mjs must be valid UTF-8.');
  }
  if (text.includes('\u0000')) throw new AdapterSourcePolicyError('adapter.mjs contains a NUL byte.');
  for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(text)) throw new AdapterSourcePolicyError(`adapter.mjs uses forbidden ${label}; trusted code is not a sandbox.`);
  }
  return text;
}

export function parseBoundedManifestJson(source: Uint8Array): AdapterManifest {
  if (source.byteLength > MAX_MANIFEST_BYTES) throw new AdapterManifestError('manifest.json exceeds the size limit.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new AdapterManifestError('manifest.json must be valid UTF-8 JSON.');
  }
  return parseAdapterManifest(new BoundedManifestJsonReader(text).read());
}

class BoundedManifestJsonReader {
  private index = 0;
  private nodes = 0;
  private keys = 0;

  public constructor(private readonly input: string) {}

  public read(): unknown {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) this.fail('Trailing JSON content is not allowed.');
    return value;
  }

  private value(depth: number): unknown {
    this.nodes += 1;
    if (this.nodes > MAX_MANIFEST_NODES || depth > MAX_MANIFEST_DEPTH) this.fail('Manifest JSON exceeds its node/depth limit.');
    this.skipWhitespace();
    const character = this.input[this.index];
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === 't' && this.consume('true')) return true;
    if (character === 'f' && this.consume('false')) return false;
    if (character === 'n' && this.consume('null')) return null;
    if (character === '-' || (character !== undefined && /[0-9]/u.test(character))) return this.number();
    this.fail('Manifest JSON value is invalid.');
  }

  private object(depth: number): Readonly<Record<string, unknown>> {
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.input[this.index] === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.input[this.index] !== '"') this.fail('Manifest JSON object keys must be strings.');
      const key = this.string();
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype' || seen.has(key)) {
        this.fail('Manifest JSON object keys must be unique and safe.');
      }
      seen.add(key);
      this.keys += 1;
      if (this.keys > MAX_MANIFEST_KEYS || key.length > 128) this.fail('Manifest JSON contains too many keys.');
      this.skipWhitespace();
      if (this.input[this.index] !== ':') this.fail('Manifest JSON object key must be followed by a colon.');
      this.index += 1;
      result[key] = this.value(depth);
      this.skipWhitespace();
      if (this.input[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.input[this.index] !== ',') this.fail('Manifest JSON object members must be comma separated.');
      this.index += 1;
    }
  }

  private array(depth: number): readonly unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.input[this.index] === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      if (result.length >= MAX_MANIFEST_ARRAY_ITEMS) this.fail('Manifest JSON array is too large.');
      result.push(this.value(depth));
      this.skipWhitespace();
      if (this.input[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.input[this.index] !== ',') this.fail('Manifest JSON array values must be comma separated.');
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    for (;;) {
      const character = this.input[this.index];
      if (character === undefined) this.fail('Manifest JSON string is unterminated.');
      if (!escaped && character === '"') {
        this.index += 1;
        const token = this.input.slice(start, this.index);
        let value: unknown;
        try {
          value = JSON.parse(token) as unknown;
        } catch {
          this.fail('Manifest JSON string is invalid.');
        }
        // eslint-disable-next-line no-control-regex
        if (typeof value !== 'string' || value.length > MAX_MANIFEST_STRING_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
          this.fail('Manifest JSON string is invalid or too large.');
        }
        return value;
      }
      if (!escaped && character < ' ') this.fail('Manifest JSON strings cannot contain control characters.');
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      this.index += 1;
    }
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.input.slice(this.index));
    if (!match) this.fail('Manifest JSON number is invalid.');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('Manifest JSON number must be finite.');
    this.index += match[0].length;
    return value;
  }

  private consume(value: string): boolean {
    if (this.input.slice(this.index, this.index + value.length) !== value) return false;
    this.index += value.length;
    return true;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? '')) this.index += 1;
  }

  private fail(message: string): never {
    throw new AdapterManifestError(`${message} (offset ${this.index}).`);
  }
}

export function validateAdapterExports(source: string, manifest: AdapterManifest): void {
  const hasExport = (name: string): boolean => new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`, 'u').test(source);
  if (!hasExport('capabilities') || !hasExport('submit') || !hasExport('normalizeError')) {
    throw new AdapterSourcePolicyError('adapter.mjs must export capabilities, submit, and normalizeError.');
  }
  const supportsCancel = manifest.capabilities.models.some((model) => model.capabilities.supportsCancel === true);
  const supportsProgress = manifest.capabilities.models.some((model) => model.capabilities.supportsProgress === true);
  if (supportsCancel && !hasExport('cancel')) throw new AdapterSourcePolicyError('Manifest supportsCancel requires an adapter cancel export.');
  if (supportsProgress && !hasExport('poll')) throw new AdapterSourcePolicyError('Manifest supportsProgress requires an adapter poll export.');
}
