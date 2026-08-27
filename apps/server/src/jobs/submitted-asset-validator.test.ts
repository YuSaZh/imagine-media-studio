import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  assertSubmittedManifestSize,
  assertDurableResultManifest,
  MAX_SUBMITTED_MANIFEST_BYTES,
  validateSubmittedAssets,
  SubmittedAssetValidationError,
} from './submitted-asset-validator.js';

function imageAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'image',
    mimeType: 'image/png',
    source: 'base64',
    base64: 'aW1hZ2U=',
    resultId: 'result-1',
    ...overrides,
  };
}

describe('submitted asset validator', () => {
  it('accepts bounded image and provider-owned video manifests', () => {
    const inlineVideo = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
    const assets = validateSubmittedAssets([
      imageAsset(),
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: 'provider',
        providerId: 'openai-videos-v1-compatible',
        remoteJobId: 'video-remote-1',
        variant: 'video',
        resultId: 'video-result-1',
      },
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: 'base64',
        base64: inlineVideo,
      },
      {
        type: 'video',
        mimeType: 'video/mp4',
        source: 'base64',
        base64: inlineVideo,
      },
    ], { maxAssets: 4 });
    expect(assets).toHaveLength(4);
  });

  it('rejects empty, over-count, non-canonical Base64, and unsupported fields', () => {
    expect(() => validateSubmittedAssets([])).toThrow(SubmittedAssetValidationError);
    expect(() => validateSubmittedAssets([imageAsset(), imageAsset()], { maxAssets: 1 }))
      .toThrow('too many assets');
    expect(() => validateSubmittedAssets([imageAsset({ base64: 'aW1hZ2U' })]))
      .toThrow('canonical Base64');
    expect(() => validateSubmittedAssets([imageAsset({ extra: 'must-not-persist' })]))
      .toThrow('unsupported fields');
    expect(() => assertDurableResultManifest([imageAsset(), 'corrupt-primitive']))
      .toThrow('unsupported values');
    expect(() => assertDurableResultManifest([{
      version: 1,
      resultAssets: [imageAsset(), 'corrupt-primitive'],
    }])).toThrow('must be a JSON object');
    expect(() => assertDurableResultManifest([{ slot: 0, assetId: 'asset-1', extra: 'reject' }]))
      .toThrow('invalid or exceeds');
  });

  it('rejects credential-bearing URL forms and provider variants', () => {
    expect(() => validateSubmittedAssets([{
      type: 'image',
      mimeType: 'image/png',
      source: 'url',
      url: 'https://user:secret@example.invalid/image.png',
    }])).toThrow('credentials');
    expect(() => validateSubmittedAssets([{
      type: 'image',
      mimeType: 'image/png',
      source: 'url',
      url: 'https://provider.invalid/image.png?token=secret',
    }])).toThrow('URL');
    expect(() => validateSubmittedAssets([{
      type: 'video',
      mimeType: 'video/mp4',
      source: 'provider',
      providerId: 'video-provider',
      remoteJobId: 'remote-1',
      variant: 'thumbnail',
    }])).toThrow('variant');
    for (const name of ['api.key', 'access.token', 'x.amz.signature', 'x_ms_token', 'oauth-token']) {
      expect(() => validateSubmittedAssets([{
        type: 'image',
        mimeType: 'image/png',
        source: 'url',
        url: `https://provider.invalid/image.png?${name}=secret`,
      }])).toThrow('URL');
    }
    for (const name of ['tokenizer', 'authenticity', 'keynote']) {
      expect(() => validateSubmittedAssets([{
        type: 'image',
        mimeType: 'image/png',
        source: 'url',
        url: `https://provider.invalid/image.png?${name}=value`,
      }])).not.toThrow();
    }
  });

  it('bounds metadata shape and rejects sensitive keys or values', () => {
    expect(() => validateSubmittedAssets([imageAsset({ metadata: {
      a: { b: { c: { d: { e: true } } } },
    } })])).toThrow('too deep');
    expect(() => validateSubmittedAssets([imageAsset({ metadata: {
      authorization: 'Bearer secret',
    } })])).toThrow('sensitive key');
    expect(() => validateSubmittedAssets([imageAsset({ metadata: {
      note: 'token=secret',
    } })])).toThrow('unsafe text');
    expect(() => validateSubmittedAssets([imageAsset({ metadata: {
      items: Array.from({ length: 33 }, () => true),
    } })])).toThrow('array items');
  });

  it('enforces the durable manifest JSON byte ceiling', () => {
    const oversized = { value: 'x'.repeat(MAX_SUBMITTED_MANIFEST_BYTES) };
    expect(() => assertSubmittedManifestSize(oversized)).toThrow('manifest exceeds');
  });
});
