import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bookmark, Check, Circle, FolderPlus, MoreHorizontal, Play, RotateCcw, X } from 'lucide-react';

import { IconButton } from '../../../components/icon-button';
import { useUiStore } from '../../../stores/ui-store.js';
import { useGalleryActions } from '../api/gallery-query';
import {
  createSelectionGestureState,
  LONG_PRESS_DURATION_MS,
  reduceSelectionGesture,
} from '../model/selection-gesture';
import { mediaStatusDescription } from '../model/status-description';
import type { FixtureFolder, FixtureGalleryItem, FixtureJobStatus } from '../model/types';

const TERMINAL_ERROR_STATUSES = new Set<FixtureJobStatus>(['expired', 'failed', 'rejected']);
const ACTIVE_STATUSES = new Set<FixtureJobStatus>([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
]);

function formatDuration(durationSeconds: number): string {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = String(durationSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function isExcludedGestureTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selectors: string) => unknown } | null;
  if (candidate === null || typeof candidate.closest !== 'function') return false;
  return candidate.closest(
    'button:not(.media-card-open), a, input, select, textarea, [role="menuitem"]',
  ) !== null;
}

interface MediaCardProps {
  folders: readonly FixtureFolder[];
  item: FixtureGalleryItem;
  scrollElementRef?: RefObject<HTMLDivElement | null>;
}

export function MediaCard({ folders, item, scrollElementRef }: MediaCardProps) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClick = useRef(false);
  const gestureState = useRef(createSelectionGestureState());
  const [longPressPending, setLongPressPending] = useState(false);
  const openViewer = useUiStore((state) => state.openViewer);
  const selectedAssetIds = useUiStore((state) => state.selectedAssetIds);
  const toggleAssetSelection = useUiStore((state) => state.toggleAssetSelection);
  const actions = useGalleryActions();
  const selectionActive = selectedAssetIds.size > 0;
  const selected = selectedAssetIds.has(item.id);
  const isActive = ACTIVE_STATUSES.has(item.status);
  const isError = TERMINAL_ERROR_STATUSES.has(item.status);
  const statusDescription = mediaStatusDescription(item);
  const statusDescriptionId = `media-card-status-${item.id}`;

  const clearLongPressTimer = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const clearSuppressClick = () => {
    if (suppressClickTimer.current) {
      clearTimeout(suppressClickTimer.current);
      suppressClickTimer.current = null;
    }
    suppressNextClick.current = false;
  };

  const suppressClick = () => {
    suppressNextClick.current = true;
    if (suppressClickTimer.current) clearTimeout(suppressClickTimer.current);
    suppressClickTimer.current = setTimeout(() => {
      suppressNextClick.current = false;
      suppressClickTimer.current = null;
    }, LONG_PRESS_DURATION_MS);
  };

  const resetGesture = () => {
    clearLongPressTimer();
    gestureState.current = reduceSelectionGesture(gestureState.current, { type: 'reset' });
    setLongPressPending(false);
  };

  useEffect(() => () => {
    clearLongPressTimer();
    if (suppressClickTimer.current) clearTimeout(suppressClickTimer.current);
  }, []);

  useEffect(() => {
    if (!longPressPending || scrollElementRef?.current === null || scrollElementRef === undefined) return;
    const scrollElement = scrollElementRef.current;
    scrollElement.addEventListener('scroll', resetGesture, { passive: true });
    return () => scrollElement.removeEventListener('scroll', resetGesture);
  }, [longPressPending, scrollElementRef]);

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.isPrimary === false) return;
    clearLongPressTimer();
    clearSuppressClick();
    const next = reduceSelectionGesture(gestureState.current, {
      type: 'pointerdown',
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      clientX: event.clientX,
      clientY: event.clientY,
      interactiveTarget: isExcludedGestureTarget(event.target),
    });
    gestureState.current = next;
    setLongPressPending(next.phase === 'pending');
    if (next.phase === 'pending') {
      longPressTimer.current = setTimeout(() => {
        const triggered = reduceSelectionGesture(gestureState.current, {
          type: 'long-press',
          pointerId: event.pointerId,
        });
        if (triggered.phase !== 'triggered') return;
        gestureState.current = triggered;
        clearLongPressTimer();
        setLongPressPending(false);
        suppressClick();
        toggleAssetSelection(item.id);
      }, LONG_PRESS_DURATION_MS);
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const previous = gestureState.current;
    const next = reduceSelectionGesture(previous, {
      type: 'pointermove',
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    gestureState.current = next;
    if (previous.phase === 'pending' && next.phase === 'idle') resetGesture();
  };

  const handlePointerEnd = (
    event: PointerEvent<HTMLElement>,
    type: 'pointerup' | 'pointercancel' | 'pointerleave',
  ) => {
    const previous = gestureState.current;
    if (previous.phase === 'triggered' && previous.pointerId === event.pointerId) {
      event.preventDefault();
      suppressClick();
    }
    clearLongPressTimer();
    gestureState.current = reduceSelectionGesture(previous, {
      type,
      pointerId: event.pointerId,
    });
    setLongPressPending(false);
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    gestureState.current = reduceSelectionGesture(gestureState.current, { type: 'contextmenu' });
    setLongPressPending(gestureState.current.phase === 'pending');
  };

  const handleOpen = () => {
    clearLongPressTimer();
    if (suppressNextClick.current) {
      clearSuppressClick();
      resetGesture();
      return;
    }
    resetGesture();
    if (selectionActive) {
      toggleAssetSelection(item.id);
    } else {
      openViewer(item.id);
    }
  };

  return (
    <article
      aria-describedby={statusDescriptionId}
      aria-label={item.alt}
      className={`media-card status-${item.status} ${selected ? 'is-selected' : ''} ${longPressPending ? 'is-long-pressing' : ''}`}
      data-item-id={item.id}
      data-kind={item.kind}
      data-long-press={longPressPending ? 'pending' : 'idle'}
      data-status={item.status}
      onContextMenu={handleContextMenu}
      onPointerCancel={(event) => handlePointerEnd(event, 'pointercancel')}
      onPointerDown={handlePointerDown}
      onPointerLeave={(event) => handlePointerEnd(event, 'pointerleave')}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => handlePointerEnd(event, 'pointerup')}
      onScrollCapture={resetGesture}
      role="listitem"
    >
      <button
        aria-label={`Open ${item.alt}`}
        aria-describedby={statusDescriptionId}
        className="media-card-open"
        onClick={handleOpen}
        type="button"
      >
        <img
          alt={item.alt}
          className="media-card-image"
          decoding="async"
          height={item.height}
          loading="lazy"
          src={item.previewPath}
          width={item.width}
        />
        <span aria-hidden="true" className="media-card-scrim" />
        <span aria-hidden="true" className="long-press-feedback" />
        {item.kind === 'video' && (
          <span aria-hidden="true" className="video-badge">
            <Play aria-hidden="true" fill="currentColor" size={12} />
            {formatDuration(item.durationSeconds)}
          </span>
        )}
        {isActive && (
          <span aria-hidden="true" className="job-state job-state--active">
            <span className="job-state-spinner" aria-hidden="true" />
            <strong>{item.stage}</strong>
            {item.progress !== null && <span>{item.progress}%</span>}
          </span>
        )}
        {isError && (
          <span aria-hidden="true" className="job-state job-state--error">
            <X aria-hidden="true" size={17} />
            <strong>{item.stage}</strong>
            <span>{item.error?.retryable ? 'Retry available' : 'Needs revision'}</span>
          </span>
        )}
        {item.status === 'cancelled' && (
          <span aria-hidden="true" className="job-state job-state--cancelled">
            <X aria-hidden="true" size={17} />
            <strong>Cancelled</strong>
          </span>
        )}
      </button>

      <span
        aria-atomic="true"
        aria-live="polite"
        className="sr-only media-card-status"
        id={statusDescriptionId}
        role="status"
      >
        {statusDescription}
      </span>

      <div className="media-card-actions">
        <IconButton
          className={`desktop-card-action ${item.saved ? 'is-active' : ''}`}
          icon={<Bookmark fill={item.saved ? 'currentColor' : 'none'} size={16} />}
          label={item.saved ? 'Remove from Saved' : 'Save'}
          onClick={() => actions.toggleSaved(item.id)}
        />
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              aria-label="Organize folders"
              className={`desktop-card-action icon-button icon-button--default ${item.folderIds.length > 0 ? 'is-active' : ''}`}
              title="Organize folders"
              type="button"
            >
              <FolderPlus size={16} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" className="folder-popover" sideOffset={8}>
              <strong>Folders</strong>
              {folders.map((folder) => {
                const included = item.folderIds.includes(folder.id);
                return (
                  <button
                    aria-pressed={included}
                    key={folder.id}
                    onClick={() => actions.toggleFolder(item.id, folder.id)}
                    type="button"
                  >
                    <span>{folder.name}</span>
                    {included && <Check aria-hidden="true" size={15} />}
                  </button>
                );
              })}
              <Popover.Arrow className="popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {isActive && (
          <IconButton
            icon={<X size={16} />}
            label="Cancel"
            onClick={() => actions.cancel(item.id)}
            className="desktop-card-action"
            tone="danger"
          />
        )}
        {isError && (
          <IconButton
            icon={<RotateCcw size={16} />}
            label="Retry"
            onClick={() => actions.retry(item.id)}
            className="desktop-card-action"
          />
        )}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              aria-label="Card actions"
              className="card-actions-more icon-button icon-button--default"
              type="button"
            >
              <MoreHorizontal size={18} />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" className="card-actions-popover" sideOffset={8}>
              <button
                aria-describedby={statusDescriptionId}
                aria-pressed={selected}
                onClick={() => toggleAssetSelection(item.id)}
                type="button"
              >
                {selected ? <Check size={16} strokeWidth={3} /> : <Circle size={16} />}
                <span>{selected ? `Unselect ${item.alt}` : `Select ${item.alt}`}</span>
              </button>
              <button onClick={() => actions.toggleSaved(item.id)} type="button">
                <Bookmark fill={item.saved ? 'currentColor' : 'none'} size={16} />
                <span>{item.saved ? 'Remove from Saved' : 'Save'}</span>
              </button>
              <span className="card-actions-heading">Folders</span>
              {folders.map((folder) => {
                const included = item.folderIds.includes(folder.id);
                return (
                  <button
                    aria-pressed={included}
                    key={folder.id}
                    onClick={() => actions.toggleFolder(item.id, folder.id)}
                    type="button"
                  >
                    <FolderPlus size={16} />
                    <span>{folder.name}</span>
                    {included && <Check aria-hidden="true" size={15} />}
                  </button>
                );
              })}
              {isActive && (
                <button className="danger-command" onClick={() => actions.cancel(item.id)} type="button">
                  <X size={16} /><span>Cancel</span>
                </button>
              )}
              {isError && (
                <button onClick={() => actions.retry(item.id)} type="button">
                  <RotateCcw size={16} /><span>Retry</span>
                </button>
              )}
              <Popover.Arrow className="popover-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>

      <button
        aria-describedby={statusDescriptionId}
        aria-label={selected ? `Unselect ${item.alt}` : `Select ${item.alt}`}
        aria-pressed={selected}
        className="selection-toggle"
        onClick={() => toggleAssetSelection(item.id)}
        type="button"
      >
        {selected && <Check size={15} strokeWidth={3} />}
      </button>
    </article>
  );
}
