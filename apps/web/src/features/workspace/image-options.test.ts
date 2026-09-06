import { describe, expect, it } from 'vitest';
import { ModelParametersSchema, type ModelDto, type ProviderDto } from '@imagine/shared';
import { mapModels } from './data';
import { acceptsImageOption, imageResolutionValue } from './image-options';

function model(capabilities: ModelDto['capabilities']) {
  return mapModels([{ id: 'image', providerId: 'provider', modelId: 'image', displayName: 'Image', enabled: true, capabilities } as ModelDto], [{ id: 'provider', name: 'Provider', enabled: true } as ProviderDto])[0]!;
}

describe('image shortcuts', () => {
  it('prefers declared native sizes and derives supported pixel sizes from the ratio', () => {
    const pixel = model({ operations: ['image.generate'], resolutions: ['1024x1024'], customFields: { type: 'object', properties: { size: { type: 'string' } } } });
    expect(imageResolutionValue(pixel, undefined, '2K', '16:9')).toBe('2048x1152');
    expect(imageResolutionValue(pixel, undefined, '4K', '9:16')).toBe('2304x4096');
    const named = model({ operations: ['image.generate'], resolutions: ['1K', '2K'] });
    expect(imageResolutionValue(named, undefined, '2K', '16:9')).toBe('2K');
    expect(imageResolutionValue(named, undefined, '4K', '16:9')).toBeUndefined();
    expect(acceptsImageOption(named, undefined, 'resolution', '1920x1080')).toBe(false);
  });

  it('honors parameter locks visibility count steps and pixel limits', () => {
    const image = model({ operations: ['image.generate'] });
    const rules = ModelParametersSchema.parse([
      { path: 'count', label: 'Count', type: 'number', min: 2, max: 6, step: 2 },
      { path: 'resolution', label: 'Resolution', type: 'select', options: ['auto'], allowCustom: true },
    ]);
    expect(acceptsImageOption(image, rules, 'count', 2)).toBe(true);
    for (const count of [1, 3, 8, 33, 1.5]) expect(acceptsImageOption(image, rules, 'count', count)).toBe(false);
    expect(acceptsImageOption(image, rules, 'resolution', '1920x1080')).toBe(true);
    for (const size of ['16385x1', '10001x10000']) expect(acceptsImageOption(image, rules, 'resolution', size)).toBe(false);
    expect(imageResolutionValue(image, rules.map(rule => ({ ...rule, locked: true })), '2K', '1:1')).toBeUndefined();
    expect(imageResolutionValue(image, rules.map(rule => ({ ...rule, visible: false })), '2K', '1:1')).toBeUndefined();
  });
});
