import { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

const reduced = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const frame = (box: DOMRect) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });

/** Keep the viewer mounted while its current pixels return to the live gallery. */
export function useViewerExit(viewerId: string | null) {
  const running = useRef<{ cancel: () => void } | null>(null);
  useLayoutEffect(() => () => { running.current?.cancel(); }, [viewerId]);
  return (findTarget: () => HTMLImageElement | null, revealTarget: () => void, onClose: () => void) => {
    if (running.current) return;
    const editor = document.querySelector<HTMLElement>('.study-viewer');
    const gallery = document.querySelector<HTMLElement>('.imagine-app');
    const backdrop = document.querySelector<HTMLElement>('.viewer-backdrop');
    if (!editor || !gallery || reduced()) { revealTarget(); onClose(); return; }
    const source = editor.querySelector<HTMLImageElement | HTMLVideoElement>('.viewer-stage > .viewer-image');
    const sourceBox = source?.getBoundingClientRect();
    let canvas: HTMLCanvasElement | null = null;
    const intrinsicWidth = source instanceof HTMLVideoElement ? source.videoWidth : source?.naturalWidth ?? 0;
    const intrinsicHeight = source instanceof HTMLVideoElement ? source.videoHeight : source?.naturalHeight ?? 0;
    const ready = source instanceof HTMLVideoElement ? source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA : source?.complete === true;
    if (source && ready && intrinsicWidth > 0 && intrinsicHeight > 0 && sourceBox?.width && sourceBox.height) {
      try {
        canvas = document.createElement('canvas');
        const scale = Math.min(1, 2048 / Math.max(intrinsicWidth, intrinsicHeight));
        canvas.width = Math.max(1, Math.round(intrinsicWidth * scale));
        canvas.height = Math.max(1, Math.round(intrinsicHeight * scale));
        const context = canvas.getContext('2d');
        if (context) context.drawImage(source, 0, 0, canvas.width, canvas.height); else canvas = null;
      } catch { canvas = null; }
    }
    const animations: Animation[] = [], frames: number[] = [];
    let layer: HTMLDivElement | null = null, target: HTMLImageElement | null = null, targetVisibility = '';
    let finished = false;
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => {
      if (finished) return;
      finished = true; running.current = null;
      // Radix portals can survive the route update until their deferred cleanup.
      // Keep those retiring nodes transparent when cancelling the filled animations.
      editor.style.opacity = '0';
      if (backdrop) backdrop.style.opacity = '0';
      flushSync(onClose); cleanup();
    };
    const onPreference = () => { if (reduced()) finish(); };
    const keys = (event: KeyboardEvent) => { event.preventDefault(); event.stopPropagation(); };
    const settings = new MutationObserver(onPreference);
    const cleanup = () => {
      frames.forEach(cancelAnimationFrame); animations.forEach(animation => animation.cancel());
      layer?.remove();
      if (target) target.style.visibility = targetVisibility;
      settings.disconnect(); preference.removeEventListener('change', onPreference);
      window.removeEventListener('resize', finish); document.removeEventListener('keydown', keys, true);
      delete document.documentElement.dataset.viewerExit;
    };
    running.current = { cancel: () => { if (finished) return; finished = true; running.current = null; cleanup(); } };
    settings.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    preference.addEventListener('change', onPreference); window.addEventListener('resize', finish);
    document.addEventListener('keydown', keys, true);
    document.documentElement.dataset.viewerExit = 'preparing';
    revealTarget();
    const begin = () => {
      if (finished) return;
      target = findTarget();
      const box = target?.getBoundingClientRect();
      if (canvas && sourceBox && target && box && box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight) {
        targetVisibility = target.style.visibility; target.style.visibility = 'hidden';
        layer = document.createElement('div'); layer.className = 'viewer-exit-layer'; layer.setAttribute('aria-hidden', 'true');
        Object.assign(layer.style, frame(sourceBox)); layer.append(canvas); document.body.append(layer);
        const stage = source!.closest('.viewer-stage')!.getBoundingClientRect();
        const clip = `inset(${Math.max(0, stage.top - sourceBox.top)}px ${Math.max(0, sourceBox.right - stage.right)}px ${Math.max(0, sourceBox.bottom - stage.bottom)}px ${Math.max(0, stage.left - sourceBox.left)}px)`;
        const shrink = layer.animate([{ ...frame(sourceBox), borderRadius: '0px', clipPath: clip }, { ...frame(box), borderRadius: getComputedStyle(target.closest('.study-card')!).borderRadius, clipPath: 'inset(0px)' }], { duration: 320, easing: 'cubic-bezier(.22,.7,.22,1)', fill: 'both' });
        shrink.id = 'viewer-exit-shrink'; animations.push(shrink);
      }
      document.documentElement.dataset.viewerExit = layer ? 'shrinking' : 'fading';
      for (const [element, from, to, name] of [[gallery, '0', '1', 'gallery'], [editor, '1', '0', 'editor'], [backdrop, '1', '0', 'backdrop']] as const) {
        if (!element) continue;
        const animation = element.animate([{ opacity: from }, { opacity: to }], { duration: 320, easing: 'linear', fill: 'both' });
        animation.id = `viewer-exit-${name}`; animations.push(animation);
      }
      void Promise.all(animations.map(animation => animation.finished)).then(finish).catch(() => {});
    };
    // Virtualized cards mount after scrollToIndex; the editor covers that update.
    frames.push(requestAnimationFrame(() => frames.push(requestAnimationFrame(begin))));
  };
}
