import { useEffect, useRef } from 'react';

export function usePwaViewport() {
  useEffect(() => {
    const standalone = matchMedia('(display-mode: standalone)');
    const installed = () => standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = viewport?.content ?? '';
    const configure = () => {
      if (viewport) viewport.content = installed() ? `${original}, maximum-scale=1, user-scalable=no` : original;
      document.documentElement.dataset.installed = String(installed());
    };
    const gesture = (event: Event) => { if (installed() && event.cancelable) event.preventDefault(); };
    const pinch = (event: TouchEvent) => { if (event.touches.length > 1) gesture(event); };
    configure(); standalone.addEventListener('change', configure);
    document.addEventListener('gesturestart', gesture, { passive: false });
    document.addEventListener('gesturechange', gesture, { passive: false });
    document.addEventListener('touchmove', pinch, { passive: false, capture: true });
    return () => {
      standalone.removeEventListener('change', configure); if (viewport) viewport.content = original;
      delete document.documentElement.dataset.installed;
      document.removeEventListener('gesturestart', gesture); document.removeEventListener('gesturechange', gesture);
      document.removeEventListener('touchmove', pinch, true);
    };
  }, []);
}

export function canScrollVertically(target: Element | null, deltaY: number): boolean {
  for (let element = target; element && element !== document.body; element = element.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue;
    const maximum = element.scrollHeight - element.clientHeight;
    if (maximum > 1 && (deltaY > 0 ? element.scrollTop > 0 : element.scrollTop < maximum - 1)) return true;
  }
  return false;
}

export function useMobileInteractions(openNavigation: () => void) {
  const open = useRef(openNavigation);
  open.current = openNavigation;
  useEffect(() => {
    const mobile = matchMedia('(max-width: 760px)');
    let start: { x: number; y: number; previousY: number; edge: boolean } | null = null;
    const begin = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!mobile.matches || !touch || event.touches.length !== 1) { start = null; return; }
      const target = event.target instanceof Element ? event.target : null;
      start = { x: touch.clientX, y: touch.clientY, previousY: touch.clientY, edge: touch.clientX <= 24 && !document.querySelector('[role="dialog"]') && !target?.closest('input,textarea,select,.viewer-stage,.mask-stage') };
    };
    const move = (event: TouchEvent) => {
      if (!mobile.matches) return;
      if (event.touches.length > 1) return;
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const deltaY = touch.clientY - start.previousY;
      start.previousY = touch.clientY;
      if (start.edge && dx > 10 && Math.abs(dy) < dx / 2) {
        if (event.cancelable) event.preventDefault();
        if (dx >= 64) { start = null; open.current(); }
        return;
      }
      if (Math.abs(dy) > 18) start.edge = false;
      const target = event.target instanceof Element ? event.target : null;
      if (deltaY && Math.abs(dy) > Math.abs(dx) && !target?.closest('.viewer-stage,.mask-stage') && !canScrollVertically(target, deltaY) && event.cancelable) event.preventDefault();
    };
    const end = () => { start = null; };
    document.addEventListener('touchstart', begin, { passive: true, capture: true });
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    document.addEventListener('touchend', end, true);
    document.addEventListener('touchcancel', end, true);
    return () => {
      document.removeEventListener('touchstart', begin, true); document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true); document.removeEventListener('touchcancel', end, true);
    };
  }, []);
}
