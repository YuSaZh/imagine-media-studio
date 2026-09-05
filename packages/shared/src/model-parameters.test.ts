import { describe, expect, it } from 'vitest';
import { applyModelParameters, ModelParametersSchema } from './model-parameters.js';
import { GenerationRequestSchema } from './generation.js';

const request = GenerationRequestSchema.parse({ providerId: 'xai', modelId: 'image', operation: 'image.generate', prompt: 'test' });
describe('model parameter policy', () => {
  it('does not invent format, ratio, dimensions or count defaults', () => {
    expect(applyModelParameters(request, [])).toEqual(request);
  });
  it('applies defaults, preserves false and zero, and restores locked values', () => {
    const rules = ModelParametersSchema.parse([
      { path: 'quality', label: 'Quality', type: 'select', options: ['low', 'high'], defaultValue: 'high', locked: true },
      { path: 'seed', label: 'Seed', type: 'number', defaultValue: 42 },
      { path: 'audio', label: 'Audio', type: 'boolean', defaultValue: true },
    ]);
    expect(applyModelParameters({ ...request, quality: 'low', seed: 0, audio: false }, rules)).toMatchObject({ quality: 'high', seed: 0, audio: false });
    expect(applyModelParameters(request, rules)).toMatchObject({ quality: 'high', seed: 42, audio: true });
  });
  it('rejects disabled, unknown, out of range and missing required parameters', () => {
    const rules = ModelParametersSchema.parse([{ path: 'count', label: 'Count', type: 'number', min: 1, max: 4, step: 1, required: true }]);
    expect(() => applyModelParameters(request, rules)).toThrow('Count');
    expect(() => applyModelParameters({ ...request, count: 5 }, rules)).toThrow('Count');
    expect(() => applyModelParameters({ ...request, count: 2, extra: { unexpected: 1 } }, rules)).toThrow('extra.unexpected');
    expect(() => applyModelParameters({ ...request, format: 'png' }, [])).toThrow('format');
  });
  it('validates safe paths, duplicate paths, fixed defaults and enum defaults on save', () => {
    for (const path of ['prompt', 'providerId', 'profile', 'extra.__proto__', 'extra.authorization', 'extra.apiKey']) expect(ModelParametersSchema.safeParse([{ path, label: 'bad', type: 'text' }]).success).toBe(false);
    const rule = { path: 'quality', label: 'Quality', type: 'text' };
    expect(ModelParametersSchema.safeParse([rule, rule]).success).toBe(false);
    expect(ModelParametersSchema.safeParse([{ ...rule, locked: true }]).success).toBe(false);
    expect(ModelParametersSchema.safeParse([{ ...rule, type: 'select', options: ['low'], defaultValue: 'high' }]).success).toBe(false);
  });
  it('maps additional scalar parameters without accepting arbitrary objects', () => {
    const rules = ModelParametersSchema.parse([{ path: 'extra.output_format', label: 'Format', type: 'select', options: ['jpeg'], allowCustom: true }]);
    expect(applyModelParameters({ ...request, extra: { output_format: 'webp' } }, rules).extra).toEqual({ output_format: 'webp' });
    expect(() => applyModelParameters({ ...request, extra: { output_format: { nested: true } } }, rules)).toThrow();
  });
});
