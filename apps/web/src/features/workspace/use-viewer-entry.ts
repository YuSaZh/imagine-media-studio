import { useLayoutEffect, useRef, useState } from 'react';
import type { MediaItem } from './data';
import { viewerMediaBounds } from './viewer-media-geometry';

export interface ViewerEntryMotion {
  start: (item: MediaItem, thumbnail: HTMLImageElement | null, onClose: () => void) => void;
  attach: (stage: HTMLElement, id: string) => void;
  cancel: () => void;
}
const reduced = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const frame = (box: { left: number; top: number; width: number; height: number }) => ({ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });

export function useViewerEntry(viewerId: string | null) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const current = useRef<{
    item: MediaItem; layer: HTMLDivElement; source: HTMLImageElement; visibility: string;
    stage?: HTMLElement; observer?: ResizeObserver; animation?: Animation; started?: number;
    cleanup: () => void; frames: number[]; sceneAnimations: Animation[];
  } | null>(null);
  const controller = useRef<ViewerEntryMotion | null>(null);
  if (!controller.current) {
    const clear = () => {
      const entry = current.current;
      current.current = null;
      if (entry) {
        entry.cleanup(); entry.observer?.disconnect(); entry.animation?.cancel();
        entry.sceneAnimations.forEach(animation => animation.cancel());
        entry.frames.forEach(cancelAnimationFrame); entry.layer.remove();
        entry.source.style.visibility = entry.visibility;
      }
      delete document.documentElement.dataset.viewerEntry;
      setActiveId(null);
    };
    const reveal = () => {
      const entry = current.current;
      if (!entry?.stage) { clear(); return; }
      entry.animation?.cancel(); delete entry.animation;
      Object.assign(entry.layer.style, frame(viewerMediaBounds(entry.stage, entry.item.width, entry.item.height)), { borderRadius: '0px' });
      document.documentElement.dataset.viewerEntry = 'revealing';
      entry.sceneAnimations.forEach(animation => animation.cancel()); entry.sceneAnimations = [];
      // The scene crossfade has already finished alongside the zoom. Paint the
      // editor's thumbnail underneath before removing the opaque shared visual.
      entry.frames.push(requestAnimationFrame(() => entry.frames.push(requestAnimationFrame(() => { if (current.current === entry) clear(); }))));
    };
    const move = () => {
      const entry = current.current;
      if (!entry?.stage || !entry.stage.isConnected) return;
      const target = viewerMediaBounds(entry.stage, entry.item.width, entry.item.height);
      if (document.documentElement.dataset.viewerEntry === 'revealing') { Object.assign(entry.layer.style, frame(target)); return; }
      const from = entry.layer.getBoundingClientRect(), radius = getComputedStyle(entry.layer).borderRadius;
      const gallery = document.querySelector<HTMLElement>('.imagine-app');
      const editor = entry.stage.closest<HTMLElement>('.study-viewer');
      const galleryOpacity = gallery ? getComputedStyle(gallery).opacity : '1';
      const editorOpacity = editor ? getComputedStyle(editor).opacity : '0';
      entry.animation?.cancel();
      entry.sceneAnimations.forEach(animation => animation.cancel()); entry.sceneAnimations = [];
      Object.assign(entry.layer.style, frame(target), { borderRadius: '0px' });
      if (reduced()) { reveal(); return; }
      entry.started ??= performance.now();
      const duration = Math.max(80, 320 - (performance.now() - entry.started));
      document.documentElement.dataset.viewerEntry = 'expanding';
      const animation = entry.layer.animate([{ ...frame(from), borderRadius: radius }, { ...frame(target), borderRadius: '0px' }], { duration, easing: 'cubic-bezier(.22,.7,.22,1)', fill: 'both' });
      animation.id = 'viewer-entry-expand'; entry.animation = animation;
      for (const [element, opacity, targetOpacity, id] of [[gallery, galleryOpacity, '0', 'gallery'], [editor, editorOpacity, '1', 'editor']] as const) {
        if (!element) continue;
        const fade = element.animate([{ opacity }, { opacity: targetOpacity }], { duration, easing: 'linear', fill: 'both' });
        fade.id = `viewer-entry-${id}`; entry.sceneAnimations.push(fade);
      }
      void animation.finished.then(() => { if (current.current === entry && entry.animation === animation) reveal(); }).catch(() => {});
    };
    controller.current = {
      cancel: clear,
      start: (item, source, onClose) => {
        clear();
        if (reduced() || !source?.complete || !source.naturalWidth || !source.getClientRects().length) return;
        const bounds = source.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 2048 / Math.max(source.naturalWidth, source.naturalHeight));
        canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
        const context = canvas.getContext('2d'); if (!context) return;
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const layer = document.createElement('div'); layer.className = 'viewer-entry-layer'; layer.dataset.assetId = item.id; layer.setAttribute('aria-hidden', 'true');
        Object.assign(layer.style, frame(bounds), { borderRadius: getComputedStyle(source.closest('.study-card') ?? source).borderRadius });
        layer.append(canvas); document.body.append(layer);
        const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clear(); onClose(); } };
        const preference = matchMedia('(prefers-reduced-motion: reduce)');
        const onPreference = () => { if (reduced()) reveal(); };
        const settings = new MutationObserver(onPreference);
        settings.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
        preference.addEventListener('change', onPreference); document.addEventListener('keydown', keydown, true);
        current.current = { item, source, layer, visibility: source.style.visibility, frames: [], sceneAnimations: [], cleanup: () => { settings.disconnect(); preference.removeEventListener('change', onPreference); document.removeEventListener('keydown', keydown, true); } };
        source.style.visibility = 'hidden'; document.documentElement.dataset.viewerEntry = 'preparing'; setActiveId(item.id);
      },
      attach: (stage, id) => {
        const entry = current.current;
        if (!entry || entry.item.id !== id || entry.stage === stage) return;
        entry.stage = stage;
        entry.observer?.disconnect(); entry.observer = new ResizeObserver(move); entry.observer.observe(stage);
        move();
      },
    };
  }
  useLayoutEffect(() => { if (current.current && current.current.item.id !== viewerId) controller.current!.cancel(); }, [viewerId]);
  useLayoutEffect(() => () => controller.current!.cancel(), []);
  return { motion: controller.current, activeId };
}
