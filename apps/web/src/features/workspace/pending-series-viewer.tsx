import { t } from '../../i18n/index';
import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Info, Sparkles } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { internalQueryKeys } from '../../api/query-keys';
import { readGeneralSettings, useSettingsQuery } from '../settings/api/settings-query';
import { ACTIVE_JOB_STATUSES, mapMedia, type MediaItem } from './data';
import { JobViewerInfo } from './job-viewer-info';
import { Tool } from './ui';
import { GenerationStatus } from './generation-status';

/** A durable job anchor lets a series open before any output asset exists. */
export function PendingSeriesViewer({ jobId, online, onClose, onSelectResult, onSelectJob }: {
  jobId: string; online: boolean; onClose: () => void; onSelectResult: (item: MediaItem) => void; onSelectJob: (id: string) => void;
}) {
  const settings = useSettingsQuery();
  const preferences = readGeneralSettings(settings.data?.settings);
  const grouped = preferences.groupBySeries && preferences.groupConcurrentImages;
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const opening = useRef(false);
  const [info, setInfo] = useState(false);
  const infoId = useId();
  useEffect(() => { setInfo(false); }, [selectedJob]);
  const series = useQuery({
    queryKey: [...internalQueryKeys.assets, 'pending-series', jobId, grouped, preferences.groupUploadedReferences],
    queryFn: () => internalClient.getJobSeries(jobId, grouped, preferences.groupUploadedReferences),
    enabled: online,
    refetchInterval: query => query.state.data?.jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status) || job.status === 'completed' && job.outputCount > 0 && !query.state.data?.assets.some(asset => asset.jobId === job.id)) ? 1500 : false,
  });
  const jobs = series.data?.jobs ?? [];
  const assets = series.data?.assets ?? [];
  const selected = jobs.find(job => job.id === (selectedJob ?? jobId)) ?? jobs[0];
  const ready = selectedJob ? assets.find(asset => asset.jobId === selectedJob) : assets.find(asset => asset.role === 'output');
  useEffect(() => {
    if (!ready || opening.current) return;
    opening.current = true;
    onSelectResult(mapMedia(ready, jobs.find(job => job.id === ready.jobId)));
  }, [ready, jobs, onSelectResult]);
  const unresolved = jobs.filter(job => !assets.some(asset => asset.jobId === job.id));
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Portal>
    <Dialog.Overlay className="viewer-backdrop" />
    <Dialog.Content className={`study-viewer image-editing-viewer pending-series-viewer ${info ? 'has-info' : ''}`} aria-describedby={undefined} onEscapeKeyDown={event => { if (info) { event.preventDefault(); setInfo(false); } }}>
      <header className="viewer-heading"><div className="viewer-heading-main"><Dialog.Close asChild><button type="button" className="tool" aria-label={t("返回作品")}><ArrowLeft size={20} /></button></Dialog.Close><Dialog.Title>{t("生成系列")}</Dialog.Title></div><div className="viewer-heading-actions"><Tool label={t("作品信息")} className="viewer-info-trigger" disabled={!selected} aria-expanded={info} aria-controls={info ? infoId : undefined} onClick={() => setInfo(!info)}><Info size={19} /></Tool></div></header>
      <div className="viewer-workspace"><div className="viewer-stage">
        <div className={`editing-generation-stage pending-study ${selected && !ACTIVE_JOB_STATUSES.has(selected.status) && selected.status !== 'completed' ? 'is-failed' : ''}`} role="status" aria-label={t("系列生成状态")}>
          <div className="pending-study-art" aria-hidden="true" /><Sparkles size={56} strokeWidth={1} />
          {series.isError ? <><p>{t("系列暂时无法加载")}</p><button type="button" className="quiet-command" onClick={() => void series.refetch()}>{t("重试加载系列")}</button></> : !online ? <p>{t("当前离线，联网后继续更新")}</p> : selected ? <><GenerationStatus status={selected.status} createdAt={selected.createdAt} completedAt={selected.completedAt} />{selected.errorMessage && <p>{selected.errorMessage}</p>}</> : <p>{series.isPending ? t("正在加载系列…") : t("此系列暂无可显示的任务")}</p>}
        </div>
      </div></div>
      {info && selected && <JobViewerInfo key={selected.id} job={selected} id={infoId} online={online} onClose={() => setInfo(false)} onDeleted={id => {
        const nextAsset = assets[0], nextJob = jobs.find(job => job.id !== id);
        if (nextAsset) onSelectResult(mapMedia(nextAsset, jobs.find(job => job.id === nextAsset.jobId)));
        else if (nextJob) onSelectJob(nextJob.id);
        else onClose();
      }} />}
      <div className="image-editing-controls"><div className="editing-results" aria-label={t("编辑系列")}>
        {assets.map(asset => <div className="editing-result" key={asset.id}><button type="button" aria-label={t("查看已完成作品")} aria-pressed="false" onClick={() => onSelectResult(mapMedia(asset, jobs.find(job => job.id === asset.jobId)))}><img src={asset.thumbnailUrl ?? asset.contentUrl} alt={t("生成结果")} /></button></div>)}
        {unresolved.map(job => <div className={`editing-result ${selected?.id === job.id ? 'is-selected' : ''}`} key={job.id}><button type="button" className="series-job" aria-label={t("查看任务 {0}", [job.prompt])} aria-pressed={selected?.id === job.id} onClick={() => setSelectedJob(job.id)}><Sparkles size={18} /><GenerationStatus status={job.status} createdAt={job.createdAt} completedAt={job.completedAt} /></button></div>)}
        {series.data?.truncated && <span>{t("系列内容较多，当前仅显示部分作品")}</span>}
      </div></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
