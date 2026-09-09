import { useEffect, useState } from 'react';
import { ACTIVE_JOB_STATUSES, JOB_LABELS } from './data';
import { generationSeconds } from './generation-time';

export function GenerationStatus({ status, createdAt, completedAt }: { status: string; createdAt?: string | undefined; completedAt?: string | null | undefined }) {
  const [now, setNow] = useState(Date.now);
  const active = ACTIVE_JOB_STATUSES.has(status);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, createdAt]);
  const seconds = generationSeconds(createdAt, completedAt ?? now);
  const label = active && status !== 'queued' ? '生成中' : JOB_LABELS[status] ?? '生成中';
  return <span>{label}{active && seconds !== null ? ` · ${seconds}s` : ''}</span>;
}
