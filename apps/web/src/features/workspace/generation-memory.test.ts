import { describe, expect, it } from 'vitest';
import { SettingsPatchSchema } from '@imagine/shared';
import { readGenerationMemory, updateGenerationMemory } from './generation-memory';

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
