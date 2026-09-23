import { useRef, useState } from 'react';
import type { JobDto } from '@imagine/shared';
import { Trash2, X } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { formatDateTime, t } from '../../i18n';
import { JOB_LABELS } from './data';
import { useRefreshWorkspace } from './queries';
import { Confirm, Tool } from './ui';

export function JobViewerInfo({ job, id, online, onClose, onDeleted }: {
  job: JobDto; id: string; online: boolean; onClose: () => void; onDeleted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  const refresh = useRefreshWorkspace();
  const deletable = ['failed', 'rejected', 'expired', 'cancelled'].includes(job.status);
  const remove = async () => {
    if (!online || !deletable || lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await internalClient.deleteJob(job.id);
      onDeleted(job.id);
      void refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('删除任务失败')); }
    finally { lock.current = false; setBusy(false); }
  };
  return <>
    <aside className="viewer-info" id={id} aria-label={t('任务信息')}>
      <header><h3>{t('任务信息')}</h3><Tool label={t('关闭作品信息')} onClick={onClose}><X size={17} /></Tool></header>
      <div className="viewer-info-body"><div className="viewer-info-content">
        <span className="muted-label">{t('提示词')}</span><p>{job.prompt}</p>
        <dl><div><dt>{t('状态')}</dt><dd>{JOB_LABELS[job.status]}</dd></div><div><dt>{t('模型')}</dt><dd>{job.modelId}</dd></div><div><dt>{t('创建时间')}</dt><dd>{formatDateTime(job.createdAt)}</dd></div></dl>
        {job.errorMessage && <p>{job.errorMessage}</p>}
        <button type="button" className="text-command danger" disabled={!online || !deletable || busy} onClick={() => setConfirming(true)}><Trash2 size={15} />{t('删除任务')}</button>
      </div></div>
    </aside>
    {confirming && <Confirm title={t('删除任务？')} description={t('删除此任务记录和系列占位，不会删除已生成的作品。')} busy={busy} onConfirm={() => void remove()} onClose={() => !busy && setConfirming(false)}>{error && <p className="error-state" role="alert">{error}</p>}</Confirm>}
  </>;
}
