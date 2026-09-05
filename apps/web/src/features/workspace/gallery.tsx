import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bookmark, Check, CheckCheck, Image as ImageIcon, MoreHorizontal, Play, RefreshCw, Trash2 } from 'lucide-react';
import { createSelectionGestureState, LONG_PRESS_DURATION_MS, reduceSelectionGesture } from '../gallery/model/selection-gesture';
import type { MediaItem } from './data';
import { Choice, Options } from './ui';

interface GalleryProps {
  items: MediaItem[];
  scrollRef: RefObject<HTMLElement | null>;
  selecting: boolean;
  selected: readonly string[];
  online: boolean;
  onPick: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  onSave: (item: MediaItem) => void;
  onDelete: (item: MediaItem) => void;
  hasMore: boolean;
  fetching: boolean;
  error: boolean;
  onMore: () => void;
  onRetry: () => void;
}

function durationLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function Card({ item, props }: { item: MediaItem; props: GalleryProps }) {
  const [broken, setBroken] = useState(false);
  const gesture = useRef(createSelectionGestureState());
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClick = useRef(false);
  const selected = props.selected.includes(item.id);
  const reset = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    gesture.current = createSelectionGestureState();
  };
  useEffect(() => {
    const element = props.scrollRef.current;
    element?.addEventListener('scroll', reset, { passive: true });
    return () => { element?.removeEventListener('scroll', reset); reset(); };
  }, [props.scrollRef]);

  return <article className={`study-card ${selected ? 'is-selected' : ''}`} data-study-id={item.id}>
    <button className="study-open" aria-label={`查看 ${item.title}`} aria-pressed={props.selecting ? selected : undefined}
      onPointerDown={event => {
        suppressClick.current = false;
        const next = reduceSelectionGesture(gesture.current, { type: 'pointerdown', pointerId: event.pointerId, pointerType: event.pointerType, clientX: event.clientX, clientY: event.clientY, interactiveTarget: false });
        gesture.current = next;
        if (next.phase === 'pending') timeout.current = setTimeout(() => {
          const triggered = reduceSelectionGesture(gesture.current, { type: 'long-press', pointerId: event.pointerId });
          gesture.current = triggered;
          if (triggered.phase === 'triggered') { suppressClick.current = true; props.onSelect(item); }
        }, LONG_PRESS_DURATION_MS);
      }}
      onPointerMove={event => {
        gesture.current = reduceSelectionGesture(gesture.current, { type: 'pointermove', pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY });
        if (gesture.current.phase !== 'pending' && timeout.current) clearTimeout(timeout.current);
      }}
      onPointerUp={reset} onPointerCancel={reset}
      onContextMenu={event => { event.preventDefault(); if (!suppressClick.current) { suppressClick.current = true; props.onSelect(item); } }}
      onClick={event => {
        if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; }
        if (event.shiftKey) props.onSelect(item); else props.onPick(item);
      }}>
      {broken ? <span className="media-unavailable"><ImageIcon size={25} /><span>预览不可用</span></span> : <img src={item.thumbnail} alt={item.title} loading="lazy" draggable={false} onError={() => setBroken(true)} />}
      {item.kind === 'video' && <span className="video-tag"><Play size={11} fill="currentColor" />{durationLabel(item.durationSeconds ?? 0)}</span>}
      <span className="study-caption"><strong>{item.title}</strong><span>{item.model}</span></span>
      {props.selecting && <span className="select-mark">{selected && <Check size={17} />}</span>}
    </button>
    {!props.selecting && <>
      <button className={`card-bookmark ${item.saved ? 'is-saved' : ''}`} disabled={!props.online} aria-label={item.saved ? `取消收藏 ${item.title}` : `收藏 ${item.title}`} onClick={() => props.onSave(item)}><Bookmark size={17} fill={item.saved ? 'currentColor' : 'none'} /></button>
      <Options label={`${item.title} 更多操作`} className="card-more" trigger={<MoreHorizontal size={19} />}>
        <Choice active={false} onClick={() => props.onSelect(item)}><CheckCheck size={15} />选择作品</Choice>
        {props.online && <Choice active={false} onClick={() => props.onDelete(item)}><Trash2 size={15} />删除</Choice>}
      </Options>
    </>}
  </article>;
}

export function Gallery(props: GalleryProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 1000, margin: 0 });
  const columns = layout.width < 560 ? 2 : layout.width < 920 ? 3 : 4;
  const gap = layout.width < 560 ? 8 : 12;
  const width = Math.max(1, (layout.width - gap * (columns - 1)) / columns);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    getScrollElement: () => props.scrollRef.current,
    getItemKey: index => props.items[index]?.id ?? index,
    estimateSize: index => width * Math.max(.5, Math.min(1.8, (props.items[index]?.height ?? 1) / (props.items[index]?.width ?? 1))),
    lanes: columns, gap, overscan: 6, scrollMargin: layout.margin,
  });
  useLayoutEffect(() => {
    const measure = () => {
      const grid = gridRef.current;
      const scroll = props.scrollRef.current;
      if (!grid || !scroll) return;
      const width = grid.clientWidth;
      const margin = grid.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      setLayout(current => current.width === width && Math.abs(current.margin - margin) < .5 ? current : { width, margin });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (gridRef.current) observer.observe(gridRef.current);
    return () => observer.disconnect();
  });
  useEffect(() => { virtualizer.measure(); }, [width, columns, virtualizer]);
  useEffect(() => {
    if (!sentinel.current || !props.hasMore || props.fetching || props.error) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) props.onMore(); }, { root: props.scrollRef.current, rootMargin: '500px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [props]);

  return <>
    <div className="study-grid virtual-studies" ref={gridRef} style={{ height: virtualizer.getTotalSize() }} aria-label="作品网格">
      {virtualizer.getVirtualItems().map(virtual => {
        const item = props.items[virtual.index];
        return item ? <div key={item.id} className="virtual-study" style={{ width, height: virtual.size, left: (virtual.lane ?? virtual.index % columns) * (width + gap), transform: `translateY(${virtual.start - layout.margin}px)` }}><Card item={item} props={props} /></div> : null;
      })}
    </div>
    <div className="gallery-pagination" ref={sentinel}>
      {props.error ? <button className="quiet-command" onClick={props.onRetry}><RefreshCw size={15} />加载失败，重试</button> : props.fetching ? <span role="status">正在加载作品…</span> : props.hasMore ? <button className="quiet-command" onClick={props.onMore}>加载更多作品</button> : props.items.length ? <span>已显示全部作品</span> : null}
    </div>
  </>;
}
