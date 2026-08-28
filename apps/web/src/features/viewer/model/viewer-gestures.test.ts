import { describe, expect, it } from 'vitest';

import {
  clampViewerPosition,
  createViewerGestureState,
  MAX_VIEWER_SCALE,
  MIN_VIEWER_SCALE,
  setViewerGestureTransform,
  transitionViewerGesture,
  type ViewerGestureLayout,
  type ViewerGestureState,
} from './viewer-gestures.js';

const layout: ViewerGestureLayout = {
  center: { x: 400, y: 300 },
  media: { height: 900, width: 1200 },
  viewport: { height: 600, width: 800 },
};

function transition(
  state: ViewerGestureState,
  event: Parameters<typeof transitionViewerGesture>[1],
): ViewerGestureState {
  return transitionViewerGesture(state, event).state;
}

describe('viewer gesture state machine', () => {
  it('clamps zoom and pan to the media bounds', () => {
    expect(clampViewerPosition({ x: 999, y: -999 }, 2, layout)).toEqual({ x: 800, y: -600 });
    expect(clampViewerPosition({ x: 999, y: -999 }, 1, layout)).toEqual({ x: 0, y: 0 });

    const state = setViewerGestureTransform(
      createViewerGestureState(),
      MAX_VIEWER_SCALE + 1,
      { x: 9999, y: -9999 },
      layout,
    );
    expect(state.scale).toBe(MAX_VIEWER_SCALE);
    expect(state.position).toEqual({ x: 2000, y: -1500 });

    const reset = setViewerGestureTransform(state, MIN_VIEWER_SCALE, { x: 200, y: 200 }, layout);
    expect(reset.position).toEqual({ x: 0, y: 0 });
  });

  it('zooms from two pointers and never turns a pinch into navigation', () => {
    let state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 300, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    state = transition(state, {
      layout,
      point: { x: 500, y: 300 },
      pointerId: 2,
      type: 'pointerdown',
    });
    expect(state.mode).toBe('pinch');

    const zoomed = transitionViewerGesture(state, {
      layout,
      point: { x: 650, y: 300 },
      pointerId: 2,
      type: 'pointermove',
    });
    expect(zoomed.effect).toBe('none');
    expect(zoomed.state.scale).toBeGreaterThan(1);

    const afterFirstUp = transitionViewerGesture(zoomed.state, {
      layout,
      point: { x: 300, y: 300 },
      pointerId: 1,
      type: 'pointerup',
    });
    expect(afterFirstUp.effect).toBe('none');
    expect(afterFirstUp.state.mode).toBe('pan');

    const afterSecondUp = transitionViewerGesture(afterFirstUp.state, {
      layout,
      point: { x: 650, y: 300 },
      pointerId: 2,
      type: 'pointerup',
    });
    expect(afterSecondUp.effect).toBe('none');
    expect(afterSecondUp.state.pointers.size).toBe(0);
  });

  it('keeps three pointers in pinch mode and re-baselines when the active pair changes', () => {
    let state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 300, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    state = transition(state, {
      layout,
      point: { x: 500, y: 300 },
      pointerId: 2,
      type: 'pointerdown',
    });
    state = transition(state, {
      layout,
      point: { x: 600, y: 300 },
      pointerId: 2,
      type: 'pointermove',
    });
    const zoomBeforeThirdPointer = state.scale;
    state = transition(state, {
      layout,
      point: { x: 700, y: 300 },
      pointerId: 3,
      type: 'pointerdown',
    });
    expect(state.mode).toBe('pinch');
    expect(state.pointers.size).toBe(3);

    state = transition(state, {
      layout,
      point: { x: 300, y: 300 },
      pointerId: 1,
      type: 'pointerup',
    });
    expect(state.mode).toBe('pinch');
    expect(state.pointers.size).toBe(2);
    const rebaselined = transition(state, {
      layout,
      point: { x: 700, y: 300 },
      pointerId: 3,
      type: 'pointermove',
    });
    expect(rebaselined.scale).toBeCloseTo(zoomBeforeThirdPointer);
    state = rebaselined;
    state = transition(state, {
      layout,
      point: { x: 600, y: 300 },
      pointerId: 2,
      type: 'pointerup',
    });
    expect(state.mode).toBe('pan');
    expect(state.pointers.size).toBe(1);
  });

  it('emits tap in zoomed pan mode so a second tap can reset zoom, but never for a drag', () => {
    let state = setViewerGestureTransform(createViewerGestureState(), 2, { x: 0, y: 0 }, layout);
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 12,
      type: 'pointerdown',
    });
    const tapped = transitionViewerGesture(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 12,
      type: 'pointerup',
    });
    expect(tapped.effect).toBe('tap');
    state = tapped.state;

    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 13,
      type: 'pointerdown',
    });
    state = transition(state, {
      layout,
      point: { x: 480, y: 300 },
      pointerId: 13,
      type: 'pointermove',
    });
    expect(transitionViewerGesture(state, {
      layout,
      point: { x: 480, y: 300 },
      pointerId: 13,
      type: 'pointerup',
    }).effect).toBe('none');
  });

  it('pans with one pointer after zoom and clamps movement', () => {
    let state = setViewerGestureTransform(createViewerGestureState(), 2, { x: 0, y: 0 }, layout);
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 9,
      type: 'pointerdown',
    });
    state = transition(state, {
      layout,
      point: { x: 9999, y: -9999 },
      pointerId: 9,
      type: 'pointermove',
    });
    expect(state.mode).toBe('pan');
    expect(state.position).toEqual({ x: 800, y: -600 });
    expect(transitionViewerGesture(state, {
      layout,
      point: { x: 9999, y: -9999 },
      pointerId: 9,
      type: 'pointerup',
    }).effect).toBe('none');
  });

  it('emits horizontal navigation only for an unzoomed single-pointer swipe', () => {
    let state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    expect(transitionViewerGesture(state, {
      layout,
      point: { x: 300, y: 315 },
      pointerId: 1,
      type: 'pointerup',
    }).effect).toBe('next');

    state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    expect(transitionViewerGesture(state, {
      layout,
      point: { x: 300, y: 90 },
      pointerId: 1,
      type: 'pointerup',
    }).effect).toBe('none');
  });

  it('returns tap and double-tap reset/toggle effects', () => {
    let state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    expect(transitionViewerGesture(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 1,
      type: 'pointerup',
    }).effect).toBe('tap');

    const zoomed = transitionViewerGesture(createViewerGestureState(), { layout, type: 'doubletap' });
    expect(zoomed.effect).toBe('double-tap');
    expect(zoomed.state.scale).toBe(2);
    const reset = transitionViewerGesture(zoomed.state, { layout, type: 'doubletap' });
    expect(reset.state.scale).toBe(1);
    expect(reset.state.position).toEqual({ x: 0, y: 0 });
  });

  it('cleans up on pointercancel and lostcapture without navigation', () => {
    let state = createViewerGestureState();
    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 1,
      type: 'pointerdown',
    });
    state = transition(state, { pointerId: 1, type: 'pointercancel' });
    expect(state.pointers.size).toBe(0);
    expect(state.mode).toBe('idle');

    state = transition(state, {
      layout,
      point: { x: 400, y: 300 },
      pointerId: 2,
      type: 'pointerdown',
    });
    const lost = transitionViewerGesture(state, { pointerId: 2, type: 'lostcapture' });
    expect(lost.state.pointers.size).toBe(0);
    expect(lost.state.mode).toBe('idle');
    expect(lost.effect).toBe('none');
  });
});
