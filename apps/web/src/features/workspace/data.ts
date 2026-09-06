import type { AssetDto, AssetInput, GenerationRequest, JobDto, ModelDto, ProviderDto, JsonObject } from '@imagine/shared';
import { GenerationRequestSchema, applyModelParameters, matchModelProtocol, normalizeAutomaticParameters } from '@imagine/shared';
import { managedParameters } from './managed-parameters';
import { internalClient } from '../../api/internal-client';
import { mapInternalModel } from './model-capabilities';
import { allowsCustomSize } from './generation-options';
import { parseAspectRatio, dimensionsForAspectRatio } from '../gallery/model/aspect-ratio';
import { mapInternalGallery } from '../gallery/model/api-mapper';
import type { FixtureGalleryItem } from '../gallery/model/types';
import { isNetworkFailure, loadOfflineGallerySnapshot, markNetworkFailure, saveOfflineGallerySnapshot } from '../../pwa-offline-snapshot';

export type MediaKind = 'image' | 'video';
export interface MediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  prompt: string;
  src: string;
  thumbnail: string;
  poster: string | null;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number | null;
  model: string;
  providerId: string;
  saved: boolean;
  collectionIds: readonly string[];
  createdAt: string;
  asset: AssetDto | null;
  job: JobDto | null;
}
export interface Project { id: string; name: string; }
export interface WorkspaceModel extends ReturnType<typeof mapInternalModel> {
  key: string;
  name: string;
  providerName: string;
  providerType: string;
  providerDefault: boolean;
  raw: ModelDto;
}
export interface ReferenceInput { asset: AssetDto; role: AssetInput['role']; }
export interface MediaFilter { kind: 'all' | MediaKind; saved: boolean; projectId: string | null; search: string; }
export interface MediaPage { items: MediaItem[]; nextCursor: string | null; offline: boolean; }
export const ACTIVE_JOB_STATUSES = new Set(['queued', 'submitting', 'remote_pending', 'remote_running', 'downloading', 'processing']);
export const JOB_LABELS: Record<string, string> = {
  queued: '等待生成', submitting: '正在提交', remote_pending: '等待服务响应', remote_running: '正在生成',
  downloading: '正在下载', processing: '正在处理', completed: '已完成', failed: '生成失败', cancelled: '已取消', rejected: '请求被拒绝', expired: '结果已过期',
};

export function mapMedia(asset: AssetDto, job: JobDto | null = null): MediaItem {
  return {
    id: asset.id, kind: asset.type, title: job?.prompt.slice(0, 48) ?? asset.originalFilename ?? '未命名作品',
    prompt: job?.prompt ?? '', src: asset.contentUrl,
    thumbnail: asset.thumbnailUrl ?? asset.posterUrl ?? asset.contentUrl,
    poster: asset.posterUrl ?? asset.thumbnailUrl,
    mimeType: asset.mimeType, width: asset.width ?? 1, height: asset.height ?? 1,
    durationSeconds: asset.durationMs === null ? null : asset.durationMs / 1000,
    model: job?.modelId ?? '本地上传', providerId: job?.providerId ?? 'local', saved: asset.favorite,
    collectionIds: asset.collectionIds, createdAt: asset.createdAt, asset, job,
  };
}

function mapOfflineMedia(item: FixtureGalleryItem): MediaItem {
  return {
    id: item.id, kind: item.kind, title: item.prompt.slice(0, 48), prompt: item.prompt,
    src: item.sourcePath ?? '', thumbnail: item.previewPath, poster: item.posterPath,
    mimeType: '', width: item.width, height: item.height, durationSeconds: item.durationSeconds,
    model: item.modelId, providerId: item.providerId, saved: item.saved, collectionIds: item.folderIds,
    createdAt: item.createdAt, asset: null, job: null,
  };
}

export async function fetchMediaPage(filter: MediaFilter, cursor?: string): Promise<MediaPage> {
  try {
    const page = await internalClient.listAssets({
      limit: 60, includeJobs: true,
      ...(cursor ? { cursor } : {}),
      ...(filter.kind !== 'all' ? { type: filter.kind } : {}),
      ...(filter.saved ? { favorite: true } : {}),
      ...(filter.projectId ? { collectionId: filter.projectId } : {}),
      ...(filter.search ? { search: filter.search } : {}),
    });
    const jobs = new Map((page.jobs ?? []).map(job => [job.id, job]));
    if (!cursor && filter.kind === 'all' && !filter.saved && !filter.projectId && !filter.search) {
      await saveOfflineGallerySnapshot(mapInternalGallery(page.items, page.jobs ?? [])).catch(() => undefined);
    }
    return { items: page.items.map(asset => mapMedia(asset, asset.jobId ? jobs.get(asset.jobId) ?? null : null)), nextCursor: page.nextCursor, offline: false };
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    markNetworkFailure();
    const cached = await loadOfflineGallerySnapshot();
    if (cached === null || cursor) throw error;
    return {
      items: cached.filter(item => item.persistedAsset !== false)
        .filter(item => filter.kind === 'all' || item.kind === filter.kind)
        .filter(item => !filter.saved || item.saved)
        .filter(item => !filter.projectId || item.folderIds.includes(filter.projectId))
        .filter(item => !filter.search || item.prompt.toLowerCase().includes(filter.search.toLowerCase()))
        .map(mapOfflineMedia),
      nextCursor: null, offline: true,
    };
  }
}

export async function allPages<T>(load: (cursor?: string) => Promise<{ items: readonly T[]; nextCursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (cursors.has(page.nextCursor)) throw new Error('分页游标重复，请重新加载');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursors.size < 100);
  throw new Error('目录过大，请缩小查询范围');
}

export function mapModels(models: readonly ModelDto[], providers: readonly ProviderDto[]): WorkspaceModel[] {
  const enabled = new Map(providers.filter(provider => provider.enabled).map(provider => [provider.id, provider]));
  return models.filter(model => model.enabled && enabled.has(model.providerId)).map(model => ({
    ...mapInternalModel(model), key: model.id, name: model.displayName,
    providerName: enabled.get(model.providerId)!.name,
    providerType: enabled.get(model.providerId)!.type ?? '',
    providerDefault: enabled.get(model.providerId)!.isDefault, raw: model,
  })).sort((left, right) => Number(right.providerDefault) - Number(left.providerDefault));
}

export function operationFor(mode: MediaKind, videoMode: 'text' | 'first_frame' | 'references', inputs: readonly ReferenceInput[]): 'image.generate' | 'image.edit' | 'video.generate' | 'video.image_to_video' | 'video.reference_to_video' {
  if (mode === 'image') return inputs.some(input => input.role === 'source' || input.role === 'reference') ? 'image.edit' : 'image.generate';
  return videoMode === 'first_frame' ? 'video.image_to_video' : videoMode === 'references' ? 'video.reference_to_video' : 'video.generate';
}

export interface Creation {
  model: WorkspaceModel;
  operation: ReturnType<typeof operationFor>;
  prompt: string;
  inputs: readonly ReferenceInput[];
  ratio: string;
  resolution: string;
  count: number;
  duration: number;
  negativePrompt: string;
  seed: string;
  audio: boolean;
  extra?: JsonObject;
  parameters?: JsonObject;
}

export function generationRequest(input: Creation): GenerationRequest {
  if (input.ratio === 'auto' || input.resolution === 'auto') input = { ...input, ratio: input.ratio === 'auto' ? '' : input.ratio, resolution: input.resolution === 'auto' ? '' : input.resolution };
  if (input.operation === 'image.edit' && !input.inputs.some(item => item.role === 'source')) {
    const first = input.inputs.findIndex(item => item.role === 'reference');
    input = { ...input, inputs: input.inputs.map((item, index) => index === first ? { ...item, role: 'source' as const } : item) };
  }
  const { model } = input;
  const video = input.operation.startsWith('video.');
  if (!model.capabilities.operations.includes(input.operation)) throw new Error('当前模型不支持这项操作');
  const rules = managedParameters(model);
  if (rules !== undefined) {
    const request: Record<string, unknown> = { operation: input.operation, providerId: model.providerId, modelId: model.id, prompt: input.prompt.trim(), inputs: input.inputs.map(({ asset, role }) => ({ assetId: asset.id, role })) };
    const extra: JsonObject = {};
    for (const rule of rules) {
      const value = input.parameters?.[rule.path];
      if (value === undefined) continue;
      if (rule.path.startsWith('extra.')) extra[rule.path.slice(6)] = value;
      else request[rule.path] = value;
    }
    if (Object.keys(extra).length) request.extra = extra;
    return normalizeAutomaticParameters(applyModelParameters(GenerationRequestSchema.parse(request), rules));
  }
  const customSize = !video && allowsCustomSize(model);
  const customRatio = !input.resolution && input.ratio && !model.capabilities.aspectRatios.includes(input.ratio);
  if (customRatio && !(customSize && parseAspectRatio(input.ratio))) throw new Error('当前模型不支持所选画幅');
  let resolution = input.resolution;
  if (!resolution && customRatio) { const size = dimensionsForAspectRatio(input.ratio); resolution = `${Math.round(size.width / 16) * 16}x${Math.round(size.height / 16) * 16}`; }
  if (resolution && !model.capabilities.resolutions.includes(resolution)) {
    const dimensions = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(resolution);
    if (!customSize || !dimensions || Number(dimensions[1]) > 16384 || Number(dimensions[2]) > 16384 || Number(dimensions[1]) * Number(dimensions[2]) > 100_000_000) throw new Error('分辨率须为有效像素尺寸，单边不超过 16384，总像素不超过 1 亿');
  }
  if (input.count > 32 || input.count < 1 || !Number.isInteger(input.count)) throw new Error('生成数量应为 1 到 32');
  if (video && model.capabilities.durations.length && !model.capabilities.durations.includes(input.duration)) throw new Error('当前模型不支持所选时长');
  const durationRange = model.capabilities.durationRange;
  if (video && durationRange && (input.duration < durationRange.min || input.duration > durationRange.max)) throw new Error('视频时长超出模型范围');
  const seed = Number(input.seed);
  if (input.seed && !Number.isSafeInteger(seed)) throw new Error('种子必须是整数');
  const extra = { ...input.extra };
  const xai = String(model.raw.capabilities.profile ?? matchModelProtocol(model.id) ?? model.providerType).startsWith('xai');
  const quality = xai ? extra.quality : undefined;
  if (xai) delete extra.quality;
  return GenerationRequestSchema.parse({
    operation: input.operation, providerId: model.providerId, modelId: model.id, prompt: input.prompt.trim(),
    inputs: input.inputs.map(({ asset, role }) => ({ assetId: asset.id, role })),
    ...(input.ratio && (video || !/^\d+x\d+$/.test(resolution)) ? { aspectRatio: input.ratio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
    ...(quality !== undefined ? { quality } : {}),
    count: input.count,
    ...(video && (model.capabilities.durations.length || durationRange) ? { durationSeconds: input.duration } : {}),
    ...(model.raw.capabilities.supportsNegativePrompt && input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(model.raw.capabilities.supportsSeed && input.seed ? { seed } : {}),
    ...(video && model.raw.capabilities.supportsAudio ? { audio: input.audio } : {}),
  });
}

export function mediaExtension(item: Pick<MediaItem, 'mimeType' | 'kind'>): string {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' } as Record<string, string>)[item.mimeType] ?? (item.kind === 'video' ? 'mp4' : 'png');
}
