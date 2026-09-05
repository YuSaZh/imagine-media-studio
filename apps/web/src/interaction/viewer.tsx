import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Bookmark, Check, ChevronLeft, ChevronRight, Copy, Download, FolderPlus, Info, Pencil, Plus, RotateCcw, Trash2, Video, X, ZoomIn, ZoomOut } from 'lucide-react';
import { type Project, type Study } from './data';
import { Choice, Options, Tool } from './ui';

export function Viewer({ item, items, projects, onClose, onMove, onSave, onDelete, onContinue, onProject, onNotice }: {
  item: Study; items: Study[]; projects: Project[];
  onClose: () => void; onMove: (id: string) => void; onSave: (id: string) => void; onDelete: (id: string) => void;
  onContinue: (item: Study, intent: 'reference' | 'edit' | 'video', prompt?: string) => void;
  onProject: (id: string, project: string | null) => void; onNotice: (text: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [info, setInfo] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const pointer = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const index = items.findIndex(study => study.id === item.id);
  const extension = item.kind === 'video' ? 'mp4' : item.mimeType === 'image/png' ? 'png' : item.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
  const move = (direction: number) => {
    if (items.length === 0) return;
    const next = items[(Math.max(index, 0) + direction + items.length) % items.length];
    if (next) onMove(next.id);
  };
  useEffect(() => { setZoom(1); setPosition({ x: 0, y: 0 }); setEditPrompt(''); }, [item.id]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(item.prompt); onNotice('已复制提示词'); } catch { onNotice('复制失败，请选择提示词后复制'); }
  };
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Portal><Dialog.Overlay className="viewer-backdrop" /><Dialog.Content className={`study-viewer ${info ? 'has-info' : ''}`} aria-describedby={undefined} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('input,textarea,video')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
  }}>
    <header className="viewer-heading"><div><Dialog.Close asChild><Tool label="返回作品"><ArrowLeft size={20} /></Tool></Dialog.Close><Dialog.Title>{item.title}</Dialog.Title><span className="viewer-index">{Math.max(index + 1, 1)} / {items.length}</span></div><div><Tool label={item.saved ? '取消收藏' : '收藏作品'} className={item.saved ? 'is-saved' : ''} onClick={() => onSave(item.id)}><Bookmark size={18} fill={item.saved ? 'currentColor' : 'none'} /></Tool><a className="tool" aria-label="下载原文件" title="下载原文件" href={item.kind === 'video' ? '/interaction-media/coast-motion.mp4' : item.src} download={`${item.title}.${extension}`}><Download size={19} /></a><Tool label="作品信息" aria-pressed={info} onClick={() => setInfo(!info)}><Info size={19} /></Tool></div></header>
    <div className="viewer-workspace">
      <div className="viewer-stage" onPointerDown={event => {
        if ((event.target as HTMLElement).closest('video,button,a')) return;
        pointer.current = { x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        if (pointer.current && zoom > 1) setPosition({ x: pointer.current.originX + event.clientX - pointer.current.x, y: pointer.current.originY + event.clientY - pointer.current.y });
      }} onPointerUp={event => {
        if (!pointer.current) return;
        const delta = event.clientX - pointer.current.x;
        if (zoom === 1 && Math.abs(delta) > 65 && Math.abs(event.clientY - pointer.current.y) < 70) move(delta < 0 ? 1 : -1);
        pointer.current = null;
      }} onPointerCancel={() => { pointer.current = null; }} onDoubleClick={event => {
        if ((event.target as HTMLElement).closest('video,button,a')) return;
        setZoom(zoom === 1 ? 2 : 1); setPosition({ x: 0, y: 0 });
      }}>
        {item.kind === 'video' ? <video key={item.id} src="/interaction-media/coast-motion.mp4" poster={item.src} controls playsInline className="viewer-image" /> : <img className="viewer-image" src={item.src} alt={item.title} draggable={false} style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }} />}
        <Tool label="上一张作品" className="viewer-arrow previous" onClick={() => move(-1)}><ChevronLeft size={23} /></Tool><Tool label="下一张作品" className="viewer-arrow next" onClick={() => move(1)}><ChevronRight size={23} /></Tool>
        {item.kind === 'image' && <div className="zoom-tools"><Tool label="缩小" disabled={zoom <= 1} onClick={() => { setZoom(Math.max(1, zoom - .5)); setPosition({ x: 0, y: 0 }); }}><ZoomOut size={17} /></Tool><span>{Math.round(zoom * 100)}%</span><Tool label="放大" disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + .5))}><ZoomIn size={17} /></Tool><Tool label="还原缩放" onClick={() => { setZoom(1); setPosition({ x: 0, y: 0 }); }}><RotateCcw size={16} /></Tool></div>}
      </div>
      {info && <aside className="viewer-info"><header><h3>作品信息</h3><Tool label="关闭作品信息" onClick={() => setInfo(false)}><X size={17} /></Tool></header><span className="muted-label">提示词</span><p>{item.prompt}</p><button className="text-command" onClick={() => void copy()}><Copy size={15} />复制提示词</button><dl><div><dt>模型</dt><dd>{item.model}</dd></div><div><dt>画幅</dt><dd>{item.ratio}</dd></div><div><dt>类型</dt><dd>{item.kind === 'image' ? '图片' : '视频'}</dd></div><div><dt>项目</dt><dd>{projects.find(project => project.id === item.projectId)?.name ?? '未归档'}</dd></div></dl><Options label="移动到项目" trigger={<><FolderPlus size={16} />移动到项目</>}><div className="option-heading">移动到项目</div><Choice active={!item.projectId} onClick={() => onProject(item.id, null)}>未归档</Choice>{projects.map(project => <Choice key={project.id} active={item.projectId === project.id} onClick={() => onProject(item.id, project.id)}><span>{project.name}</span>{item.projectId === project.id && <Check size={15} />}</Choice>)}</Options><button className="text-command danger" onClick={() => onDelete(item.id)}><Trash2 size={15} />删除作品</button></aside>}
    </div>
    <footer className="viewer-footer"><div className="continue-actions"><button className="primary-command" onClick={() => onContinue(item, item.kind === 'image' ? 'video' : 'reference')}><Video size={17} />{item.kind === 'image' ? '让画面动起来' : '继续创作'}</button>{item.kind === 'image' && <><button className="quiet-command" onClick={() => onContinue(item, 'edit')}><Pencil size={16} />修改图片</button><Tool label="用作参考图" onClick={() => onContinue(item, 'reference')}><Plus size={19} /></Tool></>}</div><form className="inline-edit" onSubmit={event => { event.preventDefault(); if (editPrompt.trim()) onContinue(item, item.kind === 'image' ? 'edit' : 'video', editPrompt.trim()); }}><input aria-label="继续创作描述" placeholder={item.kind === 'image' ? '换一个背景，或描述你想修改的地方…' : '描述下一个镜头…'} value={editPrompt} onChange={event => setEditPrompt(event.target.value)} /><button aria-label="继续生成" type="submit" disabled={!editPrompt.trim()}><Pencil size={18} /></button></form></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
