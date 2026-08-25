import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Images } from 'lucide-react';

import type { FixtureGalleryItem } from '../model/types';
import { useFoldersQuery } from '../api/gallery-query';
import { MediaCard } from './media-card';

interface VirtualGalleryProps {
  emptyLabel: string;
  items: readonly FixtureGalleryItem[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
}

function columnCountFor(width: number): number {
  if (width < 560) return 2;
  if (width < 880) return 3;
  return 4;
}

export function VirtualGallery({ emptyLabel, items, scrollElementRef }: VirtualGalleryProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const { data: folders = [] } = useFoldersQuery();
  const containerWidth =
    viewportWidth <= 720
      ? Math.max(1, viewportWidth - 16)
      : Math.max(1, Math.min(1180, viewportWidth - 64) - 40);
  const columns = columnCountFor(containerWidth);
  const gap = containerWidth < 560 ? 8 : 10;
  const columnWidth = Math.max(1, (containerWidth - gap * (columns - 1)) / columns);
  const scrollMargin = gridRef.current?.offsetTop ?? 0;

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const estimateSizes = useMemo(
    () =>
      items.map((item) => columnWidth * (item.height / item.width) + gap),
    [columnWidth, gap, items],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: (index) => estimateSizes[index] ?? 280,
    gap,
    getItemKey: (index) => items[index]?.id ?? index,
    getScrollElement: () => scrollElementRef.current,
    lanes: columns,
    overscan: 8,
    scrollMargin,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [columnWidth, columns, virtualizer]);

  if (items.length === 0) {
    return (
      <div className="gallery-empty">
        <Images aria-hidden="true" size={25} />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div
      aria-label="Media gallery"
      className="virtual-gallery"
      data-total-items={items.length}
      ref={gridRef}
      role="list"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        const lane = virtualItem.lane ?? 0;
        return (
          <div
            className="virtual-gallery-item"
            data-index={virtualItem.index}
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            style={{
              transform: `translate(${lane * (columnWidth + gap)}px, ${
                virtualItem.start - scrollMargin
              }px)`,
              width: columnWidth,
            }}
          >
            <MediaCard folders={folders} item={item} />
          </div>
        );
      })}
    </div>
  );
}
