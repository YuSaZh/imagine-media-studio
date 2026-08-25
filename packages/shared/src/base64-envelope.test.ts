import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Base64EnvelopeError,
  base64DataUrlToBlob,
  browserAtobBase64Decoder,
  decodeBase64Envelope,
  estimateBase64DecodedBytes,
  parseBase64Envelope,
} from './base64-envelope.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('decodes only after strict parsing and omits the source envelope from its result', async () => {
    const decoder = {
      decode: vi.fn(() => new Uint8Array([1, 2, 3])),
    };

    const decoded = await decodeBase64Envelope('data:IMAGE/PNG;base64,AQID', {
      allowedMimeTypes: ['image/png'],
      decoder,
      maxDecodedBytes: 3,
    });

    expect(decoder.decode).toHaveBeenCalledWith('AQID', undefined);
    expect(decoded).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    expect(decoded).not.toHaveProperty('payload');
  });

  it('rejects oversized and unsupported envelopes before invoking the decoder', async () => {
    const decoder = { decode: vi.fn(() => new Uint8Array()) };
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      decoder,
      maxDecodedBytes: 2,
    })).rejects.toMatchObject({ code: 'base64_too_large' });
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      allowedMimeTypes: ['image/jpeg'],
      decoder,
      maxDecodedBytes: 3,
    })).rejects.toMatchObject({ code: 'unsupported_mime_type' });
    expect(decoder.decode).not.toHaveBeenCalled();
  });

  it('rejects a decoder that lies about output length or returns an invalid value', async () => {
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      decoder: { decode: () => new Uint8Array([1, 2]) },
      maxDecodedBytes: 3,
    })).rejects.toMatchObject({ code: 'decoded_length_mismatch' });
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      decoder: { decode: () => 'not bytes' as unknown as Uint8Array },
      maxDecodedBytes: 3,
    })).rejects.toMatchObject({ code: 'invalid_decoded_output' });
  });

  it('maps decoder failures to a typed error and preserves the cause', async () => {
    const failure = new Error('decoder detail must not escape as an untyped error');
    try {
      await decodeBase64Envelope('data:image/png;base64,AQID', {
        decoder: { decode: () => { throw failure; } },
        maxDecodedBytes: 3,
      });
      throw new Error('Expected decodeBase64Envelope to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(Base64EnvelopeError);
      expect(error).toMatchObject({ code: 'decode_failed', cause: failure });
    }
  });

  it('honors aborts before and after the decoder without wrapping AbortError', async () => {
    const before = new AbortController();
    before.abort();
    const untouched = { decode: vi.fn(() => new Uint8Array([1, 2, 3])) };
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      decoder: untouched,
      maxDecodedBytes: 3,
      signal: before.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(untouched.decode).not.toHaveBeenCalled();

    const after = new AbortController();
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      decoder: {
        decode: () => {
          after.abort();
          return new Uint8Array([1, 2, 3]);
        },
      },
      maxDecodedBytes: 3,
      signal: after.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('provides an atob decoder and creates a MIME-preserving Blob with exact bytes', async () => {
    const atob = vi.fn(() => String.fromCharCode(1, 2, 255));
    vi.stubGlobal('atob', atob);

    expect(await Promise.resolve(browserAtobBase64Decoder.decode('AQL/'))).toEqual(
      new Uint8Array([1, 2, 255]),
    );
    const blob = await base64DataUrlToBlob('data:image/png;base64,AQL/', {
      maxDecodedBytes: 3,
    });

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 255]));
    expect(atob).toHaveBeenCalledWith('AQL/');
  });

  it('reports a typed error when atob is unavailable', async () => {
    vi.stubGlobal('atob', undefined);
    await expect(decodeBase64Envelope('data:image/png;base64,AQID', {
      maxDecodedBytes: 3,
    })).rejects.toMatchObject({ code: 'decoder_unavailable' });
  });
});
