import { useState } from 'react';
import { LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { Tool } from './ui';

export function alignImageDimension(value: string | number): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 16384) return undefined;
  return Math.max(16, Math.round(number / 16) * 16);
}

export function linkedImageDimensions(width: string, height: string, edited: 'width' | 'height', ratio: string, locked: boolean): { width: number; height: number } | undefined {
  let w = alignImageDimension(width);
  let h = alignImageDimension(height);
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(ratio);
  if (locked && match) {
    if (edited === 'width' && w !== undefined) h = alignImageDimension(w * Number(match[2]) / Number(match[1]));
    if (edited === 'height' && h !== undefined) w = alignImageDimension(h * Number(match[1]) / Number(match[2]));
  }
  if (w === undefined || h === undefined || w * h > 100_000_000) return undefined;
  return { width: w, height: h };
}

export function CustomDimensions({ value, ratio, accepts, onApply, onUnlock, unlockDisabled = false }: {
  value: string; ratio: string; accepts: (value: string) => boolean; onApply: (value: string) => void; onUnlock: () => void; unlockDisabled?: boolean;
}) {
  const size = /^(\d+)x(\d+)$/.exec(value);
  const [width, setWidth] = useState(size?.[1] ?? '1024');
  const [height, setHeight] = useState(size?.[2] ?? '1024');
  const [locked, setLocked] = useState(true);
  const [edited, setEdited] = useState<'width' | 'height'>('width');
  const [invalid, setInvalid] = useState(false);
  const normalize = (side: 'width' | 'height', lock = locked) => {
    const next = linkedImageDimensions(width, height, side, ratio, lock);
    if (next) { setWidth(String(next.width)); setHeight(String(next.height)); }
    return next;
  };
  const change = (side: 'width' | 'height', value: string) => {
    setEdited(side); setInvalid(false);
    if (side === 'width') setWidth(value); else setHeight(value);
    if (!locked || ratio === 'auto') return;
    const next = linkedImageDimensions(side === 'width' ? value : width, side === 'height' ? value : height, side, ratio, locked);
    if (next) { if (side === 'width') setHeight(String(next.height)); else setWidth(String(next.width)); }
  };
  const apply = () => {
    const next = normalize(edited);
    const value = next ? `${next.width}x${next.height}` : '';
    if (!next || !accepts(value)) { setInvalid(true); return; }
    onApply(value);
  };
  return <div className="image-custom-editor" onKeyDown={event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); apply(); } }}>
    <div className="custom-dimensions">
      <label>宽度<input autoFocus aria-label="自定义图片宽度" type="number" min={16} max={16384} step={16} value={width} aria-invalid={invalid} onChange={event => change('width', event.target.value)} onBlur={() => normalize(edited)} /></label>
      <Tool label={locked && unlockDisabled ? '模型固定画幅比例' : locked ? '解锁画幅比例' : '锁定画幅比例'} disabled={locked && unlockDisabled} aria-pressed={locked} onClick={() => { setLocked(!locked); if (locked) onUnlock(); else normalize(edited, true); }}>{locked ? <LockKeyhole size={18} /> : <UnlockKeyhole size={18} />}</Tool>
      <label>高度<input aria-label="自定义图片高度" type="number" min={16} max={16384} step={16} value={height} aria-invalid={invalid} onChange={event => change('height', event.target.value)} onBlur={() => normalize(edited)} /></label>
    </div>
    <button type="button" className="quiet-command" onClick={apply}>应用</button>
    {invalid && <p role="alert">图片尺寸超出当前模型允许范围</p>}
  </div>;
}
