import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../database/client.js';
import { JobRepository } from '../database/jobs.js';
import { ProviderRepository } from '../database/providers.js';
import { ModelRepository } from '../database/models.js';
import { describe, expect, it } from 'vitest';
import { COMPATIBLE_MODEL_IDENTITIES, imageDimensionsAllowed, matchModelProtocol, modelDisplayName, type GenerationRequest } from '@imagine/shared';
import type { ProviderContext } from '@imagine/provider-contract';
import { compatibleModelCapabilities } from './compatible-model-catalog.js';
import { canonicalLibraryModel } from './model-library.js';
import { OpenAiVideosProvider } from './openai/videos.js';
import { OpenAiImagesProvider } from './openai/provider.js';
import type { OpenAiHttpRequest } from './openai/types.js';

const profile = 'openai-videos-v1-compatible';
const context: ProviderContext = { providerId: 'fixture', secrets: { apiKey: 'fixture-only' } };
const request = (modelId: string, overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({ providerId: 'fixture', modelId, operation: 'video.generate', prompt: 'A calm sea', inputs: [], resolution: '720p', aspectRatio: '16:9', durationSeconds: 7, ...overrides });

describe('reviewed compatibility models', () => {
  it.each(COMPATIBLE_MODEL_IDENTITIES)('$id resolves every reviewed alias to the same name protocol and capabilities', model => {
    const protocol = model.kind === 'image' ? 'openai-images-v1' : profile;
    const capabilities = compatibleModelCapabilities(model.id, protocol)!;
    for (const id of [model.id, ...model.aliases]) {
      expect(canonicalLibraryModel(id)).toBe(model.id);
      expect(modelDisplayName(id)).toBe(model.name);
      expect(matchModelProtocol(id)).toBe(protocol);
      expect(compatibleModelCapabilities(id, protocol)).toEqual(capabilities);
      expect(compatibleModelCapabilities(id, model.kind === 'image' ? profile : 'openai-images-v1')).toBeUndefined();
    }
    expect(capabilities.supportsMask).toBe(false);
    if (model.kind === 'video') expect(capabilities.operations.every(operation => ['video.generate', 'video.image_to_video'].includes(operation))).toBe(true);
  });
  it('does not infer capabilities from future versions or vendor prefixes', () => {
    for (const id of ['MAI-Image-99', 'mai-image-2-future', 'seedream-99', 'doubao-seedance-9-0-pro-999999']) {
      expect(compatibleModelCapabilities(id, 'openai-images-v1')).toBeUndefined();
      expect(compatibleModelCapabilities(id, profile)).toBeUndefined();
      expect(modelDisplayName(id)).toBe(id);
    }
  });
  it('distinguishes text-only MAI models and the image limits of Seedream variants', () => {
    expect(compatibleModelCapabilities('MAI-Image-2', 'openai-images-v1')).toMatchObject({ operations: ['image.generate'], maxReferenceImages: 0 });
    const mai = compatibleModelCapabilities('MAI-Image-2.5', 'openai-images-v1')!;
    expect(mai).toMatchObject({ operations: ['image.generate', 'image.edit'], maxReferenceImages: 1 });
    expect(imageDimensionsAllowed('1024x1024', mai.imageResolution!.dimensions)).toBe(true);
    expect(imageDimensionsAllowed('2048x2048', mai.imageResolution!.dimensions)).toBe(false);
    const seed = compatibleModelCapabilities('seedream-4-5-251128', 'openai-images-v1')!;
    expect(seed.maxReferenceImages).toBe(14);
    expect(imageDimensionsAllowed('1024x1024', seed.imageResolution!.dimensions)).toBe(false);
    expect(imageDimensionsAllowed('3840x3840', seed.imageResolution!.dimensions)).toBe(true);
    expect(compatibleModelCapabilities('dola-seedream-5-0-pro-260628', 'openai-images-v1')!.maxReferenceImages).toBe(10);
  });
  it('preserves image wire IDs and enforces dimensions, single-source editing and reference limits', async () => {
    const calls: OpenAiHttpRequest[] = [];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const adapter = new OpenAiImagesProvider({ baseUrl: 'https://fixture.example/v1', http: async call => { calls.push(call); return { status: 200, json: { data: [{ b64_json: png }] } }; } });
    const req: GenerationRequest = { providerId: 'fixture', modelId: 'mai-image-2.5', operation: 'image.generate', prompt: 'A calm sea', inputs: [], resolution: '1024x1024' };
    await adapter.submit(req, context);
    expect(calls[0]?.url).toBe('https://fixture.example/v1/images/generations');
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ model: 'mai-image-2.5', size: '1024x1024' });
    await expect(adapter.validate({ ...req, resolution: '512x1024' }, context)).rejects.toThrow();
    await expect(adapter.validate({ ...req, resolution: '2048x2048' }, context)).rejects.toThrow();
    await expect(adapter.validate({ ...req, modelId: 'seedream-4-5-251128' }, context)).rejects.toThrow();
    await expect(adapter.validate({ ...req, modelId: 'seedream-4-5-251128', resolution: '2048x2048' }, context)).resolves.toBeUndefined();
    const edit: GenerationRequest = { ...req, operation: 'image.edit', inputs: [{ assetId: 'source', role: 'source' }] };
    const runtime: ProviderContext = { ...context, inputs: [{ assetId: 'source', role: 'source', mimeType: 'image/png', width: 1024, height: 1024, bytes: Buffer.from(png, 'base64') }] };
    await adapter.submit(edit, runtime);
    expect(calls[1]?.url).toBe('https://fixture.example/v1/images/edits');
    await expect(adapter.validate({ ...edit, inputs: [...edit.inputs, { assetId: 'second', role: 'reference' }] }, runtime)).rejects.toThrow();
    await expect(adapter.validate({ ...edit, modelId: 'MAI-Image-2' }, runtime)).rejects.toThrow();
  });
  it('submits a Seedance alias through the compatible endpoint without rewriting the remote model ID', async () => {
    const calls: OpenAiHttpRequest[] = [];
    const modelId = 'doubao-seedance-2-0-260128';
    const provider = new OpenAiVideosProvider({ baseUrl: 'https://fixture.example/v1', http: async call => { calls.push(call); return { status: 200, json: { id: 'video_fixture', status: 'queued', model: modelId, seconds: '7', size: '1920x1080' } }; } });
    await expect(provider.submit(request(modelId, { resolution: '1080p' }), context)).resolves.toMatchObject({ state: 'pending' });
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ model: modelId, seconds: '7', size: '1920x1080' });
    expect(calls[0]?.url).toBe('https://fixture.example/v1/videos');
    await expect(provider.validate(request(modelId, { durationSeconds: 16 }), context)).rejects.toThrow();
    await expect(provider.validate(request(modelId, { width: 1000 }), context)).rejects.toThrow();
    await expect(provider.validate(request('dreamina-seedance-2-0-fast-260128', { resolution: '1080p' }), context)).rejects.toThrow();
  });
  it('uses a persisted custom policy for submission and recovery polling, refusing invalid upstream metadata', async () => {
    const modelId = 'unknown-custom-video';
    const runtime: ProviderContext = { ...context, modelId, operationPolicy: { durations: { min: 5, max: 9, step: 2 }, resolutions: ['1080p'], aspectRatios: ['1:1'], inputRoles: ['first_frame'] } };
    const calls: OpenAiHttpRequest[] = [];
    let seconds = '7';
    const options = { models: [modelId], baseUrl: 'https://fixture.example/v1', http: async (call: OpenAiHttpRequest) => { calls.push(call); return { status: 200, json: { id: 'video_fixture', status: 'queued', model: modelId, seconds, size: '1080x1080' } }; } };
    const req = request(modelId, { resolution: '1080p', aspectRatio: '1:1' });
    await new OpenAiVideosProvider(options).submit(req, runtime);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ seconds: '7', size: '1080x1080' });
    await expect(new OpenAiVideosProvider(options).poll('video_fixture', runtime)).resolves.toMatchObject({ state: 'remote_pending' });
    seconds = '8';
    await expect(new OpenAiVideosProvider(options).poll('video_fixture', runtime)).rejects.toThrow('duration unsupported');
    await expect(new OpenAiVideosProvider(options).validate({ ...req, durationSeconds: 6 }, runtime)).rejects.toThrow();
    await expect(new OpenAiVideosProvider(options).validate(req, context)).rejects.toThrow();
  });
  it('retains the video policy through model edits, retry and SQLite reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'imagine-video-policy-'));
    const path = join(directory, 'app.db'), migrations = fileURLToPath(new URL('../../migrations', import.meta.url));
    let database = createDatabase(path, migrations);
    try {
      const provider = new ProviderRepository(database.orm).create({ name: 'Fixture', type: 'openai' });
      const models = new ModelRepository(database.orm);
      const policy = { durations: [7], resolutions: ['1080p'], aspectRatios: ['1:1'] };
      const modelId = 'custom-durable-video';
      models.saveManual({ providerId: provider.id, modelId, displayName: modelId, capabilities: { profile, operations: ['video.generate'], ...policy }, enabled: true });
      const jobs = new JobRepository(database.orm);
      const job = jobs.create({ ...request(modelId, { resolution: '1080p', aspectRatio: '1:1' }), providerId: provider.id, profile, operationPolicy: policy });
      const claimed = jobs.claimQueued(job.id, job.revision)!;
      jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed');
      const retry = jobs.retry(job.id)!;
      models.saveManual({ providerId: provider.id, modelId, displayName: 'Edited', capabilities: { profile, operations: ['video.generate'], durations: [4], resolutions: ['720x1280'] }, enabled: true });
      database.sqlite.close(); database = createDatabase(path, migrations);
      const restored = new JobRepository(database.orm).get(retry.id)!;
      expect(restored.request.operationPolicy).toEqual(policy);
      const adapter = new OpenAiVideosProvider({ models: [modelId], baseUrl: 'https://fixture.example/v1', http: async () => ({ status: 200, json: { id: 'video_restored', status: 'completed', model: modelId, seconds: '7', size: '1080x1080' } }) });
      await expect(adapter.poll('video_restored', { ...context, providerId: provider.id, modelId, operationPolicy: restored.request.operationPolicy! })).resolves.toMatchObject({ state: 'completed' });
    } finally { database.sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('sends one first-frame input without imposing Sora exact input dimensions', async () => {
    const modelId = 'dreamina-seedance-2-0-260128';
    const calls: OpenAiHttpRequest[] = [];
    const provider = new OpenAiVideosProvider({ baseUrl: 'https://fixture.example/v1', http: async call => { calls.push(call); return { status: 200, json: { id: 'video_frame', status: 'queued' } }; } });
    const runtime: ProviderContext = { ...context, inputs: [{ assetId: 'frame', role: 'first_frame', mimeType: 'image/png', width: 1024, height: 768, bytes: new Uint8Array([1, 2, 3]) }] };
    const req = request(modelId, { operation: 'video.image_to_video', inputs: [{ assetId: 'frame', role: 'first_frame' }] });
    await provider.submit(req, runtime);
    expect(Buffer.from(calls[0]!.bodyBytes!).toString()).toContain('name="input_reference"');
    await expect(provider.validate({ ...req, inputs: [...req.inputs, ...req.inputs] }, runtime)).rejects.toThrow();
    await expect(provider.validate(request('doubao-seedance-1-0-lite-t2v-250428', { operation: 'video.image_to_video', inputs: req.inputs }), runtime)).rejects.toThrow();
  });
});
