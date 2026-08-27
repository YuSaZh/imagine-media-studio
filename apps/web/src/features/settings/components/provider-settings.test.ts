import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderDto } from '@imagine/shared';
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_PROFILE_OPTIONS,
  ProviderApiKeyField,
  ManualModelCapabilityField,
  buildManualModelWriteInput,
  buildProviderWriteInput,
  modelToForm,
  providerToForm,
} from './provider-settings.js';

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
  type: 'xai-imagine-image-v1',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

describe('Provider editor mapping', () => {
  it('exposes one stable accessible name for the password field', () => {
    const markup = renderToStaticMarkup(createElement(ProviderApiKeyField, {
      hasStoredKey: true,
      onChange: () => undefined,
      value: '',
    }));

    expect(markup.match(/aria-label="API key"/g)).toHaveLength(1);
    expect(markup.match(/type="password"/g)).toHaveLength(1);
    expect(markup).toContain('Write only. Saved credentials are never returned to this page.');
  });

  it('exposes one stable accessible name for the capability JSON field', () => {
    const markup = renderToStaticMarkup(createElement(ManualModelCapabilityField, {
      onChange: () => undefined,
      value: '{}',
    }));

    expect(markup.match(/aria-label="Capability JSON"/g)).toHaveLength(1);
    expect(markup.match(/<textarea/g)).toHaveLength(1);
    expect(markup).toContain('Include at least one supported operation, such as image.generate.');
  });

  it('never places a stored Secret into editor state', () => {
    const form = providerToForm(storedProvider);
    expect(form.apiKey).toBe('');
    expect(JSON.stringify(form)).not.toContain('secret');
    expect(form).toMatchObject({
      baseUrl: 'https://api.example.com',
      name: 'Stored Provider',
      type: 'xai-imagine-image-v1',
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

  it('keeps headers separate from safe configuration and uses controlled profiles', () => {
    const withHeaders = buildProviderWriteInput({
      ...providerToForm(storedProvider),
      headersJson: '{"X-Trace":"request-id"}',
    });
    expect(withHeaders.headers).toEqual({ 'X-Trace': 'request-id' });
    expect(withHeaders.config).not.toHaveProperty('X-Trace');

    const selected = buildProviderWriteInput({
      ...providerToForm(null),
      name: 'xAI',
      profile: 'xai-imagine-image-v1',
    });
    expect(selected.type).toBe('xai-imagine-image-v1');
    expect(providerToForm(null)).toMatchObject({
      profile: 'openai-images-v1',
      type: 'openai-images-v1',
      unsupportedType: false,
    });
    expect(PROVIDER_PROFILE_OPTIONS.some((option) => (option.value as string) === 'custom')).toBe(false);
    expect(() => buildProviderWriteInput({
      ...providerToForm({ ...storedProvider, type: 'custom-http' }),
      name: 'Legacy custom',
    })).toThrow('no longer supported');
    expect(PROVIDER_PROFILE_OPTIONS.map((option) => option.value)).toEqual(expect.arrayContaining([
      'openai-videos-v1-compatible',
      'gemini-veo-operation-v1',
      'gemini-omni-interactions-video-v1',
      'xai-imagine-video-v1',
      'custom-http-v1',
      'custom-js-v1',
    ]));
    expect(() => buildProviderWriteInput({
      ...providerToForm(null),
      name: 'OpenAI video relay',
      profile: 'openai-videos-v1-compatible',
      type: 'openai-videos-v1-compatible',
    })).toThrow('requires a Base URL');
    expect(() => buildProviderWriteInput({
      ...providerToForm(null),
      name: 'Custom HTTP',
      profile: 'custom-http-v1',
      type: 'custom-http-v1',
    })).toThrow('requires a Base URL');
    expect(buildProviderWriteInput({
      ...providerToForm(null),
      name: 'Trusted JS',
      profile: 'custom-js-v1',
      type: 'custom-js-v1',
    })).toMatchObject({ type: 'custom-js-v1', baseUrl: null });
  });

  it('validates manual model capabilities before writing', () => {
    const form = modelToForm(null, 'provider-1');
    expect(buildManualModelWriteInput({
      ...form,
      displayName: 'Manual image',
      modelId: 'image-v1',
    })).toMatchObject({
      providerId: 'provider-1',
      capabilities: { operations: ['image.generate'] },
    });
    expect(() => buildManualModelWriteInput({
      ...form,
      capabilitiesJson: '{"operations":["image.generate"],"unknown":true}',
      displayName: 'Manual image',
      modelId: 'image-v1',
    })).toThrow('Capability schema');
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
