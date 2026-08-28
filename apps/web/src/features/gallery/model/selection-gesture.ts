export const LONG_PRESS_DURATION_MS = 520;
export const LONG_PRESS_MOVE_THRESHOLD_PX = 10;

export type SelectionGesturePhase = 'idle' | 'pending' | 'triggered';

export interface SelectionGestureState {
  readonly phase: SelectionGesturePhase;
  readonly pointerId: number | null;
  readonly pointerType: 'pen' | 'touch' | null;
  readonly startX: number | null;
  readonly startY: number | null;
}

export type SelectionGestureEvent =
  | {
      readonly type: 'pointerdown';
      readonly pointerId: number;
      readonly pointerType: string;
      readonly clientX: number;
      readonly clientY: number;
      readonly interactiveTarget?: boolean;
    }
  | {
      readonly type: 'pointermove';
      readonly pointerId: number;
      readonly clientX: number;
      readonly clientY: number;
    }
  | { readonly type: 'long-press'; readonly pointerId: number }
  | { readonly type: 'pointerup'; readonly pointerId: number }
  | { readonly type: 'pointercancel'; readonly pointerId: number }
  | { readonly type: 'pointerleave'; readonly pointerId: number }
  | { readonly type: 'contextmenu' }
  | { readonly type: 'scroll' }
  | { readonly type: 'reset' };

export function createSelectionGestureState(): SelectionGestureState {
  return {
    phase: 'idle',
    pointerId: null,
    pointerType: null,
    startX: null,
    startY: null,
  };
}

function isLongPressPointerType(value: string): value is 'pen' | 'touch' {
  return value === 'pen' || value === 'touch';
}

function resetState(): SelectionGestureState {
  return createSelectionGestureState();
}

export function reduceSelectionGesture(
  state: SelectionGestureState,
  event: SelectionGestureEvent,
): SelectionGestureState {
  switch (event.type) {
    case 'pointerdown':
      if (event.interactiveTarget || !isLongPressPointerType(event.pointerType)) return resetState();
      return {
        phase: 'pending',
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        startX: event.clientX,
        startY: event.clientY,
      };
    case 'pointermove':
      if (
        state.phase !== 'pending' ||
        state.pointerId !== event.pointerId ||
        state.startX === null ||
        state.startY === null
      ) {
        return state;
      }
      return Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > LONG_PRESS_MOVE_THRESHOLD_PX
        ? resetState()
        : state;
    case 'long-press':
      return state.phase === 'pending' && state.pointerId === event.pointerId
        ? { ...state, phase: 'triggered' }
        : state;
    case 'pointerup':
    case 'pointercancel':
    case 'pointerleave':
      return state.pointerId === event.pointerId ? resetState() : state;
    case 'contextmenu':
      // The browser may dispatch this event during a touch hold. Keep the
      // session alive so the controlled 520ms gesture remains authoritative.
      return state;
    case 'scroll':
    case 'reset':
      return resetState();
  }
}
