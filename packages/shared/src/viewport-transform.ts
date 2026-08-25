/*
 * Selectively adapted from CookSleep/gpt_image_playground src/lib/viewportTransform.ts.
 * Pinned revision: 997d79b35e60406d6ab6da26d0a9179a724820c7
 * Source blob: 04bef54716c4e4afd86e0ee8e7833cfa2fd103a9
 * MIT License, Copyright (c) 2026 CookSleep.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface ClientRectLike extends Size {
  readonly left: number;
  readonly top: number;
}

export interface ViewScaleLimits {
  readonly min: number;
  readonly max: number;
}

export const DEFAULT_VIEW_SCALE_LIMITS: ViewScaleLimits = { min: 1, max: 6 };

export type ViewportTransformErrorCode =
  | 'invalid_distance'
  | 'invalid_point'
  | 'invalid_scale'
  | 'invalid_scale_limits'
  | 'invalid_size'
  | 'invalid_transform';

export class ViewportTransformError extends Error {
  public override readonly name = 'ViewportTransformError';

  public constructor(
    public readonly code: ViewportTransformErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function assertPoint(point: Point, code: 'invalid_point' | 'invalid_transform'): void {
  if (!finite(point.x) || !finite(point.y)) {
    throw new ViewportTransformError(code, 'Viewport coordinates must be finite.');
  }
}

function assertSize(size: Size): void {
  if (!finite(size.width) || !finite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new ViewportTransformError('invalid_size', 'Viewport dimensions must be positive.');
  }
}

function assertLimits(limits: ViewScaleLimits): void {
  if (!finite(limits.min) || !finite(limits.max) || limits.min < 1 || limits.max < limits.min) {
    throw new ViewportTransformError(
      'invalid_scale_limits',
      'Scale limits must be finite, ordered, and cannot shrink below 1.',
    );
  }
}

function assertTransform(transform: ViewTransform): void {
  assertPoint(transform, 'invalid_transform');
  if (!finite(transform.scale) || transform.scale <= 0) {
    throw new ViewportTransformError('invalid_transform', 'Transform scale must be positive.');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function clampViewTransform(
  transform: ViewTransform,
  viewportSize: Size,
  limits: ViewScaleLimits = DEFAULT_VIEW_SCALE_LIMITS,
): ViewTransform {
  assertTransform(transform);
  assertSize(viewportSize);
  assertLimits(limits);
  const scale = clamp(transform.scale, limits.min, limits.max);
  if (scale === limits.min) return { scale, x: 0, y: 0 };
  return {
    scale,
    x: clamp(transform.x, viewportSize.width * (1 - scale), 0),
    y: clamp(transform.y, viewportSize.height * (1 - scale), 0),
  };
}

export function zoomAtPoint(
  transform: ViewTransform,
  point: Point,
  nextScale: number,
  viewportSize: Size,
  limits: ViewScaleLimits = DEFAULT_VIEW_SCALE_LIMITS,
): ViewTransform {
  assertTransform(transform);
  assertPoint(point, 'invalid_point');
  assertSize(viewportSize);
  assertLimits(limits);
  if (!finite(nextScale) || nextScale <= 0) {
    throw new ViewportTransformError('invalid_scale', 'The requested scale must be positive.');
  }
  const localPoint = {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  };
  const scale = clamp(nextScale, limits.min, limits.max);
  return clampViewTransform(
    {
      scale,
      x: point.x - localPoint.x * scale,
      y: point.y - localPoint.y * scale,
    },
    viewportSize,
    limits,
  );
}

export function getPinchTransform(input: {
  readonly startTransform: ViewTransform;
  readonly startCentroid: Point;
  readonly nextCentroid: Point;
  readonly startDistance: number;
  readonly nextDistance: number;
  readonly viewportSize: Size;
  readonly limits?: ViewScaleLimits;
}): ViewTransform {
  assertTransform(input.startTransform);
  assertPoint(input.startCentroid, 'invalid_point');
  assertPoint(input.nextCentroid, 'invalid_point');
  assertSize(input.viewportSize);
  const limits = input.limits ?? DEFAULT_VIEW_SCALE_LIMITS;
  assertLimits(limits);
  if (
    !finite(input.startDistance) ||
    !finite(input.nextDistance) ||
    input.startDistance < 0 ||
    input.nextDistance < 0
  ) {
    throw new ViewportTransformError('invalid_distance', 'Pinch distances cannot be negative.');
  }
  const localPoint = {
    x: (input.startCentroid.x - input.startTransform.x) / input.startTransform.scale,
    y: (input.startCentroid.y - input.startTransform.y) / input.startTransform.scale,
  };
  const distanceRatio =
    input.startDistance > 0 ? input.nextDistance / input.startDistance : 1;
  const scale = clamp(input.startTransform.scale * distanceRatio, limits.min, limits.max);
  return clampViewTransform(
    {
      scale,
      x: input.nextCentroid.x - localPoint.x * scale,
      y: input.nextCentroid.y - localPoint.y * scale,
    },
    input.viewportSize,
    limits,
  );
}

export function clientPointToCanvasPoint(
  rect: ClientRectLike,
  point: Point,
  canvasSize: Size,
): Point {
  assertPoint({ x: rect.left, y: rect.top }, 'invalid_point');
  assertPoint(point, 'invalid_point');
  assertSize(rect);
  assertSize(canvasSize);
  return {
    x: ((point.x - rect.left) / rect.width) * canvasSize.width,
    y: ((point.y - rect.top) / rect.height) * canvasSize.height,
  };
}
