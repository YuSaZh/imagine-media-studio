import type { GenerationRequest, JobDto } from '@imagine/shared';
import type { MediaItem } from './data';

export interface PendingStudy { id: string; jobId?: string; collectionId?: string; prompt: string; kind: 'image' | 'video'; width: number; height: number; status: string; progress: number | null; error?: string; }
export function pendingStudies(request: GenerationRequest, state: { id: string; status: string; progress: number | null; jobId?: string; error?: string }, existing: MediaItem[] = []): PendingStudy[] {
  const video = request.operation.startsWith('video.');
  const dimensions = request.resolution?.match(/^(\d+)x(\d+)$/);
  const ratio = request.aspectRatio?.match(/^(\d+):(\d+)$/);
  const width = request.width ?? Number(dimensions?.[1] ?? ratio?.[1] ?? (video ? 16 : 1));
  const height = request.height ?? Number(dimensions?.[2] ?? ratio?.[2] ?? (video ? 9 : 1));
  const ready = existing.filter(item => item.asset?.jobId === state.jobId).length;
  return Array.from({ length: Math.max(0, (video ? 1 : request.count ?? 1) - ready) }, (_, index) => ({ ...state, ...(request.collectionId ? { collectionId: request.collectionId } : {}), id: `${state.id}:${index + ready}`, prompt: request.prompt, kind: video ? 'video' : 'image', width, height }));
}
export function jobStudies(job: JobDto, items: MediaItem[]) { return pendingStudies(job.request, { id: job.id, jobId: job.id, status: job.status, progress: job.progress, ...(job.errorMessage ? { error: job.errorMessage } : {}) }, items); }
