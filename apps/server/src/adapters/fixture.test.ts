import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  digestAdapterSource,
  parseBoundedManifestJson,
  validateAdapterResult,
  validateAdapterSource,
} from './index.js';

describe('trusted adapter fixture contract', () => {
  it('has a fixed manifest digest and no direct runtime escape imports', async () => {
    const directory = new URL('../../../../fixtures/adapters/trusted-fixture-v1/', import.meta.url);
    const source = await readFile(new URL('adapter.mjs', directory));
    const manifest = parseBoundedManifestJson(await readFile(new URL('manifest.json', directory)));
    expect(digestAdapterSource(source)).toBe(manifest.sha256);
    expect(validateAdapterSource(source)).toContain('export const capabilities');
    expect(manifest.allowedHosts).toEqual(['api.example.com']);
    expect(manifest.requiredSecrets).toEqual(['apiKey']);
    const capabilities = JSON.parse(await readFile(new URL('capabilities.json', directory), 'utf8')) as unknown;
    const submit = JSON.parse(await readFile(new URL('submit-response.json', directory), 'utf8')) as unknown;
    const poll = JSON.parse(await readFile(new URL('poll-response.json', directory), 'utf8')) as unknown;
    const normalizedError = JSON.parse(await readFile(new URL('normalized-error.json', directory), 'utf8')) as unknown;
    expect(validateAdapterResult('capabilities', capabilities, 1_048_576)).toEqual(capabilities);
    expect(validateAdapterResult('submit', submit, 1_048_576)).toEqual(submit);
    expect(validateAdapterResult('poll', poll, 1_048_576)).toEqual(poll);
    expect(validateAdapterResult('normalizeError', normalizedError, 1_048_576)).toEqual(normalizedError);
  });
});
