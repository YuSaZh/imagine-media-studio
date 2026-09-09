import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { fetchSeries, seriesKey, useAssetSeries } from './series-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { DEFAULT_IMAGE_INPUT_POLICY, type AssetDto, type JsonObject, type JobDto } from '@imagine/shared';
import { ArrowUpRight, Bookmark, Check, CheckCheck, Clock3, Folder, FolderPlus, Grid2X2, Image as ImageIcon, LoaderCircle, LockKeyhole, Menu, MoreHorizontal, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys } from '../../api/query-keys';
import { createBrowserId } from '../../browser-id';
import { activatePwaUpdate, getPwaState, subscribeToPwaState } from '../../pwa-registration';
import { useOnlineStatus } from '../../hooks/use-runtime-state';
import { createComposerDraftPersistence, readComposerDraft, type ComposerDraftPersistence } from '../composer/model/composer-draft';
import { useReferenceUploads } from '../media-input/hooks/use-reference-uploads';
import type { AcquisitionRejection } from '../media-input/model/types';
import { readGeneralSettings, useSettingsQuery, usePatchSettings } from '../settings/api/settings-query';
import { readGenerationMemory, updateGenerationMemory } from './generation-memory';
import { ACTIVE_JOB_STATUSES, generationRequest, mapMedia, mapModels, operationFor, type Creation, type MediaFilter, type MediaPage, type MediaItem, type MediaKind, type Project, type ReferenceInput } from './data';
import { useMedia, useRefreshWorkspace, useWorkspaceCatalog, useWorkspaceJobs } from './queries';
import { Composer } from './composer';
import { BackToTop } from './back-to-top';
import { useWorkspaceLayout } from './workspace-layout';
import { useMobileInteractions } from './mobile-interactions';
import { Gallery } from './gallery';
import { modelForOperation, type VideoMode } from './data';
import { ModelCapabilitiesSchema } from '@imagine/shared';
import { ReferencePicker } from './reference-picker';
import { jobStudies, pendingStudies, type PendingStudy } from './pending-studies';
import type { MediaEditingDrafts } from './media-editing-workspace';
const MediaEditingWorkspace = lazy(() => import('./media-editing-workspace').then(module => ({ default: module.MediaEditingWorkspace })));
import { Choice, Confirm, Options, Panel, Tool } from './ui';

const Settings = lazy(() => import('./settings').then(module => ({ default: module.Settings })));
const Editor = lazy(() => import('./editor').then(module => ({ default: module.Editor })));
const Jobs = lazy(() => import('./jobs').then(module => ({ default: module.Jobs })));
const NAVIGATION = [
  { path: '/imagine', label: '创作', icon: Sparkles },
  { path: '/library', label: '全部作品', icon: Grid2X2 },
  { path: '/saved', label: '收藏', icon: Bookmark },
  { path: '/projects', label: '项目', icon: Folder },
] as const;

export function Workspace() {
  const layout = useWorkspaceLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const section = location.pathname.split('/')[1] || 'imagine';
  const projectId = ['projects', 'folders'].includes(section) ? location.pathname.split('/')[2] ?? null : params.get('project');
  const viewerId = params.get('asset');
  const editorId = section === 'edit' ? location.pathname.split('/')[2] : undefined;
  const online = useOnlineStatus();
  const refresh = useRefreshWorkspace();
  const queryClient = useQueryClient();
  const catalog = useWorkspaceCatalog();
  const settingsQuery = useSettingsQuery();
  const patchSettings = usePatchSettings();
  const pwa = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const preferences = readGeneralSettings(settingsQuery.data?.settings);
  const models = useMemo(() => mapModels(catalog.models.data ?? [], catalog.providers.data ?? []), [catalog.models.data, catalog.providers.data]);
  const projects = catalog.projects.data ?? [];
  const currentProject = projects.find(project => project.id === projectId);
  const [prompt, setPrompt] = useState(() => readComposerDraft()?.prompt ?? '');
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const persistence = useRef<ComposerDraftPersistence | null>(null);
  const [mode, setMode] = useState<MediaKind>('image');
  const videoMemory = readGenerationMemory(settingsQuery.data?.settings, projectId, 'video');
  const videoMode: VideoMode = ['first_frame', 'first_last_frame', 'references', 'edit', 'extend'].includes(String(videoMemory.inputMode)) ? videoMemory.inputMode as VideoMode : 'text';
  const setVideoMode = (inputMode: VideoMode) => patchSettings.mutate(updateGenerationMemory(settingsQuery.data?.settings, projectId, 'video', { inputMode }));
  const remembered = readGenerationMemory(settingsQuery.data?.settings, projectId, mode);
  const modelKey = typeof remembered.selected === 'string' ? remembered.selected : '';
  const setModelKey = (selected: string) => patchSettings.mutate(updateGenerationMemory(settingsQuery.data?.settings, projectId, mode, { selected }));
  const [references, setReferences] = useState<ReferenceInput[]>([]);
  const [referencePicker, setReferencePicker] = useState(false);
  const [optimisticStudies, setOptimisticStudies] = useState<PendingStudy[]>([]);
  const trackedJobs = useRef(new Set<string>());
  const editingDrafts = useRef<MediaEditingDrafts>(new Map());
  const removedUploads = useRef(new Set<string>());
  const uploadProjects = useRef(new Map<string, string | null>());
  const previousProject = useRef(projectId);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const [filter, setFilter] = useState<'all' | MediaKind>('all');
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<MediaItem[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  useMobileInteractions(() => setMenuOpen(true));
  const [taskOpen, setTaskOpen] = useState(false);
  const [projectEditor, setProjectEditor] = useState<Project | 'new' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [movingItem, setMovingItem] = useState<MediaItem | null>(null);
  const [deleteProjectFiles, setDeleteProjectFiles] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; projectId?: string; action: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(0);
  const busyKeys = useRef(new Set<string>());
  const [submitting, setSubmitting] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const galleryScrollRef = useRef<HTMLDivElement>(null);
  const restoreModeFocus = useRef(false);
  const operation = operationFor(mode, videoMode, references);
  const operationModels = useMemo(() => models.map(item => modelForOperation(item, operation)), [models, operation]);
  const supportsOperation = (item: typeof models[number]) => item.capabilities.operations.includes(operation) && (mode !== 'video' || videoMode !== 'first_last_frame' || ModelCapabilitiesSchema.parse(item.raw.capabilities).operationPolicies?.['video.image_to_video']?.inputRoles?.includes('last_frame'));
  const model = operationModels.find(item => item.key === modelKey && supportsOperation(item)) ?? operationModels.find(supportsOperation);
  useEffect(() => {
    if (restoreModeFocus.current) {
      mainRef.current?.querySelector<HTMLButtonElement>('.mode-segments')?.focus({ preventScroll: true });
      restoreModeFocus.current = false;
    }
  }, [mode, model?.key]);
  const excludePrivate = !projectId && ['imagine', 'library', 'projects', 'folders'].includes(section);
  const mediaQuery = useMedia({ groupBySeries: preferences.groupBySeries && !selecting, seriesCover: preferences.seriesCover, excludePrivate, publicProjectIds: projects.filter(project => !project.isPrivate).map(project => project.id).sort(), kind: filter, saved: section === 'saved', projectId, search: searchQuery });
  const items = useMemo(() => [...new Map((mediaQuery.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()], [mediaQuery.data]);
  const displayedJobIds = useMemo(() => new Set(items.flatMap(item => item.asset?.jobId ? [item.asset.jobId] : [])), [items]);
  const jobQuery = useWorkspaceJobs(undefined, excludePrivate);
  const jobs = jobQuery.data?.pages.flatMap(page => page.items) ?? [];
  const activeJobs = [...new Map(jobs.filter(job => ACTIVE_JOB_STATUSES.has(job.status)).map(job => [job.id, job])).values()];
  useEffect(() => {
    for (const job of activeJobs) trackedJobs.current.add(job.id);
    // Tracking only bridges the gap until generated assets reach the gallery.
    for (const id of displayedJobIds) trackedJobs.current.delete(id);
  }, [activeJobs, displayedJobIds]);
  const pending = [...optimisticStudies.filter(study => (!projectId || study.collectionId === projectId) && (!excludePrivate || !study.collectionId || projects.some(project => project.id === study.collectionId && !project.isPrivate))), ...jobs.filter(job => (!excludePrivate || !job.request.collectionId || projects.some(project => project.id === job.request.collectionId && !project.isPrivate)) && (ACTIVE_JOB_STATUSES.has(job.status) || ['failed', 'rejected', 'expired'].includes(job.status) || !preferences.groupBySeries && trackedJobs.current.has(job.id) && job.status === 'completed' && !displayedJobIds.has(job.id)) && (!projectId || job.request.collectionId === projectId) && (filter === 'all' || job.operation.startsWith(`${filter}.`)) && job.prompt.toLowerCase().includes(searchQuery.toLowerCase())).flatMap(job => jobStudies(job, items))];
  const viewerSeries = useAssetSeries(viewerId, online);
  const currentViewerItem = items.find(item => item.id === viewerId);
  const viewerQuery = useQuery({ ...(currentViewerItem?.asset ? { placeholderData: { asset: currentViewerItem.asset } } : {}), queryKey: [...internalQueryKeys.assets, 'detail', viewerId], queryFn: () => internalClient.getAsset(viewerId!), enabled: !!viewerId && online });
  const viewerAsset = viewerQuery.data?.asset.id === viewerId ? viewerQuery.data.asset : currentViewerItem?.asset;
  const viewerJobId = viewerAsset?.jobId ?? currentViewerItem?.job?.id;
  const viewerJob = useQuery({ queryKey: [...internalQueryKeys.jobs, 'detail', viewerJobId], queryFn: () => internalClient.getJob(viewerJobId!), enabled: !!viewerId && !!viewerJobId && online });
  const matchingJob = !viewerJobId ? null : viewerJob.data?.job.id === viewerJobId ? viewerJob.data.job : currentViewerItem?.job?.id === viewerJobId ? currentViewerItem.job : null;
  const viewer = !viewerId ? undefined : viewerAsset ? mapMedia(viewerAsset, matchingJob) : currentViewerItem;

  const lastRecordedView = useRef<string | null>(null);
  useEffect(() => {
    if (!viewerId) { lastRecordedView.current = null; return; }
    if (!online || !viewer || viewer.id !== viewerId || !viewerSeries.data || !settingsQuery.data) return;
    const context = projectId ?? 'default';
    const key = `${context}:${viewerId}`;
    if (lastRecordedView.current === key) return;
    lastRecordedView.current = key;
    const stored = settingsQuery.data.settings['gallery.series_last_viewed'];
    const history = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as JsonObject : {};
    const current = history[context];
    const entries = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    const bounded = Object.fromEntries(Object.entries({ ...entries, [viewerId]: Date.now() }).filter((entry): entry is [string, number] => typeof entry[1] === 'number').sort((a, b) => b[1] - a[1]).slice(0, 500));
    const memberIds = new Set(viewerSeries.data.assets.map(asset => asset.id));
    // Update every compatible cached page immediately; never move or duplicate a series entry.
    for (const query of queryClient.getQueryCache().findAll({ queryKey: [...internalQueryKeys.assets, 'workspace'] })) {
      const filter = query.queryKey.at(-1) as MediaFilter;
      if (!filter.groupBySeries || filter.seriesCover !== 'recent' || filter.projectId !== projectId) continue;
      if (filter.kind !== 'all' && filter.kind !== viewer.kind || filter.saved && !viewer.saved || filter.projectId && !viewer.collectionIds.includes(filter.projectId)) continue;
      if (filter.excludePrivate && viewer.collectionIds.some(id => !filter.publicProjectIds?.includes(id))) continue;
      if (filter.search && ![viewer.prompt, viewer.model, viewer.asset?.originalFilename ?? ''].some(value => value.toLowerCase().includes(filter.search.toLowerCase()))) continue;
      queryClient.setQueryData<InfiniteData<MediaPage>>(query.queryKey, current => current ? { ...current, pages: current.pages.map(page => ({ ...page, items: page.items.map(item => memberIds.has(item.id) && viewer.asset ? { ...viewer, asset: { ...viewer.asset, ...(item.asset?.series ? { series: item.asset.series } : {}) } } : item) })) } : current);
    }
    patchSettings.mutate({ 'gallery.series_last_viewed': { ...history, [context]: bounded } }, {
      onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [...internalQueryKeys.assets, 'workspace'] }); },
      onError: () => { setNotice({ text: '最近查看记录保存失败', error: true }); void queryClient.invalidateQueries({ queryKey: [...internalQueryKeys.assets, 'workspace'] }); },
    });
  }, [viewerId, viewer, viewerSeries.data, online, projectId, settingsQuery.data, patchSettings, queryClient]);

  const notify = (text: string, error = false) => setNotice({ text, error });
  const run = async (key: string, action: () => Promise<void>, success?: string): Promise<boolean> => {
    if (!online) { notify('当前离线，操作暂不可用', true); return false; }
    if (busyKeys.current.has(key)) return false;
    busyKeys.current.add(key); setBusy(value => value + 1);
    try { await action(); await refresh(); if (success) notify(success); return true; }
    catch (error) { notify(error instanceof Error ? error.message : '操作失败，请重试', true); return false; }
    finally { busyKeys.current.delete(key); setBusy(value => value - 1); }
  };
  const uploads = useReferenceUploads({
    role: mode === 'video' && videoMode === 'first_frame' ? 'first_frame' : 'reference',
    preprocessPolicy: model?.capabilities.inputImagePolicy ?? DEFAULT_IMAGE_INPUT_POLICY,
    preserveReadyOnDispose: true,
    onReady: (clientId, id, role) => {
      void internalClient.getAsset(id).then(async ({ asset }) => {
        if (removedUploads.current.has(id)) return;
        const project = uploadProjects.current.get(clientId);
        if (project) await internalClient.addCollectionAssets(project, [asset.id]);
        if ((project ?? null) === activeProject.current) setReferences(current => current.some(input => input.asset.id === id) ? current : [...current, { asset, role: mode === 'video' && videoMode === 'first_last_frame' ? current.some(input => input.role === 'first_frame') ? 'last_frame' : 'first_frame' : role }]);
        void refresh();
      }).catch(() => notify('读取上传素材失败，请移除后重新上传', true));
    },
    onRemoveReady: id => { removedUploads.current.add(id); setReferences(current => current.filter(input => input.asset.id !== id && !(input.role === 'mask' && input.asset.parentAssetId === id))); },
  });

  useEffect(() => {
    const timer = setTimeout(() => { setSearchQuery(search.trim().slice(0, 200)); setSelected([]); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (previousProject.current === projectId) return;
    previousProject.current = projectId;
    for (const entry of uploads.state.entries) uploads.remove(entry.clientId);
    setReferences([]);
  }, [projectId, uploads]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.error ? 10000 : 5000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const draft = createComposerDraftPersistence(); persistence.current = draft;
    return () => { draft.dispose(); if (persistence.current === draft) persistence.current = null; };
  }, []);
  useEffect(() => { if (prompt) persistence.current?.schedule(prompt); else persistence.current?.clear(); }, [prompt]);
  useEffect(() => { document.documentElement.dataset.reduceMotion = preferences.reduceMotion; }, [preferences.reduceMotion]);
  useEffect(() => { setSelected([]); setSelecting(false); setMenuOpen(false); }, [location.pathname, filter]);
  const defaultsApplied = useRef(false);
  useEffect(() => {
    if (defaultsApplied.current || !settingsQuery.data) return;
    defaultsApplied.current = true; setMode(preferences.defaultMode); setFilter(preferences.initialFilter);
  }, [settingsQuery.data, preferences.defaultMode, preferences.initialFilter]);
  useEffect(() => {
    if (location.pathname === '/interaction.html' || section === 'folders') void navigate(section === 'folders' ? `/projects/${encodeURIComponent(projectId ?? '')}` : '/imagine', { replace: true });
  }, [location.pathname, section, projectId, navigate]);

  const go = (path: string) => { setSearch(''); setFilter('all'); setSelected([]); setSelecting(false); setMenuOpen(false); void navigate(path); mainRef.current?.scrollTo({ top: 0 }); galleryScrollRef.current?.scrollTo({ top: 0 }); };
  const openViewer = (id: string) => { const next = new URLSearchParams(params); next.set('asset', id); setParams(next); };
  const selectViewerItem = (item: MediaItem) => {
    if (item.asset) queryClient.setQueryData([...internalQueryKeys.assets, 'detail', item.id], { asset: item.asset });
    openViewer(item.id);
  };
  const movingViewer = useRef(false);
  const viewerLocation = useRef('');
  viewerLocation.current = `${location.pathname}:${viewerId ?? ''}`;
  const resolveViewerEntry = async (delta: number, memberIds: string[], boundary = false) => {
    const locationAtStart = viewerLocation.current;
      const currentMembers = new Set(memberIds);
      let candidates = items;
      const index = candidates.findIndex(item => currentMembers.has(item.id));
      let nextIndex = index < 0 ? delta > 0 ? 0 : candidates.length - 1 : index + delta;
      while (nextIndex >= 0 && nextIndex < candidates.length && currentMembers.has(candidates[nextIndex]!.id)) nextIndex += delta;
      let hasMore = mediaQuery.hasNextPage;
      while (nextIndex >= candidates.length && hasMore) {
        const result = await mediaQuery.fetchNextPage();
        if (viewerLocation.current !== locationAtStart) return null;
        candidates = result.data?.pages.flatMap(page => page.items) ?? candidates;
        hasMore = result.hasNextPage;
        while (nextIndex < candidates.length && currentMembers.has(candidates[nextIndex]!.id)) nextIndex += delta;
      }
      const next = candidates[nextIndex];
      if (!next) return null;
      if (boundary && online) {
        const family = await queryClient.fetchQuery({ queryKey: seriesKey(next.id), queryFn: () => fetchSeries(queryClient, next.id), staleTime: 30000 });
        if (viewerLocation.current !== locationAtStart) return null;
        const asset = delta > 0 ? family.assets[0] : family.assets.at(-1);
        if (asset) return mapMedia(asset, family.jobs.find(job => job.id === asset.jobId));
      }
      return next;
  };
  const moveViewerEntry = async (delta: number, memberIds: string[], boundary = false) => {
    if (movingViewer.current) return false;
    movingViewer.current = true;
    try {
      const next = await resolveViewerEntry(delta, memberIds, boundary);
      if (!next) return false;
      selectViewerItem(next);
      return true;
    } catch { notify('下一件作品暂时无法读取，请重试', true); return false; }
    finally { movingViewer.current = false; }
  };
  const closeViewer = () => { const next = new URLSearchParams(params); next.delete('asset'); setParams(next, { replace: true }); };
  const select = (item: MediaItem) => { setSelecting(true); setSelected(current => current.some(value => value.id === item.id) ? current.filter(value => value.id !== item.id) : [...current, item]); };
  const save = (item: MediaItem) => void run(`save:${item.id}`, async () => { await internalClient.patchAsset(item.id, !item.saved); }, item.saved ? '已取消收藏' : '已加入收藏');
  const remove = (targets: MediaItem[]) => setConfirmation({ title: `删除 ${targets.length} 件作品？`, description: '这会删除服务器上的作品及其媒体文件，此操作无法撤销。', action: async () => {
    const results = await Promise.allSettled(targets.map(item => internalClient.deleteAsset(item.id)));
    for (const [index, item] of targets.entries()) if (results[index]?.status === 'fulfilled' && item.asset?.jobId) trackedJobs.current.delete(item.asset.jobId);
    const failed = targets.filter((_item, index) => results[index]?.status === 'rejected');
    setSelected(failed); setSelecting(failed.length > 0);
    if (viewerId && targets.some(item => item.id === viewerId) && !failed.some(item => item.id === viewerId)) closeViewer();
    if (failed.length) { await refresh(); throw new Error(`${targets.length - failed.length} 件已删除，${failed.length} 件失败，请重试`); }
  } });
  const useCardReference = async (item: MediaItem) => {
    await run(`reference:${item.id}`, async () => {
      let { asset } = await internalClient.getAsset(item.id);
      if (asset.type === 'video') {
        if (!asset.posterUrl) throw new Error('视频封面尚不可用');
        const response = await fetch(asset.posterUrl, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('视频封面读取失败');
        const blob = await response.blob();
        asset = (await internalClient.uploadAsset(new File([blob], 'video-reference.jpg', { type: blob.type }), { role: 'reference' })).asset;
      }
      if (mode === 'video') setVideoMode('first_frame');
      setReferences(current => mode === 'video' ? [{ asset, role: 'first_frame' }] : [...current.filter(input => input.asset.id !== asset.id), { asset, role: 'reference' }]);
      go(projectId ? `/projects/${projectId}` : '/imagine');
      setFocusToken(value => value + 1);
    });
  };
  const create = async (creation: Creation) => {
    if (submitting) return;
    setSubmitting(true);
    const submitted = creation.prompt;
    await run('create', async () => {
      const request = { ...generationRequest(creation), ...(projectId ? { collectionId: projectId } : {}) };
      setOptimisticStudies(pendingStudies(request, { id: createBrowserId(), createdAt: new Date().toISOString(), status: 'submitting', progress: null }));
      const result = await internalClient.createJob(request, createBrowserId());
      for (const job of result.jobs ?? [result.job]) trackedJobs.current.add(job.id);
      if (preferences.clearPromptAfterSubmit && promptRef.current === submitted) setPrompt('');
      setFilter('all'); setSearch('');
    });
    setOptimisticStudies([]);
    setSubmitting(false);
  };
  const addLibraryReferences = (assets: AssetDto[]) => {
    const role = mode === 'video' && ['edit', 'extend'].includes(videoMode) ? 'source' as const : mode === 'video' && ['first_frame', 'first_last_frame'].includes(videoMode) ? 'first_frame' as const : 'reference' as const;
    setReferences(current => [...current, ...assets.filter(asset => !current.some(input => input.asset.id === asset.id)).map((asset, index) => ({ asset, role: mode === 'video' && videoMode === 'first_last_frame' && current.length + index > 0 ? 'last_frame' as const : role }))]);
    setReferencePicker(false);
  };
  const addFiles = (files: readonly File[], rejected: readonly AcquisitionRejection[] = []) => {
    if (mode === 'video' && ['edit', 'extend'].includes(videoMode)) {
      const policy = model && ModelCapabilitiesSchema.parse(model.raw.capabilities).operationPolicies?.[operation]?.video;
      if (policy?.source !== 'uploaded-or-generated' && policy?.allowUploaded !== true) { notify('此操作需要从资源库选择同连接生成的视频', true); return; }
      if (!online || files.length !== 1 || references.length) { notify('请先移除已有源视频，每次选择一个视频', true); return; }
      const project = projectId;
      void run('video-upload', async () => {
        const file = files[0]!;
        if (file.type !== 'video/mp4') throw new Error('源视频须为 MP4');
        const { asset } = await internalClient.uploadAsset(file, { role: 'upload' });
        if (project) await internalClient.addCollectionAssets(project, [asset.id]);
        if (activeProject.current === project) setReferences([{ asset, role: 'source' }]);
      });
      return;
    }
    if (!online || !model) { notify('请先启用支持图片输入的模型', true); return; }
    const role = mode === 'video' && videoMode === 'first_frame' ? 'first_frame' : 'reference';
    const readyLocalIds = new Set(uploads.state.entries.map(entry => entry.assetId));
    const uploadIds = uploads.addFiles(files, { existingCount: references.filter(input => input.role === role).length + uploads.state.entries.filter(entry => !entry.assetId).length,
      existingTotalBytes: references.filter(input => !readyLocalIds.has(input.asset.id)).reduce((sum, input) => sum + input.asset.fileSize, 0),
      maxItems: mode === 'video' && videoMode === 'text' ? 0 : mode === 'video' && videoMode === 'first_last_frame' ? 2 : role === 'first_frame' ? 1 : model.capabilities.maxReferenceImages,
      preliminaryRejections: rejected,
    });
    for (const id of uploadIds ?? []) uploadProjects.current.set(id, projectId);
  };
  const changeMode = (next: MediaKind) => {
    restoreModeFocus.current = document.activeElement?.matches('.mode-segments') === true;
    setMode(next);
    if (references.some(input => input.asset.type === 'video')) { setReferences([]); return; }
    if (next === 'video' && references.length && !references.some(input => input.role === 'mask')) {
      const inputMode = references.length === 1 ? 'first_frame' : 'references'; setVideoMode(inputMode);
      setReferences(current => current.map(input => ({ ...input, role: inputMode === 'first_frame' ? 'first_frame' : 'reference' })));
    } else if (next === 'image') setReferences(current => current.map(input => ({ ...input, role: input.role === 'first_frame' ? 'reference' : input.role })));
  };
  const changeVideoMode = (next: typeof videoMode) => {
    setVideoMode(next);
    if (next === 'text') setReferences([]);
    else if (next === 'edit' || next === 'extend') setReferences(current => current.filter(input => input.asset.type === 'video').slice(0, 1).map(input => ({ ...input, role: 'source' })));
    else setReferences(current => current.filter(input => input.asset.type === 'image' && input.role !== 'mask').slice(0, next === 'first_frame' ? 1 : next === 'first_last_frame' ? 2 : undefined).map((input, index) => ({ ...input, role: next === 'first_last_frame' ? index === 0 ? 'first_frame' : 'last_frame' : next === 'first_frame' ? 'first_frame' : 'reference' })));
  };
  const continueVideo = (item: MediaItem, next: 'edit' | 'extend') => {
    const scope = `edit.${projectId ?? 'default'}.${item.id}`;
    const previous = editingDrafts.current.get(scope) ?? { prompt: '', references: [], mask: null, jobs: [] };
    editingDrafts.current.set(scope, { ...previous, mode: 'video', videoMode: next });
    openViewer(item.id);
  };
  const editProject = (project: Project | 'new') => { setProjectEditor(project); setProjectName(project === 'new' ? '' : project.name); };
  const submitProject = async () => {
    if (!projectName.trim() || !projectEditor) return;
    const success = await run('project', async () => {
      if (projectEditor === 'new') { const result = await internalClient.createCollection(projectName.trim()); go(`/projects/${result.collection.id}`); }
      else await internalClient.patchCollection(projectEditor.id, projectName.trim());
    });
    if (success) setProjectEditor(null);
  };
  const viewJob = (job: JobDto) => void run(`view-job:${job.id}`, async () => {
    const detail = await internalClient.getJob(job.id);
    if (!detail.assets[0]) throw new Error('这个任务没有可查看的结果');
    setTaskOpen(false); openViewer(detail.assets[0].id);
  });
  const jobActions = { online, busy: busy > 0,
    onCancel: (job: JobDto) => { void run(`cancel:${job.id}`, async () => { await internalClient.cancelJob(job.id); }, '已请求取消任务'); },
    onRetry: (job: JobDto) => { void run(`retry:${job.id}`, async () => { await internalClient.retryJob(job.id); }, '已重新提交任务'); }, onView: viewJob,
  };
  const renderJobs = <Suspense fallback={<p className="loading-state">正在加载任务…</p>}><Jobs {...jobActions} /></Suspense>;
  const isProjects = ['projects', 'folders'].includes(section);
  const isCreate = section === 'imagine' || isProjects && !!projectId;
  const hasGallery = section !== 'settings' && section !== 'jobs' && (!isProjects || !!projectId);
  const title = currentProject?.name ?? (section === 'library' ? '全部作品' : section === 'saved' ? '收藏' : isProjects ? '项目' : '最近创作');

  return <div className={`imagine-app ${layout === 'desktop' && railExpanded ? 'has-expanded-rail' : ''}`}>
    <aside className={`side-rail ${railExpanded ? 'is-expanded' : ''}`} onKeyDown={event => { if (event.key === 'Escape') setRailExpanded(false); }}>
      <button className="identity" aria-label={railExpanded ? '收起侧边栏' : '展开侧边栏'} aria-expanded={railExpanded} aria-controls="desktop-rail-navigation" onClick={() => setRailExpanded(current => !current)}><Sparkles size={25} strokeWidth={1.7} /></button>
      <div className="rail-navigation" id="desktop-rail-navigation"><nav aria-label="主导航">{NAVIGATION.map(({ path, label, icon: Icon }) => <Tool label={label} key={path} className={location.pathname.startsWith(path) ? 'is-active' : ''} aria-current={location.pathname.startsWith(path) ? 'page' : undefined} onClick={() => go(path)}><Icon size={21} strokeWidth={1.6} />{railExpanded && <span className="rail-label">{label}</span>}</Tool>)}</nav>
      {railExpanded && <div className="rail-project-list"><span className="muted-label">项目</span>{projects.map(project => <button type="button" key={project.id} aria-current={projectId === project.id ? 'page' : undefined} onClick={() => go(`/projects/${project.id}`)}><Folder size={20} /><span>{project.name}</span></button>)}</div>}</div>
      <div className="rail-bottom"><Tool label="连接与偏好" onClick={() => go('/settings/providers')}><Settings2 size={21} />{railExpanded && <span className="rail-label">连接与偏好</span>}</Tool><span className="avatar">I</span></div>
    </aside>
    <main ref={mainRef} className={`workspace workspace-${layout} ${hasGallery ? 'has-gallery' : ''} section-${isCreate ? 'create' : section}`}>
      <header className="workspace-header"><div className="workspace-location"><Tool label="打开导航" className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></Tool><button className="wordmark" onClick={() => go('/imagine')}>Imagine<span className="wordmark-dot">.</span></button><span className="header-divider" /><Options label="选择项目" className="current-location" trigger={<><span className="project-trigger-text">{section === 'settings' ? '设置' : section === 'jobs' ? '生成任务' : title}</span><ArrowUpRight size={12} /></>}><Choice active={!projectId} onClick={() => go('/imagine')}>最近创作</Choice>{projects.map(project => <Choice key={project.id} active={projectId === project.id} onClick={() => go(`/projects/${project.id}`)}><Folder size={15} />{project.name}</Choice>)}</Options></div><div className="header-actions"><button className="task-indicator" aria-label="生成任务" onClick={() => setTaskOpen(true)}>{activeJobs.length ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={17} />}<span>任务</span>{activeJobs.length > 0 && <b>{activeJobs.length}</b>}</button><Tool className="mobile-settings" label="连接与偏好" onClick={() => go('/settings/providers')}><Settings2 size={19} /></Tool></div></header>
      {!online && <div className="offline-banner" role="status">当前离线，仅显示最近缓存的作品；草稿已保留。</div>}
      {pwa.updateAvailable && !updateDismissed && settingsQuery.data?.settings['pwa.update_notifications'] !== false && <div className="workspace-update" role="status"><span>新版本已就绪</span><button className="quiet-command" disabled={pwa.updating} onClick={() => void activatePwaUpdate()}>更新应用</button><Tool label="稍后更新" onClick={() => setUpdateDismissed(true)}><X size={16} /></Tool></div>}
      {isCreate && <section className="creation-area"><div className="creation-heading"><h1>Imagine</h1><span className="creation-mark"><Sparkles size={22} strokeWidth={1.3} /></span></div><Composer key={`${projectId ?? "default"}:${mode}:${model?.key ?? ""}:${mode === "video" ? videoMode : ""}`} layout={layout} projectId={projectId} prompt={prompt} onPrompt={setPrompt} mode={mode} onMode={changeMode} videoMode={videoMode} onVideoMode={changeVideoMode} models={operationModels} model={model} onModel={setModelKey} references={references} uploads={uploads} onFiles={addFiles} onRemove={id => setReferences(current => current.filter(input => input.asset.id !== id && !(input.role === 'mask' && input.asset.parentAssetId === id)))} onCreate={creation => void create(creation)} onLibrary={() => setReferencePicker(true)} onConnections={() => go('/settings/providers')} online={online} submitting={submitting} loading={catalog.models.isPending || catalog.providers.isPending || busy > 0} focusToken={focusToken} /></section>}
      {section === 'settings' ? <Suspense fallback={<p className="loading-state">正在加载设置…</p>}><Settings online={online} /></Suspense> : section === 'jobs' ? <section className="library-area"><div className="library-title"><h1>生成任务</h1></div>{renderJobs}</section> : <section className="library-area" aria-label="作品库">
        <div className="library-heading"><div className="library-title">{isCreate ? <h2>{title}</h2> : <h1>{title}</h1>}<span>{isProjects && !projectId ? projects.length : items.length}{mediaQuery.hasNextPage ? '+' : ''}</span></div><div className="library-tools">{isProjects && !projectId ? <button className="quiet-command" disabled={!online} onClick={() => editProject('new')}><Plus size={16} />新建项目</button> : <><label className="library-search"><Search size={16} /><input aria-label="搜索作品" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="搜索作品" /></label><Tool label={selecting ? '退出多选' : '选择作品'} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected([]); }}><CheckCheck size={19} /></Tool>{currentProject && <Options label="项目操作" trigger={<MoreHorizontal size={19} />}><Choice active={currentProject.isPrivate} onClick={() => void run(`privacy:${currentProject.id}`, async () => { await internalClient.patchCollection(currentProject.id, { isPrivate: !currentProject.isPrivate }); }, currentProject.isPrivate ? '已在最近创作中显示' : '已设为隐私项目')}><LockKeyhole size={15} />{currentProject.isPrivate ? '取消隐私项目' : '设为隐私项目'}</Choice><Choice active={false} onClick={() => editProject(currentProject)}><Pencil size={15} />重命名</Choice><Choice active={false} onClick={() => { setDeleteProjectFiles(false); setConfirmation({ title: '删除项目？', description: '默认仅删除项目，保留作品。勾选下方选项将同时删除其中的作品，包括它们在其他项目中的引用。', projectId: currentProject.id, action: async () => { go('/projects'); } }); }}><Trash2 size={15} />删除项目</Choice></Options>}</>}</div></div>
        {isProjects && !projectId ? <>{catalog.projects.isError && <p className="error-state">项目加载失败<button onClick={() => void catalog.projects.refetch()}>重试</button></p>}<div className="project-grid">{projects.map(project => <article className="project-tile" key={project.id}><button className="project-open" onClick={() => go(`/projects/${project.id}`)}><div className={`project-cover${project.isPrivate ? ' is-private' : ''}`} aria-label={project.isPrivate ? '隐私项目封面已模糊' : undefined}>{!project.isPrivate && items.filter(item => item.collectionIds.includes(project.id)).slice(0, 3).map(item => <img key={item.id} src={item.thumbnail} alt="" />)}<Folder size={28} strokeWidth={1.3} />{project.isPrivate && <span className="private-project-label"><LockKeyhole size={22} /><span>隐私项目</span></span>}</div><span><strong>{project.name}</strong><small>{project.itemCount} 件作品</small></span><ArrowUpRight size={18} /></button></article>)}<button className="new-project-tile" disabled={!online} onClick={() => editProject('new')}><FolderPlus size={26} /><span>新建项目</span></button></div></> : <>
          <div className="library-filter" role="group" aria-label="作品类型">{[{ key: 'all' as const, label: '全部' }, { key: 'image' as const, label: '图片' }, { key: 'video' as const, label: '视频' }].map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}{selecting && <button className="select-all" onClick={() => setSelected(selected.length === items.length ? [] : items)}>选择已加载作品</button>}</div>
          <div className="gallery-scroll" ref={galleryScrollRef} aria-busy={mediaQuery.isFetching}>
            {mediaQuery.isPending ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={24} />正在加载作品…</div> : !items.length && !(isCreate && pending.length) && !mediaQuery.isError ? <div className="empty-state"><ImageIcon size={34} strokeWidth={1.2} /><h3>{searchQuery ? '没有找到相关作品' : section === 'saved' ? '还没有收藏' : projectId ? '这个项目还没有作品' : '还没有作品'}</h3><button className="quiet-command" onClick={() => { if (searchQuery) setSearch(''); else { go(projectId ? `/projects/${projectId}` : '/imagine'); setFocusToken(value => value + 1); } }}>{searchQuery ? '清除搜索' : '开始创作'}</button></div> : <Gallery onMoveProject={setMovingItem} onNotice={notify} canEditVideo={models.some(item => item.capabilities.operations.includes('video.edit'))} canExtendVideo={models.some(item => item.capabilities.operations.includes('video.extend'))} onVideoContinue={(item, operation) => void continueVideo(item, operation)} onReference={item => void useCardReference(item)} onDeleteJob={id => { void run(`delete-job:${id}`, async () => { await internalClient.deleteJob(id); trackedJobs.current.delete(id); }); }} items={items} pending={isCreate ? pending : []} onCancelJob={id => { const job = jobs.find(job => job.id === id); if (job) jobActions.onCancel(job); }} onRetryJob={id => { const job = jobs.find(job => job.id === id); if (job) jobActions.onRetry(job); }} scrollRef={layout === 'desktop' ? galleryScrollRef : mainRef} selecting={selecting} selected={selected.map(item => item.id)} online={online && busy === 0} onPick={item => selecting ? select(item) : openViewer(item.id)} onSelect={select} onSave={save} onDelete={item => remove([item])} hasMore={!!mediaQuery.hasNextPage} fetching={mediaQuery.isFetchingNextPage} error={mediaQuery.isError} onMore={() => { if (!mediaQuery.isFetchingNextPage) void mediaQuery.fetchNextPage(); }} onRetry={() => void mediaQuery.refetch()} />}
          </div>
        </>}
      </section>}
    </main>
    {hasGallery && <BackToTop key={`${location.pathname}:${layout}:${mode}:${model?.key ?? ""}:${videoMode}`} scrollRef={layout === 'desktop' ? galleryScrollRef : mainRef} galleryRef={galleryScrollRef} workspaceRef={mainRef} hasComposer={isCreate} hidden={selecting || !!viewerId || !!editorId} reduceMotion={preferences.reduceMotion} />}
    {selecting && <div className={`batch-toolbar ${isCreate ? '' : 'batch-toolbar-library'}`}><span>已选 {selected.length} 件</span><Tool label="收藏所选作品" disabled={!selected.length || !online || busy > 0} onClick={() => void run('bulk-save', async () => { for (const item of selected) await internalClient.patchAsset(item.id, true); }, '已加入收藏')}><Bookmark size={18} /></Tool><Options label="将所选作品加入项目" trigger={<FolderPlus size={18} />}><div className="option-heading">项目</div>{projects.map(project => <Choice key={project.id} active={false} onClick={() => void run('bulk-project', async () => { if (!selected.length) return; await internalClient.addCollectionAssets(project.id, selected.map(item => item.id)); setSelected([]); setSelecting(false); }, '已加入项目')}>{project.name}</Choice>)}</Options><Tool label="删除所选作品" disabled={!selected.length || !online || busy > 0} onClick={() => remove(selected)}><Trash2 size={18} /></Tool><Tool label="关闭多选" onClick={() => { setSelected([]); setSelecting(false); }}><X size={18} /></Tool></div>}
    {viewer && !viewerQuery.isError && <Suspense fallback={<Panel open title="作品编辑" onClose={closeViewer}><p className="loading-state">正在加载编辑工作区…</p></Panel>}><MediaEditingWorkspace models={models} projectId={projectId} layout={layout} drafts={editingDrafts.current} onSelectResult={selectViewerItem} onBrowseEntry={moveViewerEntry} onResolveEntry={resolveViewerEntry} item={viewer} index={Math.max(0, items.findIndex(item => item.id === viewer.id))} total={Math.max(1, items.length)} projects={projects} online={online} busy={busy > 0} providerName={catalog.providers.data?.find(provider => provider.id === viewer.providerId)?.name ?? '本地上传'} onClose={closeViewer} onMove={delta => { const index = items.findIndex(item => item.id === viewer.id); const next = items[(Math.max(0, index) + delta + items.length) % items.length]; if (next) openViewer(next.id); }} onSave={() => save(viewer)} onDelete={() => remove([viewer])} onProject={(id, included) => void run('project-membership', async () => { if (included) await internalClient.addCollectionAssets(id, [viewer.id]); else await internalClient.removeCollectionAsset(id, viewer.id); }, included ? '已加入项目' : '已移出项目')} onNotice={notify} /></Suspense>}
    {viewerId && (viewerQuery.isError || (!viewer && !online)) && <Panel open title="作品不可用" onClose={closeViewer}><p className="error-state">作品已删除或暂时无法加载。</p></Panel>}
    {editorId && <Suspense fallback={<Panel open title="局部编辑" onClose={() => go(projectId ? `/projects/${projectId}` : '/imagine')}><p className="loading-state">正在加载编辑器…</p></Panel>}><Editor assetId={editorId} onClose={() => go(projectId ? `/projects/${projectId}` : '/imagine')} onApply={(source, mask, document) => { editingDrafts.current.set(`edit.${projectId ?? 'default'}.${source.id}`, { prompt: '', mode: 'image', references: [], mask, document, jobs: [] }); go(`${projectId ? `/projects/${projectId}` : '/imagine'}?asset=${encodeURIComponent(source.id)}`); void refresh(); }} /></Suspense>}
    <Panel title="Imagine" open={layout === 'mobile' && menuOpen} onClose={() => setMenuOpen(false)} className="navigation-panel"><nav aria-label={layout === 'desktop' ? '侧边导航' : '手机导航'}>{NAVIGATION.map(({ path, label, icon: Icon }) => <button type="button" key={path} aria-current={location.pathname.startsWith(path) ? 'page' : undefined} onClick={() => go(path)}><Icon size={20} /><span>{label}</span></button>)}</nav><div className="mobile-project-list"><span className="muted-label">项目</span>{projects.map(project => <button key={project.id} aria-current={projectId === project.id ? 'page' : undefined} onClick={() => go(`/projects/${project.id}`)}><Folder size={17} />{project.name}</button>)}</div></Panel>
    {referencePicker && <ReferencePicker kind={mode === 'video' && ['edit', 'extend'].includes(videoMode) ? 'video' : 'image'} projectId={projectId} selectedIds={references.map(input => input.asset.id)} maximum={Math.max(0, (mode === 'video' && ['first_frame', 'edit', 'extend'].includes(videoMode) ? 1 : mode === 'video' && videoMode === 'first_last_frame' ? 2 : model?.capabilities.maxReferenceImages ?? 0) - references.length)} onPick={addLibraryReferences} onClose={() => setReferencePicker(false)} />}
    <Panel title="生成任务" open={taskOpen} onClose={() => setTaskOpen(false)} className="task-panel">{taskOpen && renderJobs}</Panel>
    <Panel title={projectEditor === 'new' ? '新建项目' : '重命名项目'} open={projectEditor !== null} onClose={() => setProjectEditor(null)} className="compact-panel"><form className="project-form" onSubmit={event => { event.preventDefault(); void submitProject(); }}><label>项目名称<input aria-label="项目名称" value={projectName} maxLength={120} onChange={event => setProjectName(event.target.value)} /></label><div><button type="button" className="quiet-command" disabled={busy > 0} onClick={() => setProjectEditor(null)}>取消</button><button className="primary-command" type="submit" disabled={!projectName.trim() || busy > 0}>保存项目</button></div></form></Panel>
    {movingItem && <Panel title="移动到项目" open onClose={() => { if (!busy) setMovingItem(null); }} className="compact-panel"><div className="move-project-list">{projects.length ? projects.map(project => <button type="button" key={project.id} disabled={!online || busy > 0 || movingItem.collectionIds.length === 1 && movingItem.collectionIds[0] === project.id} onClick={() => void run('move-project', async () => { await internalClient.moveCollectionAssets(project.id, [movingItem.id]); setMovingItem(null); }, '已移动到项目')}><Folder size={18} /><span>{project.name}</span>{movingItem.collectionIds.includes(project.id) && <small>当前项目</small>}</button>) : <p className="muted-label">暂无项目，请先在项目页创建项目。</p>}</div></Panel>}
    {confirmation && <Confirm title={confirmation.title} description={confirmation.description} busy={busy > 0} onClose={() => setConfirmation(null)} onConfirm={() => { const pending = confirmation; setConfirmation(null); void run('delete', async () => { if (pending.projectId) await internalClient.deleteCollection(pending.projectId, deleteProjectFiles); await pending.action(); }, '删除成功'); }}>{confirmation.projectId && <label className="delete-project-files"><input type="checkbox" checked={deleteProjectFiles} onChange={event => setDeleteProjectFiles(event.target.checked)} />同时删除项目内文件</label>}</Confirm>}
    {notice && <div className={`feedback-toast ${notice.error ? 'is-error' : ''}`} role={notice.error ? 'alert' : 'status'}><Check size={17} /><span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
