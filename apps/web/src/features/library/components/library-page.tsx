import { useMemo, useRef } from 'react';
import { Bookmark, FolderClosed, ListTodo } from 'lucide-react';
import { useParams } from 'react-router-dom';

import { useUiStore } from '../../../stores/ui-store';
import { MediaViewer } from '../../viewer/components/media-viewer';
import { useFolderQuery, useGalleryQuery } from '../../gallery/api/gallery-query';
import { GalleryPagination, VirtualGallery } from '../../gallery/components/virtual-gallery';
import type { FixtureGalleryItem } from '../../gallery/model/types';

interface LibraryPageProps {
  mode: 'folder' | 'jobs' | 'saved';
}

export function groupGalleryItemsByJob(
  items: readonly FixtureGalleryItem[],
): readonly FixtureGalleryItem[] {
  const jobs = new Map<string, FixtureGalleryItem>();
  for (const item of items) {
    if (!jobs.has(item.jobId)) jobs.set(item.jobId, item);
  }
  return [...jobs.values()];
}

export function LibraryPage({ mode }: LibraryPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { folderId } = useParams();
  const galleryQuery = useGalleryQuery();
  const { data = [] } = galleryQuery;
  const folderQuery = useFolderQuery(folderId);
  const { data: folderResult } = folderQuery;
  const openViewer = useUiStore((state) => state.openViewer);
  const folder = folderResult?.folder ?? null;
  const items = useMemo(() => {
    if (mode === 'saved') return data.filter((item) => item.saved);
    if (mode === 'folder') return folderResult?.items ?? [];
    return groupGalleryItemsByJob(data);
  }, [data, folderResult?.items, mode]);
  const title = mode === 'saved' ? 'Saved' : mode === 'jobs' ? 'Jobs' : (folder?.name ?? 'Folder');
  const Icon = mode === 'saved' ? Bookmark : mode === 'jobs' ? ListTodo : FolderClosed;

  return (
    <div className="page-scroll library-page" ref={scrollRef}>
      <header className="section-header">
        <div className="section-title">
          <Icon aria-hidden="true" size={20} />
          <div><p className="page-eyebrow">Library</p><h1>{title}</h1></div>
        </div>
        <span className="item-count">{items.length} items</span>
      </header>

      {mode === 'jobs' ? (
        <>
          <div className="jobs-list">
            {items.map((item) => (
              <button
                className="job-row"
                key={item.id}
                onClick={() => openViewer(item.id)}
                type="button"
              >
                <img alt="" src={item.previewPath} />
                <span className="job-row-copy"><strong>{item.prompt}</strong><small>{item.modelId}</small></span>
                <span className={`status-chip status-chip--${item.status}`}>{item.stage}</span>
                <time>{item.createdAt.slice(0, 10)}</time>
              </button>
            ))}
          </div>
          <GalleryPagination
            hasNextPage={galleryQuery.hasNextPage}
            isError={galleryQuery.isError}
            isFetchingNextPage={galleryQuery.isFetchingNextPage}
            isInitialLoading={galleryQuery.isLoading && items.length === 0}
            onFetchNextPage={() => galleryQuery.fetchNextPage()}
            onRetry={() => data.length === 0 ? galleryQuery.refetch() : galleryQuery.fetchNextPage()}
            scrollElementRef={scrollRef}
          />
        </>
      ) : (
        <div className="gallery-body gallery-body--library">
          <VirtualGallery
            emptyLabel={mode === 'saved' ? 'Nothing saved yet' : 'This folder is empty'}
            hasNextPage={mode === 'folder' ? false : galleryQuery.hasNextPage}
            isError={mode === 'folder' ? folderQuery.isError : galleryQuery.isError}
            isFetchingNextPage={mode === 'folder' ? false : galleryQuery.isFetchingNextPage}
            isInitialLoading={mode === 'folder' ? folderQuery.isLoading : galleryQuery.isLoading}
            items={items}
            onFetchNextPage={mode === 'folder' ? undefined : () => galleryQuery.fetchNextPage()}
            onRetry={mode === 'folder'
              ? () => folderQuery.refetch()
              : () => data.length === 0 ? galleryQuery.refetch() : galleryQuery.fetchNextPage()}
            scrollElementRef={scrollRef}
          />
        </div>
      )}
      <MediaViewer items={items} />
    </div>
  );
}
