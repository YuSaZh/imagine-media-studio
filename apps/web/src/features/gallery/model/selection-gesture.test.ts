import { describe, expect, it } from 'vitest';

import {
  createSelectionGestureState,
  LONG_PRESS_MOVE_THRESHOLD_PX,
  reduceSelectionGesture,
} from './selection-gesture.js';

const pointerDown = (overrides: Partial<{
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly interactiveTarget: boolean;
}> = {}) => ({
  type: 'pointerdown' as const,
  pointerId: 4,
  pointerType: 'touch',
  clientX: 100,
  clientY: 200,
  ...overrides,
});

describe('Gallery selection gesture state machine', () => {
  it('starts only for touch or pen media targets', () => {
    const initial = createSelectionGestureState();

    expect(reduceSelectionGesture(initial, pointerDown()).phase).toBe('pending');
    expect(reduceSelectionGesture(initial, pointerDown({ pointerType: 'pen' })).phase).toBe('pending');
    expect(reduceSelectionGesture(initial, pointerDown({ pointerType: 'mouse' })).phase).toBe('idle');
    expect(reduceSelectionGesture(initial, pointerDown({ interactiveTarget: true })).phase).toBe('idle');
  });

  it('keeps a stationary hold pending and cancels only beyond the movement threshold', () => {
    const pending = reduceSelectionGesture(createSelectionGestureState(), pointerDown());
    const withinThreshold = reduceSelectionGesture(pending, {
      type: 'pointermove',
      pointerId: 4,
      clientX: 100 + LONG_PRESS_MOVE_THRESHOLD_PX,
      clientY: 200,
    });
    const moved = reduceSelectionGesture(pending, {
      type: 'pointermove',
      pointerId: 4,
      clientX: 100 + LONG_PRESS_MOVE_THRESHOLD_PX + 1,
      clientY: 200,
    });

    expect(withinThreshold.phase).toBe('pending');
    expect(moved).toEqual(createSelectionGestureState());
  });

  it('triggers only for the active pointer and consumes the session on release', () => {
    const pending = reduceSelectionGesture(createSelectionGestureState(), pointerDown());
    expect(reduceSelectionGesture(pending, { type: 'long-press', pointerId: 9 })).toEqual(pending);

    const triggered = reduceSelectionGesture(pending, { type: 'long-press', pointerId: 4 });
    expect(triggered.phase).toBe('triggered');
    expect(reduceSelectionGesture(triggered, { type: 'pointerup', pointerId: 4 })).toEqual(
      createSelectionGestureState(),
    );
  });

  it('cleans up all interruption paths while allowing contextmenu to be suppressed safely', () => {
    const pending = reduceSelectionGesture(createSelectionGestureState(), pointerDown());
    expect(reduceSelectionGesture(pending, { type: 'contextmenu' })).toEqual(pending);
    expect(reduceSelectionGesture(pending, { type: 'scroll' })).toEqual(createSelectionGestureState());
    expect(reduceSelectionGesture(pending, { type: 'pointercancel', pointerId: 4 })).toEqual(
      createSelectionGestureState(),
    );
    expect(reduceSelectionGesture(pending, { type: 'pointerleave', pointerId: 4 })).toEqual(
      createSelectionGestureState(),
    );
  });
});
