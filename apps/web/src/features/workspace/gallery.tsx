import { t, rich } from '../../i18n/index';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Bookmark, FolderInput, Images, Copy, Check, CheckCheck, Image as ImageIcon, ImagePlus, MoreHorizontal, Play, RefreshCw, Trash2, LoaderCircle, Sparkles, X } from 'lucide-react';
import { copyPrompt } from './copy-prompt';
import { useGallerySelection } from './use-gallery-selection';
import { RETRYABLE_JOB_STATUSES, type MediaItem } from './data';
import { Choice, Options } from './ui';
import { groupPendingStudies, type PendingStudy } from './pending-studies';
import { GenerationStatus } from './generation-status';
import { formatGenerationTime, generationSeconds } from './generation-time';

const GALLERY_PRELOAD_DISTANCE = 1000;

interface GalleryProps {
  revealRef?: RefObject<((id: string) => void) | null>;
  loading?: boolean;
  onShowJobs?: () => void;
  onOpenPendingSeries?: (jobId: string) => void;
  onNotice?: (message: string) => void;
  onVideoContinue?: (item: MediaItem, operation: 'edit' | 'extend') => void;
  canEditVideo?: boolean;
  canExtendVideo?: boolean;
  pending?: PendingStudy[];
  onCancelJob?: (id: string) => void;
  onRetryJob?: (id: string) => void;
  onDeleteJob?: (id: string) => void;
  onDeleteJobs?: (ids: string[]) => void;
  onReference?: (item: MediaItem) => void;
  items: MediaItem[];
  scrollRef: RefObject<HTMLElement | null>;
  selecting: boolean;
  selected: readonly string[];
  online: boolean;
  onPick: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  onSave: (item: MediaItem) => void;
  onDelete: (item: MediaItem) => void;
  onMoveProject?: (item: MediaItem) => void;
  hasMore: boolean;
  fetching: boolean;
  error: boolean;
  onMore: () => void;
  onRetry: () => void;
}

function durationLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function Thumbnail({ item, visible, shouldLoad }: { item: MediaItem; visible: boolean; shouldLoad: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [requested, setRequested] = useState(shouldLoad);
  useEffect(() => { if (shouldLoad) setRequested(true); }, [shouldLoad]);
  const mount = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete) setState(image.naturalWidth > 0 ? 'ready' : 'error');
  }, []);
  if (state === 'error') return <span className="media-unavailable"><ImageIcon size={25} /><span>{t("预览不可用")}</span></span>;
  return <>
    {state === 'loading' && <span className="thumbnail-placeholder" aria-hidden="true" />}
    {(shouldLoad || requested) && <img ref={mount} src={item.thumbnail} alt={item.title} width={item.width} height={item.height} className={`thumbnail-${state}`} loading="eager" fetchPriority={visible ? 'high' : 'low'} decoding="async" draggable={false} onLoad={() => setState('ready')} onError={() => setState('error')} />}
  </>;
}

function Card({ item, props, visible, shouldLoad, task }: { item: MediaItem; props: GalleryProps; visible: boolean; shouldLoad: boolean; task?: PendingStudy }) {
  const selected = props.selected.includes(item.id);
  const elapsed = item.job?.completedAt ? generationSeconds(item.job.createdAt, item.job.completedAt) : null;
  const selection = useGallerySelection(props.scrollRef, () => props.onSelect(item), () => props.onPick(item));
  return <article className={`study-card ${task ? 'pending-study has-cover' : ''} ${selected ? 'is-selected' : ''}`} data-study-id={item.id} data-pending-job={task?.jobId}>
    <button className="study-open" aria-label={t("查看 {0}", [item.title])} aria-pressed={props.selecting ? selected : undefined}
      {...selection}>
      <Thumbnail key={item.thumbnail} item={item} visible={visible} shouldLoad={shouldLoad} />
      {item.kind === 'video' && <span className="video-tag"><Play size={11} fill="currentColor" />{durationLabel(item.durationSeconds ?? 0)}</span>}
      {item.asset?.series && item.asset.series.count > 1 && <span className="series-count" aria-label={t("系列共 {0} 件作品", [item.asset.series.count])}><Images size={14} strokeWidth={1.75} aria-hidden="true" /><span>{item.asset.series.count}</span></span>}
      <span className="study-caption"><strong>{item.title}</strong><span>{item.model}{elapsed !== null ? ` · ${formatGenerationTime(elapsed)}` : ''}</span></span>
      {props.selecting && <span className="select-mark">{selected && <Check size={17} />}</span>}
    </button>
    {task && !props.selecting && <span title={task.error} className={`pending-cover-status ${RETRYABLE_JOB_STATUSES.has(task.status) ? 'is-failed' : ''}`}>{RETRYABLE_JOB_STATUSES.has(task.status) ? t("生成失败") : <GenerationStatus status={task.status} createdAt={task.createdAt} completedAt={task.completedAt} />}</span>}
    {!props.selecting && <>
      {(item.prompt || task?.prompt) && <button className="card-copy-prompt" aria-label={t("复制提示词 {0}", [item.title])} title={t("复制提示词")} onClick={event => { event.stopPropagation(); void copyPrompt(item.prompt || task?.prompt || '', props.onNotice ?? (() => {})); }}><Copy size={17} /></button>}
      <button className={`card-bookmark ${item.saved ? 'is-saved' : ''}`} disabled={!props.online} aria-label={item.saved ? t("取消收藏 {0}", [item.title]) : t("收藏 {0}", [item.title])} onClick={() => props.onSave(item)}><Bookmark size={17} fill={item.saved ? 'currentColor' : 'none'} /></button>
      <button className="card-reference" disabled={!props.online} aria-label={t("加入参考 {0}", [item.title])} title={t("加入参考")} onClick={() => props.onReference?.(item)}><ImagePlus size={17} /></button>
      <Options label={t("{0} 更多操作", [item.title])} className="card-more" contentClassName="asset-options" trigger={<MoreHorizontal size={19} />}>
        {task && <Choice active={false} onClick={() => props.onShowJobs?.()}>{t("查看系列任务")}</Choice>}
        {task && props.online && (task.members ?? [task]).some(member => RETRYABLE_JOB_STATUSES.has(member.status) && member.jobId) && <Choice active={false} onClick={() => props.onDeleteJobs?.((task.members ?? [task]).filter(member => RETRYABLE_JOB_STATUSES.has(member.status) && member.jobId).map(member => member.jobId!))}><Trash2 size={15} />{t("删除失败任务")}</Choice>}
        <Choice active={false} onClick={() => props.onSelect(item)}><CheckCheck size={15} />{t("选择作品")}</Choice>
        {props.online && props.onMoveProject && <Choice active={false} onClick={() => props.onMoveProject?.(item)}><FolderInput size={15} />{t("移动到项目")}</Choice>}
        {item.kind === 'video' && props.online && props.canEditVideo && <Choice active={false} onClick={() => props.onVideoContinue?.(item, 'edit')}>{t("编辑视频")}</Choice>}
        {item.kind === 'video' && props.online && props.canExtendVideo && <Choice active={false} onClick={() => props.onVideoContinue?.(item, 'extend')}>{t("续写视频")}</Choice>}
        {props.online && <Choice active={false} onClick={() => props.onDelete(item)}><Trash2 size={15} />{t("删除")}</Choice>}
      </Options>
    </>}
  </article>;
}

const loadingEntries = [0.8, 1.25, 1, 1.5, 1.1, 0.85, 1.4, 1, 1.25, 0.8, 1.1, 1.4].map((height, index) => ({ type: 'loading' as const, id: `gallery-loading-${index}`, width: 1, height }));

export function Gallery(props: GalleryProps) {
  const grouped = useMemo(() => groupPendingStudies(props.pending ?? [], props.items), [props.pending, props.items]);
  const entries = useMemo(() => [...grouped.pending.map(task => ({ type: 'task' as const, task, id: task.id, width: task.width, height: task.height })), ...(props.loading ? loadingEntries : grouped.items.map(item => ({ type: 'asset' as const, item, id: item.id, width: item.width, height: item.height })))], [grouped, props.loading]);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ width: 1000, margin: 0, measured: false });
  const columns = layout.width < 560 ? 2 : layout.width < 920 ? 3 : 4;
  const gap = layout.width < 560 ? 8 : 12;
  const width = Math.max(1, (layout.width - gap * (columns - 1)) / columns);
  // Mount enough cards to cover the preload distance even at the minimum card height.
  const overscan = Math.max(6, Math.ceil(GALLERY_PRELOAD_DISTANCE / (width * .5 + gap)) * columns);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => props.scrollRef.current,
    getItemKey: index => entries[index]?.id ?? index,
    estimateSize: index => width * Math.max(.5, Math.min(1.8, (entries[index]?.height ?? 1) / (entries[index]?.width ?? 1))),
    lanes: columns, gap, overscan, scrollMargin: layout.margin,
  });
  useLayoutEffect(() => {
    const ref = props.revealRef;
    if (!ref) return;
    ref.current = id => {
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0 || !props.scrollRef.current) return;
      virtualizer.scrollToIndex(index, { align: 'center', behavior: 'auto' });
    };
    return () => { ref.current = null; };
  }, [props.revealRef, props.scrollRef, entries, virtualizer]);
  useLayoutEffect(() => {
    const measure = () => {
      const grid = gridRef.current;
      const scroll = props.scrollRef.current;
      if (!grid || !scroll) return;
      const width = grid.clientWidth;
      const margin = grid.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      setLayout(current => current.measured && current.width === width && Math.abs(current.margin - margin) < .5 ? current : { width, margin, measured: true });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (gridRef.current) observer.observe(gridRef.current);
    return () => observer.disconnect();
  });
  useEffect(() => { virtualizer.measure(); }, [width, columns, virtualizer]);
  useEffect(() => {
    if (!sentinel.current || !props.hasMore || props.fetching || props.error) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) props.onMore(); }, { root: props.scrollRef.current, rootMargin: `${GALLERY_PRELOAD_DISTANCE}px` });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [props]);

  return <>
    <div className="study-grid virtual-studies" ref={gridRef} style={{ height: virtualizer.getTotalSize() }} role={props.loading ? 'status' : undefined} aria-busy={props.loading || undefined} aria-label={props.loading ? t("正在加载作品") : t("作品网格")}>
      {virtualizer.getVirtualItems().map(virtual => {
        const top = virtualizer.scrollOffset ?? 0;
        const bottom = top + (props.scrollRef.current?.clientHeight ?? 0);
        const visible = layout.measured && virtual.end > top && virtual.start < bottom;
        const shouldLoad = layout.measured && virtual.end > top - GALLERY_PRELOAD_DISTANCE && virtual.start < bottom + GALLERY_PRELOAD_DISTANCE;
        const entry = entries[virtual.index];
        return entry ? <div key={entry.id} className="virtual-study" style={{ width, height: virtual.size, left: (virtual.lane ?? virtual.index % columns) * (width + gap), transform: `translateY(${virtual.start - layout.margin}px)` }}>{entry.type === 'loading' ? <div className="gallery-skeleton" aria-hidden="true" /> : entry.type === 'asset' ? <Card item={entry.item} props={props} visible={visible} shouldLoad={shouldLoad} /> : <PendingCard task={entry.task} props={props} />}</div> : null;
      })}
    </div>
    <div className="gallery-pagination" ref={sentinel}>
      {props.error ? <button className="quiet-command" onClick={props.onRetry}><RefreshCw size={15} />{t("加载失败，重试")}</button> : props.fetching ? <span role="status">{t("正在加载作品…")}</span> : props.hasMore ? <button className="quiet-command" onClick={props.onMore}>{t("加载更多作品")}</button> : props.items.length ? <span>{t("已显示全部作品")}</span> : null}
    </div>
  </>;
}

function PendingCard({ task, props }: { task: PendingStudy; props: GalleryProps }) {
  if (task.cover) {
    const item = { ...task.cover, ...(task.cover.asset ? { asset: { ...task.cover.asset, series: { id: task.seriesId ?? task.cover.id, count: task.seriesCount ?? task.cover.asset.series?.count ?? 1 } } } : {}) };
    return <Card item={item} props={props} visible shouldLoad task={task} />;
  }
  const failed = RETRYABLE_JOB_STATUSES.has(task.status);
  return <article className={`study-card pending-study ${failed ? 'is-failed' : ''}`} data-pending-job={task.jobId ?? task.id} aria-label={failed ? t("生成失败") : task.kind === 'image' ? t("正在生成图片") : t("正在生成视频")} aria-busy={!failed}>
    {task.seriesId && task.jobId && <button className="study-open pending-series-open" aria-label={t("查看生成中的系列")} disabled={props.selecting} onClick={() => props.onOpenPendingSeries?.(task.jobId!)} />}
    {!!task.seriesCount && task.seriesCount > 1 && <span className="series-count" aria-label={t("系列共 {0} 件作品", [task.seriesCount])}><Images size={14} /><span>{task.seriesCount}</span></span>}
    <div className="pending-study-art"><Sparkles size={34} strokeWidth={1} /></div><div className="pending-study-copy" role="status">{failed ? <span>{task.error ?? t("生成失败")}</span> : <><LoaderCircle size={17} className="spin" /><GenerationStatus status={task.status} createdAt={task.createdAt} completedAt={task.completedAt} />{task.progress !== null && <span>{Math.round(task.progress)}%</span>}</>}<p>{task.prompt}</p>{task.members && task.members.length > 1 && <span>{rich("{0} 个任务 · {1} 个失败", [task.members.length, task.members.filter(member => ['failed', 'rejected', 'expired'].includes(member.status)).length])}</span>}</div>
    {(task.members && task.members.length > 1) && <Options label={t("系列更多操作")} className="pending-study-action" trigger={<MoreHorizontal size={17} />}>
      <Choice active={false} onClick={() => props.onShowJobs?.()}>{t("查看系列任务")}</Choice>
      {props.online && (task.members ?? [task]).some(member => RETRYABLE_JOB_STATUSES.has(member.status) && member.jobId) && <Choice active={false} onClick={() => props.onDeleteJobs?.((task.members ?? [task]).filter(member => RETRYABLE_JOB_STATUSES.has(member.status) && member.jobId).map(member => member.jobId!))}><Trash2 size={15} />{t("删除失败任务")}</Choice>}
    </Options>}
    {(!task.members || task.members.length === 1) && task.jobId && <button type="button" className="pending-study-action" aria-label={failed ? t("重试生成") : t("取消生成")} title={failed ? t("重试生成") : t("取消生成")} disabled={!props.online} onClick={() => failed ? props.onRetryJob?.(task.jobId!) : props.onCancelJob?.(task.jobId!)}>{failed ? <RefreshCw size={17} /> : <X size={17} />}</button>}
    {failed && task.prompt && <button type="button" className="card-copy-prompt" aria-label={t("复制提示词")} title={t("复制提示词")} onClick={() => void copyPrompt(task.prompt, props.onNotice ?? (() => {}))}><Copy size={17} /></button>}
    {failed && (!task.members || task.members.length === 1) && task.jobId && <button type="button" className="pending-study-action pending-study-delete" aria-label={t("删除失败任务")} title={t("删除失败任务")} disabled={!props.online} onClick={() => props.onDeleteJob?.(task.jobId!)}><Trash2 size={17} /></button>}
  </article>;
}
