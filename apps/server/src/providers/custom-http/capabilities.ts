import type { ProviderModel } from '@imagine/provider-contract';

import {
  MAX_SPEC_KEYS,
  RestrictedRequestSchema,
  type DeclarativeHttpSpec,
  type RestrictedRequestSchema as RestrictedRequestSchemaType,
} from './schema.js';
import { isSecretTemplate } from './template.js';

type DeclarativeModel = DeclarativeHttpSpec['models'][number];

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

const MAX_METADATA_DEPTH = 12;

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function metadataKeyWords(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function isCredentialLikeMetadataKey(key: string): boolean {
  return metadataKeyWords(key).some((word) => CREDENTIAL_METADATA_WORDS.has(word));
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStaticCredentialValue(value: unknown): boolean {
  return value !== null && isScalar(value);
}

function hasExactRequestSchemaKeys(value: Readonly<Record<string, unknown>>, depth = 0): boolean {
  if (depth > 12 || Object.keys(value).some((key) => !REQUEST_SCHEMA_KEYS.has(key))) return false;
  const properties = value.properties;
  if (properties === undefined) return true;
  const propertyRecord = objectValue(properties);
  return propertyRecord !== undefined && Object.values(propertyRecord).every((child) => {
    const childRecord = objectValue(child);
    return childRecord !== undefined && hasExactRequestSchemaKeys(childRecord, depth + 1);
  });
}

/**
 * Rejects credentials in capability metadata without treating descriptive text
 * as a secret. Schema-shaped children are still traversed for secret templates,
 * but are not treated as credential values merely because a request field is
 * named apiKey or authorization.
 */
export function assertSafeCustomFields(customFields: unknown): void {
  const seen = new Set<object>();
  const visit = (value: unknown, path: readonly string[], credentialScope = false, depth = 0): void => {
    if (depth > MAX_METADATA_DEPTH) throw new Error('Custom field metadata is too deeply nested.');
    if (typeof value === 'string') {
      if (isSecretTemplate(value) || (credentialScope && value.length > 0)) {
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
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) visit(child, [...path, String(index)], credentialScope, depth + 1);
    } else {
      for (const [key, child] of Object.entries(value)) {
        const childPath = [...path, key];
        const credentialKey = isCredentialLikeMetadataKey(key);
        if (credentialKey && isStaticCredentialValue(child)) {
          throw new Error(`Custom field metadata contains a credential value at ${childPath.join('.')}.`);
        }
        const childIsSchema = credentialKey && isStrictRestrictedRequestSchema(child);
        const descriptiveChild = credentialScope && DESCRIPTIVE_METADATA_WORDS.has(key.toLowerCase());
        visit(child, childPath, childIsSchema || descriptiveChild ? false : credentialScope || credentialKey, depth + 1);
      }
    }
    seen.delete(value);
  };
  visit(customFields, []);
}

/** Mirrors the compiler's strict restricted-schema invariants without throwing. */
export function isStrictRestrictedRequestSchema(
  value: unknown,
  depth = 0,
): value is RestrictedRequestSchemaType {
  const schema = objectValue(value);
  if (schema === undefined || depth > 12 || !hasExactRequestSchemaKeys(schema, depth) || typeof schema.type !== 'string' || !REQUEST_SCHEMA_TYPES.has(schema.type)) return false;
  const properties = objectValue(schema.properties);
  const propertyNames = Object.keys(properties ?? {});
  if (propertyNames.length > MAX_SPEC_KEYS) return false;
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) return false;
    if (schema.enum !== undefined || (schema.required !== undefined && !Array.isArray(schema.required))) return false;
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length || required.some((key) => !propertyNames.includes(key))) return false;
    if (properties === undefined) return false;
    return Object.values(properties).every((child) => isStrictRestrictedRequestSchema(child, depth + 1));
  }
  if (properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return false;
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) return false;
  if (schema.type === 'string' && schema.enum?.some((item) => typeof item !== 'string')) return false;
  if ((schema.type === 'number' || schema.type === 'integer') && schema.enum?.some((item) => typeof item !== 'number')) return false;
  if (schema.type === 'boolean' && schema.enum?.some((item) => typeof item !== 'boolean')) return false;
  const min = schema.min;
  const max = schema.max;
  const minLength = schema.minLength;
  const maxLength = schema.maxLength;
  if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) return false;
  if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) return false;
  if (minLength !== undefined && (typeof minLength !== 'number' || !Number.isSafeInteger(minLength) || minLength < 0)) return false;
  if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 0)) return false;
  if (schema.type === 'string' && (schema.min !== undefined || schema.max !== undefined)) return false;
  if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined)) return false;
  if (schema.type !== 'number' && schema.type !== 'integer' && (schema.min !== undefined || schema.max !== undefined)) return false;
  if (schema.type === 'integer' && schema.enum?.some((item) => !Number.isSafeInteger(item))) return false;
  if (min !== undefined && max !== undefined && max < min) return false;
  if (minLength !== undefined && maxLength !== undefined && maxLength < minLength) return false;
  return true;
}

function requestSchemaToCustomFields(
  schema: RestrictedRequestSchemaType,
): Record<string, unknown> {
  const result: Record<string, unknown> = { type: schema.type };
  if (schema.properties !== undefined) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, property]) => [key, requestSchemaToCustomFields(property)]),
    );
  }
  if (schema.required !== undefined) result.required = [...schema.required];
  if (schema.additionalProperties !== undefined) result.additionalProperties = schema.additionalProperties;
  if (schema.enum !== undefined) result.enum = [...schema.enum];
  if (schema.min !== undefined) result.min = schema.min;
  if (schema.max !== undefined) result.max = schema.max;
  if (schema.minLength !== undefined) result.minLength = schema.minLength;
  if (schema.maxLength !== undefined) result.maxLength = schema.maxLength;
  return result;
}

function supportedCustomFieldSchema(
  customFields: Readonly<Record<string, unknown>> | undefined,
): RestrictedRequestSchemaType | undefined {
  if (customFields?.type !== 'object') return undefined;
  if (customFields.additionalProperties !== false) return undefined;
  const rawProperties = objectValue(customFields.properties);
  if (customFields.properties !== undefined && rawProperties === undefined) return undefined;
  const candidate: Record<string, unknown> = {
    properties: rawProperties ?? {},
    type: 'object',
  };
  for (const key of REQUEST_SCHEMA_KEYS) {
    if (key === 'type' || key === 'properties') continue;
    if (Object.hasOwn(customFields, key)) candidate[key] = customFields[key];
  }
  if (!hasExactRequestSchemaKeys(candidate)) return undefined;
  const parsed = RestrictedRequestSchema.safeParse(candidate);
  return parsed.success && isStrictRestrictedRequestSchema(parsed.data) ? parsed.data : undefined;
}

function metadataFields(
  customFields: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (customFields === undefined) return {};
  return Object.fromEntries(
    Object.entries(customFields).filter(([key]) => !REQUEST_SCHEMA_KEYS.has(key)),
  );
}

export interface DeclarativeModelProjection {
  readonly requestSchema?: RestrictedRequestSchemaType;
  readonly customFields?: ProviderModel['capabilities']['customFields'];
}

/**
 * Produces the one schema used by both capability presentation and request
 * validation. A model's requestSchema is authoritative when present; a
 * customFields may provide a complete restricted-schema fallback only when
 * requestSchema is absent. Once requestSchema exists, its properties,
 * constraints, required keys, and additionalProperties policy are immutable;
 * other customFields keys remain metadata and never become request extras.
 */
export function projectDeclarativeModel(model: DeclarativeModel): DeclarativeModelProjection {
  const explicit = objectValue(model.capabilities.customFields);
  if (explicit !== undefined) assertSafeCustomFields(explicit);
  const supplement = supportedCustomFieldSchema(explicit);
  const requestSchema = model.requestSchema === undefined
    ? supplement
    : model.requestSchema;
  if (requestSchema === undefined) {
    const metadata = metadataFields(explicit);
    return {
      ...(Object.keys(metadata).length === 0 ? {} : { customFields: metadata }),
    };
  }
  return {
    customFields: {
      ...requestSchemaToCustomFields(requestSchema),
      ...metadataFields(explicit),
    },
    requestSchema,
  };
}
