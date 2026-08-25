import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import {
  PR1_MOCK_FOLDERS,
  PR1_MOCK_GALLERY_ITEMS,
  PR1_MOCK_IMAGE_ASSETS,
  PR1_MOCK_PROVIDER,
} from '../model/fixtures.js';
import type {
  FixtureAspectRatio,
  FixtureFolder,
  FixtureGalleryItem,
  FixtureJobStatus,
} from '../model/types.js';

export const galleryQueryKey = ['pr1-gallery-fixture'] as const;
export const optimisticSequenceQueryKey = ['pr1-gallery-optimistic-sequence'] as const;
export const providerQueryKey = ['pr1-provider-fixture'] as const;
export const modelsQueryKey = ['pr1-model-fixtures'] as const;

const MOCK_SUBMISSION_EPOCH_MS = Date.parse('2026-08-25T00:00:00.000Z');
const ACTIVE_STATUSES = new Set<FixtureJobStatus>([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
]);

async function loadGalleryFixture(): Promise<readonly FixtureGalleryItem[]> {
  return PR1_MOCK_GALLERY_ITEMS;
}

export function useGalleryQuery() {
  return useQuery({ queryKey: galleryQueryKey, queryFn: loadGalleryFixture });
}

export function useProviderQuery() {
  return useQuery({ queryKey: providerQueryKey, queryFn: async () => PR1_MOCK_PROVIDER });
}

export function useModelsQuery() {
  return useQuery({
    queryKey: modelsQueryKey,
    queryFn: async () => PR1_MOCK_PROVIDER.models,
  });
}

function deriveFolders(items: readonly FixtureGalleryItem[]): readonly FixtureFolder[] {
  return PR1_MOCK_FOLDERS.map((folder) => ({
    ...folder,
    itemIds: items.filter((item) => item.folderIds.includes(folder.id)).map((item) => item.id),
  }));
}

export function useFoldersQuery() {
  return useQuery({
    queryKey: galleryQueryKey,
    queryFn: loadGalleryFixture,
    select: deriveFolders,
  });
}

export interface FolderGalleryResult {
  readonly folder: FixtureFolder | null;
  readonly items: readonly FixtureGalleryItem[];
}

export function useFolderQuery(folderId: string | undefined) {
  return useQuery({
    queryKey: galleryQueryKey,
    queryFn: loadGalleryFixture,
    select: (items): FolderGalleryResult => {
      const folder = deriveFolders(items).find((candidate) => candidate.id === folderId) ?? null;
      return {
        folder,
        items: folder === null ? [] : items.filter((item) => item.folderIds.includes(folder.id)),
      };
    },
  });
}

export type GalleryCacheAction =
  | { readonly type: 'toggleSaved'; readonly itemId: string }
  | { readonly type: 'toggleFolder'; readonly itemId: string; readonly folderId: string }
  | { readonly type: 'retry'; readonly itemId: string }
  | { readonly type: 'cancel'; readonly itemId: string }
  | { readonly type: 'remove'; readonly itemId: string }
  | { readonly type: 'removeMany'; readonly itemIds: readonly string[] };

function updateItem(
  items: readonly FixtureGalleryItem[],
  itemId: string,
  update: (item: FixtureGalleryItem) => FixtureGalleryItem,
): readonly FixtureGalleryItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== itemId) return item;
    const updated = update(item);
    changed ||= updated !== item;
    return updated;
  });
  return changed ? next : items;
}

export function reduceGalleryItems(
  items: readonly FixtureGalleryItem[],
  action: GalleryCacheAction,
): readonly FixtureGalleryItem[] {
  switch (action.type) {
    case 'toggleSaved':
      return updateItem(items, action.itemId, (item) => ({ ...item, saved: !item.saved }));
    case 'toggleFolder':
      return updateItem(items, action.itemId, (item) => {
        const folderIds = item.folderIds.includes(action.folderId)
          ? item.folderIds.filter((folderId) => folderId !== action.folderId)
          : [...item.folderIds, action.folderId];
        return { ...item, folderIds };
      });
    case 'retry':
      return updateItem(items, action.itemId, (item) => {
        if (!['failed', 'cancelled', 'rejected'].includes(item.status)) return item;
        return {
          ...item,
          status: 'queued',
          stage: 'Waiting in queue',
          progress: null,
          error: null,
        };
      });
    case 'cancel':
      return updateItem(items, action.itemId, (item) => {
        if (!ACTIVE_STATUSES.has(item.status)) return item;
        return {
          ...item,
          status: 'cancelled',
          stage: 'Cancelled',
          progress: null,
          error: null,
        };
      });
    case 'remove':
      return items.filter((item) => item.id !== action.itemId);
    case 'removeMany': {
      const removedIds = new Set(action.itemIds);
      if (removedIds.size === 0) return items;
      return items.filter((item) => !removedIds.has(item.id));
    }
  }
}

export function applyGalleryCacheAction(
  queryClient: QueryClient,
  action: GalleryCacheAction,
): void {
  queryClient.setQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey, (current = []) =>
    reduceGalleryItems(current, action),
  );
}

export function useGalleryActions() {
  const queryClient = useQueryClient();
  const apply = useCallback(
    (action: GalleryCacheAction) => applyGalleryCacheAction(queryClient, action),
    [queryClient],
  );

  return {
    toggleSaved: useCallback((itemId: string) => apply({ type: 'toggleSaved', itemId }), [apply]),
    toggleFolder: useCallback(
      (itemId: string, folderId: string) => apply({ type: 'toggleFolder', itemId, folderId }),
      [apply],
    ),
    retry: useCallback((itemId: string) => apply({ type: 'retry', itemId }), [apply]),
    cancel: useCallback((itemId: string) => apply({ type: 'cancel', itemId }), [apply]),
    remove: useCallback((itemId: string) => apply({ type: 'remove', itemId }), [apply]),
    removeMany: useCallback(
      (itemIds: readonly string[]) => apply({ type: 'removeMany', itemIds }),
      [apply],
    ),
  };
}

export interface MockSubmission {
  readonly mode: 'image' | 'video';
  readonly prompt: string;
  readonly modelId: string;
  readonly count: number;
  readonly aspectRatio: FixtureAspectRatio;
  readonly durationSeconds: number | null;
  readonly referenceCount: number;
}

function normalizedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function optimisticTimestamp(sequence: number): string {
  const date = new Date(MOCK_SUBMISSION_EPOCH_MS + sequence * 60_000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Mock submission sequence ${sequence} exceeds the fixture timestamp range.`);
  }
  return date.toISOString();
}

function nextOptimisticSequence(items: readonly FixtureGalleryItem[]): number {
  let maximum = 0;
  for (const item of items) {
    const match = /^optimistic-(?:image|video)-(\d+)-\d+$/.exec(item.id);
    if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

export function createMockSubmissionItems(
  input: MockSubmission,
  sequence: number,
): readonly FixtureGalleryItem[] {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Mock submission sequence must be a positive safe integer.');
  }

  const source =
    PR1_MOCK_IMAGE_ASSETS.find((item) => item.aspectRatio === input.aspectRatio) ??
    PR1_MOCK_IMAGE_ASSETS[0];
  if (!source) throw new Error('The PR 1 fixture inventory is empty.');

  const model = PR1_MOCK_PROVIDER.models.find((candidate) => candidate.id === input.modelId);
  if (!model || model.mediaKind !== input.mode) {
    throw new Error(`Model ${input.modelId} does not support ${input.mode} submissions.`);
  }

  const outputCount = input.mode === 'video' ? 1 : normalizedInteger(input.count, 1, 4);
  const referenceCount = normalizedInteger(
    input.referenceCount,
    0,
    model.capabilities.maxReferenceImages,
  );
  const timestamp = optimisticTimestamp(sequence);
  const sequenceLabel = String(sequence).padStart(4, '0');
  const jobId = `optimistic-job-${input.mode}-${sequenceLabel}`;

  return Array.from({ length: outputCount }, (_, outputIndex): FixtureGalleryItem => {
    const outputLabel = String(outputIndex + 1).padStart(2, '0');
    const base = {
      id: `optimistic-${input.mode}-${sequenceLabel}-${outputLabel}`,
      jobId,
      prompt: input.prompt,
      alt: `${source.alt}, newly queued ${input.mode}`,
      createdAt: timestamp,
      status: 'queued' as const,
      stage: 'Waiting in queue',
      progress: null,
      error: null,
      saved: false,
      folderIds: [],
      providerId: PR1_MOCK_PROVIDER.id,
      modelId: input.modelId,
      width: source.width,
      height: source.height,
      aspectRatio: input.aspectRatio,
      referenceCount,
      batchCount: outputCount,
      previewPath: source.previewPath,
    };

    return input.mode === 'image'
      ? {
          ...base,
          kind: 'image',
          sourcePath: source.previewPath,
          posterPath: null,
          durationSeconds: null,
        }
      : {
          ...base,
          kind: 'video',
          sourcePath: null,
          posterPath: source.previewPath,
          durationSeconds: normalizedInteger(input.durationSeconds ?? 5, 1, 60),
        };
  });
}

export interface MockSubmissionContext {
  readonly previousItems: readonly FixtureGalleryItem[];
  readonly optimisticItems: readonly FixtureGalleryItem[];
}

export async function applyOptimisticSubmission(
  queryClient: QueryClient,
  input: MockSubmission,
): Promise<MockSubmissionContext> {
  await queryClient.cancelQueries({ queryKey: galleryQueryKey });
  const previousItems =
    queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ??
    PR1_MOCK_GALLERY_ITEMS;
  const previousSequence = queryClient.getQueryData<number>(optimisticSequenceQueryKey) ?? 0;
  const sequence = Math.max(previousSequence + 1, nextOptimisticSequence(previousItems));
  queryClient.setQueryData(optimisticSequenceQueryKey, sequence);
  const optimisticItems = createMockSubmissionItems(input, sequence);
  queryClient.setQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey, [
    ...optimisticItems,
    ...previousItems,
  ]);
  return { previousItems, optimisticItems };
}

export function rollbackOptimisticSubmission(
  queryClient: QueryClient,
  context: MockSubmissionContext | undefined,
): void {
  if (!context) return;
  const optimisticIds = new Set(context.optimisticItems.map((item) => item.id));
  queryClient.setQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey, (current) =>
    current === undefined
      ? context.previousItems
      : current.filter((item) => !optimisticIds.has(item.id)),
  );
}

export function useMockSubmission() {
  const queryClient = useQueryClient();

  return useMutation<MockSubmission, Error, MockSubmission, MockSubmissionContext>({
    mutationFn: async (input) => {
      await Promise.resolve();
      return input;
    },
    onMutate: (input) => applyOptimisticSubmission(queryClient, input),
    onError: (_error, _input, context) => rollbackOptimisticSubmission(queryClient, context),
  });
}
