import { describe, expect, it } from 'vitest';
import type { ModelDto, ProviderDto } from '@imagine/shared';
import { allPages, generationRequest, mapModels, mediaExtension, operationFor, type Creation } from './data';

const provider = (id: string) => ({ id, enabled: true, name: id, isDefault: false }) as ProviderDto;
const model = (id: string, providerId: string): ModelDto => ({ id, providerId, modelId: 'same-model', displayName: id, enabled: true, capabilitySource: 'manual', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z', capabilities: { operations: ['image.generate'], aspectRatios: ['1:1', '3:2'], maxBatchCount: 4, supportsBatchCount: true } });

describe('workspace API contracts', () => {
  it('selects identical model IDs from different providers without confusing their identities', () => {
    const models = mapModels([model('a', 'first'), model('b', 'second')], [provider('first'), provider('second')]);
    expect(models.map(item => item.key)).toEqual(['a', 'b']);
    const input: Creation = { model: models[1]!, prompt: ' test ', operation: 'image.generate', inputs: [], ratio: '1:1', resolution: '', count: 1, duration: 5, negativePrompt: '', seed: '', audio: false };
    expect(generationRequest(input)).toMatchObject({ providerId: 'second', modelId: 'same-model', prompt: 'test' });
    expect(() => generationRequest({ ...input, ratio: '16:9' })).toThrow();
    expect(() => generationRequest({ ...input, count: 5 })).toThrow();
    expect(() => generationRequest({ ...input, operation: 'video.generate' })).toThrow();
  });
  it('excludes disabled providers and models', () => {
    expect(mapModels([model('a', 'first'), { ...model('b', 'second'), enabled: false }], [{ ...provider('first'), enabled: false }, provider('second')])).toEqual([]);
  });
  it('uses the original MIME type for downloads', () => {
    expect(mediaExtension({ mimeType: 'image/jpeg', kind: 'image' })).toBe('jpg');
    expect(mediaExtension({ mimeType: 'video/webm', kind: 'video' })).toBe('webm');
  });
  it('derives edit and image-to-video operations from input roles', () => {
    expect(operationFor('image', 'text', [{ role: 'source', asset: {} as never }])).toBe('image.edit');
    expect(operationFor('video', 'first_frame', [])).toBe('video.image_to_video');
  });
  it('traverses catalogs and rejects a repeated cursor', async () => {
    await expect(allPages(async cursor => ({ items: [cursor ?? 'first'], nextCursor: cursor ? null : 'second' }))).resolves.toEqual(['first', 'second']);
    await expect(allPages(async () => ({ items: [], nextCursor: 'same' }))).rejects.toThrow('分页游标重复');
  });
});
