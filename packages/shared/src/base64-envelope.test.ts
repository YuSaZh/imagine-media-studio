import { describe, expect, it } from 'vitest';

import {
  Base64EnvelopeError,
  estimateBase64DecodedBytes,
  parseBase64Envelope,
} from './base64-envelope.js';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('strict Base64 envelopes', () => {
  it('parses a MIME-allowed canonical data URL without decoding it', () => {
    expect(parseBase64Envelope('data:IMAGE/PNG;base64,AQID', {
      allowedMimeTypes: ['image/png'],
      maxDecodedBytes: 3,
    })).toEqual({ mimeType: 'image/png', payload: 'AQID', decodedBytes: 3 });
  });

  it('rejects loose grammar, whitespace, URL-safe alphabet, and noncanonical padding', () => {
    for (const value of [
      'AQID',
      'data:image/png;charset=utf-8;base64,AQID',
      'data:image/png;base64,AQI D',
      'data:image/png;base64,AQI_',
      'data:image/png;base64,AQ',
      'data:image/png;base64,AR==',
    ]) {
      expect(() => parseBase64Envelope(value, { maxDecodedBytes: 10 })).toThrow(
        Base64EnvelopeError,
      );
    }
  });

  it('enforces MIME and decoded-size limits before a caller allocates decoded bytes', () => {
    expect(() => parseBase64Envelope('data:image/png;base64,AQID', {
      allowedMimeTypes: ['image/jpeg'],
      maxDecodedBytes: 3,
    })).toThrowError(expect.objectContaining<Partial<Base64EnvelopeError>>({
      code: 'unsupported_mime_type',
    }));
    expect(() => parseBase64Envelope('data:image/png;base64,AQID', {
      maxDecodedBytes: 2,
    })).toThrowError(expect.objectContaining<Partial<Base64EnvelopeError>>({
      code: 'base64_too_large',
    }));
    expect(() => parseBase64Envelope(
      `data:image/${'x'.repeat(300)};base64,AQ==`,
      { maxDecodedBytes: 1 },
    )).toThrowError(expect.objectContaining<Partial<Base64EnvelopeError>>({
      code: 'invalid_data_url',
    }));
  });

  it('matches Node decoded lengths across seeded byte sequences', () => {
    const random = seeded(0xb64e2026);
    for (let length = 1; length <= 512; length += 1) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(random() * 256));
      const payload = Buffer.from(bytes).toString('base64');
      expect(estimateBase64DecodedBytes(payload)).toBe(length);
      expect(parseBase64Envelope(`data:image/png;base64,${payload}`, {
        maxDecodedBytes: 512,
      }).decodedBytes).toBe(Buffer.from(payload, 'base64').byteLength);
    }
  });
});
