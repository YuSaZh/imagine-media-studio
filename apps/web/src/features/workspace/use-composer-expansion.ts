import { useLayoutEffect, useRef, type RefObject } from 'react';

function geometry(element: HTMLElement) {
  const style = getComputedStyle(element);
  return { height: `${element.getBoundingClientRect().height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight, borderRadius: style.borderRadius };
}
const reducedMotion = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Animate measured heights without leaving a fixed height on the responsive Composer. */
export function useComposerExpansion(ref: RefObject<HTMLFormElement | null>, compact: boolean | undefined) {
  const previous = useRef<{ compact: boolean; frame: ReturnType<typeof geometry> } | null>(null);
  const active = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || compact === undefined) return;
    const before = previous.current;
    if (before?.compact === compact) {
      if (!active.current) previous.current = { compact, frame: geometry(element) };
      return;
    }
    const from = active.current ? geometry(element) : before?.frame;
    active.current?.cancel(); active.current = null;
    const to = geometry(element);
    previous.current = { compact, frame: to };
    if (!from || reducedMotion() || from.height === to.height) return;
    const animation = element.animate([
      { ...from, minHeight: '0px', overflow: 'clip' },
      { ...to, minHeight: '0px', overflow: 'clip' },
    ], { duration: 240, easing: 'cubic-bezier(.22,.7,.22,1)' });
    animation.id = 'editor-composer-resize';
    active.current = animation;
    animation.onfinish = () => {
      if (active.current !== animation) return;
      animation.cancel(); active.current = null;
      previous.current = { compact, frame: geometry(element) };
    };
  });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || compact === undefined) return;
    const settle = () => {
      active.current?.cancel(); active.current = null;
      if (previous.current) previous.current.frame = geometry(element);
    };
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; settle(); }
      else if (!active.current && previous.current) previous.current.frame = geometry(element);
    });
    observer.observe(element);
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => { if (reducedMotion()) settle(); };
    preference.addEventListener('change', onPreference);
    const settings = new MutationObserver(onPreference);
    settings.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    return () => { observer.disconnect(); settings.disconnect(); preference.removeEventListener('change', onPreference); active.current?.cancel(); active.current = null; };
  }, [ref, compact === undefined]);
}
