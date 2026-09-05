import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectAllowedMedia } from '../media/mime.js';
import { normalizeImageResponse, buildImageGenerationPayload, assertImageGenerationPayload, imageRequestOptions } from './openai/protocol.js';
import { parseXaiImagineImageResponse } from './xai/xai-imagine-image.js';

describe('unlabelled image results', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('detects actual %s bytes instead of assuming PNG', async format => {
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#257944' } }).toFormat(format).toBuffer();
    for (const parse of [normalizeImageResponse, parseXaiImagineImageResponse]) {
      const [asset] = parse({ data: [{ b64_json: bytes.toString('base64') }] });
      expect(asset?.mimeType).toBe('application/octet-stream');
      await expect(detectAllowedMedia(bytes, { claimedMimeType: asset!.mimeType, expectedKind: 'image' })).resolves.toMatchObject({ mimeType: `image/${format}` });
      const [claimed] = parse({ data: [{ b64_json: bytes.toString('base64'), mime_type: 'image/png' }] });
      if (format !== 'png') await expect(detectAllowedMedia(bytes, { claimedMimeType: claimed!.mimeType, expectedKind: 'image' })).rejects.toThrow('does not match');
    }
  });
  it('leaves extensionless image URLs untyped until download inspection', () => {
    for (const parse of [normalizeImageResponse, parseXaiImagineImageResponse]) expect(parse({ data: [{ url: 'https://example.com/media/opaque-id' }] })[0]?.mimeType).toBe('application/octet-stream');
  });
  it('passes custom compatible dimensions and explicit output format to the upstream request', () => {
    const input = { operation: 'image.generate' as const, providerId: 'compatible', modelId: 'grok-imagine-image-2.0', prompt: 'test', inputs: [], resolution: '1920x1080', extra: { quality: 'high', output_format: 'jpeg' } };
    const options = imageRequestOptions(input, undefined, { compatibleSize: true });
    const payload = buildImageGenerationPayload(options);
    expect(payload).toMatchObject({ size: '1920x1080', output_format: 'jpeg', quality: 'high' });
    expect(() => assertImageGenerationPayload(payload, { compatibleSize: true })).not.toThrow();
    expect(() => imageRequestOptions({ ...input, resolution: '99999x99999' }, undefined, { compatibleSize: true })).toThrow();
    expect(imageRequestOptions({ ...input, resolution: undefined, aspectRatio: '16:9', extra: {} }, undefined, { compatibleSize: true }).size).toBe('1024x576');
  });
});
