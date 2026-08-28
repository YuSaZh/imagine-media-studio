export const MIN_VIEWER_SCALE = 1;
export const MAX_VIEWER_SCALE = 4;
export const VIEWER_SWIPE_THRESHOLD = 48;
export const VIEWER_SWIPE_VERTICAL_TOLERANCE = 60;

const VIEWER_MOVE_TOLERANCE = 6;

export interface ViewerPoint {
  readonly x: number;
  readonly y: number;
}

export interface ViewerGestureLayout {
  readonly center: ViewerPoint;
  readonly media: {
    readonly height: number;
    readonly width: number;
  };
  readonly viewport: {
    readonly height: number;
    readonly width: number;
  };
}

export type ViewerGestureMode = 'idle' | 'pan' | 'pinch' | 'swipe';

export interface ViewerPinchStart {
  readonly center: ViewerPoint;
  readonly distance: number;
  readonly position: ViewerPoint;
  readonly scale: number;
}

export interface ViewerGestureState {
  readonly lastPoint: ViewerPoint | null;
  readonly mode: ViewerGestureMode;
  readonly moved: boolean;
  readonly pinchStart: ViewerPinchStart | null;
  readonly pointers: ReadonlyMap<number, ViewerPoint>;
  readonly position: ViewerPoint;
  readonly primaryPointerId: number | null;
  readonly scale: number;
  readonly startPoint: ViewerPoint | null;
  readonly startPosition: ViewerPoint;
}

export interface ViewerPointerGestureEvent {
  readonly layout: ViewerGestureLayout;
  readonly point: ViewerPoint;
  readonly pointerId: number;
  readonly type: 'pointerdown' | 'pointermove' | 'pointerup';
}

export type ViewerGestureEvent =
  | ViewerPointerGestureEvent
  | {
      readonly pointerId: number;
      readonly type: 'pointercancel' | 'lostcapture';
    }
  | {
      readonly layout?: ViewerGestureLayout;
      readonly type: 'doubletap';
    };

export type ViewerGestureEffect = 'double-tap' | 'next' | 'none' | 'previous' | 'tap';

export interface ViewerGestureTransition {
  readonly effect: ViewerGestureEffect;
  readonly state: ViewerGestureState;
}

function point(x: number, y: number): ViewerPoint {
  return { x, y };
}

function zeroPoint(): ViewerPoint {
  return point(0, 0);
}

function distance(left: ViewerPoint, right: ViewerPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function midpoint(left: ViewerPoint, right: ViewerPoint): ViewerPoint {
  return point((left.x + right.x) / 2, (left.y + right.y) / 2);
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return MIN_VIEWER_SCALE;
  return Math.min(MAX_VIEWER_SCALE, Math.max(MIN_VIEWER_SCALE, value));
}

function mapPoints(pointers: ReadonlyMap<number, ViewerPoint>): readonly ViewerPoint[] {
  return Array.from(pointers.values());
}

function withPointers(
  state: ViewerGestureState,
  pointers: ReadonlyMap<number, ViewerPoint>,
  overrides: Partial<Pick<ViewerGestureState, 'lastPoint' | 'mode' | 'moved' | 'pinchStart' | 'primaryPointerId' | 'startPoint' | 'startPosition'>> = {},
): ViewerGestureState {
  return {
    ...state,
    ...overrides,
    pointers,
  };
}

function resetInteraction(
  state: ViewerGestureState,
  pointers: ReadonlyMap<number, ViewerPoint> = new Map(),
): ViewerGestureState {
  return {
    ...state,
    lastPoint: null,
    mode: 'idle',
    moved: false,
    pinchStart: null,
    pointers,
    primaryPointerId: null,
    startPoint: null,
    startPosition: state.position,
  };
}

function firstTwoPointers(pointers: ReadonlyMap<number, ViewerPoint>): readonly [ViewerPoint, ViewerPoint] | null {
  const values = mapPoints(pointers);
  const left = values[0];
  const right = values[1];
  return left && right ? [left, right] : null;
}

export function clampViewerPosition(
  value: ViewerPoint,
  scale: number,
  layout: ViewerGestureLayout,
): ViewerPoint {
  const normalizedScale = clampScale(scale);
  if (normalizedScale === MIN_VIEWER_SCALE) return zeroPoint();
  const viewportWidth = Number.isFinite(layout.viewport.width) ? Math.max(0, layout.viewport.width) : 0;
  const viewportHeight = Number.isFinite(layout.viewport.height) ? Math.max(0, layout.viewport.height) : 0;
  const mediaWidth = Number.isFinite(layout.media.width) ? Math.max(0, layout.media.width) : 0;
  const mediaHeight = Number.isFinite(layout.media.height) ? Math.max(0, layout.media.height) : 0;
  const maxX = Math.max(0, (mediaWidth * normalizedScale - viewportWidth) / 2);
  const maxY = Math.max(0, (mediaHeight * normalizedScale - viewportHeight) / 2);
  const x = Number.isFinite(value.x) ? value.x : 0;
  const y = Number.isFinite(value.y) ? value.y : 0;
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

export function createViewerGestureState(
  scale = MIN_VIEWER_SCALE,
  position: ViewerPoint = zeroPoint(),
): ViewerGestureState {
  const normalizedScale = clampScale(scale);
  return {
    lastPoint: null,
    mode: 'idle',
    moved: false,
    pinchStart: null,
    pointers: new Map(),
    position: normalizedScale === MIN_VIEWER_SCALE ? zeroPoint() : position,
    primaryPointerId: null,
    scale: normalizedScale,
    startPoint: null,
    startPosition: normalizedScale === MIN_VIEWER_SCALE ? zeroPoint() : position,
  };
}

export function setViewerGestureTransform(
  state: ViewerGestureState,
  nextScale: number,
  nextPosition: ViewerPoint = zeroPoint(),
  layout?: ViewerGestureLayout,
): ViewerGestureState {
  const scale = clampScale(nextScale);
  const position = scale === MIN_VIEWER_SCALE
    ? zeroPoint()
    : layout
      ? clampViewerPosition(nextPosition, scale, layout)
      : nextPosition;
  return {
    ...state,
    position,
    scale,
    startPosition: position,
  };
}

function beginPinch(
  state: ViewerGestureState,
  pointers: ReadonlyMap<number, ViewerPoint>,
  layout?: ViewerGestureLayout,
): ViewerGestureState {
  const pair = firstTwoPointers(pointers);
  if (!pair) return withPointers(state, pointers);
  const [left, right] = pair;
  const position = layout
    ? clampViewerPosition(state.position, state.scale, layout)
    : state.position;
  const pinchDistance = distance(left, right);
  if (pinchDistance <= 0) {
    return withPointers(state, pointers, {
      lastPoint: null,
      mode: 'pinch',
      moved: true,
      pinchStart: null,
      primaryPointerId: null,
      startPoint: null,
      startPosition: position,
    });
  }
  return withPointers(state, pointers, {
    lastPoint: null,
    mode: 'pinch',
    moved: true,
    pinchStart: {
      center: midpoint(left, right),
      distance: pinchDistance,
      position,
      scale: state.scale,
    },
    primaryPointerId: null,
    startPoint: null,
    startPosition: position,
  });
}

function continuePinch(
  state: ViewerGestureState,
  pointers: ReadonlyMap<number, ViewerPoint>,
  layout: ViewerGestureLayout,
): ViewerGestureState {
  const pinch = state.pinchStart;
  const pair = firstTwoPointers(pointers);
  if (!pair) return withPointers(state, pointers);
  if (!pinch || pinch.distance <= 0) return beginPinch(state, pointers, layout);
  const [left, right] = pair;
  const nextDistance = distance(left, right);
  const nextCenter = midpoint(left, right);
  const scale = clampScale(pinch.scale * (nextDistance / pinch.distance));
  const anchor = {
    x: (pinch.center.x - layout.center.x - pinch.position.x) / pinch.scale,
    y: (pinch.center.y - layout.center.y - pinch.position.y) / pinch.scale,
  };
  const position = clampViewerPosition({
    x: nextCenter.x - layout.center.x - anchor.x * scale,
    y: nextCenter.y - layout.center.y - anchor.y * scale,
  }, scale, layout);
  return {
    ...state,
    lastPoint: nextCenter,
    moved: true,
    pointers,
    position,
    scale,
  };
}

function finishAfterPointerRemoval(
  state: ViewerGestureState,
  pointers: ReadonlyMap<number, ViewerPoint>,
  layout?: ViewerGestureLayout,
): ViewerGestureState {
  if (pointers.size >= 2) return beginPinch(state, pointers, layout);
  const remaining = mapPoints(pointers)[0];
  const remainingId = Array.from(pointers.keys())[0];
  if (remaining && remainingId !== undefined) {
    return withPointers(state, pointers, {
      lastPoint: remaining,
      mode: 'pan',
      moved: true,
      pinchStart: null,
      primaryPointerId: remainingId,
      startPoint: remaining,
      startPosition: state.position,
    });
  }
  return resetInteraction(state, pointers);
}

function transitionPointerDown(
  state: ViewerGestureState,
  event: ViewerPointerGestureEvent,
): ViewerGestureTransition {
  const pointers = new Map(state.pointers);
  pointers.set(event.pointerId, event.point);
  if (pointers.size >= 2) {
    return {
      effect: 'none',
      state: beginPinch(state, pointers, event.layout),
    };
  }
  return {
    effect: 'none',
    state: withPointers(state, pointers, {
      lastPoint: event.point,
      mode: state.scale > MIN_VIEWER_SCALE ? 'pan' : 'swipe',
      moved: false,
      pinchStart: null,
      primaryPointerId: event.pointerId,
      startPoint: event.point,
      startPosition: state.position,
    }),
  };
}

function transitionPointerMove(
  state: ViewerGestureState,
  event: ViewerPointerGestureEvent,
): ViewerGestureTransition {
  if (!state.pointers.has(event.pointerId)) return { effect: 'none', state };
  const pointers = new Map(state.pointers);
  pointers.set(event.pointerId, event.point);
  if (state.mode === 'pinch') {
    return { effect: 'none', state: continuePinch(state, pointers, event.layout) };
  }
  if (state.primaryPointerId !== event.pointerId || !state.startPoint) {
    return { effect: 'none', state: { ...state, pointers } };
  }
  const moved = state.moved || distance(state.startPoint, event.point) > VIEWER_MOVE_TOLERANCE;
  if (state.mode !== 'pan') {
    return {
      effect: 'none',
      state: { ...state, lastPoint: event.point, moved, pointers },
    };
  }
  const nextPosition = clampViewerPosition({
    x: state.startPosition.x + event.point.x - state.startPoint.x,
    y: state.startPosition.y + event.point.y - state.startPoint.y,
  }, state.scale, event.layout);
  return {
    effect: 'none',
    state: {
      ...state,
      lastPoint: event.point,
      moved,
      pointers,
      position: nextPosition,
    },
  };
}

function transitionPointerUp(
  state: ViewerGestureState,
  event: ViewerPointerGestureEvent,
): ViewerGestureTransition {
  if (!state.pointers.has(event.pointerId)) return { effect: 'none', state };
  const pointers = new Map(state.pointers);
  pointers.set(event.pointerId, event.point);
  pointers.delete(event.pointerId);
  if (state.mode === 'pinch') {
    return { effect: 'none', state: finishAfterPointerRemoval(state, pointers, event.layout) };
  }
  if (state.mode === 'pan') {
    const moved = state.moved || (state.startPoint !== null && distance(state.startPoint, event.point) > VIEWER_MOVE_TOLERANCE);
    return {
      effect: !moved && pointers.size === 0 ? 'tap' : 'none',
      state: resetInteraction(state, pointers),
    };
  }
  const start = state.startPoint;
  if (!start || pointers.size > 0) {
    return { effect: 'none', state: resetInteraction(state, pointers) };
  }
  const moved = state.moved || distance(start, event.point) > VIEWER_MOVE_TOLERANCE;
  const deltaX = start.x - event.point.x;
  const deltaY = start.y - event.point.y;
  const isSwipe = Math.abs(deltaX) >= VIEWER_SWIPE_THRESHOLD &&
    Math.abs(deltaY) <= VIEWER_SWIPE_VERTICAL_TOLERANCE;
  const effect: ViewerGestureEffect = isSwipe
    ? deltaX > 0 ? 'next' : 'previous'
    : !moved ? 'tap' : 'none';
  return { effect, state: resetInteraction(state, pointers) };
}

function transitionPointerCancel(
  state: ViewerGestureState,
  pointerId: number,
): ViewerGestureTransition {
  if (!state.pointers.has(pointerId)) return { effect: 'none', state };
  const pointers = new Map(state.pointers);
  pointers.delete(pointerId);
  return { effect: 'none', state: finishAfterPointerRemoval(state, pointers) };
}

export function transitionViewerGesture(
  state: ViewerGestureState,
  event: ViewerGestureEvent,
): ViewerGestureTransition {
  switch (event.type) {
    case 'pointerdown':
      return transitionPointerDown(state, event);
    case 'pointermove':
      return transitionPointerMove(state, event);
    case 'pointerup':
      return transitionPointerUp(state, event);
    case 'pointercancel':
    case 'lostcapture':
      return transitionPointerCancel(state, event.pointerId);
    case 'doubletap': {
      const scale = state.scale === MIN_VIEWER_SCALE ? 2 : MIN_VIEWER_SCALE;
      const position = event.layout
        ? clampViewerPosition(zeroPoint(), scale, event.layout)
        : zeroPoint();
      return {
        effect: 'double-tap',
        state: {
          ...resetInteraction(state),
          position,
          scale,
          startPosition: position,
        },
      };
    }
  }
}
