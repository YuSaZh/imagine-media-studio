import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus } from 'lucide-react';

export function GenerationCount({ value, onChange, label = '选择图片生成数量', title = '图片数量', trigger, className = '' }: {
  value: number; onChange: (value: number) => void; label?: string; title?: string; trigger?: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const commit = (next: number) => { onChange(next); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={value => { setOpen(value); setCustom(false); setInvalid(false); }}>
    <Popover.Trigger asChild><button type="button" className={`option-trigger ${className}`} aria-label={label}>{trigger ?? <span>×{value}</span>}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="options count-options" aria-label={title} sideOffset={10} collisionPadding={12}>
      <div className="option-heading">{title}</div>
      <div className="count-segments">{[1, 2, 4, 8].map(count => <button type="button" key={count} aria-pressed={value === count && !custom} className={value === count && !custom ? 'is-active' : ''} onClick={() => commit(count)}>{count}</button>)}
        <button type="button" aria-label="自定义生成数量" title="自定义生成数量" aria-pressed={custom || ![1, 2, 4, 8].includes(value)} className={custom || ![1, 2, 4, 8].includes(value) ? 'is-active' : ''} onClick={() => { setDraft(String(value)); setCustom(true); setInvalid(false); }}><Plus size={19} /></button>
      </div>
      {custom && <div className="custom-count"><label>张数<input autoFocus aria-label="自定义张数" type="number" min={1} max={32} step={1} value={draft} aria-invalid={invalid} onChange={event => { setDraft(event.target.value); setInvalid(false); }} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); const next = Number(draft); if (Number.isInteger(next) && next >= 1 && next <= 32) commit(next); else setInvalid(true); }
      }} /></label><button type="button" className="quiet-command" onClick={() => { const next = Number(draft); if (Number.isInteger(next) && next >= 1 && next <= 32) commit(next); else setInvalid(true); }}>应用</button>{invalid && <p role="alert">生成数量应为 1 到 32</p>}</div>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
