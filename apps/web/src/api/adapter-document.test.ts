import { describe, expect, it } from 'vitest';

import { readExportedYamlEnvelopeVersion } from './adapter-document.js';

describe('readExportedYamlEnvelopeVersion', () => {
  it.each([
    ['plain', '2.0.0'],
    ['single quoted', "'2.0.0'"],
    ['double quoted', '"2.0.0"'],
  ])('accepts %s bounded root versions', (_label, version) => {
    expect(readExportedYamlEnvelopeVersion(`\n\nschemaVersion: 1\nversion: ${version}\ndefinition:\n  id: custom\n`)).toBe('2.0.0');
  });

  it('accepts the server sorted export order with definition as the first root key', () => {
    expect(readExportedYamlEnvelopeVersion(
      'definition:\n  id: custom\n  name: Custom\nschemaVersion: 1\nversion: 2.0.0\n',
    )).toBe('2.0.0');
  });

  it('does not parse nested lookalikes or comments as an envelope', () => {
    expect(readExportedYamlEnvelopeVersion('document:\n  schemaVersion: 1\n  version: 2.0.0\n  definition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('# schemaVersion: 1\nschemaVersion: 1\nversion: 2.0.0\ndefinition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1 # comment\nversion: 2.0.0\ndefinition:\n')).toBeUndefined();
  });

  it('rejects escapes, comments, controls, unbounded values, and non-root definition keys', () => {
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: "2\\.0.0"\ndefinition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0 # comment\ndefinition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: "2.0.0\u0000"\ndefinition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion(`schemaVersion: 1\nversion: ${'a'.repeat(65)}\ndefinition:\n`)).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\n  definition:\n')).toBeUndefined();
  });

  it('rejects duplicate or extra root keys and unsafe YAML constructs anywhere', () => {
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\nextra: false\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\nschemaVersion: 1\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\nstray scalar\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  value: &anchor text\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  value: !tag text\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n  value: *anchor\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('---\nschemaVersion: 1\nversion: 2.0.0\ndefinition:\n')).toBeUndefined();
    expect(readExportedYamlEnvelopeVersion('schemaVersion: 1\nversion: 2.0.0\ndefinition:\n...\n')).toBeUndefined();
  });
});
