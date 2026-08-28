import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Images, RefreshCw } from 'lucide-react';

import type { FixtureGalleryItem } from '../model/types';
import { useFoldersQuery } from '../api/gallery-query';
import { MediaCard } from './media-card';

export interface VirtualGalleryProps {
  emptyLabel: string;
  items: readonly FixtureGalleryItem[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
  hasNextPage?: boolean;
  isError?: boolean;
  isFetchingNextPage?: boolean;
  isInitialLoading?: boolean;
  onFetchNextPage?: (() => Promise<unknown> | unknown) | undefined;
  onRetry?: (() => Promise<unknown> | unknown) | undefined;
}

export interface GalleryPaginationProps {
  hasNextPage?: boolean;
  isError?: boolean;
  isFetchingNextPage?: boolean;
  isInitialLoading?: boolean;
  onFetchNextPage?: (() => Promise<unknown> | unknown) | undefined;
  onRetry?: (() => Promise<unknown> | unknown) | undefined;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}

/** Shared cursor state for list views that do not use the masonry virtualizer. */
export function GalleryPagination({
  hasNextPage = false,
  isError = false,
  isFetchingNextPage = false,
  isInitialLoading = false,
  onFetchNextPage,
  onRetry,
  scrollElementRef,
}: GalleryPaginationProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nextPageRequestRef = useRef(false);
  const requestNextPage = useCallback(() => {
    if (!onFetchNextPage || !hasNextPage || isError || isFetchingNextPage || nextPageRequestRef.current) return;
    nextPageRequestRef.current = true;
    try {
      void Promise.resolve(onFetchNextPage()).catch(() => undefined).finally(() => {
        nextPageRequestRef.current = false;
      });
    } catch {
      nextPageRequestRef.current = false;
    }
  }, [hasNextPage, isError, isFetchingNextPage, onFetchNextPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || !onFetchNextPage || isError || isFetchingNextPage) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestNextPage();
      },
      { root: scrollElementRef.current, rootMargin: '0px 0px 720px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isError, isFetchingNextPage, onFetchNextPage, requestNextPage, scrollElementRef]);

  const retry = onRetry ?? onFetchNextPage;
  let state: ReactNode = null;
  if (isInitialLoading) {
    state = (
      <div className="gallery-pagination-state gallery-pagination-state--loading" data-gallery-state="loading" role="status">
        <span className="gallery-state-spinner" aria-hidden="true" />
        <span>Loading media...</span>
      </div>
    );
  } else if (isError) {
    state = (
      <div className="gallery-pagination-state gallery-pagination-state--error" data-gallery-state="error" role="alert">
        <span>Unable to load more media.</span>
        {retry && (
          <button onClick={() => void Promise.resolve(retry()).catch(() => undefined)} type="button">
            <RefreshCw aria-hidden="true" size={15} />
            Retry
          </button>
        )}
      </div>
    );
  } else if (isFetchingNextPage) {
    state = (
      <div className="gallery-pagination-state gallery-pagination-state--loading" data-gallery-state="loading-more" role="status">
        <span className="gallery-state-spinner" aria-hidden="true" />
        <span>Loading more media...</span>
      </div>
    );
  } else if (!hasNextPage) {
    state = (
      <div className="gallery-pagination-state gallery-pagination-state--end" data-gallery-state="end" role="status">
        End of gallery
      </div>
    );
  }

  return (
    <div className="gallery-pagination">
      {state}
      <div aria-hidden="true" className="gallery-sentinel" data-gallery-sentinel="true" ref={sentinelRef} />
    </div>
  );
}

function columnCountFor(width: number): number {
  if (width < 560) return 2;
  if (width < 880) return 3;
  return 4;
}

export function VirtualGallery({
  emptyLabel,
  hasNextPage = false,
  isError = false,
  isFetchingNextPage = false,
  isInitialLoading = false,
  items,
  onFetchNextPage,
  onRetry,
  scrollElementRef,
}: VirtualGalleryProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nextPageRequestRef = useRef(false);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth,
  );
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

  const requestNextPage = useCallback(() => {
    if (
      !onFetchNextPage ||
      !hasNextPage ||
      isError ||
      isFetchingNextPage ||
      nextPageRequestRef.current
    ) return;
    nextPageRequestRef.current = true;
    try {
      void Promise.resolve(onFetchNextPage()).catch(() => undefined).finally(() => {
        nextPageRequestRef.current = false;
      });
    } catch {
      nextPageRequestRef.current = false;
    }
  }, [hasNextPage, isError, isFetchingNextPage, onFetchNextPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage || !onFetchNextPage || isError || isFetchingNextPage) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) requestNextPage();
      },
      { root: scrollElementRef.current, rootMargin: '0px 0px 720px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isError, isFetchingNextPage, onFetchNextPage, requestNextPage, scrollElementRef]);

  useEffect(() => {
    if (!hasNextPage || !onFetchNextPage || isError || isFetchingNextPage || items.length === 0) return;
    const virtualItems = virtualizer.getVirtualItems();
    const lastVirtualItem = virtualItems.at(-1);
    const preloadThreshold = Math.max(columns * 2, 4);
    if (lastVirtualItem && lastVirtualItem.index >= items.length - preloadThreshold) {
      requestNextPage();
    }
  }, [columns, hasNextPage, isError, isFetchingNextPage, items.length, onFetchNextPage, requestNextPage, virtualizer]);

  const paginationEnabled = onFetchNextPage !== undefined ||
    (onRetry !== undefined && (isInitialLoading || isError));
  const retry = onRetry ?? onFetchNextPage;
  const paginationState = (empty = false) => {
    if (isInitialLoading) {
      return (
        <div className="gallery-pagination-state gallery-pagination-state--loading" data-gallery-state="loading" role="status">
          <span className="gallery-state-spinner" aria-hidden="true" />
          <span>{empty ? 'Loading media...' : 'Loading more media...'}</span>
        </div>
      );
    }
    if (isError) {
      return (
        <div className="gallery-pagination-state gallery-pagination-state--error" data-gallery-state="error" role="alert">
          <span>Unable to load more media.</span>
          {retry && (
            <button onClick={() => void Promise.resolve(retry()).catch(() => undefined)} type="button">
              <RefreshCw aria-hidden="true" size={15} />
              Retry
            </button>
          )}
        </div>
      );
    }
    if (isFetchingNextPage) {
      return (
        <div className="gallery-pagination-state gallery-pagination-state--loading" data-gallery-state="loading-more" role="status">
          <span className="gallery-state-spinner" aria-hidden="true" />
          <span>Loading more media...</span>
        </div>
      );
    }
    if (hasNextPage && empty) {
      return (
        <div className="gallery-pagination-state gallery-pagination-state--loading" data-gallery-state="loading-more" role="status">
          <span className="gallery-state-spinner" aria-hidden="true" />
          <span>Loading more media...</span>
        </div>
      );
    }
    if (!hasNextPage && !empty) {
      return (
        <div className="gallery-pagination-state gallery-pagination-state--end" data-gallery-state="end" role="status">
          End of gallery
        </div>
      );
    }
    return null;
  };

  const pagination = (state: ReturnType<typeof paginationState>) => paginationEnabled ? (
    <div className="gallery-pagination">
      {state}
      <div aria-hidden="true" className="gallery-sentinel" data-gallery-sentinel="true" ref={sentinelRef} />
    </div>
  ) : null;

  if (items.length === 0) {
    if (isInitialLoading || isError || hasNextPage) {
      return (
        <div className="gallery-empty gallery-empty--loading">
          {pagination(paginationState(true))}
        </div>
      );
    }
    return (
      <div className="gallery-empty">
        <Images aria-hidden="true" size={25} />
        <span>{emptyLabel}</span>
      </div>
    );
  }

  return (
    <div className="virtual-gallery-shell">
      <div
        aria-label="Media gallery"
        aria-busy={isFetchingNextPage || isInitialLoading}
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
              <MediaCard folders={folders} item={item} scrollElementRef={scrollElementRef} />
            </div>
          );
        })}
      </div>
      {pagination(paginationState())}
    </div>
  );
}
