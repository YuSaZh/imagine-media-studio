import { describe, expect, it } from 'vitest';

import {
  clampViewTransform,
  clientPointToCanvasPoint,
  getPinchTransform,
  zoomAtPoint,
} from './viewport-transform.js';
import type { ViewportTransformError } from './viewport-transform.js';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('viewport transforms', () => {
  it('clamps scale and translation to the visible viewport', () => {
    expect(clampViewTransform({ scale: 1, x: -80, y: 40 }, { width: 300, height: 200 })).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
    expect(clampViewTransform({ scale: 9, x: -9_999, y: 20 }, { width: 300, height: 200 })).toEqual({
      scale: 6,
      x: -1_500,
      y: 0,
    });
  });

  it('keeps the requested focal point stable while zooming', () => {
    const result = zoomAtPoint(
      { scale: 1, x: 0, y: 0 },
      { x: 150, y: 100 },
      2,
      { width: 300, height: 200 },
    );
    expect(result).toEqual({ scale: 2, x: -150, y: -100 });
    expect((150 - result.x) / result.scale).toBe(150);
    expect((100 - result.y) / result.scale).toBe(100);
  });

  it('handles pinch pan and a zero starting distance without non-finite output', () => {
    expect(getPinchTransform({
      startTransform: { scale: 1, x: 0, y: 0 },
      startCentroid: { x: 150, y: 100 },
      nextCentroid: { x: 160, y: 120 },
      startDistance: 100,
      nextDistance: 200,
      viewportSize: { width: 300, height: 200 },
    })).toEqual({ scale: 2, x: -140, y: -80 });
    expect(getPinchTransform({
      startTransform: { scale: 1, x: 0, y: 0 },
      startCentroid: { x: 10, y: 10 },
      nextCentroid: { x: 20, y: 20 },
      startDistance: 0,
      nextDistance: 100,
      viewportSize: { width: 100, height: 100 },
    })).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('maps client coordinates to natural canvas pixels', () => {
    expect(clientPointToCanvasPoint(
      { left: 10, top: 20, width: 200, height: 100 },
      { x: 110, y: 70 },
      { width: 1_000, height: 500 },
    )).toEqual({ x: 500, y: 250 });
  });

  it('rejects non-finite values and zero-sized geometry', () => {
    expect(() => clampViewTransform(
      { scale: Number.NaN, x: 0, y: 0 },
      { width: 100, height: 100 },
    )).toThrowError(expect.objectContaining<Partial<ViewportTransformError>>({
      code: 'invalid_transform',
    }));
    expect(() => clientPointToCanvasPoint(
      { left: 0, top: 0, width: 0, height: 10 },
      { x: 0, y: 0 },
      { width: 10, height: 10 },
    )).toThrowError(expect.objectContaining<Partial<ViewportTransformError>>({
      code: 'invalid_size',
    }));
    expect(() => clampViewTransform(
      { scale: 1, x: 0, y: 0 },
      { width: 100, height: 100 },
      { min: 0.5, max: 4 },
    )).toThrowError(expect.objectContaining<Partial<ViewportTransformError>>({
      code: 'invalid_scale_limits',
    }));
  });

  it('maintains clamp bounds, finite output, focal stability, and coordinate round trips', () => {
    const random = seeded(0x51a7c0de);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const viewport = { width: 100 + random() * 1_900, height: 100 + random() * 1_000 };
      const scale = 1 + random() * 5;
      const point = { x: random() * viewport.width, y: random() * viewport.height };
      const result = zoomAtPoint({ scale: 1, x: 0, y: 0 }, point, scale, viewport);
      expect(result.scale).toBeGreaterThanOrEqual(1);
      expect(result.scale).toBeLessThanOrEqual(6);
      expect(result.x).toBeGreaterThanOrEqual(viewport.width * (1 - result.scale));
      expect(result.x).toBeLessThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(viewport.height * (1 - result.scale));
      expect(result.y).toBeLessThanOrEqual(0);
      expect(Object.values(result).every(Number.isFinite)).toBe(true);
      expect((point.x - result.x) / result.scale).toBeCloseTo(point.x, 8);
      expect((point.y - result.y) / result.scale).toBeCloseTo(point.y, 8);

      const rect = {
        left: random() * 50,
        top: random() * 50,
        width: 50 + random() * 500,
        height: 50 + random() * 500,
      };
      const canvas = { width: 1 + random() * 4_000, height: 1 + random() * 4_000 };
      const canvasPoint = { x: random() * canvas.width, y: random() * canvas.height };
      const clientPoint = {
        x: rect.left + (canvasPoint.x / canvas.width) * rect.width,
        y: rect.top + (canvasPoint.y / canvas.height) * rect.height,
      };
      const roundTrip = clientPointToCanvasPoint(rect, clientPoint, canvas);
      expect(roundTrip.x).toBeCloseTo(canvasPoint.x, 8);
      expect(roundTrip.y).toBeCloseTo(canvasPoint.y, 8);
    }
  });
});
