import { useEffect, useRef, type ButtonHTMLAttributes, type RefObject } from 'react';
import { createSelectionGestureState, LONG_PRESS_DURATION_MS, reduceSelectionGesture } from '../gallery/model/selection-gesture';

export function useGallerySelection(scrollRef: RefObject<HTMLElement | null>, onSelect: () => void, onOpen: () => void): ButtonHTMLAttributes<HTMLButtonElement> {
  const gesture = useRef(createSelectionGestureState());
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const select = useRef(onSelect); select.current = onSelect;
  const reset = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    gesture.current = createSelectionGestureState();
  };
  useEffect(() => {
    const element = scrollRef.current;
    element?.addEventListener('scroll', reset, { passive: true });
    return () => { element?.removeEventListener('scroll', reset); reset(); };
  }, [scrollRef]);
  return {
    onPointerDown: event => {
      reset(); suppressClick.current = false;
      gesture.current = reduceSelectionGesture(gesture.current, { type: 'pointerdown', pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY });
      if (gesture.current.phase === 'pending') timeout.current = setTimeout(() => {
        gesture.current = reduceSelectionGesture(gesture.current, { type: 'long-press', pointerId: event.pointerId });
        if (gesture.current.phase === 'triggered') { suppressClick.current = true; select.current(); }
      }, LONG_PRESS_DURATION_MS);
    },
    onPointerMove: event => {
      gesture.current = reduceSelectionGesture(gesture.current, { type: 'pointermove', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
      if (gesture.current.phase !== 'pending' && timeout.current) clearTimeout(timeout.current);
    },
    onPointerUp: reset, onPointerCancel: reset, onPointerLeave: reset,
    onContextMenu: event => {
      event.preventDefault();
      if (gesture.current.pointerType || suppressClick.current) return;
      suppressClick.current = true; select.current();
    },
    onClick: event => {
      if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; }
      if (event.shiftKey) select.current(); else onOpen();
    },
  };
}
