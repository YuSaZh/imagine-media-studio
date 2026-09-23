import { formatDateTime, t } from '../../i18n/index';
import { Select, SelectItem } from './select';
import { useState } from 'react';
import type { JobDto } from '@imagine/shared';
import { ArrowUpRight, Check, Clock3, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { ACTIVE_JOB_STATUSES, JOB_LABELS, RETRYABLE_JOB_STATUSES } from './data';
import { useWorkspaceJobs } from './queries';
import { Tool } from './ui';

export function Jobs({ online, busy, onCancel, onRetry, onView }: { online: boolean; busy: boolean; onCancel: (job: JobDto) => void; onRetry: (job: JobDto) => void; onView: (job: JobDto) => void }) {
  const [status, setStatus] = useState('');
  const query = useWorkspaceJobs(status || undefined);
  const jobs = query.data?.pages.flatMap(page => page.items) ?? [];
  return <div className="task-content">
    <label className="task-filter"><span>{t("任务状态")}</span><Select aria-label={t("任务状态")} value={status} onChange={event => setStatus(event.target.value)}><SelectItem value="">{t("全部任务")}</SelectItem>{Object.entries(JOB_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</Select></label>
    {query.isPending && <p className="loading-state" role="status">{t("正在加载任务…")}</p>}
    {query.isError && <p className="error-state" role="alert">{t("任务加载失败")}<button className="quiet-command" onClick={() => void query.refetch()}>{t("重试")}</button></p>}
    {!query.isPending && !query.isError && !jobs.length && <div className="empty-state"><Clock3 size={30} /><h3>{t("没有符合条件的任务")}</h3></div>}
    {jobs.map(job => <div className="task-row" key={job.id} data-job-id={job.id} data-status={job.status}>
      <span className={`task-state state-${job.status}`}>{ACTIVE_JOB_STATUSES.has(job.status) ? <LoaderCircle size={18} className="spin" /> : job.status === 'completed' ? <Check size={18} /> : <X size={18} />}</span>
      <div><strong>{JOB_LABELS[job.status]}{job.progress !== null && ACTIVE_JOB_STATUSES.has(job.status) ? ` · ${Math.round(job.progress)}%` : ''}</strong><p>{job.prompt}</p><small>{job.modelId} · {formatDateTime(job.createdAt)}</small>{job.errorMessage && <p className="task-error">{job.errorMessage}</p>}</div>
      {ACTIVE_JOB_STATUSES.has(job.status) ? <Tool label={t("取消此任务")} disabled={!online || busy} onClick={() => onCancel(job)}><X size={17} /></Tool> : RETRYABLE_JOB_STATUSES.has(job.status) ? <Tool label={t("重试此任务")} disabled={!online || busy} onClick={() => onRetry(job)}><RefreshCw size={17} /></Tool> : job.status === 'completed' ? <Tool label={t("查看生成结果")} onClick={() => onView(job)}><ArrowUpRight size={18} /></Tool> : null}
    </div>)}
    {query.hasNextPage && <button className="quiet-command load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t("正在加载") : t("加载更多任务")}</button>}
  </div>;
}
