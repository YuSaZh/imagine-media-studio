import type { ProviderDto } from '@imagine/shared';
import { describe, expect, it } from 'vitest';

import { buildProviderWriteInput, providerToForm } from './provider-settings.js';

const storedProvider: ProviderDto = {
  baseUrl: 'https://api.example.com',
  config: { region: 'test' },
  createdAt: '2026-08-25T00:00:00.000Z',
  enabled: true,
  hasApiKey: true,
  hasCustomHeaders: true,
  id: 'provider-1',
  isDefault: false,
  name: 'Stored Provider',
  type: 'custom-http',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

describe('Provider editor mapping', () => {
  it('never places a stored Secret into editor state', () => {
    const form = providerToForm(storedProvider);
    expect(form.apiKey).toBe('');
    expect(JSON.stringify(form)).not.toContain('secret');
    expect(form).toMatchObject({
      baseUrl: 'https://api.example.com',
      name: 'Stored Provider',
      type: 'custom-http',
    });
  });

  it('omits a blank API key and includes only a newly entered value', () => {
    const blank = buildProviderWriteInput(providerToForm(storedProvider));
    expect(blank).not.toHaveProperty('apiKey');

    const replacement = buildProviderWriteInput({
      ...providerToForm(storedProvider),
      apiKey: 'new-key',
    });
    expect(replacement.apiKey).toBe('new-key');
  });

  it('validates required fields and JSON object configuration', () => {
    expect(() =>
      buildProviderWriteInput({ ...providerToForm(null), name: '   ' }),
    ).toThrow('name is required');
    expect(() =>
      buildProviderWriteInput({ ...providerToForm(null), name: 'Provider', configJson: '[' }),
    ).toThrow('valid JSON');
    expect(() =>
      buildProviderWriteInput({ ...providerToForm(null), name: 'Provider', configJson: '[]' }),
    ).toThrow('JSON object');
    expect(() =>
      buildProviderWriteInput({
        ...providerToForm(null),
        name: 'Provider',
        configJson: '{"api_key":"wrong field"}',
      }),
    ).toThrow('Secret-like keys');
  });
});
