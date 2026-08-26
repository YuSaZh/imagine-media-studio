import { useMemo, useRef } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';

import { IconButton } from '../../../components/icon-button';
import { useUiStore, type GalleryFilter } from '../../../stores/ui-store';
import { Composer } from '../../composer/components/composer';
import { MediaViewer } from '../../viewer/components/media-viewer';
import { useGalleryActions, useGalleryQuery } from '../api/gallery-query';
import type { FixtureGalleryItem } from '../model/types';
import { VirtualGallery } from './virtual-gallery';

const ACTIVE_STATUSES = new Set([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
]);

const FILTERS: Array<{ id: GalleryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'failed', label: 'Failed' },
  { id: 'favorites', label: 'Saved' },
];

export function mediaDownloadTarget(item: FixtureGalleryItem): { href: string; filename: string } | null {
  const href = item.kind === 'video' ? item.sourcePath : item.previewPath;
  if (!href) return null;
  return {
    filename: `${item.id}-${item.kind}.${item.kind === 'video' ? 'mp4' : 'png'}`,
    href,
  };
}

function matchesFilter(item: FixtureGalleryItem, filter: GalleryFilter): boolean {
  if (filter === 'image' || filter === 'video') return item.kind === filter;
  if (filter === 'in-progress') return ACTIVE_STATUSES.has(item.status);
  if (filter === 'failed') {
    return item.status === 'expired' || item.status === 'failed' || item.status === 'rejected';
  }
  if (filter === 'favorites') return item.saved;
  return true;
}

export function GalleryPage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { isOnline } = useOutletContext<{ isOnline: boolean; isStandalone: boolean }>();
  const { data = [] } = useGalleryQuery();
  const actions = useGalleryActions();
  const activeFilter = useUiStore((state) => state.activeFilter);
  const setActiveFilter = useUiStore((state) => state.setActiveFilter);
  const selectedAssetIds = useUiStore((state) => state.selectedAssetIds);
  const clearAssetSelection = useUiStore((state) => state.clearAssetSelection);
  const items = useMemo(
    () => data.filter((item) => matchesFilter(item, activeFilter)),
    [activeFilter, data],
  );
  const selectedItems = data.filter((item) => selectedAssetIds.has(item.id));

  const downloadSelected = () => {
    for (const item of selectedItems) {
      const target = mediaDownloadTarget(item);
      if (!target) continue;
      const anchor = document.createElement('a');
      anchor.download = target.filename;
      anchor.href = target.href;
      anchor.click();
    }
  };

  return (
    <div className="page-scroll" ref={scrollRef}>
      <header className="gallery-header">
        <div>
          <p className="page-eyebrow">Studio Mock</p>
          <h1>Imagine</h1>
        </div>
        <div className="gallery-filter" aria-label="Gallery filters" role="group">
          {FILTERS.map((filter) => (
            <button
              aria-pressed={activeFilter === filter.id}
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              type="button"
            >
              {filter.label}
            </button>
          ))}
        </div>
      </header>

      <div className="gallery-body">
        <VirtualGallery
          emptyLabel="No media matches this filter"
          items={items}
          scrollElementRef={scrollRef}
        />
      </div>

      {selectedAssetIds.size > 0 && (
        <div className="selection-bar" role="toolbar" aria-label="Selection actions">
          <span>{selectedAssetIds.size} selected</span>
          <div>
            <IconButton
              icon={<Download size={17} />}
              label="Download selected"
              onClick={downloadSelected}
            />
            <IconButton
              icon={<Trash2 size={17} />}
              label="Delete selected"
              onClick={() => {
                actions.removeMany(selectedItems.map((item) => item.id));
                clearAssetSelection();
              }}
              tone="danger"
            />
            <IconButton icon={<X size={18} />} label="Clear selection" onClick={clearAssetSelection} />
          </div>
        </div>
      )}

      <Composer isOnline={isOnline} />
      <MediaViewer items={items} />
    </div>
  );
}
