import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { GenerationRequest } from '@imagine/shared';
import type { ProviderInput } from '@imagine/provider-contract';

import {
  digestAdapterSource,
  parseBoundedManifestJson,
  validateAdapterExports,
  validateAdapterSource,
} from '../../adapters/index.js';
import { compileDeclarativeRequest } from './compiler.js';
import { parseDeclarativeJson, parseDeclarativeYaml } from './parser.js';

const EXAMPLES = new URL('../../../../../examples/custom-providers/', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, EXAMPLES), 'utf8');
}

describe('PR 6 custom Provider examples', () => {
  it('parses the safe synchronous, asynchronous, and multipart declarations', () => {
    const sync = parseDeclarativeJson(read('sync-image.json'));
    expect(sync.submit.body?.type).toBe('json');
    expect(sync.submit.extract.resultBase64Path).toBe('/data/0/b64_json');
    expect(sync.models[0]?.capabilities.operations).toEqual(['image.generate']);
    expect(sync.models[0]?.requestSchema?.additionalProperties).toBe(false);
    expect(sync.models[0]?.requestSchema?.required).toEqual(['style']);

    const syncRequest: GenerationRequest = {
      operation: 'image.generate',
      providerId: 'example-provider',
      modelId: 'image-model',
      prompt: 'A lighthouse at dawn',
      inputs: [],
      extra: { style: 'editorial' },
    };
    const providerContext = { providerId: 'example-provider', secrets: { apiKey: 'unit-test-placeholder' } };
    const compiledSync = compileDeclarativeRequest(sync, syncRequest, providerContext);
    expect(compiledSync.body).toMatchObject({
      type: 'json',
      value: { model: 'image-model', prompt: 'A lighthouse at dawn', style: 'editorial' },
    });
    expect(() => compileDeclarativeRequest(sync, { ...syncRequest, extra: {} }, providerContext)).toThrow(/style/);

    const asyncVideo = parseDeclarativeYaml(read('async-video.yaml'));
    expect(asyncVideo.submit.body?.type).toBe('form');
    expect(asyncVideo.submit.extract.remoteIdPath).toBe('/id');
    expect(asyncVideo.poll?.path).toBe('/v1/videos/{{ remoteJobId }}');
    expect(asyncVideo.poll?.extract.statusPath).toBe('/status');
    expect(asyncVideo.poll?.extract.resultUrlPath).toBe('/video/url');
    expect(asyncVideo.poll?.extract.successValues).toEqual(['completed']);
    expect(asyncVideo.models[0]?.capabilities.supportsProgress).toBe(true);
    const asyncRequest: GenerationRequest = {
      operation: 'video.generate',
      providerId: 'example-provider',
      modelId: 'video-model',
      prompt: 'A paper plane over a lake',
      inputs: [],
    };
    const compiledAsyncSubmit = compileDeclarativeRequest(asyncVideo, asyncRequest, providerContext);
    expect(compiledAsyncSubmit.body).toMatchObject({
      type: 'form',
      fields: { model: 'video-model', prompt: 'A paper plane over a lake' },
    });
    const compiledAsyncPoll = compileDeclarativeRequest(
      asyncVideo,
      asyncRequest,
      { ...providerContext, remoteJobId: 'job-placeholder' },
      asyncVideo.poll!,
    );
    expect(compiledAsyncPoll.relativePath).toBe('/v1/videos/job-placeholder');

    const multipart = parseDeclarativeJson(read('multipart-image-edit.json'));
    expect(multipart.submit.body?.type).toBe('multipart');
    expect(multipart.submit.body?.type === 'multipart' ? multipart.submit.body.files : undefined).toHaveLength(2);
    expect(multipart.submit.extract.resultUrlPath).toBe('/data/0/url');
    expect(multipart.models[0]?.capabilities.supportsMask).toBe(true);
    const source: ProviderInput = {
      assetId: 'source-placeholder',
      role: 'source',
      filename: 'source.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
      fileSize: 3,
      parentAssetId: null,
      sha256: '0'.repeat(64),
    };
    const mask: ProviderInput = {
      assetId: 'mask-placeholder',
      role: 'mask',
      filename: 'mask.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([4, 5, 6]),
      width: 1,
      height: 1,
      fileSize: 3,
      parentAssetId: source.assetId,
      sha256: '1'.repeat(64),
    };
    const multipartRequest: GenerationRequest = {
      operation: 'image.edit',
      providerId: 'example-provider',
      modelId: 'edit-model',
      prompt: 'Remove the background',
      inputs: [
        { assetId: source.assetId, role: 'source' },
        { assetId: mask.assetId, role: 'mask' },
      ],
    };
    const compiledMultipart = compileDeclarativeRequest(multipart, multipartRequest, {
      ...providerContext,
      inputs: [source, mask],
    });
    expect(compiledMultipart.body).toMatchObject({ type: 'multipart' });
    expect(compiledMultipart.body.type === 'multipart' ? compiledMultipart.body.files.map((file) => file.field) : []).toEqual(['image', 'mask']);
  });

  it('accepts the Trusted JavaScript manifest/source pair under the source policy', () => {
    const source = new TextEncoder().encode(read('trusted-js/adapter.mjs'));
    const manifest = parseBoundedManifestJson(new TextEncoder().encode(read('trusted-js/manifest.json')));
    expect(digestAdapterSource(source)).toBe(manifest.sha256);
    expect(manifest.requiredSecrets).toEqual(['apiKey']);
    expect(manifest.allowedHosts).toEqual(['api.provider.invalid']);
    const sourceText = validateAdapterSource(source);
    expect(() => validateAdapterExports(sourceText, manifest)).not.toThrow();
    expect(sourceText).not.toMatch(/\b(?:import|require|fetch)\s*\(/u);
  });
});
