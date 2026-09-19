import type { GenerationRequest, JobDto } from '@imagine/shared';
import type { MediaItem } from './data';

export interface PendingStudy { seriesId?: string; members?: PendingStudy[]; cover?: MediaItem; seriesCount?: number; createdAt?: string; completedAt?: string | null; id: string; jobId?: string; collectionId?: string; prompt: string; kind: 'image' | 'video'; width: number; height: number; status: string; progress: number | null; error?: string; }
export function pendingStudies(request: GenerationRequest, state: { seriesId?: string; createdAt?: string; completedAt?: string | null; id: string; status: string; progress: number | null; jobId?: string; error?: string }, existing: MediaItem[] = []): PendingStudy[] {
  const video = request.operation.startsWith('video.');
  const dimensions = request.resolution?.match(/^(\d+)x(\d+)$/);
  const ratio = request.aspectRatio?.match(/^(\d+):(\d+)$/);
  const width = request.width ?? Number(dimensions?.[1] ?? ratio?.[1] ?? (video ? 16 : 1));
  const height = request.height ?? Number(dimensions?.[2] ?? ratio?.[2] ?? (video ? 9 : 1));
  const ready = existing.filter(item => item.asset?.jobId === state.jobId).length;
  return Array.from({ length: Math.max(0, (request.count ?? 1) - ready) }, (_, index) => ({ ...state, ...(request.collectionId ? { collectionId: request.collectionId } : {}), id: `${state.id}:${index + ready}`, prompt: request.prompt, kind: video ? 'video' : 'image', width, height }));
}
export function jobStudies(job: JobDto, items: MediaItem[]) { return pendingStudies(job.request, { ...(job.seriesId ? { seriesId: job.seriesId } : {}), id: job.id, jobId: job.id, createdAt: job.createdAt, completedAt: job.completedAt, status: job.status, progress: job.progress, ...(job.errorMessage ? { error: job.errorMessage } : {}) }, items); }

/** Keep queued jobs and already-published covers in one gallery entry. */
export function groupPendingStudies(pending: PendingStudy[], items: MediaItem[]) {
  const groups = new Map<string, PendingStudy[]>();
  for (const task of pending) {
    const key = task.seriesId ?? task.id;
    const members = groups.get(key) ?? [];
    members.push(task); groups.set(key, members);
  }
  const covered = new Set<string>();
  const studies = [...groups].map(([id, members]) => {
    const first = members[0]!;
    if (!first.seriesId) return first;
    const cover = items.find(item => item.asset?.series?.id === first.seriesId);
    if (cover) covered.add(cover.id);
    const active = members.find(task => !['failed', 'rejected', 'expired'].includes(task.status));
    return { ...(active ?? first), id, members, ...(cover ? { cover } : {}), seriesCount: members.length + (cover?.asset?.series?.count ?? 0) };
  });
  return { pending: studies, items: items.filter(item => !covered.has(item.id)) };
}
