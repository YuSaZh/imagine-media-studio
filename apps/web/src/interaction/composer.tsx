import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, ImagePlus, Image as ImageIcon, Plus, Ratio, SlidersHorizontal, Video, X } from 'lucide-react';
import { MODEL_OPTIONS, RATIOS, type MediaKind, type Study } from './data';
import { Choice, Options, Tool } from './ui';

export interface Creation {
  prompt: string;
  kind: MediaKind;
  model: string;
  ratio: string;
  count: number;
  references: Study[];
  quality: string;
  durationSeconds: number | null;
}

export function Composer({ prompt, setPrompt, mode, setMode, references, setReferences, onCreate, connectionsEnabled, onConnections, focusToken }: {
  prompt: string; setPrompt: (value: string) => void;
  mode: MediaKind; setMode: (mode: MediaKind) => void;
  references: Study[]; setReferences: (items: Study[]) => void;
  onCreate: (creation: Creation) => void; connectionsEnabled: boolean; onConnections: () => void; focusToken: number;
}) {
  const [modelKey, setModelKey] = useState<string>('xai:imagine-image');
  const [ratio, setRatio] = useState('3:2');
  const [count, setCount] = useState(2);
  const [quality, setQuality] = useState('quality');
  const [duration, setDuration] = useState('6');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const model = MODEL_OPTIONS.find(item => item.key === modelKey && item.kind === mode) ?? MODEL_OPTIONS.find(item => item.kind === mode)!;
  const incompatible = references.length > model.references;

  useEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken]);
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--composer-size', `${element.offsetHeight}px`));
    observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--composer-size'); };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const offset = viewport ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
      document.documentElement.style.setProperty('--keyboard-lift', `${offset}px`);
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); };
  }, []);

  const addFiles = (files: File[]) => {
    setError('');
    const accepted = files.filter(file => ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && file.size <= 10 * 1024 * 1024);
    if (accepted.length !== files.length) setError('请使用 10 MB 以内的 JPG、PNG 或 WebP 图片。');
    if (accepted.length + references.length > model.references) { setError(`当前模型最多接受 ${model.references} 张参考图。`); return; }
    setReferences([...references, ...accepted.map(file => {
      const src = URL.createObjectURL(file);
      return { id: crypto.randomUUID(), title: file.name, prompt: '', src, kind: 'image' as const, ratio: '1:1', model: '上传', projectId: null, saved: false, mimeType: file.type };
    })]);
  };
  const submit = () => {
    if (!prompt.trim() || !connectionsEnabled || incompatible) return;
    onCreate({ prompt: prompt.trim(), kind: mode, model: `${model.provider} · ${model.name}`, ratio, count: mode === 'video' ? 1 : count, references, quality, durationSeconds: mode === 'video' ? Number(duration) : null });
  };
  const parameters = <>
    <div className="option-heading">生成设置</div>
    <label className="setting-line mobile-control"><span>模型与服务</span><select aria-label="模型与服务" value={model.key} onChange={event => setModelKey(event.target.value)}>{MODEL_OPTIONS.filter(item => item.kind === mode).map(item => <option key={item.key} value={item.key}>{item.provider} · {item.name}</option>)}</select></label>
    <label className="setting-line"><span>画幅</span><select aria-label="画幅" value={ratio} onChange={event => setRatio(event.target.value)}>{RATIOS.map(value => <option key={value}>{value}</option>)}</select></label>
    {mode === 'image' ? <><label className="setting-line"><span>生成数量</span><select aria-label="生成数量" value={count} onChange={event => setCount(Number(event.target.value))}>{[1, 2, 4].map(value => <option key={value} value={value}>{value} 张</option>)}</select></label><div className="setting-line"><span>生成偏好</span><div className="segments"><button aria-pressed={quality === 'speed'} onClick={() => setQuality('speed')} type="button">快速</button><button aria-pressed={quality === 'quality'} onClick={() => setQuality('quality')} type="button">精细</button></div></div></> : <label className="setting-line"><span>视频时长</span><select aria-label="视频时长" value={duration} onChange={event => setDuration(event.target.value)}><option value="6">6 秒</option><option value="10">10 秒</option></select></label>}
  </>;

  return <form className={`creation-composer ${dragging ? 'is-dragging' : ''}`} ref={composerRef} onSubmit={event => { event.preventDefault(); submit(); }} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); }}>
    {dragging && <div className="drop-target"><ImagePlus size={28} /></div>}
    {references.length > 0 && <div className="reference-tray">{references.map((item, index) => <div className="reference" key={item.id}><img src={item.src} alt={item.title} /><span>{mode === 'video' ? '首帧' : `参考 ${index + 1}`}</span><Tool label={`移除参考图 ${index + 1}`} onClick={() => setReferences(references.filter(ref => ref.id !== item.id))}><X size={13} /></Tool></div>)}</div>}
    <textarea ref={textareaRef} aria-label="创作描述" placeholder={mode === 'image' ? (references.length ? '想怎样修改这张图片？' : '把脑海中的画面，变成眼前的作品。') : (references.length ? '让这个画面怎样动起来？' : '描述场景、镜头与动作…')} value={prompt} maxLength={6000} rows={2} onChange={event => setPrompt(event.target.value)} onPaste={event => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
    {(error || incompatible || !connectionsEnabled) && <div className="composer-notice" role="alert">{!connectionsEnabled ? <><span>尚未启用生成连接</span><button type="button" onClick={onConnections}>配置连接</button></> : error || `当前模型最多接受 ${model.references} 张参考图，请移除多余图片。`}</div>}
    <div className="creation-controls">
      <input aria-label="上传参考图" ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => { addFiles([...event.target.files ?? []]); event.target.value = ''; }} />
      <Tool label="添加参考图" onClick={() => inputRef.current?.click()}><Plus size={20} /></Tool>
      <div className="segments mode-segments" role="group" aria-label="创作类型"><button type="button" aria-label="图片" aria-pressed={mode === 'image'} onClick={() => { setMode('image'); setError(''); }}><ImageIcon size={15} /><span>图片</span></button><button type="button" aria-label="视频" aria-pressed={mode === 'video'} onClick={() => { setMode('video'); setError(''); }}><Video size={16} /><span>视频</span></button></div>
      <Options label="选择生成模型" className="model-trigger" trigger={<><span className="model-dot" /><span>{model.name}</span><ChevronDown size={13} /></>}><div className="option-heading">生成模型</div>{MODEL_OPTIONS.filter(item => item.kind === mode).map(item => <Choice active={model.key === item.key} key={item.key} onClick={() => setModelKey(item.key)}><span className="model-letter">{item.badge}</span><span className="choice-copy"><strong>{item.name}</strong><small>{item.provider}</small></span>{model.key === item.key && <Check size={15} />}</Choice>)}</Options>
      <Options label="选择画幅" className="desktop-control" trigger={<><Ratio size={15} /><span>{ratio}</span><ChevronDown size={12} /></>}><div className="option-heading">画幅</div><div className="ratio-options">{RATIOS.map(value => <Choice active={ratio === value} key={value} onClick={() => setRatio(value)}><i style={{ aspectRatio: value.replace(':', '/') }} /><span>{value}</span></Choice>)}</div></Options>
      <Options label="生成设置" trigger={<SlidersHorizontal size={18} />}>{parameters}</Options>
      <span className="composer-spacer" />
      <button type="submit" aria-label="开始生成" className="generate-button" disabled={!prompt.trim() || !connectionsEnabled || incompatible}><ArrowUp size={21} strokeWidth={2.5} /></button>
    </div>
    <div className="mobile-model-status"><span>{model.provider} · {model.name}</span><span>{ratio} · {mode === 'image' ? `${count} 张` : `${duration} 秒`}</span></div>
  </form>;
}
