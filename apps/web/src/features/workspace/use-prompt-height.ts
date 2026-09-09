import { useLayoutEffect, type RefObject } from 'react';

export function usePromptHeight(ref: RefObject<HTMLTextAreaElement | null>, text: string, mobile: boolean, focused: boolean, compact: boolean) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (compact) { element.style.height = ''; element.style.minHeight = ''; element.style.maxHeight = ''; element.style.overflowY = ''; return; }
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const style = getComputedStyle(element);
      const line = parseFloat(style.lineHeight), padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const minimum = line * 2 + padding + border;
      const maximum = line * (mobile ? focused ? 4 : 2 : 5) + padding + border;
      element.style.minHeight = '0'; element.style.maxHeight = 'none'; element.style.height = '0';
      const required = element.scrollHeight + border;
      element.style.height = `${Math.min(maximum, Math.max(minimum, required))}px`;
      element.style.overflowY = required > maximum + 1 ? 'auto' : 'hidden';
      if (mobile && !focused) element.scrollTop = 0;
    };
    measure();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; measure(); } });
    observer.observe(element);
    void document.fonts.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [ref, text, mobile, focused, compact]);
}
