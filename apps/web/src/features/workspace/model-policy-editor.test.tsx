import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelPolicyEditor, parameterPresets, mergeCapabilityPresets } from './model-policy-editor';

describe('model parameter administration', () => {
  it('retains flexible pixel sizing when deriving resolution rules from capabilities', () => {
    const capabilities = { operations: ['image.generate'], resolutions: ['auto', '1024x1024'], customFields: { properties: { size: { type: 'string' } } } };
    expect(parameterPresets(capabilities)).toContainEqual(expect.objectContaining({ path: 'resolution', allowCustom: true }));
    expect(parameterPresets({ ...capabilities, resolutions: [] })).toContainEqual(expect.objectContaining({ path: 'resolution', type: 'text' }));
    for (const size of [{ type: 'string', enum: ['1024x1024'] }, { type: 'string', const: '1024x1024' }]) {
      expect(parameterPresets({ ...capabilities, customFields: { properties: { size } } })).toContainEqual(expect.objectContaining({ path: 'resolution', allowCustom: false }));
    }
    const current = { ...capabilities, parameters: [{ path: 'resolution', label: 'Restricted', type: 'select', options: ['1024x1024'], allowCustom: false }] };
    expect(mergeCapabilityPresets(current, capabilities, 'openai', 'gpt-image-2').parameters).toContainEqual(expect.objectContaining({ allowCustom: false, label: 'Restricted' }));
  });
  it('loads missing capabilities while retaining edited rules and explicit capability choices', () => {
    const merged = mergeCapabilityPresets({ operations: ['image.generate'], maxReferenceImages: 2, parameters: [{ path: 'resolution', label: 'Pinned resolution', type: 'select', options: ['2K'], defaultValue: '2K', locked: true }] }, { operations: ['image.generate', 'image.edit'], maxReferenceImages: 14, aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K', '4K'] }, 'xai', 'gemini-3.1-flash-image');
    expect(merged).toMatchObject({ operations: ['image.generate'], maxReferenceImages: 2, resolutions: ['1K', '2K', '4K'], parameters: expect.arrayContaining([{ path: 'aspectRatio', label: '画幅', type: 'select', options: ['1:1', '16:9'], enabled: true, visible: true, required: false, locked: false, allowCustom: false }, expect.objectContaining({ path: 'resolution', label: 'Pinned resolution', defaultValue: '2K', locked: true, options: ['2K'] })]) });
  });
  it('shows automatic matching independently of the provider default', () => {
    const value = JSON.stringify({ operations: ['image.generate'] });
    const html = renderToStaticMarkup(createElement(ModelPolicyEditor, { value, modelId: 'gemini-3.1-flash-image', providerType: 'openai', onChange: () => {} }));
    expect(html).toContain('自动匹配（Gemini · Generate Content）');
    expect(html).toContain('role="combobox"');
    expect(html).not.toContain('<select');
    expect(renderToStaticMarkup(createElement(ModelPolicyEditor, { value, modelId: 'unknown', providerType: 'xai', onChange: () => {} }))).toContain('提供商默认（xAI）');
  });
  it('keeps xAI native fields out of extra and excludes catalog-only metadata', () => {
    const rules = parameterPresets({ operations: ['video.generate'], supportsAudio: true, customFields: { properties: { audio: { type: 'boolean' }, referenceMaxResolution: { const: '720p' }, quality: { type: 'string', enum: ['low', 'medium'] } } } }, 'xai');
    expect(rules.map(rule => rule.path)).toEqual(['audio', 'quality']);
    expect(rules.every(rule => rule.defaultValue === undefined)).toBe(true);
    expect(parameterPresets({ operations: ['image.generate'], customFields: { properties: { quality: { type: 'string', enum: ['low', 'high'] } } } }, 'openai')[0]?.path).toBe('extra.quality');
    expect(parameterPresets({ operations: ['image.generate'], customFields: { properties: { quality: { type: 'string', enum: ['low', 'high'] } } } }, 'openai', 'grok-imagine-image')[0]?.path).toBe('quality');
  });
  it('retains the JSON editor for incomplete or malformed advanced configuration', () => {
    for (const value of ['null', '{', '{"parameters":[null]}', '{"parameters":[{"path":"quality","label":"Quality","options":1}]}']) {
      expect(renderToStaticMarkup(createElement(ModelPolicyEditor, { value, providerType: 'xai', onChange: () => {} }))).toContain('aria-label="模型能力 JSON"');
    }
  });
});
