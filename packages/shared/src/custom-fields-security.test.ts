import { describe, expect, it } from 'vitest';

import {
  assertSafeCustomFields,
  isStrictRestrictedRequestSchema,
} from './custom-fields-security.js';

const options = {
  isSecretTemplate: (value: string): boolean => /\{\{\s*secret\./u.test(value),
};

const stringSchema = { type: 'string', maxLength: 64 } as const;

describe('custom field security', () => {
  it('allows null, empty containers, descriptive metadata, and schema-shaped credential fields', () => {
    expect(() => assertSafeCustomFields(null, options)).not.toThrow();
    expect(() => assertSafeCustomFields({}, options)).not.toThrow();
    expect(() => assertSafeCustomFields([], options)).not.toThrow();
    expect(() => assertSafeCustomFields({
      description: 'The API key is configured separately.',
      labels: ['Authorization', 'safe label'],
      modelFields: { style: { description: 'Visual treatment.' } },
    }, options)).not.toThrow();
    expect(() => assertSafeCustomFields({ apiKey: stringSchema, authorization: stringSchema }, options)).not.toThrow();
  });

  it('accepts strict restricted schemas and enforces the configured key bound', () => {
    const schema = {
      type: 'object',
      properties: {
        apiKey: stringSchema,
        secretary: { type: 'string' },
        mytoken: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    } as const;
    expect(isStrictRestrictedRequestSchema(schema)).toBe(true);
    expect(isStrictRestrictedRequestSchema(schema, { maxKeys: 2 })).toBe(false);
    expect(isStrictRestrictedRequestSchema(stringSchema)).toBe(true);
  });

  it('rejects credential scalars, secret templates, malformed schemas, and cycles', () => {
    for (const value of [
      { apiKey: 'plaintext' },
      { authorization: '{{ secret.apiKey }}' },
      { apiKey: { type: 'string', unexpected: true } },
      { apiKey: 42 },
    ]) {
      expect(() => assertSafeCustomFields(value, options)).toThrow(/credential/i);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.metadata = cyclic;
    expect(() => assertSafeCustomFields(cyclic, options)).toThrow(/cycle/i);
  });
});
