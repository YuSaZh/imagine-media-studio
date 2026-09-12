import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Bookmark, ChevronLeft, ChevronRight, Download, Info } from 'lucide-react';
import { VIEWER_EDGE_BACK_WIDTH, VIEWER_EDGE_BACK_THRESHOLD, createViewerGestureState, setViewerGestureTransform, transitionViewerGesture, type ViewerGestureLayout } from '../viewer/model/viewer-gestures';
import { mediaExtension, type MediaItem, type Project } from './data';
import { Tool } from './ui';
import type { ViewerMotion } from './viewer-motion';
import { ViewerInfo } from './viewer-info';

export interface ViewerProps {
  motion?: ViewerMotion;
  editingControls?: ReactNode;
  canPrevious?: boolean;
  canNext?: boolean;
  onMoveEntry?: (delta: number) => void;
  stageContent?: ReactNode;
  videoRef?: RefObject<HTMLVideoElement | null>;
  initialVideoTime?: number;
  onVideoTime?: (time: number) => void;
  previewSrc?: string;
  onStageClick?: () => void;
  item: MediaItem;
  index: number;
  total: number;
  projects: Project[];
  online: boolean;
  busy: boolean;
  providerName: string;
  onClose: () => void;
  onMove: (delta: number) => void;
  onSave: () => void;
  onDelete: () => void;
  onProject: (project: string, included: boolean) => void;
  onNotice: (text: string) => void;
}

export function Viewer(props: ViewerProps) {
  const { item } = props;
  const image = !props.stageContent && (item.kind === 'image' || props.previewSrc !== undefined);
  const [info, setInfo] = useState(false);
  const infoId = useId();
  const [mediaError, setMediaError] = useState(false);
  const [gesture, setGesture] = useState(createViewerGestureState);
  const gestureRef = useRef(gesture);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageNode, setStageNode] = useState<HTMLDivElement | null>(null);
  const mountStage = useCallback((node: HTMLDivElement | null) => { stageRef.current = node; setStageNode(node); props.motion?.attach(node); }, [props.motion]);
  const focusRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const lastTap = useRef(0);

  useEffect(() => {
    const initial = createViewerGestureState();
    gestureRef.current = initial; setGesture(initial); setMediaError(false); lastTap.current = 0;
  }, [item.id, image]);

  useEffect(() => { setMediaError(false); }, [props.previewSrc]);
  const layout = (): ViewerGestureLayout => {
    const stage = stageRef.current!;
    const box = stage.getBoundingClientRect();
    const media = stage.querySelector('.viewer-image')?.getBoundingClientRect();
    return { center: { x: media ? media.left + media.width / 2 - gestureRef.current.position.x : box.left + box.width / 2, y: media ? media.top + media.height / 2 - gestureRef.current.position.y : box.top + box.height / 2 }, media: { width: (media?.width ?? box.width) / gestureRef.current.scale, height: (media?.height ?? box.height) / gestureRef.current.scale }, viewport: { width: box.width, height: box.height } };
  };
  const apply = (transition: ReturnType<typeof transitionViewerGesture>) => {
    gestureRef.current = transition.state; setGesture(transition.state);
    const { mode, startPoint, lastPoint } = transition.state;
    if (mode === 'swipe' && startPoint && lastPoint) props.motion?.drag(lastPoint.x - startPoint.x, lastPoint.y - startPoint.y, matchMedia('(max-width: 760px)').matches);
    else if (['none', 'tap', 'double-tap'].includes(transition.effect)) props.motion?.settle();
    if (transition.effect === 'close') props.onClose();
    if (transition.effect === 'next') props.onMove(1);
    if (transition.effect === 'previous') props.onMove(-1);
    if (transition.effect === 'next-entry') props.onMoveEntry?.(1);
    if (transition.effect === 'previous-entry') props.onMoveEntry?.(-1);
  };
  useEffect(() => {
    const stage = stageNode;
    if (!stage || !image) return;
    const wheel = (event: WheelEvent) => {
      if (!matchMedia('(min-width: 761px)').matches || (event.target as HTMLElement).closest('button,video')) return;
      event.preventDefault();
      const state = gestureRef.current, bounds = layout();
      const scale = Math.max(1, Math.min(4, state.scale * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.03 : 0.002))));
      const anchor = { x: event.clientX - bounds.center.x, y: event.clientY - bounds.center.y };
      const position = { x: anchor.x - (anchor.x - state.position.x) * scale / state.scale, y: anchor.y - (anchor.y - state.position.y) * scale / state.scale };
      const next = setViewerGestureTransform(state, scale, position, bounds);
      gestureRef.current = next; setGesture(next);
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, [item.id, image, stageNode]);
  const writeDisabled = !props.online || props.busy || !!props.stageContent;
  return <Dialog.Root open onOpenChange={open => !open && props.onClose()}><Dialog.Portal>
    <Dialog.Overlay className="viewer-backdrop" />
    <Dialog.Content className={`study-viewer ${item.kind === 'image' ? 'image-editing-viewer' : 'video-editing-viewer'} ${info ? 'has-info' : ''}`} aria-describedby={undefined}
      onPointerDownCapture={event => {
        if (info && matchMedia('(max-width: 760px)').matches && !(event.target as Element).closest('.viewer-info, .viewer-info-projects, .viewer-info-trigger')) setInfo(false);
      }}
      onEscapeKeyDown={event => { if (info) { event.preventDefault(); setInfo(false); } }}
      onCloseAutoFocus={event => { event.preventDefault(); if (focusRef.current?.isConnected) focusRef.current.focus(); }}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest('input,textarea,select,video')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.onMove(event.key === 'ArrowLeft' ? -1 : 1); }
      }}>
      <header className="viewer-heading"><div className="viewer-heading-main"><Dialog.Close asChild><button type="button" className="tool" aria-label="返回作品"><ArrowLeft size={20} /></button></Dialog.Close><Dialog.Title>{item.title}</Dialog.Title><span className="viewer-index">{props.index + 1} / {props.total}</span></div><div className="viewer-heading-actions">
        <Tool label={item.saved ? '取消收藏' : '收藏作品'} disabled={writeDisabled} className={item.saved ? 'is-saved' : ''} onClick={props.onSave}><Bookmark size={18} fill={item.saved ? 'currentColor' : 'none'} /></Tool>
        <a className="tool" aria-label="下载原文件" title="下载原文件" aria-disabled={writeDisabled} href={!writeDisabled ? item.src : undefined} download={`${item.title.slice(0, 60)}.${mediaExtension(item)}`}><Download size={19} /></a>
        <Tool label="作品信息" className="viewer-info-trigger" disabled={!!props.stageContent} aria-pressed={info} aria-expanded={info} aria-controls={info ? infoId : undefined} onClick={() => setInfo(!info)}><Info size={19} /></Tool>
      </div></header>
      <div className="viewer-workspace">
        <div className="viewer-stage" ref={mountStage} data-viewer-scale={gesture.scale} onClick={event => { if (!(event.target as HTMLElement).closest('button,a,video')) props.onStageClick?.(); }}
          onDoubleClick={event => { if (image && !(event.target as HTMLElement).closest('button,a,video') && Date.now() - lastTap.current > 400) apply(transitionViewerGesture(gestureRef.current, { type: 'doubletap', layout: layout() })); }}
          onPointerDown={event => {
            if ((event.target as HTMLElement).closest('button,a')) return;
            if ((event.target as HTMLElement).closest('video')) {
              const box = (event.target as HTMLElement).getBoundingClientRect();
              if (event.pointerType !== 'touch' || matchMedia('(min-width: 761px)').matches || event.clientY > box.bottom - 52) return;
            }
            if (event.pointerType === 'mouse') event.preventDefault();
            apply(transitionViewerGesture(gestureRef.current, { type: 'pointerdown', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout(), allowEdgeBack: event.pointerType === 'touch' && matchMedia('(max-width: 760px)').matches && event.clientX >= 0 && event.clientX <= VIEWER_EDGE_BACK_WIDTH }));
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => { if (gestureRef.current.pointers.has(event.pointerId)) apply(transitionViewerGesture(gestureRef.current, { type: 'pointermove', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout() })); }}
          onPointerUp={event => {
            const transition = transitionViewerGesture(gestureRef.current, { type: 'pointerup', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout(), allowVerticalSwipe: event.pointerType === 'touch' && matchMedia('(max-width: 760px)').matches });
            apply(transition);
            if (image && event.pointerType === 'touch' && transition.effect === 'tap') {
              const now = Date.now();
              if (now - lastTap.current < 320) apply(transitionViewerGesture(gestureRef.current, { type: 'doubletap', layout: layout() }));
              lastTap.current = now;
            }
          }}
          onLostPointerCapture={event => apply(transitionViewerGesture(gestureRef.current, { type: 'lostcapture', pointerId: event.pointerId }))}
          onPointerCancel={event => apply(transitionViewerGesture(gestureRef.current, { type: 'pointercancel', pointerId: event.pointerId }))}>
          {props.stageContent ?? (mediaError ? <p className="media-error" role="alert">原文件暂时无法加载<button className="quiet-command" onClick={() => setMediaError(false)}>重试</button></p> : <>
            {image && <img className="viewer-image" src={props.previewSrc ?? (props.online ? item.src : item.thumbnail)} alt={item.title} draggable={false} onError={() => setMediaError(true)} style={{ transform: `translate(${gesture.position.x}px, ${gesture.position.y}px) scale(${gesture.scale})` }} />}
            {item.kind === 'video' && (props.online ? <video key={item.id} ref={props.videoRef} src={item.src} poster={item.poster ?? undefined} controls playsInline preload="auto" className="viewer-image viewer-source-video" aria-label="原视频" aria-hidden={image} style={image ? { display: 'none' } : undefined} onLoadedMetadata={event => { const video = event.currentTarget, time = props.initialVideoTime ?? 0; if (time > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration); }} onTimeUpdate={event => props.onVideoTime?.(event.currentTarget.currentTime)} onSeeked={event => props.onVideoTime?.(event.currentTarget.currentTime)} onError={() => { if (!image) setMediaError(true); }} /> : !image && <img className="viewer-image" src={item.poster ?? item.thumbnail} alt={item.title} />)}
          </>)}

          {gesture.mode === 'edge-back' && gesture.startPoint && gesture.lastPoint && gesture.lastPoint.x > gesture.startPoint.x && <span className="viewer-edge-back" aria-hidden="true" style={{ opacity: Math.min(1, (gesture.lastPoint.x - gesture.startPoint.x) / VIEWER_EDGE_BACK_THRESHOLD) }}><ChevronLeft size={24} /></span>}
          <Tool label="上一张作品" className="viewer-arrow previous" disabled={!(props.canPrevious ?? props.total > 1)} onClick={() => props.onMove(-1)}><ChevronLeft size={23} /></Tool>
          <Tool label="下一张作品" className="viewer-arrow next" disabled={!(props.canNext ?? props.total > 1)} onClick={() => props.onMove(1)}><ChevronRight size={23} /></Tool>

        </div>
        {info && !props.stageContent && <ViewerInfo key={item.id} {...props} id={infoId} writeDisabled={writeDisabled} onClose={() => setInfo(false)} />}
      </div>
      {props.editingControls}

    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
