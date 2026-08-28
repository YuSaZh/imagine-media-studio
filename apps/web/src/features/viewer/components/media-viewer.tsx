import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  ImagePlus,
  Pencil,
  RotateCcw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { IconButton } from '../../../components/icon-button';
import { useUiStore } from '../../../stores/ui-store';
import { isVisualFixtureMode } from '../../../visual-fixture';
import { useGalleryActions } from '../../gallery/api/gallery-query';
import { VIDEO_PLACEHOLDER_PATH } from '../../gallery/model/api-mapper';
import type { FixtureGalleryItem } from '../../gallery/model/types';
import { canContinueWithImageInput } from '../../gallery/model/input-eligibility';
import {
  createViewerGestureState,
  setViewerGestureTransform,
  transitionViewerGesture,
  type ViewerGestureLayout,
  type ViewerGestureMode,
  type ViewerGestureState,
} from '../model/viewer-gestures';

interface MediaViewerProps {
  items: readonly FixtureGalleryItem[];
}

export function VideoPreview({
  alt,
  errorMessage,
  messageRole = 'alert',
  onError,
  posterPath,
  sourcePath,
  style,
}: {
  alt: string;
  errorMessage: string | null;
  messageRole?: 'alert' | 'status';
  onError: () => void;
  posterPath: string;
  sourcePath: string;
  style?: CSSProperties;
}) {
  if (errorMessage) {
    return <p aria-live="polite" className="viewer-media-state" role={messageRole}>{errorMessage}</p>;
  }
  return (
    <video
      aria-label={`Video preview: ${alt}`}
      className="viewer-media"
      controls
      onError={onError}
      playsInline
      poster={posterPath || VIDEO_PLACEHOLDER_PATH}
      preload="metadata"
      src={sourcePath}
      style={style}
    />
  );
}

export function isNativeMediaInteractionTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as EventTarget & {
    closest?: (selectors: string) => Element | null;
    tagName?: unknown;
  };
  if (candidate.tagName === 'VIDEO' || candidate.tagName === 'AUDIO') return true;
  return typeof candidate.closest === 'function' &&
    candidate.closest('video, audio, input[type="range"], [role="slider"]') !== null;
}

export function isViewerGestureInteractionTarget(target: EventTarget | null): boolean {
  if (isNativeMediaInteractionTarget(target)) return true;
  if (!target || typeof target !== 'object') return false;
  const candidate = target as EventTarget & {
    closest?: (selectors: string) => Element | null;
  };
  return typeof candidate.closest === 'function' &&
    candidate.closest('a, button, input, select, textarea, [role="button"], [data-viewer-control]') !== null;
}

export function shouldHandleViewerDoubleClick(
  kind: FixtureGalleryItem['kind'],
  target: EventTarget | null,
): boolean {
  return kind === 'image' && !isViewerGestureInteractionTarget(target);
}

export function formatViewerTime(createdAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u.exec(createdAt.trim());
  return match ? `${match[1]} ${match[2]} UTC` : createdAt;
}

function viewerGestureLayout(stage: HTMLElement, scale: number): ViewerGestureLayout {
  const stageRect = stage.getBoundingClientRect();
  const media = stage.querySelector<HTMLElement>('.viewer-media');
  const mediaRect = media?.getBoundingClientRect();
  const normalizedScale = Math.max(1, scale);
  return {
    center: {
      x: stageRect.left + stageRect.width / 2,
      y: stageRect.top + stageRect.height / 2,
    },
    media: {
      height: mediaRect ? mediaRect.height / normalizedScale : stageRect.height,
      width: mediaRect ? mediaRect.width / normalizedScale : stageRect.width,
    },
    viewport: {
      height: stageRect.height,
      width: stageRect.width,
    },
  };
}

export function MediaViewer({ items }: MediaViewerProps) {
  const navigate = useNavigate();
  const viewerAssetId = useUiStore((state) => state.viewerAssetId);
  const closeViewer = useUiStore((state) => state.closeViewer);
  const addComposerInput = useUiStore((state) => state.addComposerInput);
  const setComposerPrimaryInput = useUiStore((state) => state.setComposerPrimaryInput);
  const setComposerMode = useUiStore((state) => state.setComposerMode);
  const setComposerExpanded = useUiStore((state) => state.setComposerExpanded);
  const actions = useGalleryActions();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const previousViewerAssetId = useRef<string | null>(null);
  const gestureRef = useRef<ViewerGestureState>(createViewerGestureState());
  const capturedPointerIds = useRef<Set<number>>(new Set());
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const lastTouchDoubleTapAt = useRef(0);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [gestureMode, setGestureMode] = useState<ViewerGestureMode>('idle');
  const [viewerAnnouncement, setViewerAnnouncement] = useState('');
  const [videoPlaybackError, setVideoPlaybackError] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const currentIndex =
    viewerAssetId === null ? -1 : items.findIndex((item) => item.id === viewerAssetId);
  const item = items[currentIndex];

  useLayoutEffect(() => {
    if (previousViewerAssetId.current === null && viewerAssetId !== null) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    if (previousViewerAssetId.current !== null && viewerAssetId === null) {
      returnFocusRef.current?.focus();
    }
    previousViewerAssetId.current = viewerAssetId;
  }, [viewerAssetId]);

  useEffect(() => {
    gestureRef.current = createViewerGestureState();
    lastTapRef.current = null;
    lastTouchDoubleTapAt.current = 0;
    setScale(gestureRef.current.scale);
    setPosition(gestureRef.current.position);
    setGestureMode(gestureRef.current.mode);
    setViewerAnnouncement(item ? `${item.kind === 'video' ? 'Video' : 'Image'} ${currentIndex + 1} of ${items.length}` : '');
    setVideoPlaybackError(false);
    setCopyStatus('');
  }, [currentIndex, item?.id, item?.kind, items.length]);

  const move = (offset: number) => {
    if (items.length === 0) return;
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    const next = items[nextIndex];
    if (next) useUiStore.getState().openViewer(next.id);
  };

  const setZoom = (nextScale: number) => {
    const layout = stageRef.current
      ? viewerGestureLayout(stageRef.current, gestureRef.current.scale)
      : undefined;
    const next = setViewerGestureTransform(
      gestureRef.current,
      nextScale,
      gestureRef.current.position,
      layout,
    );
    gestureRef.current = next;
    setScale(next.scale);
    setPosition(next.position);
    setGestureMode(next.mode);
  };

  const applyGestureTransition = (transition: ReturnType<typeof transitionViewerGesture>) => {
    gestureRef.current = transition.state;
    setScale(transition.state.scale);
    setPosition(transition.state.position);
    setGestureMode(transition.state.mode);
    if (transition.effect === 'next') move(1);
    if (transition.effect === 'previous') move(-1);
  };

  const applyTouchDoubleTap = (layout: ViewerGestureLayout) => {
    const transition = transitionViewerGesture(gestureRef.current, {
      layout,
      type: 'doubletap',
    });
    lastTouchDoubleTapAt.current = Date.now();
    applyGestureTransition(transition);
  };

  const releasePointerCapture = (stage: HTMLDivElement, pointerId: number) => {
    capturedPointerIds.current.delete(pointerId);
    try {
      if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture can already be released by the browser during cancellation.
    }
  };

  const continueWith = (intent: 'edit' | 'reference' | 'video') => {
    if (!item) return;
    if (intent === 'edit' && !isVisualFixtureMode()) {
      closeViewer();
      void navigate(`/edit/${encodeURIComponent(item.id)}`);
      return;
    }
    if (intent === 'reference') {
      addComposerInput({ assetId: item.id, role: 'reference' });
      setComposerMode('image');
    } else if (intent === 'edit') {
      setComposerPrimaryInput({ assetId: item.id, role: 'source' });
      setComposerMode('image');
    } else {
      setComposerPrimaryInput({ assetId: item.id, role: 'first_frame' });
      setComposerMode('video');
    }
    setComposerExpanded(true);
    closeViewer();
    void navigate('/imagine');
  };

  if (!item) return null;
  const canContinue = canContinueWithImageInput(item);
  const videoStatusMessage = item.kind !== 'video'
    ? null
    : item.status === 'expired'
      ? 'This video result has expired and is no longer available.'
      : item.status === 'cancelled'
        ? 'This video generation was cancelled.'
        : item.status === 'failed' || item.status === 'rejected'
          ? item.error?.message ?? 'This video generation did not complete.'
          : item.sourcePath === null
            ? 'This video is still being prepared.'
            : videoPlaybackError
              ? 'The video could not be loaded.'
              : null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && closeViewer()}>
      <Dialog.Portal>
        <Dialog.Overlay className="viewer-overlay" />
        <Dialog.Content
          className="viewer-content"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onKeyDown={(event) => {
            if (isNativeMediaInteractionTarget(event.target)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              closeViewer();
              return;
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              move(event.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
          ref={contentRef}
          tabIndex={-1}
        >
          <Dialog.Title className="sr-only">{item.alt}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Generated {item.kind} preview and actions
          </Dialog.Description>
          <span aria-live="polite" className="sr-only" role="status">{viewerAnnouncement}</span>

          <div className="viewer-topbar">
            <span className="viewer-counter">
              {currentIndex + 1} / {items.length}
            </span>
            <div className="viewer-top-actions">
              <IconButton
                className={item.saved ? 'is-active' : ''}
                icon={<Bookmark fill={item.saved ? 'currentColor' : 'none'} size={18} />}
                label={item.saved ? 'Remove from Saved' : 'Save'}
                onClick={() => actions.toggleSaved(item.id)}
              />
              <a
                aria-label={item.kind === 'video' ? 'Download video' : 'Download image'}
                className="viewer-link-button"
                download={`${item.id}-${item.kind === 'video' ? 'video.mp4' : 'image.png'}`}
                href={item.kind === 'video' ? (item.sourcePath ?? undefined) : item.previewPath}
                onClick={(event) => {
                  if (item.kind === 'video' && item.sourcePath === null) event.preventDefault();
                }}
              >
                <Download size={18} />
              </a>
              <Dialog.Close asChild>
                <IconButton icon={<X size={20} />} label="Close viewer" />
              </Dialog.Close>
            </div>
          </div>

          <IconButton
            className="viewer-nav viewer-nav--previous"
            icon={<ChevronLeft size={24} />}
            label="Previous item"
            onClick={() => move(-1)}
          />
          <IconButton
            className="viewer-nav viewer-nav--next"
            icon={<ChevronRight size={24} />}
            label="Next item"
            onClick={() => move(1)}
          />

          <div
            className="viewer-stage"
            data-media-kind={item.kind}
            data-position-x={position.x}
            data-position-y={position.y}
            data-viewer-gesture={gestureMode}
            data-viewer-scale={scale}
            onDoubleClick={(event) => {
              if (!shouldHandleViewerDoubleClick(item.kind, event.target)) return;
              if (Date.now() - lastTouchDoubleTapAt.current < 500) return;
              const stage = stageRef.current;
              if (!stage) return;
              applyGestureTransition(transitionViewerGesture(gestureRef.current, {
                layout: viewerGestureLayout(stage, gestureRef.current.scale),
                type: 'doubletap',
              }));
            }}
            onPointerDown={(event) => {
              if (isViewerGestureInteractionTarget(event.target)) return;
              const transition = transitionViewerGesture(gestureRef.current, {
                layout: viewerGestureLayout(event.currentTarget, gestureRef.current.scale),
                point: { x: event.clientX, y: event.clientY },
                pointerId: event.pointerId,
                type: 'pointerdown',
              });
              applyGestureTransition(transition);
              capturedPointerIds.current.add(event.pointerId);
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Browsers can reject capture for an already-cancelled pointer.
              }
            }}
            onPointerMove={(event) => {
              if (!gestureRef.current.pointers.has(event.pointerId)) return;
              applyGestureTransition(transitionViewerGesture(gestureRef.current, {
                layout: viewerGestureLayout(event.currentTarget, gestureRef.current.scale),
                point: { x: event.clientX, y: event.clientY },
                pointerId: event.pointerId,
                type: 'pointermove',
              }));
            }}
            onPointerUp={(event) => {
              const stage = event.currentTarget;
              const transition = transitionViewerGesture(gestureRef.current, {
                layout: viewerGestureLayout(stage, gestureRef.current.scale),
                point: { x: event.clientX, y: event.clientY },
                pointerId: event.pointerId,
                type: 'pointerup',
              });
              releasePointerCapture(stage, event.pointerId);
              applyGestureTransition(transition);
              if (transition.effect !== 'tap' || !['touch', 'pen'].includes(event.pointerType)) return;
              const now = Date.now();
              const previousTap = lastTapRef.current;
              if (previousTap && now - previousTap.time <= 320 &&
                Math.hypot(previousTap.x - event.clientX, previousTap.y - event.clientY) <= 28) {
                lastTapRef.current = null;
                applyTouchDoubleTap(viewerGestureLayout(stage, gestureRef.current.scale));
                return;
              }
              lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
            }}
            onPointerCancel={(event) => {
              releasePointerCapture(event.currentTarget, event.pointerId);
              applyGestureTransition(transitionViewerGesture(gestureRef.current, {
                pointerId: event.pointerId,
                type: 'pointercancel',
              }));
            }}
            onLostPointerCapture={(event) => {
              capturedPointerIds.current.delete(event.pointerId);
              applyGestureTransition(transitionViewerGesture(gestureRef.current, {
                pointerId: event.pointerId,
                type: 'lostcapture',
              }));
            }}
            ref={stageRef}
          >
            {item.kind === 'video' ? (
              videoStatusMessage ? (
                <VideoPreview
                  alt={item.alt}
                  errorMessage={videoStatusMessage}
                  messageRole={item.status === 'failed' || item.status === 'rejected' || videoPlaybackError ? 'alert' : 'status'}
                  onError={() => setVideoPlaybackError(true)}
                  posterPath={item.posterPath}
                  sourcePath={item.sourcePath ?? ''}
                />
              ) : (
                <VideoPreview
                  alt={item.alt}
                  errorMessage={null}
                  onError={() => setVideoPlaybackError(true)}
                  posterPath={item.posterPath}
                  sourcePath={item.sourcePath ?? ''}
                  style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
                />
              )
            ) : (
              <img
                alt={item.alt}
                className="viewer-media"
                src={item.previewPath}
                style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
              />
            )}
            {item.kind === 'image' && (
              <div className="viewer-zoom-controls">
                <IconButton
                  icon={<ZoomOut size={17} />}
                  label="Zoom out"
                  onClick={() => setZoom(scale - 0.5)}
                />
                <span>{Math.round(scale * 100)}%</span>
                <IconButton
                  icon={<ZoomIn size={17} />}
                  label="Zoom in"
                  onClick={() => setZoom(scale + 0.5)}
                />
                <IconButton
                  icon={<RotateCcw size={16} />}
                  label="Reset zoom"
                  onClick={() => setZoom(1)}
                />
              </div>
            )}
          </div>

          <aside className="viewer-details">
            <span className="sr-only" role="status" aria-live="polite">{copyStatus}</span>
            <div className="viewer-prompt">
              <span>Prompt</span>
              <p>{item.prompt}</p>
              <IconButton
                icon={<Copy size={16} />}
                label={copyStatus || 'Copy prompt'}
                onClick={() => {
                  void navigator.clipboard.writeText(item.prompt)
                    .then(() => setCopyStatus('Prompt copied'))
                    .catch(() => setCopyStatus('Copy unavailable'));
                }}
              />
            </div>
            <dl className="viewer-metadata">
              <div><dt>Provider</dt><dd>{item.providerId}</dd></div>
              <div><dt>Model</dt><dd>{item.modelId}</dd></div>
              <div><dt>Size</dt><dd>{item.width} x {item.height}</dd></div>
              <div><dt>Aspect</dt><dd>{item.aspectRatio}</dd></div>
              <div><dt>References</dt><dd>{item.referenceCount}</dd></div>
              <div><dt>Status</dt><dd>{videoStatusMessage ?? item.stage}</dd></div>
              <div><dt>Time</dt><dd>{formatViewerTime(item.createdAt)}</dd></div>
            </dl>
            <div className="viewer-create-actions">
              {canContinue && <button onClick={() => continueWith('reference')} type="button"><ImagePlus size={17} />Use as reference</button>}
              {canContinue && <button onClick={() => continueWith('edit')} type="button"><Pencil size={17} />Edit image</button>}
              {canContinue && <button onClick={() => continueWith('video')} type="button"><Clapperboard size={17} />Make video</button>}
              <button
                className="danger-command"
                onClick={() => { actions.remove(item.id); closeViewer(); }}
                type="button"
              >
                <Trash2 size={17} />Delete
              </button>
            </div>
          </aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
