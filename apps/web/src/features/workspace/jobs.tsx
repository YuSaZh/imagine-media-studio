import { useState } from 'react';
import type { JobDto } from '@imagine/shared';
import { ArrowUpRight, Check, Clock3, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { ACTIVE_JOB_STATUSES, JOB_LABELS } from './data';
import { useWorkspaceJobs } from './queries';
import { Tool } from './ui';

export function Jobs({ online, busy, onCancel, onRetry, onView }: { online: boolean; busy: boolean; onCancel: (job: JobDto) => void; onRetry: (job: JobDto) => void; onView: (job: JobDto) => void }) {
  const [status, setStatus] = useState('');
  const query = useWorkspaceJobs(status || undefined);
  const jobs = query.data?.pages.flatMap(page => page.items) ?? [];
  return <div className="task-content">
    <label className="task-filter"><span>任务状态</span><select aria-label="任务状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部任务</option>{Object.entries(JOB_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {query.isPending && <p className="loading-state" role="status">正在加载任务…</p>}
    {query.isError && <p className="error-state" role="alert">任务加载失败<button className="quiet-command" onClick={() => void query.refetch()}>重试</button></p>}
    {!query.isPending && !query.isError && !jobs.length && <div className="empty-state"><Clock3 size={30} /><h3>没有符合条件的任务</h3></div>}
    {jobs.map(job => <div className="task-row" key={job.id} data-job-id={job.id} data-status={job.status}>
      <span className={`task-state state-${job.status}`}>{ACTIVE_JOB_STATUSES.has(job.status) ? <LoaderCircle size={18} className="spin" /> : job.status === 'completed' ? <Check size={18} /> : <X size={18} />}</span>
      <div><strong>{JOB_LABELS[job.status]}{job.progress !== null && ACTIVE_JOB_STATUSES.has(job.status) ? ` · ${Math.round(job.progress)}%` : ''}</strong><p>{job.prompt}</p><small>{job.modelId} · {new Date(job.createdAt).toLocaleString()}</small>{job.errorMessage && <p className="task-error">{job.errorMessage}</p>}</div>
      {ACTIVE_JOB_STATUSES.has(job.status) ? <Tool label="取消此任务" disabled={!online || busy} onClick={() => onCancel(job)}><X size={17} /></Tool> : ['failed', 'expired', 'cancelled'].includes(job.status) ? <Tool label="重试此任务" disabled={!online || busy} onClick={() => onRetry(job)}><RefreshCw size={17} /></Tool> : job.status === 'completed' ? <Tool label="查看生成结果" onClick={() => onView(job)}><ArrowUpRight size={18} /></Tool> : null}
    </div>)}
    {query.hasNextPage && <button className="quiet-command load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '正在加载' : '加载更多任务'}</button>}
  </div>;
}
