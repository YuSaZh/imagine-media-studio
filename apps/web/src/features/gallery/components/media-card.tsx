import { useEffect, useRef, type PointerEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Bookmark, Check, FolderPlus, MoreHorizontal, Play, RotateCcw, X } from 'lucide-react';

import { IconButton } from '../../../components/icon-button';
import { useUiStore } from '../../../stores/ui-store';
import { useGalleryActions } from '../api/gallery-query';
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

interface MediaCardProps {
  folders: readonly FixtureFolder[];
  item: FixtureGalleryItem;
}

export function MediaCard({ folders, item }: MediaCardProps) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressConsumed = useRef(false);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const openViewer = useUiStore((state) => state.openViewer);
  const selectedAssetIds = useUiStore((state) => state.selectedAssetIds);
  const toggleAssetSelection = useUiStore((state) => state.toggleAssetSelection);
  const actions = useGalleryActions();
  const selectionActive = selectedAssetIds.size > 0;
  const selected = selectedAssetIds.has(item.id);
  const isActive = ACTIVE_STATUSES.has(item.status);
  const isError = TERMINAL_ERROR_STATUSES.has(item.status);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse') {
      longPressConsumed.current = false;
      pointerStart.current = { x: event.clientX, y: event.clientY };
      longPressTimer.current = setTimeout(() => {
        longPressConsumed.current = true;
        toggleAssetSelection(item.id);
        longPressTimer.current = null;
      }, 520);
    }
  };

  const handleOpen = () => {
    clearLongPress();
    if (longPressConsumed.current) {
      longPressConsumed.current = false;
      return;
    }
    if (selectionActive) {
      toggleAssetSelection(item.id);
    } else {
      openViewer(item.id);
    }
  };

  return (
    <article
      className={`media-card status-${item.status} ${selected ? 'is-selected' : ''}`}
      data-item-id={item.id}
      data-kind={item.kind}
      onContextMenu={(event) => {
        event.preventDefault();
        const originatedFromTouch = pointerStart.current !== null;
        clearLongPress();
        pointerStart.current = null;
        if (longPressConsumed.current) return;
        toggleAssetSelection(item.id);
        longPressConsumed.current = originatedFromTouch;
      }}
      onPointerCancel={clearLongPress}
      onPointerDown={handlePointerDown}
      onPointerLeave={clearLongPress}
      onPointerMove={(event) => {
        const start = pointerStart.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
          clearLongPress();
          pointerStart.current = null;
        }
      }}
      onPointerUp={clearLongPress}
      role="listitem"
    >
      <button
        aria-label={`Open ${item.alt}`}
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
        <span className="media-card-scrim" aria-hidden="true" />
        {item.kind === 'video' && (
          <span className="video-badge">
            <Play aria-hidden="true" fill="currentColor" size={12} />
            {formatDuration(item.durationSeconds)}
          </span>
        )}
        {isActive && (
          <span className="job-state job-state--active">
            <span className="job-state-spinner" aria-hidden="true" />
            <strong>{item.stage}</strong>
            {item.progress !== null && <span>{item.progress}%</span>}
          </span>
        )}
        {isError && (
          <span className="job-state job-state--error">
            <X aria-hidden="true" size={17} />
            <strong>{item.stage}</strong>
            <span>{item.error?.retryable ? 'Retry available' : 'Needs revision'}</span>
          </span>
        )}
        {item.status === 'cancelled' && (
          <span className="job-state job-state--cancelled">
            <X aria-hidden="true" size={17} />
            <strong>Cancelled</strong>
          </span>
        )}
      </button>

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

      {selectionActive && (
        <button
          aria-label={selected ? `Deselect ${item.alt}` : `Select ${item.alt}`}
          aria-pressed={selected}
          className="selection-toggle"
          onClick={() => toggleAssetSelection(item.id)}
          type="button"
        >
          {selected && <Check size={15} strokeWidth={3} />}
        </button>
      )}
    </article>
  );
}
