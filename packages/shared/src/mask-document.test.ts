import { describe, expect, it } from 'vitest';

import {
  applyMaskStroke,
  clearMaskDocument,
  createMaskDocument,
  deserializeMaskDocument,
  interpolateMaskStroke,
  redoMaskDocument,
  serializeMaskDocument,
  undoMaskDocument,
} from './mask-document.js';
import type { MaskDocumentError } from './mask-document.js';
import { classifyMaskRgba } from './mask-target.js';

function alphas(rgba: ArrayLike<number>): number[] {
  const values: number[] = [];
  for (let index = 3; index < rgba.length; index += 4) values.push(rgba[index]!);
  return values;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 22_695_477) + 1) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('clean-room mask document', () => {
  it('uses alpha 0 for brush edits and interpolates a continuous stroke', () => {
    const document = applyMaskStroke(createMaskDocument({ width: 5, height: 1 }), {
      tool: 'brush',
      diameter: 1,
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    });

    expect(alphas(document.rgba)).toEqual([0, 0, 0, 0, 0]);
    expect(classifyMaskRgba(document.rgba)).toBe('full');
    expect(interpolateMaskStroke(
      [{ x: -10, y: 0 }, { x: 20, y: 0 }],
      1,
      { width: 5, height: 1 },
    ).every((point) => point.x >= 0 && point.x <= 4)).toBe(true);
  });

  it('uses alpha 255 for erasing and supports undo, redo, clear, and branch truncation', () => {
    const blank = createMaskDocument({ width: 5, height: 1 });
    const painted = applyMaskStroke(blank, {
      tool: 'brush',
      diameter: 1,
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    });
    const erased = applyMaskStroke(painted, {
      tool: 'erase',
      diameter: 1,
      points: [{ x: 2, y: 0 }],
    });
    expect(alphas(erased.rgba)).toEqual([0, 0, 255, 0, 0]);
    expect(undoMaskDocument(erased).rgba).toEqual(painted.rgba);
    expect(redoMaskDocument(undoMaskDocument(erased)).rgba).toEqual(erased.rgba);
    expect(alphas(clearMaskDocument(erased).rgba)).toEqual([255, 255, 255, 255, 255]);

    const branched = applyMaskStroke(undoMaskDocument(erased), {
      tool: 'erase',
      diameter: 1,
      points: [{ x: 0, y: 0 }],
    });
    expect(branched.cursor).toBe(branched.history.length);
    expect(redoMaskDocument(branched)).toBe(branched);
  });

  it('caps command history by compacting the oldest applied command', () => {
    let document = createMaskDocument({ width: 4, height: 1, historyLimit: 2 });
    for (const x of [0, 1, 2]) {
      document = applyMaskStroke(document, {
        tool: 'brush',
        diameter: 1,
        points: [{ x, y: 0 }],
      });
    }

    expect(document.history).toHaveLength(2);
    document = undoMaskDocument(undoMaskDocument(document));
    expect(alphas(document.rgba)).toEqual([0, 255, 255, 255]);
  });

  it('serializes compacted history deterministically and restores identical pixels', () => {
    let document = createMaskDocument({ width: 8, height: 8, historyLimit: 2 });
    for (const point of [{ x: 1, y: 1 }, { x: 4, y: 4 }, { x: 7, y: 7 }]) {
      document = applyMaskStroke(document, {
        tool: 'brush',
        diameter: 2,
        points: [point],
      });
    }
    document = undoMaskDocument(document);
    const serialized = serializeMaskDocument(document);
    const restored = deserializeMaskDocument(serialized);

    expect(restored).toMatchObject({
      width: document.width,
      height: document.height,
      historyLimit: document.historyLimit,
      cursor: document.cursor,
      history: document.history,
    });
    expect(restored.rgba).toEqual(document.rgba);
    expect(serializeMaskDocument(restored)).toBe(serialized);
  });

  it('deep-copies and freezes caller-owned stroke commands', () => {
    const points = [{ x: 1, y: 1 }];
    const document = applyMaskStroke(createMaskDocument({ width: 4, height: 4 }), {
      tool: 'brush',
      diameter: 1,
      points,
    });
    const before = document.rgba.slice();
    points[0]!.x = 3;
    points.push({ x: 2, y: 2 });

    expect(document.rgba).toEqual(before);
    expect(document.history[0]).toMatchObject({ points: [{ x: 1, y: 1 }] });
    expect(Object.isFrozen(document.history)).toBe(true);
    expect(Object.isFrozen(document.history[0])).toBe(true);
  });

  it('rejects invalid dimensions, strokes, history, and serialized data', () => {
    expect(() => createMaskDocument({ width: 0, height: 1 })).toThrowError(
      expect.objectContaining<Partial<MaskDocumentError>>({ code: 'invalid_dimensions' }),
    );
    const document = createMaskDocument({ width: 2, height: 2 });
    expect(() => applyMaskStroke(document, {
      tool: 'brush',
      diameter: Number.NaN,
      points: [{ x: 0, y: 0 }],
    })).toThrowError(expect.objectContaining<Partial<MaskDocumentError>>({
      code: 'invalid_stroke',
    }));
    expect(() => deserializeMaskDocument('{"version":2}')).toThrowError(
      expect.objectContaining<Partial<MaskDocumentError>>({ code: 'invalid_serialization' }),
    );
    expect(() => interpolateMaskStroke(
      [{ x: 0, y: 0 }, { x: 200_000, y: 0 }],
      1,
      { width: 200_001, height: 1 },
    )).toThrowError(expect.objectContaining<Partial<MaskDocumentError>>({
      code: 'invalid_stroke',
    }));
    expect(() => interpolateMaskStroke(
      [{ x: 0, y: 0 }],
      1,
      { width: 0, height: 1 },
    )).toThrowError(expect.objectContaining<Partial<MaskDocumentError>>({
      code: 'invalid_dimensions',
    }));
    expect(() => applyMaskStroke(createMaskDocument({ width: 2_048, height: 2_048 }), {
      tool: 'brush',
      diameter: 1_024,
      points: Array.from({ length: 10 }, (_, index) => ({ x: index, y: index })),
    })).toThrowError(expect.objectContaining<Partial<MaskDocumentError>>({
      code: 'invalid_stroke',
    }));
    expect(() => deserializeMaskDocument(JSON.stringify({
      version: 1,
      width: 1,
      height: 1,
      historyLimit: 1,
      baseAlphaRle: [[255, 1]],
      history: [{ type: 'clear', unexpected: true }],
      cursor: 1,
    }))).toThrowError(expect.objectContaining<Partial<MaskDocumentError>>({
      code: 'invalid_serialization',
    }));
  });

  it('keeps compacted history pixels equal to a larger uncompressed history', () => {
    const random = seeded(0xc04fac7);
    let compacted = createMaskDocument({ width: 24, height: 18, historyLimit: 5 });
    let expanded = createMaskDocument({ width: 24, height: 18, historyLimit: 100 });
    for (let index = 0; index < 75; index += 1) {
      const stroke = {
        tool: random() < 0.75 ? ('brush' as const) : ('erase' as const),
        diameter: 1 + random() * 5,
        points: [{ x: random() * 24, y: random() * 18 }],
      };
      compacted = applyMaskStroke(compacted, stroke);
      expanded = applyMaskStroke(expanded, stroke);
      expect(compacted.rgba).toEqual(expanded.rgba);
    }
  });

  it('preserves canonical RGBA and bounded history across seeded random commands', () => {
    const random = seeded(0x0badc0de);
    let document = createMaskDocument({ width: 32, height: 24, historyLimit: 7 });
    for (let index = 0; index < 250; index += 1) {
      document = applyMaskStroke(document, {
        tool: random() < 0.7 ? 'brush' : 'erase',
        diameter: 1 + random() * 12,
        points: Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
          x: random() * 64 - 16,
          y: random() * 48 - 12,
        })),
      });
      expect(document.history.length).toBeLessThanOrEqual(document.historyLimit);
      let canonical = true;
      for (let offset = 0; offset < document.rgba.length; offset += 4) {
        canonical &&=
          document.rgba[offset] === 255 &&
          document.rgba[offset + 1] === 255 &&
          document.rgba[offset + 2] === 255 &&
          (document.rgba[offset + 3] === 0 || document.rgba[offset + 3] === 255);
      }
      expect(canonical).toBe(true);
    }
    expect(deserializeMaskDocument(serializeMaskDocument(document)).rgba).toEqual(document.rgba);
  });
});
