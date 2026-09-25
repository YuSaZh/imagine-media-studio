import { formatDateTime, t } from '../../i18n/index';
import { Select, SelectItem } from './select';
import { useLayoutEffect, useRef, useState } from 'react';
import type { JobDto } from '@imagine/shared';
import { ArrowUpRight, Check, Clock3, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { ACTIVE_JOB_STATUSES, JOB_LABELS, RETRYABLE_JOB_STATUSES } from './data';
import { useWorkspaceJobs } from './queries';
import { Tool } from './ui';

function TaskPrompt({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(prompt);
  const text = useRef<HTMLParagraphElement>(null);
  const probe = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = text.current, measure = probe.current;
    if (!element || !measure) return;
    const update = () => {
      measure.style.width = `${element.clientWidth}px`;
      measure.textContent = prompt;
      const max = parseFloat(getComputedStyle(measure).lineHeight) * 2 + 1;
      if (measure.offsetHeight <= max) { setPreview(prompt); return; }
      let low = 0, high = prompt.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        measure.textContent = `${prompt.slice(0, middle)}… ${t("展开全部")}`;
        if (measure.offsetHeight <= max) low = middle; else high = middle - 1;
      }
      setPreview(prompt.slice(0, low).trimEnd());
    };
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [prompt]);
  const clipped = preview !== prompt;
  return <div className="task-prompt"><p ref={text}>{expanded ? prompt : preview}{clipped && <><span>{expanded ? ' ' : '… '}</span><button type="button" className="task-prompt-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t("收起") : t("展开全部")}</button></>}</p><p ref={probe} className="task-prompt-probe" aria-hidden="true" /></div>;
}

export function Jobs({ online, busy, onCancel, onRetry, onView, onDelete }: { online: boolean; busy: boolean; onCancel: (job: JobDto) => void; onRetry: (job: JobDto) => void; onView: (job: JobDto) => void; onDelete: (job: JobDto) => void }) {
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
      <strong className="task-title">{JOB_LABELS[job.status]}{job.progress !== null && ACTIVE_JOB_STATUSES.has(job.status) ? ` · ${Math.round(job.progress)}%` : ''}</strong>
      <div className="task-actions">
      {ACTIVE_JOB_STATUSES.has(job.status) ? <Tool label={t("取消此任务")} disabled={!online || busy} onClick={() => onCancel(job)}><X size={17} /></Tool> : RETRYABLE_JOB_STATUSES.has(job.status) ? <Tool label={t("重试此任务")} disabled={!online || busy} onClick={() => onRetry(job)}><RefreshCw size={17} /></Tool> : job.status === 'completed' ? <Tool label={t("查看生成结果")} onClick={() => onView(job)}><ArrowUpRight size={18} /></Tool> : null}
      {(RETRYABLE_JOB_STATUSES.has(job.status) || job.status === 'cancelled') && <Tool label={t("删除此任务")} disabled={!online || busy} onClick={() => onDelete(job)}><Trash2 size={17} /></Tool>}
      </div><div className="task-body"><TaskPrompt prompt={job.prompt} />{job.errorMessage && <p className="task-error">{job.errorMessage}</p>}<small>{job.modelId} · {formatDateTime(job.createdAt)}</small></div>
    </div>)}
    {query.hasNextPage && <button className="quiet-command load-more" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? t("正在加载") : t("加载更多任务")}</button>}
  </div>;
}
