import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelPolicyEditor, parameterPresets } from './model-policy-editor';

describe('model parameter administration', () => {
  it('shows automatic matching independently of the provider default', () => {
    const value = JSON.stringify({ operations: ['image.generate'] });
    const html = renderToStaticMarkup(createElement(ModelPolicyEditor, { value, modelId: 'gemini-3.1-flash-image', providerType: 'openai', onChange: () => {} }));
    expect(html).toContain('自动匹配（Gemini · Generate Content）');
    expect(html).toContain('OpenAI · Responses Image Tool');
    expect(renderToStaticMarkup(createElement(ModelPolicyEditor, { value, modelId: 'unknown', providerType: 'xai', onChange: () => {} }))).toContain('提供商默认（xAI）');
  });
  it('keeps xAI native fields out of extra and excludes catalog-only metadata', () => {
    const rules = parameterPresets({ operations: ['video.generate'], supportsAudio: true, customFields: { properties: { audio: { type: 'boolean' }, referenceMaxResolution: { const: '720p' }, quality: { type: 'string', enum: ['low', 'medium'] } } } }, 'xai');
    expect(rules.map(rule => rule.path)).toEqual(['audio', 'quality']);
    expect(rules.every(rule => rule.defaultValue === undefined)).toBe(true);
    expect(parameterPresets({ operations: ['image.generate'], customFields: { properties: { quality: { type: 'string', enum: ['low', 'high'] } } } }, 'openai')[0]?.path).toBe('extra.quality');
  });
  it('retains the JSON editor for incomplete or malformed advanced configuration', () => {
    for (const value of ['null', '{', '{"parameters":[null]}', '{"parameters":[{"path":"quality","label":"Quality","options":1}]}']) {
      expect(renderToStaticMarkup(createElement(ModelPolicyEditor, { value, providerType: 'xai', onChange: () => {} }))).toContain('aria-label="模型能力 JSON"');
    }
  });
});
