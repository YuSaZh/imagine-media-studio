import { useLayoutEffect, useRef } from 'react';
import type { MediaItem } from './data';

export type SlideAxis = 'x' | 'y';
type Neighbor = { item: MediaItem; image: HTMLImageElement };
export interface ViewerMotion {
  attach: (stage: HTMLDivElement | null) => void;
  prepare: (resolve: (axis: SlideAxis, direction: number) => Promise<MediaItem | null>, select: (item: MediaItem) => void, key: string) => void;
  drag: (x: number, y: number, vertical: boolean) => void;
  settle: () => void;
  navigate: (axis: SlideAxis, direction: number, action: () => void | Promise<boolean>) => void;
}
const reducedMotion = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const vector = (axis: SlideAxis, value: number) => axis === 'x' ? `${value}px 0px` : `0px ${value}px`;
const mediaIn = (stage: HTMLDivElement | null) => stage?.querySelector<HTMLImageElement | HTMLVideoElement>('.viewer-image:not([aria-hidden="true"])');

export function useViewerMotion(itemId: string): ViewerMotion {
  const state = useRef<{
    id: string; stage: HTMLDivElement | null;
    neighbors: Map<string, Neighbor | 'loading'>; preparationKey?: string; resolve?: (axis: SlideAxis, direction: number) => Promise<MediaItem | null>; select?: (item: MediaItem) => void;
    drag?: { axis: SlideAxis; direction: number; offset: number; neighbor?: Neighbor; layer?: HTMLDivElement };
    pending?: { id: string; axis: SlideAxis; direction: number; offset: number; outgoing: HTMLDivElement; incoming?: HTMLDivElement; expectedId?: string; started?: boolean };
    layers: Set<HTMLDivElement>; animations: Animation[]; version: number;
  }>({ id: itemId, stage: null, neighbors: new Map(), layers: new Set(), animations: [], version: 0 });
  const motion = useRef<ViewerMotion | null>(null);
  const clear = (keep: HTMLDivElement[] = []) => {
    const current = state.current; current.version++;
    current.animations.forEach(animation => animation.cancel()); current.animations = [];
    for (const layer of current.layers) if (!keep.includes(layer)) layer.remove();
    current.layers = new Set(keep); delete current.pending; delete current.drag;
    const media = mediaIn(current.stage);
    if (media) { media.style.translate = ''; media.style.visibility = ''; }
    if (current.stage) delete current.stage.dataset.slideAxis;
  };
  const createLayer = (stage: HTMLDivElement, className: string) => {
    const layer = document.createElement('div'); layer.className = className; layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { position: 'absolute', left: '0px', top: '0px', width: `${stage.clientWidth}px`, height: `${stage.clientHeight}px`, overflow: 'hidden', pointerEvents: 'none', zIndex: '1' });
    stage.append(layer); state.current.layers.add(layer); return layer;
  };
  const updateDrag = () => {
    const current = state.current, drag = current.drag, stage = current.stage;
    if (!drag || !stage) return;
    const neighbor = current.neighbors.get(`${drag.axis}:${drag.direction}`);
    if (!drag.layer) {
      if (!neighbor || neighbor === 'loading') return;
      drag.neighbor = neighbor;
      const layer = createLayer(stage, 'viewer-drag-neighbor'); layer.dataset.assetId = neighbor.item.id;
      const image = document.createElement('img'); image.src = neighbor.image.src; image.alt = '';
      const style = getComputedStyle(stage), left = parseFloat(style.paddingLeft), top = parseFloat(style.paddingTop);
      const width = stage.clientWidth - left - parseFloat(style.paddingRight), height = stage.clientHeight - top - parseFloat(style.paddingBottom);
      const ratio = Math.min(1, width / neighbor.item.width, height / neighbor.item.height);
      Object.assign(image.style, { position: 'absolute', left: `${left + (width - neighbor.item.width * ratio) / 2}px`, top: `${top + (height - neighbor.item.height * ratio) / 2}px`, width: `${neighbor.item.width * ratio}px`, height: `${neighbor.item.height * ratio}px`, objectFit: 'contain' });
      layer.append(image); drag.layer = layer;
    }
    const distance = (drag.axis === 'x' ? stage.clientWidth : stage.clientHeight) * drag.direction;
    drag.layer.style.translate = vector(drag.axis, distance + drag.offset);
  };
  const loadNeighbor = (axis: SlideAxis, direction: number) => {
    const current = state.current, id = current.id, preparationKey = current.preparationKey;
    const key = `${axis}:${direction}`;
    if (!current.resolve || current.neighbors.has(key)) return;
    current.neighbors.set(key, 'loading');
    void current.resolve(axis, direction).then(async item => {
      if (!item || item.id === id) return null;
      // At most four small previews; opening a neighbor remains the only full-media load.
      const image = new Image(); image.src = item.thumbnail;
      await image.decode(); return { item, image };
    }).catch(() => null).then(neighbor => {
      if (current.id !== id || current.preparationKey !== preparationKey) return;
      if (neighbor) current.neighbors.set(key, neighbor); else current.neighbors.delete(key);
      updateDrag();
    });
  };
  const animateIncoming = () => {
    const current = state.current, pending = current.pending, stage = current.stage;
    if (!pending || pending.started || pending.id === current.id || !stage) return;
    pending.started = true;
    const media = mediaIn(stage);
    if (!media) { clear(); return; }
    const version = current.version, axis = pending.axis;
    media.style.visibility = 'hidden';
    const poster = media instanceof HTMLVideoElement && media.poster ? new Image() : null;
    if (poster && media instanceof HTMLVideoElement) poster.src = media.poster;
    const ready = media instanceof HTMLImageElement ? media.decode().catch(() => undefined) : poster?.decode().catch(() => undefined) ?? Promise.resolve();
    void ready.then(() => {
      if (version !== current.version) return;
      if (!media.isConnected) { clear(); return; }
      const distance = (axis === 'x' ? stage.clientWidth : stage.clientHeight) * pending.direction;
      const progress = Math.min(1, Math.abs(pending.offset / distance));
      const options = { duration: Math.max(100, (axis === 'x' ? 280 : 320) * (1 - progress)), easing: 'cubic-bezier(.22,.7,.22,1)' };
      stage.dataset.slideAxis = axis;
      const outgoing = pending.outgoing.animate([{ translate: '0px 0px' }, { translate: vector(axis, -distance - pending.offset) }], options);
      let incoming: Animation;
      if (pending.incoming && pending.expectedId === current.id) {
        const layer = pending.incoming, visual = layer.querySelector('img')!;
        const box = media.getBoundingClientRect(), bounds = stage.getBoundingClientRect();
        const geometry = visual.animate([
          { left: visual.style.left, top: visual.style.top, width: visual.style.width, height: visual.style.height },
          { left: `${box.left - bounds.left}px`, top: `${box.top - bounds.top}px`, width: `${box.width}px`, height: `${box.height}px` },
        ], options);
        incoming = layer.animate([{ translate: layer.style.translate }, { translate: '0px 0px' }], options);
        current.animations.push(geometry);
      } else {
        pending.incoming?.remove(); media.style.visibility = '';
        incoming = media.animate([{ translate: vector(axis, distance + pending.offset) }, { translate: '0px 0px' }], options);
      }
      current.animations.push(outgoing, incoming);
      void incoming.finished.then(() => { if (version === current.version) clear(); }).catch(() => undefined);
    });
  };
  if (!motion.current) motion.current = {
    attach: stage => {
      const current = state.current;
      const layers = current.pending ? [current.pending.outgoing, current.pending.incoming].filter((layer): layer is HTMLDivElement => !!layer) : [];
      if (!stage && current.stage) for (const layer of layers) {
        const box = current.stage.getBoundingClientRect();
        Object.assign(layer.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, zIndex: '46' }); document.body.append(layer);
      }
      current.stage = stage;
      if (stage) for (const layer of layers) {
        Object.assign(layer.style, { position: 'absolute', left: '0px', top: '0px', zIndex: '1' }); stage.append(layer);
      }
      animateIncoming();
    },
    prepare: (resolve, select, key) => {
      const current = state.current;
      if (current.preparationKey !== key) { current.neighbors.clear(); current.preparationKey = key; }
      current.resolve = resolve; current.select = select;
      for (const axis of ['x', 'y'] as const) for (const direction of [-1, 1]) loadNeighbor(axis, direction);
    },
    drag: (x, y, vertical) => {
      const current = state.current;
      if (reducedMotion() || current.pending || Math.max(Math.abs(x), Math.abs(y)) < 6) return;
      if (!current.drag) clear();
      const axis = !vertical ? 'x' : Math.abs(y) > Math.abs(x) * 1.25 ? 'y' : Math.abs(x) > Math.abs(y) * 1.25 ? 'x' : current.drag?.axis ?? 'x';
      const offset = axis === 'x' ? x : y, direction = offset < 0 ? 1 : -1;
      if (current.drag?.axis !== axis || current.drag.direction !== direction) {
        if (current.drag?.layer) { current.drag.layer.remove(); current.layers.delete(current.drag.layer); }
        current.drag = { axis, direction, offset };
      } else current.drag.offset = offset;
      const media = mediaIn(current.stage);
      if (media) media.style.translate = vector(axis, offset);
      loadNeighbor(axis, direction); updateDrag();
    },
    settle: () => {
      const current = state.current, media = mediaIn(current.stage), drag = current.drag;
      if (!media || current.pending || !drag) return;
      const version = ++current.version; delete current.drag;
      const from = media.style.translate; media.style.translate = '';
      if (reducedMotion()) { clear(); return; }
      const options = { duration: 180, easing: 'ease-out' };
      const animation = media.animate([{ translate: from }, { translate: '0px 0px' }], options); current.animations.push(animation);
      if (drag.layer && current.stage) {
        const distance = (drag.axis === 'x' ? current.stage.clientWidth : current.stage.clientHeight) * drag.direction;
        current.animations.push(drag.layer.animate([{ translate: drag.layer.style.translate }, { translate: vector(drag.axis, distance) }], options));
      }
      void animation.finished.then(() => { if (version === current.version) clear(); }).catch(() => undefined);
    },
    navigate: (axis, direction, action) => {
      const current = state.current, stage = current.stage;
      if (current.pending?.id === current.id) return;
      const media = mediaIn(stage), drag = current.drag?.axis === axis && current.drag.direction === direction ? current.drag : undefined;
      let outgoing: HTMLDivElement | undefined;
      if (stage && media && !reducedMotion()) {
        const bounds = stage.getBoundingClientRect(), box = media.getBoundingClientRect();
        const decoded = media instanceof HTMLVideoElement ? media.readyState >= 2 : media.complete && media.naturalWidth > 0;
        const visual = decoded ? document.createElement('canvas') : document.createElement('img');
        if (visual instanceof HTMLCanvasElement) {
          const scale = Math.min(devicePixelRatio || 1, 2048 / Math.max(box.width, box.height, 1));
          visual.width = Math.max(1, Math.round(box.width * scale)); visual.height = Math.max(1, Math.round(box.height * scale));
          visual.getContext('2d')?.drawImage(media, 0, 0, visual.width, visual.height);
        } else if (visual instanceof HTMLImageElement) visual.src = media instanceof HTMLVideoElement ? media.poster : media.currentSrc || media.src;
        Object.assign(visual.style, { position: 'absolute', left: `${box.left - bounds.left}px`, top: `${box.top - bounds.top}px`, width: `${box.width}px`, height: `${box.height}px`, objectFit: 'contain' });
        outgoing = createLayer(stage, 'viewer-slide-overlay'); outgoing.append(visual);
      }
      clear([outgoing, outgoing ? drag?.layer : undefined].filter((layer): layer is HTMLDivElement => !!layer));
      if (outgoing && media) {
        media.style.visibility = 'hidden';
        current.pending = { id: current.id, axis, direction, offset: drag?.offset ?? 0, outgoing, ...(drag?.layer ? { incoming: drag.layer, expectedId: drag.neighbor!.item.id } : {}) };
      }
      const result = drag?.neighbor ? current.select?.(drag.neighbor.item) : action();
      if (result) void result.then(moved => { if (!moved && current.pending?.id === current.id) clear(); }).catch(() => clear());
    },
  };
  useLayoutEffect(() => {
    if (state.current.id !== itemId) state.current.neighbors.clear();
    state.current.id = itemId; animateIncoming();
  }, [itemId]);
  useLayoutEffect(() => () => clear(), []);
  return motion.current;
}
