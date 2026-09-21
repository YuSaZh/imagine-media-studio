import { useLayoutEffect, useRef, type RefObject } from 'react';

type Frame = { x: number; y: number; width: number; height: number };
export type SegmentMemory = { value: string; frame: Frame; containerWidth: number; scrollLeft: number } | null;
const reducedMotion = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const keyframe = (frame: Frame) => ({ transform: `translate(${frame.x}px, ${frame.y}px)`, width: `${frame.width}px`, height: `${frame.height}px` });

/** The visual history survives keyed Composer fields; model parameter state does not. */
export function useSegmentIndicator(ref: RefObject<HTMLElement | null>, value: string, memory: RefObject<SegmentMemory>) {
  const animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const container = ref.current;
    const indicator = container?.querySelector<HTMLElement>('.segment-indicator');
    const selected = container?.querySelector<HTMLElement>('[data-active="true"], [aria-pressed="true"]');
    if (!container || !indicator || !selected) return;
    const measure = (): Frame => ({ x: selected.offsetLeft, y: selected.offsetTop, width: selected.offsetWidth, height: selected.offsetHeight });
    const visible = (): Frame => {
      const box = indicator.getBoundingClientRect(), parent = container.getBoundingClientRect();
      return { x: box.x - parent.x, y: box.y - parent.y, width: box.width, height: box.height };
    };
    const before = memory.current;
    const viewport = container.parentElement?.classList.contains('mobile-video-mode-row') ? container.parentElement : null;
    const revealSelected = () => {
      if (!viewport) return;
      const left = selected.offsetLeft - 3, right = selected.offsetLeft + selected.offsetWidth + 3;
      if (left < viewport.scrollLeft) viewport.scrollLeft = left;
      else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
    };
    if (viewport) viewport.scrollLeft = before?.scrollLeft ?? 0;
    revealSelected();
    const to = measure();
    Object.assign(indicator.style, keyframe(to));
    indicator.hidden = !to.width;
    if (before && before.value !== value && before.containerWidth === container.clientWidth && to.width && !reducedMotion()) {
      const current = indicator.animate([keyframe(before.frame), keyframe(to)], { duration: 220, easing: 'cubic-bezier(.22,.7,.22,1)' });
      current.id = 'segment-slide';
      animation.current = current;
      current.onfinish = () => { animation.current = null; };
    }
    const settle = () => {
      animation.current?.cancel(); animation.current = null;
      const frame = measure(); Object.assign(indicator.style, keyframe(frame)); indicator.hidden = !frame.width;
      revealSelected();
    };
    let width = container.clientWidth;
    const observer = new ResizeObserver(() => { if (container.clientWidth !== width || !animation.current) { width = container.clientWidth; settle(); } });
    observer.observe(container); observer.observe(selected);
    if (viewport) observer.observe(viewport);
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => { if (reducedMotion()) settle(); };
    preference.addEventListener('change', onPreference);
    const settings = new MutationObserver(onPreference);
    settings.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    return () => {
      if (container.clientWidth && indicator.offsetWidth) memory.current = { value, frame: visible(), containerWidth: container.clientWidth, scrollLeft: viewport?.scrollLeft ?? 0 };
      observer.disconnect(); settings.disconnect(); preference.removeEventListener('change', onPreference);
      animation.current?.cancel(); animation.current = null;
    };
  }, [ref, value, memory]);
}
