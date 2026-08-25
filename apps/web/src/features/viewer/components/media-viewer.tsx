import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  Download,
  ImagePlus,
  Pause,
  Pencil,
  Play,
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
import type { FixtureGalleryItem } from '../../gallery/model/types';
import { canContinueWithImageInput } from '../../gallery/model/input-eligibility';

interface MediaViewerProps {
  items: readonly FixtureGalleryItem[];
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
  const previousViewerAssetId = useRef<string | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [playing, setPlaying] = useState(false);
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
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setPlaying(false);
    setCopyStatus('');
  }, [item?.id]);

  const move = (offset: number) => {
    if (items.length === 0) return;
    const nextIndex = (currentIndex + offset + items.length) % items.length;
    const next = items[nextIndex];
    if (next) useUiStore.getState().openViewer(next.id);
  };

  const setZoom = (nextScale: number) => {
    const normalizedScale = Math.min(4, Math.max(1, nextScale));
    setScale(normalizedScale);
    if (normalizedScale === 1) setPosition({ x: 0, y: 0 });
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
            if (event.key === 'ArrowLeft') move(-1);
            if (event.key === 'ArrowRight') move(1);
          }}
          onTouchEnd={(event) => {
            const start = touchStart.current;
            const end = event.changedTouches[0];
            touchStart.current = null;
            if (!start || !end || scale !== 1) return;
            const deltaX = start.x - end.clientX;
            const deltaY = start.y - end.clientY;
            if (Math.abs(deltaX) < 48 || Math.abs(deltaY) > 60) return;
            move(deltaX > 0 ? 1 : -1);
          }}
          onTouchStart={(event) => {
            const point = event.touches[0];
            touchStart.current = point ? { x: point.clientX, y: point.clientY } : null;
          }}
          ref={contentRef}
          tabIndex={-1}
        >
          <Dialog.Title className="sr-only">{item.alt}</Dialog.Title>
          <Dialog.Description className="sr-only">
            Generated {item.kind} preview and actions
          </Dialog.Description>

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
                aria-label={item.kind === 'video' ? 'Download poster' : 'Download image'}
                className="viewer-link-button"
                download={`${item.id}-${item.kind === 'video' ? 'poster' : 'image'}.png`}
                href={item.previewPath}
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
            onDoubleClick={() => setZoom(scale === 1 ? 2 : 1)}
            onPointerDown={(event) => {
              if (scale === 1) return;
              dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const offset = dragOffset.current;
              if (offset) setPosition({ x: event.clientX - offset.x, y: event.clientY - offset.y });
            }}
            onPointerUp={() => { dragOffset.current = null; }}
          >
            <img
              alt={item.alt}
              className="viewer-media"
              src={item.previewPath}
              style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${scale})` }}
            />
            {item.kind === 'video' && (
              <button
                aria-label={playing ? 'Pause mock video preview' : 'Play mock video preview'}
                className="viewer-play"
                onClick={() => setPlaying((value) => !value)}
                type="button"
              >
                {playing ? <Pause fill="currentColor" size={28} /> : <Play fill="currentColor" size={28} />}
              </button>
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
              <div><dt>Model</dt><dd>{item.modelId}</dd></div>
              <div><dt>Size</dt><dd>{item.width} x {item.height}</dd></div>
              <div><dt>Aspect</dt><dd>{item.aspectRatio}</dd></div>
              <div><dt>References</dt><dd>{item.referenceCount}</dd></div>
              <div><dt>Status</dt><dd>{item.stage}</dd></div>
              <div><dt>Created</dt><dd>{item.createdAt.slice(0, 10)}</dd></div>
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
