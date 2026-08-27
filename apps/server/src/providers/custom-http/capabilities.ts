import type { ProviderModel } from '@imagine/provider-contract';
import {
  assertSafeCustomFields,
  isStrictRestrictedRequestSchema,
  type StrictRestrictedRequestSchema,
} from '@imagine/shared';

import {
  MAX_SPEC_KEYS,
  RestrictedRequestSchema,
  type DeclarativeHttpSpec,
} from './schema.js';
import { isSecretTemplate } from './template.js';

type DeclarativeModel = DeclarativeHttpSpec['models'][number];
const CUSTOM_FIELDS_SECURITY_OPTIONS = { isSecretTemplate, maxKeys: MAX_SPEC_KEYS } as const;

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

function objectValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}


function requestSchemaToCustomFields(
  schema: StrictRestrictedRequestSchema,
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
): StrictRestrictedRequestSchema | undefined {
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
  const parsed = RestrictedRequestSchema.safeParse(candidate);
  return parsed.success && isStrictRestrictedRequestSchema(parsed.data, { maxKeys: MAX_SPEC_KEYS }) ? parsed.data : undefined;
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
  readonly requestSchema?: StrictRestrictedRequestSchema;
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
  if (explicit !== undefined) assertSafeCustomFields(explicit, CUSTOM_FIELDS_SECURITY_OPTIONS);
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
