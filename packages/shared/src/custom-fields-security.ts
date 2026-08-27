export interface StrictRestrictedRequestSchema {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean';
  readonly properties?: Readonly<Record<string, StrictRestrictedRequestSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: false | undefined;
  readonly enum?: readonly (string | number | boolean)[] | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
}

export interface RestrictedRequestSchemaOptions {
  readonly maxKeys?: number;
}

export interface CustomFieldsSecurityOptions extends RestrictedRequestSchemaOptions {
  readonly isSecretTemplate: (value: string) => boolean;
}

const DEFAULT_MAX_KEYS = 512;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_STRING_LENGTH = 4_096;
const MAX_ENUM_ITEMS = 64;
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
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CREDENTIAL_METADATA_WORDS = new Set([
  'access',
  'api',
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
const DESCRIPTIVE_METADATA_WORDS = new Set([
  'description',
  'descriptions',
  'help',
  'hint',
  'hints',
  'label',
  'labels',
  'placeholder',
  'placeholders',
  'title',
  'titles',
]);

function resolvedMaxKeys(value: number | undefined): number {
  const maxKeys = value ?? DEFAULT_MAX_KEYS;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0) throw new RangeError('maxKeys must be a non-negative safe integer.');
  return maxKeys;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function safeSchemaKey(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !DANGEROUS_KEYS.has(value);
}

function metadataKeyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

export function isCredentialLikeMetadataKey(key: string): boolean {
  return metadataKeyWords(key).some((word) => CREDENTIAL_METADATA_WORDS.has(word));
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStaticCredentialValue(value: unknown): boolean {
  return value !== null && isScalar(value);
}

function strictRestrictedRequestSchema(
  value: unknown,
  depth: number,
  maxKeys: number,
): value is StrictRestrictedRequestSchema {
  const schema = objectValue(value);
  if (schema === undefined || depth > MAX_SCHEMA_DEPTH) return false;
  const keys = Object.keys(schema);
  if (keys.length > maxKeys || keys.some((key) => !REQUEST_SCHEMA_KEYS.has(key))) return false;
  if (typeof schema.type !== 'string' || !REQUEST_SCHEMA_TYPES.has(schema.type)) return false;
  const properties = objectValue(schema.properties);
  const propertyNames = Object.keys(properties ?? {});
  if (propertyNames.length > maxKeys || propertyNames.some((key) => !safeSchemaKey(key))) return false;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || properties === undefined || schema.enum !== undefined) return false;
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.length > maxKeys || required.some((key) => typeof key !== 'string' || !safeSchemaKey(key))) return false;
    if (new Set(required).size !== required.length || required.some((key) => !propertyNames.includes(key))) return false;
    return Object.values(properties).every((child) => strictRestrictedRequestSchema(child, depth + 1, maxKeys));
  }
  if (properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return false;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > MAX_ENUM_ITEMS || schema.enum.some((item) => !['string', 'number', 'boolean'].includes(typeof item))) return false;
    if (schema.type === 'string' && schema.enum.some((item) => typeof item !== 'string')) return false;
    if ((schema.type === 'number' || schema.type === 'integer') && schema.enum.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return false;
    if (schema.type === 'boolean' && schema.enum.some((item) => typeof item !== 'boolean')) return false;
    if (schema.type === 'integer' && schema.enum.some((item) => !Number.isSafeInteger(item))) return false;
  }
  const min = schema.min;
  const max = schema.max;
  const minLength = schema.minLength;
  const maxLength = schema.maxLength;
  if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) return false;
  if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) return false;
  if (minLength !== undefined && (typeof minLength !== 'number' || !Number.isSafeInteger(minLength) || minLength < 0 || minLength > MAX_SCHEMA_STRING_LENGTH)) return false;
  if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > MAX_SCHEMA_STRING_LENGTH)) return false;
  if (schema.type === 'string' && (min !== undefined || max !== undefined)) return false;
  if (schema.type !== 'string' && (minLength !== undefined || maxLength !== undefined)) return false;
  if (schema.type !== 'number' && schema.type !== 'integer' && (min !== undefined || max !== undefined)) return false;
  if (min !== undefined && max !== undefined && max < min) return false;
  if (minLength !== undefined && maxLength !== undefined && maxLength < minLength) return false;
  return true;
}

export function isStrictRestrictedRequestSchema(
  value: unknown,
  options: RestrictedRequestSchemaOptions = {},
): value is StrictRestrictedRequestSchema {
  return strictRestrictedRequestSchema(value, 0, resolvedMaxKeys(options.maxKeys));
}

/** Rejects credential values while allowing descriptive metadata and schema-shaped fields. */
export function assertSafeCustomFields(
  customFields: unknown,
  options: CustomFieldsSecurityOptions,
): void {
  const maxKeys = resolvedMaxKeys(options.maxKeys);
  const seen = new Set<object>();
  const visit = (value: unknown, path: readonly string[], credentialScope = false, depth = 0): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error('Custom field metadata is too deeply nested.');
    if (typeof value === 'string') {
      if (options.isSecretTemplate(value) || (credentialScope && value.length > 0)) {
        throw new Error(`Custom field metadata contains a credential value at ${path.join('.')}.`);
      }
      return;
    }
    if (isScalar(value)) {
      if (credentialScope && value !== null) throw new Error(`Custom field metadata contains a credential value at ${path.join('.')}.`);
      return;
    }
    if (value === null || typeof value !== 'object') throw new Error('Custom field metadata contains an unsupported value.');
    if (seen.has(value)) throw new Error('Custom field metadata contains a cycle.');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        for (const [index, child] of value.entries()) visit(child, [...path, String(index)], credentialScope, depth + 1);
      } else {
        const entries = Object.entries(value);
        if (entries.length > maxKeys) throw new Error('Custom field metadata has too many keys.');
        for (const [key, child] of entries) {
          const childPath = [...path, key];
          const credentialKey = isCredentialLikeMetadataKey(key);
          if (credentialKey && isStaticCredentialValue(child)) {
            throw new Error(`Custom field metadata contains a credential value at ${childPath.join('.')}.`);
          }
          const childIsSchema = credentialKey && isStrictRestrictedRequestSchema(child, { maxKeys });
          const descriptiveChild = credentialScope && DESCRIPTIVE_METADATA_WORDS.has(key.toLowerCase());
          visit(child, childPath, childIsSchema || descriptiveChild ? false : credentialScope || credentialKey, depth + 1);
        }
      }
    } finally {
      seen.delete(value);
    }
  };
  visit(customFields, []);
}
