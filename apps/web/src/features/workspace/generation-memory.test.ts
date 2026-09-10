import { describe, expect, it } from 'vitest';
import { SettingsPatchSchema, type JsonObject } from '@imagine/shared';
import { generationMemoryKey, generationMemoryScope, readGenerationMemory, updateGenerationMemory } from './generation-memory';

describe('generation memory scopes', () => {
  it('keeps legacy keys and separates project, source, mode and model settings', () => {
    const project = '11111111-1111-4111-8111-111111111111';
    const asset = '22222222-2222-4222-8222-222222222222';
    const scope = generationMemoryScope(project, asset);
    expect(generationMemoryKey(scope)).toBe(`generation.edit.${project}.${asset}`);
    expect(generationMemoryKey(null)).toBe('generation.default');
    const contexts = [generationMemoryScope(project), scope, generationMemoryScope(null, asset), generationMemoryScope(project, 'another-source')];
    let settings: JsonObject = {};
    for (const [index, context] of contexts.entries()) {
      for (const mode of ['image', 'video'] as const) {
        const update = updateGenerationMemory(settings, context, mode, { selected: `${mode}-${index}`, models: { first: { ratio: '1:1' }, second: { ratio: '3:4' } } });
        expect(SettingsPatchSchema.safeParse({ values: update }).success).toBe(true);
        settings = { ...settings, ...update };
      }
    }
    const restored = JSON.parse(JSON.stringify(settings)) as JsonObject;
    for (const [index, context] of contexts.entries()) for (const mode of ['image', 'video'] as const) {
      expect(readGenerationMemory(restored, context, mode)).toEqual({ selected: `${mode}-${index}`, models: { first: { ratio: '1:1' }, second: { ratio: '3:4' } } });
    }
  });
});

describe('generation memory', () => {
  it('keeps project and mode values separate using valid bounded setting keys', () => {
    const project = '12345678-1234-1234-1234-123456789abc';
    let settings = updateGenerationMemory({}, project, 'image', { selected: 'image-a', models: { 'image-a': { count: 3 } } });
    settings = { ...settings, ...updateGenerationMemory(settings, project, 'video', { selected: 'video-a' }) };
    settings = { ...settings, ...updateGenerationMemory(settings, null, 'image', { selected: 'image-b' }) };
    expect(SettingsPatchSchema.safeParse({ values: settings }).success).toBe(true);
    expect(readGenerationMemory(settings, project, 'image')).toEqual({ selected: 'image-a', models: { 'image-a': { count: 3 } } });
    expect(readGenerationMemory(settings, project, 'video')).toEqual({ selected: 'video-a' });
    expect(readGenerationMemory(settings, null, 'image')).toEqual({ selected: 'image-b' });
    expect(readGenerationMemory(settings, 'other', 'image')).toEqual({});
  });
});
