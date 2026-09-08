import { describe, expect, it } from 'vitest';
import { ModelParametersSchema, type ModelDto, type ProviderDto } from '@imagine/shared';
import { generationRequest, mapModels } from './data';
import { acceptsImageOption, imageResolutionValue, imagePresetRatioChoices } from './image-options';

function model(capabilities: ModelDto['capabilities'], modelId = 'image', providerType = '') {
  return mapModels([{ id: 'image', providerId: 'provider', modelId, displayName: 'Image', enabled: true, capabilities } as ModelDto], [{ id: 'provider', name: 'Provider', type: providerType, enabled: true } as ProviderDto])[0]!;
}

describe('image shortcuts', () => {
  it.each([
    ['openai-chat-image-v1', 'gemini-3.1-flash-image', '4K'],
    ['gemini-generate-content-image-v1', 'gemini-3.1-flash-image', '4K'],
    ['gemini-interactions-image-v1', 'gemini-3-pro-image', '4K'],
    ['xai-imagine-image-v1', 'grok-imagine-image', '2k'],
  ])('selects and submits a native tier without a ratio for %s', (profile, modelId, wireResolution) => {
    const image = model({ profile, operations: ['image.generate'], aspectRatios: ['auto', '1:1', '16:9'], resolutions: ['auto', '1024x1024', '2048x2048'], imageResolution: { mode: 'native', values: ['auto', wireResolution], allowCustomDimensions: false } }, modelId, 'openai');
    expect(imageResolutionValue(image, undefined, wireResolution.toUpperCase(), 'auto')).toBe(wireResolution);
    expect(imagePresetRatioChoices(image, undefined, wireResolution.toUpperCase())).toEqual([]);
    const request = generationRequest({ model: image, operation: 'image.generate', prompt: 'test', inputs: [], ratio: 'auto', resolution: wireResolution, count: 1, duration: 5, negativePrompt: '', seed: '', audio: false });
    expect(request.resolution).toBe(wireResolution);
    expect(request).not.toHaveProperty('aspectRatio');
    expect(image.raw.capabilities.resolutions).toEqual(['auto', '1024x1024', '2048x2048']);
  });
  it('handles free-text native policies without treating missing options as a pixel protocol', () => {
    const image = model({ profile: 'openai-chat-image-v1', operations: ['image.generate'], resolutions: ['auto', '2K', '4K', '8K'] }, 'custom-image', 'openai');
    for (const rule of [{ type: 'text' }, { type: 'select', options: ['auto'], allowCustom: true }]) {
      const rules = ModelParametersSchema.parse([{ path: 'resolution', label: 'Resolution', ...rule }]);
      expect(imageResolutionValue(image, rules, '4K', 'auto')).toBe('4K');
      expect(imagePresetRatioChoices(image, rules, '4K')).toEqual([]);
    }
    const restricted = ModelParametersSchema.parse([{ path: 'resolution', label: 'Resolution', type: 'select', options: ['2K'] }]);
    expect(imageResolutionValue(image, restricted, '2K', 'auto')).toBe('2K');
    expect(imageResolutionValue(image, restricted, '4K', 'auto')).toBeUndefined();
    expect(imagePresetRatioChoices(image, restricted, '4K')).toEqual([]);
  });
  it('honors explicit pixel protocol overrides over native-looking model names and options', () => {
    for (const profile of ['openai-images-v1', 'openai-responses-image-v1']) {
      const image = model({ profile, operations: ['image.generate'], resolutions: ['1K', '2K'], aspectRatios: ['auto', '16:9'], customFields: { properties: { size: { type: 'string' } } } }, 'gemini-3.1-flash-image', 'openai');
      expect(imageResolutionValue(image, undefined, '2K', 'auto')).toBeUndefined();
      expect(imageResolutionValue(image, undefined, '2K', '16:9')).toBe('2048x1152');
    }
  });
  it('offers only protocol-valid GPT Image 2 ratios without overriding restricted rules', () => {
    const gpt = model({ operations: ['image.generate'], profile: 'openai-images-v1', imageResolution: { mode: 'pixels', values: ['auto'], allowCustomDimensions: true, dimensions: { multipleOf: 16, maxWidth: 3840, maxHeight: 3840, minPixels: 655360, maxPixels: 8294400, maxAspectRatio: 3 } } }, 'arbitrary-renamed-model');
    const rules = ModelParametersSchema.parse([
      { path: 'aspectRatio', label: 'Ratio', type: 'select', options: ['auto', '1:1', '16:9', '9:16', '3:2', '2:3'] },
      { path: 'resolution', label: 'Resolution', type: 'select', options: ['auto', '1024x1024', '3840x2160'], allowCustom: true },
    ]);
    expect(imagePresetRatioChoices(gpt, rules, '1K').map(choice => choice.ratio)).toEqual(['1:1', '16:9', '9:16', '3:2', '2:3']);
    expect(imagePresetRatioChoices(gpt, rules, '4K')).toEqual([{ ratio: '16:9', resolution: '3840x2160' }, { ratio: '9:16', resolution: '2160x3840' }]);
    expect(imageResolutionValue(gpt, rules, '1K', '3:2')).toBe('1024x688');
    expect(imageResolutionValue(gpt, rules, '2K', '2:3')).toBe('1360x2048');
    expect(imageResolutionValue(gpt, rules, '4K', '1:1')).toBeUndefined();
    expect(imagePresetRatioChoices(gpt, rules.map(rule => ({ ...rule, locked: true })), '1K')).toEqual([]);
    expect(imageResolutionValue(gpt, rules.map(rule => ({ ...rule, allowCustom: false })), '1K', '3:2')).toBeUndefined();
  });
  it('prefers declared native sizes and derives supported pixel sizes from the ratio', () => {
    const pixel = model({ operations: ['image.generate'], resolutions: ['1024x1024'], customFields: { type: 'object', properties: { size: { type: 'string' } } } });
    expect(imageResolutionValue(pixel, undefined, '2K', '16:9')).toBe('2048x1152');
    expect(imageResolutionValue(pixel, undefined, '4K', '9:16')).toBe('2160x3840');
    for (const preset of ['1K', '2K', '4K']) expect(imageResolutionValue(pixel, undefined, preset, 'auto')).toBeUndefined();
    const named = model({ operations: ['image.generate'], resolutions: ['1K', '2K'] });
    expect(imageResolutionValue(named, undefined, '2K', '16:9')).toBe('2K');
    expect(imageResolutionValue(named, undefined, '2K', 'auto')).toBe('2K');
    expect(imageResolutionValue(named, undefined, '4K', '16:9')).toBeUndefined();
    expect(acceptsImageOption(named, undefined, 'resolution', '1920x1080')).toBe(false);
    const lowerCase = model({ operations: ['image.generate'], resolutions: ['1k', '2k'] });
    expect(imageResolutionValue(lowerCase, undefined, '2K', '16:9')).toBe('2k');
    expect(imageResolutionValue(lowerCase, undefined, '2K', 'auto')).toBe('2k');
    const mixed = model({ operations: ['image.generate'], resolutions: ['2K', '1920x1080'] });
    expect(imageResolutionValue(mixed, undefined, '2K', '16:9')).toBe('2K');
  });

  it('honors resolution policy and pixel limits while count uses application limits', () => {
    const image = model({ operations: ['image.generate'], imageResolution: { mode: 'pixels', values: ['auto'], allowCustomDimensions: true } });
    const rules = ModelParametersSchema.parse([
      { path: 'count', label: 'Count', type: 'number', min: 2, max: 6, step: 2 },
      { path: 'resolution', label: 'Resolution', type: 'select', options: ['auto'], allowCustom: true },
    ]);
    expect(acceptsImageOption(image, rules, 'count', 2)).toBe(true);
    for (const count of [1, 3, 8, 32]) expect(acceptsImageOption(image, rules, 'count', count)).toBe(true);
    for (const count of [0, 33, 1.5]) expect(acceptsImageOption(image, rules, 'count', count)).toBe(false);
    expect(acceptsImageOption(image, rules, 'resolution', '1920x1080')).toBe(true);
    expect(imageResolutionValue(image, rules, '4K', '16:9')).toBe('3840x2160');
    expect(imageResolutionValue(image, rules, '4K', 'auto')).toBeUndefined();
    for (const size of ['16385x1', '10001x10000']) expect(acceptsImageOption(image, rules, 'resolution', size)).toBe(false);
    expect(imageResolutionValue(image, rules.map(rule => ({ ...rule, locked: true })), '2K', '1:1')).toBeUndefined();
    expect(imageResolutionValue(image, rules.map(rule => ({ ...rule, visible: false })), '2K', '1:1')).toBeUndefined();
  });
  it('keeps strict pixel-valued native policies selectable without widening them', () => {
    const values = ['auto', '1024x1024', '2048x2048'];
    const rules = ModelParametersSchema.parse([
      { path: 'aspectRatio', label: 'Ratio', type: 'select', options: ['auto', '1:1', '16:9'] },
      { path: 'resolution', label: 'Resolution', type: 'select', options: values, allowCustom: false },
    ]);
    const image = model({ operations: ['image.generate'], profile: 'openai-chat-image-v1', resolutions: values, parameters: JSON.parse(JSON.stringify(rules)) }, 'unknown-custom-image', 'openai');
    expect(imageResolutionValue(image, rules, '1K', '1:1')).toBe('1024x1024');
    expect(imageResolutionValue(image, rules, '2K', '1:1')).toBe('2048x2048');
    expect(imageResolutionValue(image, rules, '4K', '1:1')).toBeUndefined();
    expect(imageResolutionValue(image, rules, '1K', 'auto')).toBeUndefined();
    expect(imagePresetRatioChoices(image, rules, '1K')).toEqual([{ ratio: '1:1', resolution: '1024x1024' }]);
  });
});
