import { copyPrompt } from './copy-prompt';
import { useViewerMotion, type ViewerMotion } from './viewer-motion';
import { useAssetSeries } from './series-query';
import { GenerationStatus } from './generation-status';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_IMAGE_INPUT_POLICY, MASK_OVERLAY_COLOR, ModelCapabilitiesSchema, type AssetDto, type MaskDocument, type MediaOperation } from '@imagine/shared';
import { Brush, Copy, Play, Sparkles, LoaderCircle } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys } from '../../api/query-keys';
import { createBrowserId } from '../../browser-id';
import { useReferenceUploads } from '../media-input/hooks/use-reference-uploads';
import { usePatchSettings, useSettingsQuery } from '../settings/api/settings-query';
import { generationMemoryScope, readGenerationMemory, updateGenerationMemory } from './generation-memory';
import { ACTIVE_JOB_STATUSES, generationRequest, mapMedia, modelForOperation, type Creation, type MediaKind, type MediaItem, type ReferenceInput, type WorkspaceModel } from './data';
import { Composer } from './composer';
import { Viewer, type ViewerProps } from './viewer';
import { ReferencePicker } from './reference-picker';
import { Panel, Tool } from './ui';
import { useRefreshWorkspace } from './queries';
import type { WorkspaceLayout } from './workspace-layout';
import { captureVideoFrame, videoFrameLabel } from './video-frame';
import type { VideoMode } from './data';
import { Editor } from './editing-modules';

export interface MediaEditingDraft { prompt: string; mode: MediaKind; references: AssetDto[]; mask: AssetDto | null; document?: MaskDocument; jobs: string[]; videoMode?: 'edit' | 'extend'; videoTime?: number; frame?: { asset: AssetDto; timeSeconds: number } }
export type MediaEditingDrafts = Map<string, MediaEditingDraft>;
const emptyDraft = (mode: MediaKind): MediaEditingDraft => ({ prompt: '', mode, references: [], mask: null, jobs: [] });
function operationForModel(model: WorkspaceModel, mode: MediaKind, videoMode: VideoMode): MediaOperation {
  return mode === 'video' ? videoMode === 'edit' ? 'video.edit' : videoMode === 'extend' ? 'video.extend' : 'video.image_to_video' : model.capabilities.operations.includes('image.edit') ? 'image.edit' : 'image.generate';
}
function editable(model: WorkspaceModel): boolean {
  return model.capabilities.operations.includes('image.edit') || model.capabilities.operations.includes('image.generate') && model.capabilities.maxReferenceImages > 0;
}
function useMaskPreview(source: string, document: MaskDocument | undefined) {
  const [preview, setPreview] = useState<{ source: string; document: MaskDocument; url: string }>();
  useEffect(() => {
    setPreview(undefined);
    if (!document) return;
    let disposed = false, url: string | undefined;
    const image = new Image(); image.src = source;
    void image.decode().then(async () => {
      if (disposed) return;
      const canvas = window.document.createElement('canvas'); canvas.width = document.width; canvas.height = document.height;
      const context = canvas.getContext('2d'); if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const overlay = window.document.createElement('canvas'); overlay.width = canvas.width; overlay.height = canvas.height;
      const pixels = new Uint8ClampedArray(document.rgba.length), color = MASK_OVERLAY_COLOR;
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = color.red; pixels[i + 1] = color.green; pixels[i + 2] = color.blue; pixels[i + 3] = Math.round((255 - document.rgba[i + 3]!) * color.alpha / 255); }
      overlay.getContext('2d')?.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      context.drawImage(overlay, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob || disposed) return; url = URL.createObjectURL(blob); setPreview({ source, document, url });
    }).catch(() => undefined);
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [source, document]);
  return preview?.source === source && preview.document === document ? preview.url : undefined;
}

export function MediaEditingWorkspace(props: ViewerProps & { models: WorkspaceModel[]; projectId: string | null; layout: WorkspaceLayout; drafts: MediaEditingDrafts; onSelectResult: (item: MediaItem) => void; onBrowseEntry: (delta: number, memberIds: string[], boundary?: boolean) => Promise<boolean>; onResolveEntry: (delta: number, memberIds: string[], boundary?: boolean) => Promise<MediaItem | null> }) {
  const motion = useViewerMotion(props.item.id);
  return <EditingSession key={`${props.projectId ?? 'default'}:${props.item.id}`} {...props} motion={motion} />;
}
function EditingSession(props: ViewerProps & { motion: ViewerMotion; models: WorkspaceModel[]; projectId: string | null; layout: WorkspaceLayout; drafts: MediaEditingDrafts; onSelectResult: (item: MediaItem) => void; onBrowseEntry: (delta: number, memberIds: string[], boundary?: boolean) => Promise<boolean>; onResolveEntry: (delta: number, memberIds: string[], boundary?: boolean) => Promise<MediaItem | null> }) {
  const queryClient = useQueryClient();
  const scope = generationMemoryScope(props.projectId, props.item.id);
  const sourceIsVideo = props.item.kind === 'video';
  const [draft, setDraft] = useState(() => props.drafts.get(scope) ?? emptyDraft(props.item.kind));
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoTime = useRef(draft.videoTime ?? draft.frame?.timeSeconds ?? 0);
  const initialVideoTime = useRef(videoTime.current);
  const captureAbort = useRef<AbortController | null>(null);
  const [capturing, setCapturing] = useState(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const update = (patch: Partial<MediaEditingDraft>) => setDraft(current => ({ ...current, ...patch }));
  useEffect(() => { props.drafts.set(scope, { ...draft, ...(sourceIsVideo ? { videoTime: videoTime.current } : {}) }); while (props.drafts.size > 8) { const oldest = props.drafts.keys().next().value; if (oldest === undefined) break; props.drafts.delete(oldest); } }, [draft, scope, props.drafts, sourceIsVideo]);
  const [expanded, setExpanded] = useState(false), [maskOpen, setMaskOpen] = useState(false), [pickerOpen, setPickerOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState('');
  const actionLocks = useRef(new Set<string>());
  const [actionJobs, setActionJobs] = useState<string[]>([]);
  const lock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; captureAbort.current?.abort(); props.drafts.set(scope, { ...draftRef.current, ...(sourceIsVideo ? { videoTime: videoTime.current } : {}) }); }; }, []);
  const sourceQuery = useQuery({ queryKey: [...internalQueryKeys.assets, 'editing-source', props.item.id], queryFn: () => internalClient.getAsset(props.item.id), enabled: props.online });
  const series = useAssetSeries(props.item.id, props.online);
  const original = sourceQuery.data?.asset ?? props.item.asset;
  const source = sourceIsVideo && draft.mode === 'image' ? draft.frame?.asset ?? null : original;
  const settings = useSettingsQuery(), patchSettings = usePatchSettings(), refresh = useRefreshWorkspace();
  const selected = readGenerationMemory(settings.data?.settings, scope, draft.mode).selected;
  const continuationModes = (['edit', 'extend'] as const).filter(mode => props.models.some(model => model.capabilities.operations.includes(mode === 'edit' ? 'video.edit' : 'video.extend')));
  const videoMode: VideoMode = sourceIsVideo ? draft.videoMode && continuationModes.includes(draft.videoMode) ? draft.videoMode : continuationModes[0] ?? 'edit' : 'first_frame';
  const videoOperation = videoMode === 'edit' ? 'video.edit' : videoMode === 'extend' ? 'video.extend' : 'video.image_to_video';
  const candidates = props.models.filter(model => draft.mode === 'image' ? editable(model) : model.capabilities.operations.includes(videoOperation));
  const selectedModel = candidates.find(model => model.key === selected) ?? candidates.find(model => model.id === props.item.model && model.providerId === props.item.providerId) ?? candidates[0];
  const operation = selectedModel ? operationForModel(selectedModel, draft.mode, videoMode) : draft.mode === 'image' ? 'image.edit' : videoOperation;
  const models = candidates.map(model => modelForOperation(model, operationForModel(model, draft.mode, videoMode)));
  const model = models.find(model => model.key === selectedModel?.key);
  const sourceRole = draft.mode === 'video' ? sourceIsVideo ? 'source' : 'first_frame' : operation === 'image.edit' ? 'source' : 'reference';
  const inputs: ReferenceInput[] = [...(source ? [{ asset: source, role: sourceRole } as ReferenceInput] : []), ...(draft.mode === 'image' ? [...draft.references.map(asset => ({ asset, role: 'reference' as const })), ...(draft.mask ? [{ asset: draft.mask, role: 'mask' as const }] : [])] : [])];
  const referenceLimit = model ? ModelCapabilitiesSchema.parse(model.raw.capabilities).operationPolicies?.[operation]?.maxReferenceImages ?? model.capabilities.maxReferenceImages : 0;
  const maximum = draft.mode === 'video' ? 1 : Math.max(sourceRole === 'source' ? 1 : 0, Math.min(model?.capabilities.inputImagePolicy?.maxCount ?? DEFAULT_IMAGE_INPUT_POLICY.maxCount, referenceLimit + (sourceRole === 'source' ? 1 : 0)));
  const uploads = useReferenceUploads({ role: 'reference', preserveReadyOnDispose: true, preprocessPolicy: model?.capabilities.inputImagePolicy ?? DEFAULT_IMAGE_INPUT_POLICY,
    onReady: (_clientId, assetId) => { void internalClient.getAsset(assetId).then(async ({ asset }) => { if (props.projectId) await internalClient.addCollectionAssets(props.projectId, [asset.id]); if (mounted.current) setDraft(current => ({ ...current, references: current.references.some(item => item.id === asset.id) ? current.references : [...current.references, asset] })); }).catch(() => setError('读取上传素材失败')); },
    onRemoveReady: assetId => setDraft(current => ({ ...current, references: current.references.filter(asset => asset.id !== assetId) })),
  });
  const changeMode = (mode: MediaKind) => {
    if (capturing || submitting) return;
    setExpanded(true); setError(''); update({ mode });
  };
  const captureFrame = async (forMask = false): Promise<AssetDto> => {
    const video = videoRef.current;
    if (!props.online || !video) throw new Error('请先加载并定位视频');
    if (captureAbort.current) throw new Error('正在准备视频帧，请稍候');
    video.pause();
    const cached = draftRef.current.frame;
    if (cached && (draftRef.current.mask || forMask && !video.seeking && Math.abs(cached.timeSeconds - video.currentTime) < 0.001)) {
      try { return (await internalClient.getAsset(cached.asset.id)).asset; } catch { if (draftRef.current.mask && !forMask) throw new Error('这张临时帧已过期，请重新打开蒙版后发送'); }
    }
    const abort = new AbortController(); captureAbort.current = abort; setCapturing(true);
    try {
      const captured = await captureVideoFrame(video, abort.signal);
      const { asset } = await internalClient.uploadAsset(captured.file, { role: 'reference', parentAssetId: props.item.id, temporaryVideoFrame: true }, { signal: abort.signal });
      if (!mounted.current || abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      setDraft(current => { const { document: _document, ...rest } = current; return { ...rest, mask: null, frame: { asset, timeSeconds: captured.timeSeconds } }; });
      return asset;
    } finally { if (captureAbort.current === abort) captureAbort.current = null; if (mounted.current) setCapturing(false); }
  };
  const openMask = async () => {
    try { setError(''); if (sourceIsVideo) await captureFrame(true); if (mounted.current) setMaskOpen(true); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '视频截图失败，请重试'); }
  };
  const jobs = useQueries({ queries: draft.jobs.map(id => ({ queryKey: [...internalQueryKeys.jobs, 'image-editor', id], queryFn: () => internalClient.getJob(id), enabled: props.online, retry: false, refetchInterval: (query: { state: { data: Awaited<ReturnType<typeof internalClient.getJob>> | undefined; error: unknown } }) => query.state.error ? false : !query.state.data || ACTIVE_JOB_STATUSES.has(query.state.data.job.status) ? 1500 : false as const })) });
  useEffect(() => {
    if (!sourceIsVideo || !draft.frame) return;
    const related = jobs.filter(query => query.data?.inputs.some(input => input.assetId === draft.frame!.asset.id));
    if (related.length && related.every(query => query.data && !ACTIVE_JOB_STATUSES.has(query.data.job.status))) {
      setDraft(current => { const { frame: _frame, document: _document, ...rest } = current; return { ...rest, mask: null }; });
    }
  }, [sourceIsVideo, draft.frame, jobs]);
  const submit = async (creation: Creation) => {
    if (activeJobId) { setError('请先选择系列中的图片或视频作为编辑原图'); return; }
    if (!original || sourceQuery.isError) { setError('原素材暂时无法读取，请重试'); return; }
    if (lock.current) return; lock.current = true; setSubmitting(true); setError('');
    try {
      const frame = sourceIsVideo && draft.mode === 'image' ? await captureFrame() : undefined;
      const prepared = frame ? { ...creation, inputs: [{ asset: frame, role: sourceRole } as ReferenceInput, ...creation.inputs.filter(input => input.asset.id !== source?.id && (input.role !== 'mask' || input.asset.parentAssetId === frame.id))] } : creation;
      const result = await internalClient.createJob({ ...generationRequest(prepared), ...(props.projectId ? { collectionId: props.projectId } : {}) }, createBrowserId());
      for (const job of result.jobs ?? [result.job]) queryClient.setQueryData([...internalQueryKeys.jobs, 'image-editor', job.id], { job, assets: [], inputs: job.request.inputs.map((input, sortOrder) => ({ ...input, sortOrder })) });
      const ids = (result.jobs ?? [result.job]).map(job => job.id);
      if (mounted.current) { setActiveJobId(ids[0] ?? null); setExpanded(false); (document.activeElement as HTMLElement | null)?.blur(); }
      if (mounted.current) setDraft(current => ({ ...current, jobs: [...current.jobs, ...ids] }));
      else props.drafts.set(scope, { ...draftRef.current, jobs: [...draftRef.current.jobs, ...ids] });
      void refresh();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '生成提交失败'); }
    finally { lock.current = false; if (mounted.current) setSubmitting(false); }
  };
  const jobAction = async (id: string, retry: boolean) => {
    if (retry && sourceIsVideo && jobs.some(query => query.data?.job.id === id && query.data.job.operation.startsWith('image.'))) { setError('临时视频帧已清理，请确认视频位置后重新发送'); return; }
    if (actionLocks.current.has(id)) return;
    actionLocks.current.add(id); setActionJobs([...actionLocks.current]);
    try {
      const result = retry ? await internalClient.retryJob(id) : await internalClient.cancelJob(id);
      if (retry) { const next = { ...draftRef.current, jobs: draftRef.current.jobs.map(value => value === id ? result.job.id : value) }; props.drafts.set(scope, next); if (mounted.current) { setDraft(next); setActiveJobId(result.job.id); } }
      void refresh();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : '任务操作失败'); }
    finally { actionLocks.current.delete(id); if (mounted.current) setActionJobs([...actionLocks.current]); }
  };
  const seriesJobs = [...new Map([...(series.data?.jobs ?? []), ...jobs.flatMap(query => query.data ? [query.data.job] : [])].map(job => [job.id, job])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seriesAssets = [...new Map([...(series.data?.assets ?? []), ...(original ? [original] : []), ...jobs.flatMap(query => query.data?.assets ?? [])].map(asset => [asset.id, asset])).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seriesItems = seriesAssets.map(asset => mapMedia(asset, seriesJobs.find(job => job.id === asset.jobId) ?? (asset.id === props.item.id ? props.item.job : null)));
  const unresolvedJobs = seriesJobs.filter(job => job.status !== 'completed' && !seriesAssets.some(asset => asset.jobId === job.id));
  const seriesIndex = Math.max(0, seriesItems.findIndex(item => item.id === props.item.id));
  useEffect(() => {
    if (!series.data) return;
    props.motion.prepare(async (axis, direction) => {
      if (axis === 'x') {
        const adjacent = seriesItems[seriesIndex + direction];
        if (adjacent) return adjacent;
        if (props.layout === 'mobile') return null;
      } else if (props.layout !== 'mobile') return null;
      return props.onResolveEntry(direction, seriesAssets.map(asset => asset.id), axis === 'x');
    }, props.onSelectResult, `${props.projectId ?? 'default'}:${props.layout}:${seriesAssets.map(asset => asset.id).join(',')}`);
  });
  const activeQuery = jobs[draft.jobs.indexOf(activeJobId ?? '')];
  const activeJob = seriesJobs.find(job => job.id === activeJobId);
  const activeResult = seriesAssets.find(asset => asset.jobId === activeJobId);
  useEffect(() => {
    if (activeJobId && activeResult) { setActiveJobId(null); props.onSelectResult(mapMedia(activeResult, activeJob)); }
  }, [activeJobId, activeResult, activeJob, props.onSelectResult]);
  const selectItem = (item: MediaItem) => {
    setActiveJobId(null);
    if (item.id !== props.item.id) props.motion.navigate('x', seriesItems.findIndex(member => member.id === item.id) > seriesIndex ? 1 : -1, () => props.onSelectResult(item));
  };
  const selectJob = (id: string) => { setActiveJobId(id); setExpanded(false); };
  const stageContent = activeJobId || submitting && !sourceIsVideo ? <div className={`editing-generation-stage pending-study ${activeJob && ['failed', 'rejected', 'expired', 'cancelled'].includes(activeJob.status) ? 'is-failed' : ''}`} role="status" aria-label="编辑生成状态">
    <div className="pending-study-art" aria-hidden="true" /><Sparkles size={56} strokeWidth={1} />
    {activeJob ? <GenerationStatus status={activeJob.status} createdAt={activeJob.createdAt} completedAt={activeJob.completedAt} /> : <span>{activeQuery?.isError ? '任务读取失败' : submitting ? '正在提交' : '正在读取任务'}</span>}
    {activeJob?.errorMessage && <p>{activeJob.errorMessage}</p>}
    <div>{activeQuery?.isError && <button type="button" className="quiet-command" onClick={() => void activeQuery.refetch()}>重试读取</button>}
    {activeJob && ['failed', 'expired', 'cancelled'].includes(activeJob.status) && <button type="button" className="quiet-command" disabled={!props.online || actionJobs.includes(activeJob.id)} onClick={() => void jobAction(activeJob.id, true)}>重试生成</button>}
    {activeJob && !ACTIVE_JOB_STATUSES.has(activeJob.status) && <button type="button" className="quiet-command" onClick={() => void copyPrompt(activeJob.prompt, props.onNotice)}><Copy size={16} />复制提示词</button>}</div>
  </div> : undefined;
  const frameSource = sourceIsVideo ? draft.frame?.asset.contentUrl ?? '' : props.online ? props.item.src : props.item.thumbnail;
  const preview = useMaskPreview(frameSource, draft.mask ? draft.document : undefined);
  const visiblePreview = draft.mode === 'image' ? preview : undefined;
  const controls = <>
    <div className={`image-editing-controls ${expanded ? 'is-expanded' : ''}`}>
      {(seriesItems.length > 1 || unresolvedJobs.length > 0 || submitting || series.isError) && <div className="editing-results" aria-label="编辑系列">{seriesItems.map((item, index) => <div className={`editing-result ${!activeJobId && item.id === props.item.id ? 'is-selected' : ''}`} key={item.id}><button type="button" aria-label={index === 0 ? '查看原图' : item.kind === 'video' ? '查看生成视频' : '编辑此生成结果'} aria-pressed={!activeJobId && item.id === props.item.id} title={item.title} onClick={() => selectItem(item)}><img src={item.thumbnail} alt={index === 0 ? '原图' : '生成结果'} />{item.kind === 'video' && <Play className="series-video-mark" size={16} fill="currentColor" />}</button></div>)}
      {unresolvedJobs.map(job => <div className={`editing-result ${activeJobId === job.id ? 'is-selected' : ''}`} key={job.id}><button type="button" className="series-job" aria-label={`查看任务 ${job.prompt}`} aria-pressed={activeJobId === job.id} onClick={() => selectJob(job.id)}><Sparkles size={18} /><GenerationStatus status={job.status} createdAt={job.createdAt} completedAt={job.completedAt} /></button></div>)}
      {series.isError && <button type="button" onClick={() => void series.refetch()}>重试加载系列</button>}{series.data?.truncated && <span>系列内容较多，当前仅显示部分作品</span>}
      </div>}
      {capturing && <p className="composer-notice editing-error" role="status">正在截取并上传当前视频帧…</p>}
      {sourceQuery.isError && <p className="composer-notice editing-error" role="alert">原素材暂时无法读取<button type="button" onClick={() => void sourceQuery.refetch()}>重试</button></p>}
      {error && <p className="composer-notice editing-error" role="alert">{error}<button type="button" onClick={() => setError('')}>关闭</button></p>}
      {draft.mode === 'image' && <Tool label="编辑蒙版" className={`editing-mask-entry ${draft.mask ? 'is-active' : ''}`} aria-pressed={!!draft.mask} disabled={!props.online || !original || !candidates.length || submitting || capturing || !!activeJobId} onPointerDown={event => event.preventDefault()} onClick={() => void openMask()}><Brush size={18} /></Tool>}
      <Composer key={`${draft.mode}:${videoMode}:${model?.key ?? ''}`} editing={{ compact: !expanded, onExpand: () => setExpanded(true), sourceId: source?.id ?? props.item.id, ...(sourceIsVideo ? { videoModes: continuationModes, busy: capturing, ...(draft.mode === 'image' && draft.mask && draft.frame ? { sourceLabel: `参考帧 ${videoFrameLabel(draft.frame.timeSeconds)}` } : {}) } : {}) }} operationOverride={operation} layout={props.layout} projectId={scope} prompt={draft.prompt} onPrompt={prompt => update({ prompt })} mode={draft.mode} onMode={mode => void changeMode(mode)} videoMode={videoMode} onVideoMode={mode => { if (mode === 'edit' || mode === 'extend') update({ videoMode: mode }); }} models={models} model={model} onModel={key => patchSettings.mutate(updateGenerationMemory(settings.data?.settings, scope, draft.mode, { selected: key }))} references={inputs} uploads={uploads} onFiles={(files, rejected) => uploads.addFiles(files, { existingCount: draft.references.length + 1, maxItems: maximum, ...(rejected ? { preliminaryRejections: rejected } : {}) })} onRemove={id => { if (id !== source?.id) update({ references: draft.references.filter(asset => asset.id !== id), ...(draft.mask?.id === id ? { mask: null } : {}) }); }} onCreate={creation => void submit(creation)} onLibrary={() => setPickerOpen(true)} onConnections={() => props.onNotice('请先在模型与服务中添加支持当前操作的模型')} online={props.online} submitting={submitting} loading={capturing || !original || sourceQuery.isError || !!activeJobId} focusToken={0} />
    </div>
    {pickerOpen && <ReferencePicker projectId={props.projectId} selectedIds={inputs.map(input => input.asset.id)} maximum={Math.max(0, maximum - 1 - draft.references.length)} onClose={() => setPickerOpen(false)} onPick={assets => { update({ references: [...draft.references, ...assets] }); setPickerOpen(false); }} />}
    {maskOpen && source?.type === 'image' && <Suspense fallback={<Panel open title="局部编辑" onClose={() => setMaskOpen(false)}><LoaderCircle className="spin" /></Panel>}><Editor assetId={source!.id} {...(draft.document ? { initialDocument: draft.document } : {})} onClose={() => setMaskOpen(false)} onApply={(_source, mask, document) => { update({ mask, document }); setMaskOpen(false); void refresh(); }} /></Suspense>}
  </>;
  const move = (delta: number) => {
    const next = seriesItems[seriesIndex + delta];
    if (next) selectItem(next);
    else if (props.layout === 'desktop') props.motion.navigate('x', delta, () => props.onBrowseEntry(delta, seriesAssets.map(asset => asset.id), true));
    else props.motion.settle();
  };
  return <Viewer {...props} stageContent={stageContent} index={seriesIndex} total={seriesItems.length}
    canPrevious={seriesIndex > 0 || props.layout === 'desktop' && props.total > 1}
    canNext={seriesIndex < seriesItems.length - 1 || props.layout === 'desktop' && props.total > 1}
    onMove={move} onMoveEntry={delta => props.motion.navigate('y', delta, () => props.onBrowseEntry(delta, seriesAssets.map(asset => asset.id)))} videoRef={videoRef} initialVideoTime={initialVideoTime.current} onVideoTime={time => { videoTime.current = time; }} {...(visiblePreview ? { previewSrc: visiblePreview } : {})} onStageClick={() => { setExpanded(false); (window.document.activeElement as HTMLElement | null)?.blur(); }} editingControls={controls} />;
}
