import { describe, expect, it } from 'vitest';
import { alignImageDimension, linkedImageDimensions } from './custom-dimensions';

describe('custom image dimensions', () => {
  it('aligns to the nearest 16 pixels and rejects invalid or excessive sides', () => {
    for (const [input, expected] of [[1, 16], [1000, 1008], [1001, 1008], [999, 992], [1080, 1088], [16384, 16384]]) expect(alignImageDimension(input!)).toBe(expected);
    for (const value of ['', 0, -1, 'invalid', Infinity, 16385]) expect(alignImageDimension(value)).toBeUndefined();
  });
  it('links either edited edge to the selected ratio and aligns the result', () => {
    expect(linkedImageDimensions('1920', '100', 'width', '16:9', true)).toEqual({ width: 1920, height: 1088 });
    expect(linkedImageDimensions('100', '1440', 'height', '16:9', true)).toEqual({ width: 2560, height: 1440 });
    expect(linkedImageDimensions('1080', '100', 'width', '9:16', true)).toEqual({ width: 1088, height: 1936 });
  });
  it('keeps edges independent with auto or unlocked and enforces total pixels', () => {
    for (const [ratio, lock] of [['auto', true], ['16:9', false]] as const) expect(linkedImageDimensions('1920', '1000', 'width', ratio, lock)).toEqual({ width: 1920, height: 1008 });
    expect(linkedImageDimensions('16384', '16384', 'width', '1:1', true)).toBeUndefined();
    expect(linkedImageDimensions('16384', '100', 'width', '1:10', true)).toBeUndefined();
  });
});
