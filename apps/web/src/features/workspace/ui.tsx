import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Popover from '@radix-ui/react-popover';
import { X } from 'lucide-react';

export function Tool({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button type="button" aria-label={label} className={`tool ${className}`} {...props}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tip" sideOffset={8}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}

export function Panel({ title, open, onClose, children, className = '', onEscapeKeyDown }: { title: string; open: boolean; onClose: () => void; children: ReactNode; className?: string; onEscapeKeyDown?: (event: KeyboardEvent) => void }) {
  return <Dialog.Root open={open} onOpenChange={value => !value && onClose()}><Dialog.Portal><Dialog.Overlay className="panel-backdrop" /><Dialog.Content {...(onEscapeKeyDown ? { onEscapeKeyDown } : {})} className={`panel ${className}`} aria-describedby={undefined}><header className="panel-header"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><button type="button" className="tool" aria-label="关闭面板"><X size={20} /></button></Dialog.Close></header>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function Options({ label, trigger, children, className = '' }: { label: string; trigger: ReactNode; children: ReactNode; className?: string }) {
  return <Popover.Root><Popover.Trigger asChild><button type="button" aria-label={label} className={`option-trigger ${className}`}>{trigger}</button></Popover.Trigger><Popover.Portal><Popover.Content className="options" sideOffset={10} collisionPadding={12} aria-label={label}>{children}</Popover.Content></Popover.Portal></Popover.Root>;
}

export function Choice({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return <Popover.Close asChild><button className={`choice ${active ? 'is-active' : ''}`} type="button" aria-pressed={active} onClick={onClick}>{children}</button></Popover.Close>;
}

export function Confirm({ title, description, busy, onConfirm, onClose }: { title: string; description: string; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Panel title={title} open onClose={() => !busy && onClose()} className="compact-panel">
    <div className="confirmation-body"><p>{description}</p><div><button className="quiet-command" disabled={busy} onClick={onClose}>取消</button><button className="primary-command danger-fill" disabled={busy} onClick={onConfirm}>{busy ? '正在处理' : '确认删除'}</button></div></div>
  </Panel>;
}
