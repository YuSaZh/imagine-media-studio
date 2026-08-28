import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  AssetInput,
  GenerationRequest,
  ImageInputPolicy,
  JsonObject,
  JsonValue,
  ModelDto,
  ProviderDto,
} from '@imagine/shared';
import { DEFAULT_IMAGE_INPUT_POLICY } from '@imagine/shared';

import { internalClient } from '../../../api/internal-client.js';
import { internalQueryKeys } from '../../../api/query-keys.js';
import {
  isNetworkFailure,
  loadOfflineGallerySnapshot,
  markNetworkFailure,
  saveOfflineGallerySnapshot,
} from '../../../pwa-offline-snapshot.js';
import { isVisualFixtureMode } from '../../../visual-fixture.js';
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
  FixtureMediaOperation,
  FixtureDurationRange,
  FixtureModel,
  FixtureProvider,
} from '../model/types.js';
import { mapInternalGallery } from '../model/api-mapper.js';
import { dimensionsForAspectRatio, parseAspectRatio } from '../model/aspect-ratio.js';

export { isVisualFixtureMode } from '../../../visual-fixture.js';

export const galleryQueryKey = internalQueryKeys.gallery;
export const inputAssetInventoryQueryKey = [...internalQueryKeys.assets, 'input-inventory'] as const;
export const optimisticSequenceQueryKey = ['pr1-gallery-optimistic-sequence'] as const;
export const providerQueryKey = internalQueryKeys.providers;
export const modelsQueryKey = internalQueryKeys.models;
export const foldersQueryKey = internalQueryKeys.collections;

export function folderQueryKey(folderId: string | undefined) {
  return [...foldersQueryKey, 'folder', folderId ?? 'none'] as const;
}

const MOCK_SUBMISSION_EPOCH_MS = Date.parse('2026-08-25T00:00:00.000Z');
const ACTIVE_STATUSES = new Set<FixtureJobStatus>([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
]);

interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface GalleryModel extends FixtureModel {
  readonly providerId: string;
}

async function collectPages<T>(
  load: (cursor: string | undefined) => Promise<CursorPage<T>>,
): Promise<readonly T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
    const page = await load(cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('Internal API returned a repeated pagination cursor.');
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Internal API pagination exceeded the safety limit.');
}

function withCursor(cursor: string | undefined): { cursor?: string; limit: number } {
  return cursor === undefined ? { limit: 100 } : { cursor, limit: 100 };
}

const knownOperations = new Set<FixtureMediaOperation>([
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
]);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object';
}

function stringArray(value: JsonValue | undefined, maximumLength = 64): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const normalized = item.trim();
    return normalized.length > 0 && normalized.length <= maximumLength &&
      ![...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
      ? [normalized]
      : [];
  });
}

function aspectRatioArray(value: JsonValue | undefined): readonly FixtureAspectRatio[] {
  return [...new Set(stringArray(value, 32).flatMap((item) => {
    const ratio = parseAspectRatio(item);
    return ratio ? [ratio] : [];
  }))];
}

function numberArray(value: JsonValue | undefined): readonly number[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
    );
  }
  return [];
}

function durationRange(value: JsonValue | undefined): FixtureDurationRange | undefined {
  if (!isObject(value)) return undefined;
  const min = value.min;
  const max = value.max;
  const step = value.step ?? 1;
  if (
    typeof min !== 'number' || !Number.isSafeInteger(min) || min <= 0 ||
    typeof max !== 'number' || !Number.isSafeInteger(max) || max < min ||
    typeof step !== 'number' || !Number.isSafeInteger(step) || step <= 0
  ) return undefined;
  return { min, max, step };
}

function positiveInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedImageLimit(value: JsonValue | undefined, fallback: number): number {
  return Math.min(positiveInteger(value, fallback), fallback);
}

function mapImageInputPolicy(capabilities: JsonObject, maxReferenceImages: number): ImageInputPolicy {
  const constraints = isObject(capabilities.inputImageConstraints)
    ? capabilities.inputImageConstraints
    : {};
  const declaredMimeTypes = stringArray(constraints.mimeTypes).map((mime) => mime.trim().toLowerCase());
  const allowedMimeTypes = declaredMimeTypes.length === 0
    ? DEFAULT_IMAGE_INPUT_POLICY.allowedMimeTypes
    : DEFAULT_IMAGE_INPUT_POLICY.allowedMimeTypes.filter((mime) => declaredMimeTypes.includes(mime));
  return {
    allowedMimeTypes,
    maxCount: Math.min(DEFAULT_IMAGE_INPUT_POLICY.maxCount, maxReferenceImages),
    maxFileBytes: boundedImageLimit(constraints.maxBytes, DEFAULT_IMAGE_INPUT_POLICY.maxFileBytes),
    maxTotalBytes: DEFAULT_IMAGE_INPUT_POLICY.maxTotalBytes,
    maxPixels: boundedImageLimit(constraints.maxPixels, DEFAULT_IMAGE_INPUT_POLICY.maxPixels),
    maxWidth: boundedImageLimit(constraints.maxWidth, DEFAULT_IMAGE_INPUT_POLICY.maxWidth),
    maxHeight: boundedImageLimit(constraints.maxHeight, DEFAULT_IMAGE_INPUT_POLICY.maxHeight),
  };
}

export function mapInternalModel(model: ModelDto): GalleryModel {
  const capabilities = model.capabilities;
  const operations = stringArray(capabilities.operations).filter(
    (operation): operation is FixtureMediaOperation => knownOperations.has(operation as FixtureMediaOperation),
  );
  const mediaKind = operations.some((operation) => operation.startsWith('video.'))
    ? 'video'
    : 'image';
  const aspectRatios = aspectRatioArray(capabilities.aspectRatios);
  const durations = numberArray(capabilities.durations);
  const range = durationRange(capabilities.durations);
  const supportsBatchCount = capabilities.supportsBatchCount === true;
  const maxReferenceImages = positiveInteger(capabilities.maxReferenceImages, 0);
  return {
    id: model.modelId,
    providerId: model.providerId,
    displayName: model.displayName,
    mediaKind,
    capabilities: {
      operations,
      aspectRatios: aspectRatios.length > 0 ? aspectRatios : ['1:1'],
      resolutions: stringArray(capabilities.resolutions),
      durations,
      ...(range ? { durationRange: range } : {}),
      maxReferenceImages,
      supportsMask: capabilities.supportsMask === true,
      supportsProgress: capabilities.supportsProgress === true,
      supportsCancel: capabilities.supportsCancel === true,
      supportsBatchCount,
      maxBatchCount: supportsBatchCount ? positiveInteger(capabilities.maxBatchCount, 1) : 1,
      inputImagePolicy: mapImageInputPolicy(capabilities, maxReferenceImages),
    },
  };
}

function visualModels(): readonly GalleryModel[] {
  return PR1_MOCK_PROVIDER.models.map((model) => ({
    ...model,
    providerId: PR1_MOCK_PROVIDER.id,
  }));
}

export async function loadModelsData(): Promise<readonly GalleryModel[]> {
  if (isVisualFixtureMode()) return visualModels();
  const models = await collectPages((cursor) =>
    internalClient.listModels({ ...withCursor(cursor), enabled: true }),
  );
  return models.map(mapInternalModel);
}

function mapInternalProvider(
  provider: ProviderDto,
  models: readonly GalleryModel[],
): FixtureProvider {
  return {
    id: provider.id,
    type: provider.type,
    displayName: provider.name,
    enabled: provider.enabled,
    isDefault: provider.isDefault,
    models: models.filter((model) => model.providerId === provider.id),
  };
}

export async function loadProviderData(): Promise<FixtureProvider | null> {
  if (isVisualFixtureMode()) return PR1_MOCK_PROVIDER;
  const [providers, models] = await Promise.all([
    collectPages((cursor) => internalClient.listProviders({ ...withCursor(cursor), enabled: true })),
    loadModelsData(),
  ]);
  const provider = providers.find((candidate) => candidate.isDefault) ?? providers[0];
  return provider ? mapInternalProvider(provider, models) : null;
}

export async function loadGalleryData(): Promise<readonly FixtureGalleryItem[]> {
  if (isVisualFixtureMode()) return PR1_MOCK_GALLERY_ITEMS;
  try {
    const [assets, jobs] = await Promise.all([
      collectPages((cursor) => internalClient.listAssets(withCursor(cursor))),
      collectPages((cursor) => internalClient.listJobs(withCursor(cursor))),
    ]);
    const items = mapInternalGallery(assets, jobs);
    try {
      await saveOfflineGallerySnapshot(items);
    } catch {
      // A storage failure must not make an authoritative response unusable.
    }
    return items;
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    markNetworkFailure();
    const fallback = await loadOfflineGallerySnapshot();
    if (fallback === null) throw error;
    return fallback;
  }
}

export function useGalleryQuery() {
  return useQuery({
    queryKey: galleryQueryKey,
    queryFn: () => loadGalleryData(),
    retry: false,
  });
}

export async function loadInputAssetInventoryData(): Promise<readonly FixtureGalleryItem[]> {
  if (isVisualFixtureMode()) {
    return PR1_MOCK_GALLERY_ITEMS.filter((item) => item.kind === 'image');
  }
  try {
    const [visibleImages, masks] = await Promise.all([
      collectPages((cursor) => internalClient.listAssets({ ...withCursor(cursor), type: 'image' })),
      collectPages((cursor) =>
        internalClient.listAssets({ ...withCursor(cursor), role: 'mask', type: 'image' }),
      ),
    ]);
    const assetsById = new Map([...visibleImages, ...masks].map((asset) => [asset.id, asset]));
    return mapInternalGallery([...assetsById.values()], []).filter((item) => item.kind === 'image');
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    markNetworkFailure();
    const fallback = await loadOfflineGallerySnapshot();
    if (fallback === null) throw error;
    return fallback.filter((item) => item.kind === 'image');
  }
}

export function useInputAssetInventoryQuery() {
  return useQuery({
    queryKey: inputAssetInventoryQueryKey,
    queryFn: () => loadInputAssetInventoryData(),
  });
}

export function useProviderQuery() {
  return useQuery({ queryKey: providerQueryKey, queryFn: () => loadProviderData() });
}

export function useModelsQuery() {
  return useQuery({ queryKey: modelsQueryKey, queryFn: () => loadModelsData() });
}

function deriveFolders(items: readonly FixtureGalleryItem[]): readonly FixtureFolder[] {
  return PR1_MOCK_FOLDERS.map((folder) => ({
    ...folder,
    itemIds: items.filter((item) => item.folderIds.includes(folder.id)).map((item) => item.id),
  }));
}

export function useFoldersQuery() {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: foldersQueryKey,
    queryFn: async (): Promise<readonly FixtureFolder[]> => {
      if (isVisualFixtureMode()) {
        return deriveFolders(
          queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ??
            PR1_MOCK_GALLERY_ITEMS,
        );
      }
      const collections = await collectPages((cursor) =>
        internalClient.listCollections(withCursor(cursor)),
      );
      return collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        itemIds: [],
      }));
    },
  });
}

export interface FolderGalleryResult {
  readonly folder: FixtureFolder | null;
  readonly items: readonly FixtureGalleryItem[];
}

export function useFolderQuery(folderId: string | undefined) {
  const visualFixtures = isVisualFixtureMode();
  const queryClient = useQueryClient();
  return useQuery({
    enabled: visualFixtures || folderId !== undefined,
    queryKey: folderQueryKey(folderId),
    queryFn: async (): Promise<FolderGalleryResult> => {
      if (visualFixtures) {
        const items =
          queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ??
          PR1_MOCK_GALLERY_ITEMS;
        const folder = deriveFolders(items).find((candidate) => candidate.id === folderId) ?? null;
        return {
          folder,
          items: folder === null ? [] : items.filter((item) => item.folderIds.includes(folder.id)),
        };
      }
      if (folderId === undefined) return { folder: null, items: [] };
      const [collections, assets, jobs] = await Promise.all([
        collectPages((cursor) => internalClient.listCollections(withCursor(cursor))),
        collectPages((cursor) =>
          internalClient.listAssets({ ...withCursor(cursor), collectionId: folderId }),
        ),
        collectPages((cursor) => internalClient.listJobs(withCursor(cursor))),
      ]);
      const collection = collections.find((candidate) => candidate.id === folderId) ?? null;
      const folderJobIds = new Set(
        assets.flatMap((asset) => asset.jobId === null ? [] : [asset.jobId]),
      );
      const items = mapInternalGallery(
        assets,
        jobs.filter((job) => folderJobIds.has(job.id)),
      );
      return {
        folder: collection === null
          ? null
          : { id: collection.id, name: collection.name, itemIds: items.map((item) => item.id) },
        items: collection === null ? [] : items,
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
        if (!['expired', 'failed', 'cancelled', 'rejected'].includes(item.status)) return item;
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
  let nextItems: readonly FixtureGalleryItem[] = [];
  queryClient.setQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey, (current = []) => {
    nextItems = reduceGalleryItems(current, action);
    return nextItems;
  });
  const folders = deriveFolders(nextItems);
  queryClient.setQueryData(foldersQueryKey, folders);
  for (const folder of folders) {
    queryClient.setQueryData<FolderGalleryResult>(folderQueryKey(folder.id), {
      folder,
      items: nextItems.filter((item) => item.folderIds.includes(folder.id)),
    });
  }
}

function isPersistedAsset(item: FixtureGalleryItem): boolean {
  return !item.id.startsWith('job-slot-') && !item.id.startsWith('optimistic-');
}

function itemForAction(
  items: readonly FixtureGalleryItem[],
  itemId: string,
): FixtureGalleryItem | null {
  return items.find((item) => item.id === itemId) ?? null;
}

export async function executeGalleryAction(
  action: GalleryCacheAction,
  items: readonly FixtureGalleryItem[],
): Promise<void> {
  if (action.type === 'removeMany') {
    const uniqueIds = [...new Set(action.itemIds)];
    await Promise.all(
      uniqueIds.map((itemId) =>
        executeGalleryAction({ type: 'remove', itemId }, items),
      ),
    );
    return;
  }

  const item = itemForAction(items, action.itemId);
  if (!item) return;
  switch (action.type) {
    case 'toggleSaved':
      if (isPersistedAsset(item)) {
        await internalClient.patchAsset(item.id, !item.saved);
      }
      return;
    case 'toggleFolder':
      if (!isPersistedAsset(item)) return;
      if (item.folderIds.includes(action.folderId)) {
        await internalClient.removeCollectionAsset(action.folderId, item.id);
      } else {
        await internalClient.addCollectionAssets(action.folderId, [item.id]);
      }
      return;
    case 'retry':
      await internalClient.retryJob(item.jobId);
      return;
    case 'cancel':
      await internalClient.cancelJob(item.jobId);
      return;
    case 'remove':
      if (isPersistedAsset(item)) {
        await internalClient.deleteAsset(item.id);
      } else {
        await internalClient.deleteJob(item.jobId);
      }
      return;
  }
}

export function useGalleryActions() {
  const queryClient = useQueryClient();
  const visualFixtures = isVisualFixtureMode();
  const mutation = useMutation<void, Error, GalleryCacheAction>({
    mutationFn: async (action) => {
      if (visualFixtures) return;
      const items = queryClient.getQueryData<readonly FixtureGalleryItem[]>(galleryQueryKey) ?? [];
      await executeGalleryAction(action, items);
    },
    onMutate: (action) => {
      if (visualFixtures) applyGalleryCacheAction(queryClient, action);
    },
    onSuccess: async () => {
      if (visualFixtures) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.assets }),
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.collections }),
        queryClient.invalidateQueries({ queryKey: galleryQueryKey }),
      ]);
    },
  });
  const apply = useCallback((action: GalleryCacheAction) => mutation.mutate(action), [mutation]);

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
  readonly providerId?: string;
  readonly count: number;
  readonly aspectRatio: FixtureAspectRatio;
  readonly resolution?: string | null;
  readonly durationSeconds: number | null;
  readonly referenceCount: number;
  readonly inputAssets?: readonly AssetInput[];
}

function normalizedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function durationForModel(value: number | null, model: GalleryModel): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Duration for model ${model.id} must be a positive whole number.`);
  }
  if (model.capabilities.durationRange) {
    const { min, max, step } = model.capabilities.durationRange;
    if (value < min || value > max || (value - min) % step !== 0) {
      throw new Error(`Duration for model ${model.id} must be between ${min} and ${max} seconds.`);
    }
    return value;
  }
  if (!model.capabilities.durations.includes(value)) {
    throw new Error(`Duration ${value} is not supported by model ${model.id}.`);
  }
  return value;
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
      width: source.aspectRatio === input.aspectRatio
        ? source.width
        : dimensionsForAspectRatio(input.aspectRatio).width,
      height: source.aspectRatio === input.aspectRatio
        ? source.height
        : dimensionsForAspectRatio(input.aspectRatio).height,
      aspectRatio: input.aspectRatio,
      referenceCount,
      batchCount: outputCount,
      previewPath: source.previewPath,
      inputDescriptor: input.mode === 'image' ? source.inputDescriptor : null,
      persistedAsset: true,
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
          durationSeconds: input.durationSeconds ?? 5,
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

function operationForSubmission(
  input: MockSubmission,
  model: GalleryModel,
): FixtureMediaOperation {
  const inputs = input.inputAssets ?? [];
  const count = (role: AssetInput['role']) => inputs.filter((item) => item.role === role).length;
  const references = count('reference');
  if (references > model.capabilities.maxReferenceImages) {
    throw new Error(`Model ${model.id} accepts at most ${model.capabilities.maxReferenceImages} references.`);
  }
  if (count('source') > 1 || count('mask') > 1 || count('first_frame') > 1) {
    throw new Error('Composer inputs contain duplicate singleton roles.');
  }
  if (count('mask') > 0 && (!model.capabilities.supportsMask || count('source') !== 1)) {
    throw new Error(`Model ${model.id} cannot use the selected Mask input.`);
  }

  let operation: FixtureMediaOperation;
  if (input.mode === 'image') {
    if (count('first_frame') > 0 || count('last_frame') > 0) {
      throw new Error('Frame inputs cannot be used for image generation.');
    }
    operation = count('source') > 0 || count('mask') > 0
      ? 'image.edit'
      : 'image.generate';
  } else {
    if (count('source') > 0 || count('mask') > 0 || count('last_frame') > 0) {
      throw new Error('Image edit inputs cannot be used for video generation.');
    }
    if (count('first_frame') > 0 && references > 0) {
      throw new Error('Choose either a first frame or reference images for video generation.');
    }
    operation = count('first_frame') > 0
      ? 'video.image_to_video'
      : references > 0
        ? 'video.reference_to_video'
        : 'video.generate';
  }
  if (!model.capabilities.operations.includes(operation)) {
    throw new Error(`Model ${model.id} does not support ${operation}.`);
  }
  return operation;
}

export function createGenerationRequest(
  input: MockSubmission,
  models: readonly GalleryModel[],
): GenerationRequest {
  const model = models.find((candidate) => candidate.id === input.modelId);
  if (!model || model.mediaKind !== input.mode) {
    throw new Error(`Model ${input.modelId} is not available for ${input.mode} generation.`);
  }
  if (!model.capabilities.aspectRatios.includes(input.aspectRatio)) {
    throw new Error(`Aspect ratio ${input.aspectRatio} is not supported by model ${model.id}.`);
  }
  if (input.resolution !== null && input.resolution !== undefined) {
    if (!model.capabilities.resolutions.includes(input.resolution)) {
      throw new Error(`Resolution ${input.resolution} is not supported by model ${model.id}.`);
    }
  }
  const inputAssets = input.inputAssets ?? [];
  const uniqueInputs = new Set(inputAssets.map((item) => `${item.role}\0${item.assetId}`));
  if (uniqueInputs.size !== inputAssets.length) {
    throw new Error('Composer inputs contain duplicate Asset roles.');
  }
  return {
    operation: operationForSubmission(input, model),
    providerId: input.providerId ?? model.providerId,
    modelId: model.id,
    prompt: input.prompt,
    inputs: [...inputAssets],
    aspectRatio: input.aspectRatio,
    count: input.mode === 'video'
      ? 1
      : model.capabilities.supportsBatchCount
        ? normalizedInteger(input.count, 1, model.capabilities.maxBatchCount)
        : 1,
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.mode === 'video'
      ? (() => {
          const duration = durationForModel(input.durationSeconds, model);
          return duration === undefined ? {} : { durationSeconds: duration };
        })()
      : {}),
  };
}

export function useGallerySubmission() {
  const queryClient = useQueryClient();
  const visualFixtures = isVisualFixtureMode();

  return useMutation<
    MockSubmission,
    Error,
    MockSubmission,
    MockSubmissionContext | undefined
  >({
    mutationFn: async (input) => {
      if (!visualFixtures) {
        const models =
          queryClient.getQueryData<readonly GalleryModel[]>(modelsQueryKey) ?? await loadModelsData();
        await internalClient.createJob(createGenerationRequest(input, models));
      }
      return input;
    },
    onMutate: (input) => visualFixtures
      ? applyOptimisticSubmission(queryClient, input)
      : undefined,
    onError: (_error, _input, context) => {
      if (visualFixtures) rollbackOptimisticSubmission(queryClient, context);
    },
    onSuccess: async () => {
      if (visualFixtures) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.jobs }),
        queryClient.invalidateQueries({ queryKey: galleryQueryKey }),
      ]);
    },
  });
}

export const useMockSubmission = useGallerySubmission;
