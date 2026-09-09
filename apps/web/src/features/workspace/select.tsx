import { Children, isValidElement, useId, useRef, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';

interface ItemProps { value?: string | number; disabled?: boolean; children?: ReactNode }

// Declarative options are read by Select; they never create a native menu.
export function SelectItem(_props: ItemProps) { return null; }

function optionText(value: ReactNode): string {
  return Children.toArray(value).map(child => isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child)).join('');
}

export function Select({ value, onChange, children, disabled, iconOnly = false, 'aria-label': label }: {
  value: string | number;
  onChange: (event: { target: { value: string } }) => void;
  children: ReactNode;
  disabled?: boolean;
  iconOnly?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const content = useRef<HTMLDivElement>(null);
  const search = useRef({ value: '', time: 0 });
  const options = Children.toArray(children).filter(isValidElement<ItemProps>).map(child => ({
    value: String(child.props.value ?? optionText(child.props.children)),
    label: optionText(child.props.children), disabled: child.props.disabled === true,
  }));
  const selected = options.find(option => option.value === String(value));
  const buttons = () => Array.from(content.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
  return <Popover.Root modal open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? listId : undefined} aria-haspopup="listbox" disabled={disabled || !options.length} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
    }}>{!iconOnly && <span>{selected?.label ?? '请选择'}</span>}<ChevronDown size={14} aria-hidden="true" /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} id={listId} className="options select-options" role="listbox" aria-label={label} sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => {
      event.preventDefault(); search.current = { value: '', time: 0 };
      (buttons().find(button => button.getAttribute('aria-selected') === 'true') ?? buttons()[0])?.focus();
    }} onKeyDown={event => {
      const items = buttons();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
      else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
      else if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items.at(-1);
      else if (event.key === 'Tab') { setOpen(false); return; }
      else if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const now = Date.now();
        const prefix = now - search.current.time < 700 ? search.current.value + event.key : event.key;
        search.current = { value: prefix.toLocaleLowerCase(), time: now };
        next = [...items.slice(index + 1), ...items.slice(0, index + 1)].find(item => item.textContent?.toLocaleLowerCase().startsWith(search.current.value));
      }
      if (next) { event.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
    }}>
      {label && <div className="option-heading">{label}</div>}
      {options.map(option => <button type="button" role="option" value={option.value} aria-selected={option.value === String(value)} tabIndex={-1} className={`choice ${option.value === String(value) ? 'is-active' : ''}`} key={option.value} disabled={option.disabled} onClick={() => { onChange({ target: { value: option.value } }); setOpen(false); }}><span>{option.label}</span>{option.value === String(value) && <Check size={15} aria-hidden="true" />}</button>)}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
