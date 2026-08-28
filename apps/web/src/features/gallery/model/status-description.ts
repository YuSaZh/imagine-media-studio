import type { FixtureGalleryItem } from './types.js';

type MediaStatusFields = Pick<FixtureGalleryItem, 'status' | 'stage' | 'progress' | 'error'>;

export function mediaStatusDescription(item: MediaStatusFields): string {
  const stage = item.stage.trim() || 'Unknown stage';
  const progress = item.progress === null ? 'unavailable' : `${item.progress}%`;
  const error = item.error === null
    ? 'none'
    : `${item.error.message}${item.error.retryable ? ' Retry available' : ''}`;

  return `Task status: ${item.status}. Stage: ${stage}. Progress: ${progress}. Error: ${error}.`;
}
