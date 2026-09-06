import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface CatalogModel { id: string; displayName: string }

export function ModelCatalogPicker({ models, value, loading, onSelect }: {
  models: readonly CatalogModel[]; value: string; loading: boolean; onSelect: (id: string) => void;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = models.filter(model => terms.every(term => `${model.id} ${model.displayName}`.toLowerCase().includes(term)));
  const index = Math.min(active, filtered.length - 1);
  const selected = models.find(model => model.id === value);
  const label = (model: CatalogModel) => model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`;
  const choose = (id: string) => { onSelect(id); setOpen(false); setQuery(''); };
  const expand = () => { setOpen(true); setQuery(''); setActive(0); };

  useEffect(() => {
    const container = list.current;
    const item = container?.children.item(index) as HTMLElement | null;
    if (!open || !container || !item) return;
    if (item.offsetTop < container.scrollTop) container.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = item.offsetTop + item.offsetHeight - container.clientHeight;
  }, [open, index, query]);

  return <div className="catalog-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="catalog-search-input"><input ref={input} role="combobox" aria-label="远端模型目录" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={open && index >= 0 ? `${listId}-${index}` : undefined}
      autoComplete="off" disabled={loading} placeholder={loading ? '正在拉取模型…' : '搜索模型名称或 ID'} value={open ? query : selected ? label(selected) : ''}
      onFocus={expand} onClick={() => { if (!open) expand(); }} onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { expand(); return; }
          setActive(current => Math.max(0, Math.min(filtered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Enter' && open) { event.preventDefault(); if (filtered[index]) choose(filtered[index].id); }
      }} /><button type="button" aria-label="展开模型目录" title="展开模型目录" disabled={loading} onMouseDown={event => event.preventDefault()} onClick={() => { if (open) setOpen(false); else { input.current?.focus(); expand(); } }}><ChevronDown size={16} /></button></div>
    {open && <div className="catalog-search-popup"><div ref={list} id={listId} role="listbox" aria-label="可选模型" className="catalog-search-results">
      {filtered.map((model, i) => <div id={`${listId}-${i}`} key={model.id} role="option" aria-selected={index === i} className="catalog-search-option" onMouseDown={event => event.preventDefault()} onClick={() => choose(model.id)}>
        <span><strong>{model.displayName}</strong>{model.displayName !== model.id && <small>{model.id}</small>}</span>{model.id === value && <Check size={15} />}
      </div>)}
    </div>{!filtered.length && <p className="menu-empty" role="status">没有匹配的模型</p>}</div>}
  </div>;
}
