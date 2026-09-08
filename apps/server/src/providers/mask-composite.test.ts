import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../database/client.js';
import { ProviderRepository } from '../database/providers.js';
import { JobRepository } from '../database/jobs.js';
import { AssetRepository } from '../database/assets.js';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MASK_OVERLAY_COLOR, MASK_OVERLAY_INSTRUCTION, providerGenerationRequest, type GenerationRequest } from '@imagine/shared';
import type { ProviderInput } from '@imagine/provider-contract';
import { prepareMaskedInputs } from './mask-composite.js';
import { OpenAiImagesProvider } from './openai/provider.js';
import type { OpenAiHttpRequest } from './openai/types.js';

async function fixture() {
  const bytes = await sharp({ create: { width: 3, height: 1, channels: 4, background: { r: 100, g: 100, b: 100, alpha: 1 } } }).png().toBuffer();
  const mask = await sharp(Buffer.from([0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 255]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const inputs: ProviderInput[] = [{ assetId: 'source', role: 'source', width: 3, height: 1, bytes, mimeType: 'image/png', publicUrl: 'https://fixture.example/original' }, { assetId: 'mask', parentAssetId: 'source', role: 'mask', width: 3, height: 1, bytes: mask, mimeType: 'image/png' }];
  const request: GenerationRequest = { providerId: 'fixture', modelId: 'custom-image', operation: 'image.edit', prompt: 'Replace the marked object', inputs: inputs.map(({ assetId, role }) => ({ assetId, role })), maskProcessing: { version: 1, mode: 'overlay', sourceAssetId: 'source', outputMimeType: 'image/png' } };
  return { request, inputs };
}

describe('server-owned mask preparation', () => {
  it('composites edited and partially edited pixels and preserves unmarked pixels and source bytes', async () => {
    const { request, inputs } = await fixture(); const original = Buffer.from(inputs[0]!.bytes);
    const prepared = await prepareMaskedInputs(request, inputs, 10000, 20000);
    expect(prepared).toHaveLength(1); expect(prepared[0]).not.toHaveProperty('publicUrl');
    expect(inputs[0]!.bytes).toEqual(original);
    const raw = await sharp(prepared[0]!.bytes).ensureAlpha().raw().toBuffer();
    expect([...raw.slice(8, 12)]).toEqual([100, 100, 100, 255]);
    const color = MASK_OVERLAY_COLOR;
    for (const [pixel, alpha] of [[0, color.alpha / 255], [1, Math.round(127 * color.alpha / 255) / 255]]) {
      for (const [channel, target] of [color.red, color.green, color.blue].entries()) expect(Math.abs(raw[pixel! * 4 + channel]! - (100 * (1 - alpha!) + target * alpha!))).toBeLessThanOrEqual(1);
    }
    const wire = providerGenerationRequest(request);
    expect(wire.inputs).toEqual([{ assetId: 'source', role: 'source' }]);
    expect(wire.prompt).toBe(`${request.prompt}\n\n${MASK_OVERLAY_INSTRUCTION}`);
    expect(wire).not.toHaveProperty('maskProcessing'); expect(request.prompt).toBe('Replace the marked object');
  });
  it('preserves native and historical inputs without conflating mask capability', async () => {
    const { request, inputs } = await fixture();
    request.maskProcessing!.mode = 'native';
    expect(await prepareMaskedInputs(request, inputs, 10000, 20000)).toBe(inputs);
    expect(providerGenerationRequest(request).inputs).toHaveLength(2);
    expect(providerGenerationRequest(request).prompt).toBe(request.prompt);
    delete request.maskProcessing;
    expect(await prepareMaskedInputs(request, inputs, 10000, 20000)).toBe(inputs);
  });
  it('rejects changed dimensions, unrelated masks, empty masks, output limits and cancellation', async () => {
    const { request, inputs } = await fixture();
    await expect(prepareMaskedInputs(request, [{ ...inputs[0]!, width: 4 }, inputs[1]!], 10000, 20000)).rejects.toThrow('尺寸');
    await expect(prepareMaskedInputs(request, [inputs[0]!, { ...inputs[1]!, parentAssetId: 'someone-else' }], 10000, 20000)).rejects.toThrow('关联');
    await expect(prepareMaskedInputs(request, [inputs[0]!, { ...inputs[1]!, bytes: inputs[0]!.bytes }], 10000, 20000)).rejects.toThrow('没有可编辑区域');
    await expect(prepareMaskedInputs({ ...request, maskProcessing: { ...request.maskProcessing!, maxOutputBytes: 1 } }, inputs, 10000, 20000)).rejects.toThrow('大小限制');
    await expect(prepareMaskedInputs(request, inputs, 10000, 20000, AbortSignal.abort())).rejects.toThrow();
  });
  it('retains the processing mode and clean prompt through retry and SQLite reopen', async () => {
    const { request, inputs } = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'imagine-mask-recovery-'));
    const path = join(directory, 'app.db'), migrations = fileURLToPath(new URL('../../migrations', import.meta.url));
    let database = createDatabase(path, migrations);
    try {
      const provider = new ProviderRepository(database.orm).create({ name: 'Fixture', type: 'openai' });
      const assets = new AssetRepository(database.orm);
      const source = assets.create({ type: 'image', role: 'upload', mimeType: 'image/png', filePath: 'source.png', width: 3, height: 1, fileSize: inputs[0]!.bytes.length, sha256: 'fixture-source' });
      const mask = assets.create({ type: 'image', role: 'mask', parentAssetId: source.id, mimeType: 'image/png', filePath: 'mask.png', width: 3, height: 1, fileSize: inputs[1]!.bytes.length, sha256: 'fixture-mask' });
      const jobs = new JobRepository(database.orm);
      const job = jobs.create({ ...request, providerId: provider.id, inputs: [{ assetId: source.id, role: 'source' }, { assetId: mask.id, role: 'mask' }], maskProcessing: { ...request.maskProcessing!, sourceAssetId: source.id } });
      const claimed = jobs.claimQueued(job.id, job.revision)!; jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed');
      const retry = jobs.retry(job.id)!; database.sqlite.close(); database = createDatabase(path, migrations);
      const restored = new JobRepository(database.orm).get(retry.id)!;
      expect(restored.request.prompt).toBe(request.prompt); expect(restored.request.maskProcessing).toMatchObject({ mode: 'overlay', version: 1, sourceAssetId: source.id });
      const prepared = await prepareMaskedInputs(restored.request, [{ ...inputs[0]!, assetId: source.id }, { ...inputs[1]!, assetId: mask.id, parentAssetId: source.id }], 10000, 20000);
      expect(prepared).toHaveLength(1); expect(prepared[0]).not.toHaveProperty('publicUrl');
    } finally { database.sqlite.close(); rmSync(directory, { force: true, recursive: true }); }
  });
  it.each(['native', 'overlay'] as const)('sends the correct multipart input through the injected Images adapter (%s)', async mode => {
    const { request, inputs } = await fixture(); request.maskProcessing!.mode = mode;
    const calls: OpenAiHttpRequest[] = [];
    const prepared = await prepareMaskedInputs(request, inputs, 10000, 20000);
    const adapter = new OpenAiImagesProvider({ baseUrl: 'https://fixture.example/v1', http: async call => { calls.push(call); return { status: 200, json: { data: [{ b64_json: Buffer.from(inputs[0]!.bytes).toString('base64') }] } }; } });
    await adapter.submit(providerGenerationRequest(request), { providerId: request.providerId, modelId: request.modelId, secrets: { apiKey: 'fixture-only' }, inputs: prepared });
    const body = Buffer.from(calls[0]!.bodyBytes!).toString();
    expect(body.includes('name="mask"')).toBe(mode === 'native');
    expect(body.includes(MASK_OVERLAY_INSTRUCTION)).toBe(mode === 'overlay');
    expect(calls[0]!.url).toBe('https://fixture.example/v1/images/edits');
  });
});
