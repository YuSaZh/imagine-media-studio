import { useState } from 'react';
import type { AssetDto } from '@imagine/shared';
import { Check, Search } from 'lucide-react';
import { useMedia } from './queries';
import { Panel } from './ui';

export function ReferencePicker({ projectId, selectedIds, maximum, onPick, onClose }: { projectId: string | null; selectedIds: string[]; maximum: number; onPick: (assets: AssetDto[]) => void; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<AssetDto[]>([]);
  const query = useMedia({ kind: 'image', saved: false, projectId, search });
  const items = query.data?.pages.flatMap(page => page.items).filter(item => item.asset && item.asset.role !== 'mask') ?? [];
  return <Panel title="选择参考图片" open onClose={onClose} className="reference-picker"><div className="reference-picker-toolbar"><Search size={17} /><input aria-label="搜索参考图片" placeholder="搜索图片" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} /><span>{picked.length} / {maximum}</span></div>
    <div className="reference-picker-grid">{items.map(item => { const selected = picked.some(asset => asset.id === item.id); const existing = selectedIds.includes(item.id); return <button type="button" className={`reference-option ${selected || existing ? 'is-selected' : ''}`} key={item.id} aria-label={`选择参考 ${item.title}`} aria-pressed={selected || existing} disabled={existing || !selected && picked.length >= maximum} onClick={() => setPicked(current => selected ? current.filter(asset => asset.id !== item.id) : [...current, item.asset!])}><img src={item.thumbnail} alt={item.title} loading="lazy" /><span>{item.title}</span>{(selected || existing) && <Check size={18} />}</button>; })}</div>
    {query.isPending && <p className="loading-state" role="status">正在加载图片…</p>}{query.isError && <p className="error-state" role="alert">图片加载失败<button className="quiet-command" onClick={() => void query.refetch()}>重试</button></p>}{!query.isPending && !query.isError && !items.length && <p className="empty-state">没有可用的图片</p>}{query.hasNextPage && <button className="quiet-command" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多图片</button>}
    <div className="reference-picker-footer"><button className="quiet-command" onClick={onClose}>取消</button><button className="primary-command" disabled={!picked.length} onClick={() => onPick(picked)}>添加 {picked.length || ''} 张图片</button></div>
  </Panel>;
}
