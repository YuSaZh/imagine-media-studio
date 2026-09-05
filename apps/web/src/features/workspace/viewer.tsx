import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Bookmark, Brush, Check, ChevronLeft, ChevronRight, Copy, Download, FolderPlus, Info, Pencil, Plus, RotateCcw, Trash2, Video, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createViewerGestureState, setViewerGestureTransform, transitionViewerGesture, type ViewerGestureLayout } from '../viewer/model/viewer-gestures';
import { JOB_LABELS, mediaExtension, type MediaItem, type Project } from './data';
import { Choice, Options, Tool } from './ui';

interface ViewerProps {
  item: MediaItem;
  index: number;
  total: number;
  projects: Project[];
  online: boolean;
  busy: boolean;
  canEdit: boolean;
  canMask: boolean;
  canVideo: boolean;
  providerName: string;
  onClose: () => void;
  onMove: (delta: number) => void;
  onSave: () => void;
  onDelete: () => void;
  onContinue: (intent: 'reference' | 'edit' | 'video', prompt?: string) => void;
  onMask: () => void;
  onProject: (project: string, included: boolean) => void;
  onNotice: (text: string) => void;
}

export function Viewer(props: ViewerProps) {
  const { item } = props;
  const [info, setInfo] = useState(false);
  const [editPrompt, setEditPrompt] = useState('');
  const [mediaError, setMediaError] = useState(false);
  const [gesture, setGesture] = useState(createViewerGestureState);
  const gestureRef = useRef(gesture);
  const stageRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const lastTap = useRef(0);

  useEffect(() => {
    const initial = createViewerGestureState();
    gestureRef.current = initial; setGesture(initial); setEditPrompt(''); setMediaError(false); lastTap.current = 0;
  }, [item.id]);

  const layout = (): ViewerGestureLayout => {
    const stage = stageRef.current!;
    const box = stage.getBoundingClientRect();
    const media = stage.querySelector('.viewer-image')?.getBoundingClientRect();
    return { center: { x: box.left + box.width / 2, y: box.top + box.height / 2 }, media: { width: (media?.width ?? box.width) / gestureRef.current.scale, height: (media?.height ?? box.height) / gestureRef.current.scale }, viewport: { width: box.width, height: box.height } };
  };
  const apply = (transition: ReturnType<typeof transitionViewerGesture>) => {
    gestureRef.current = transition.state; setGesture(transition.state);
    if (transition.effect === 'next') props.onMove(1);
    if (transition.effect === 'previous') props.onMove(-1);
  };
  const zoom = (scale: number) => {
    const next = setViewerGestureTransform(gestureRef.current, scale, gestureRef.current.position, layout());
    gestureRef.current = next; setGesture(next);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(item.prompt); props.onNotice('已复制提示词'); }
    catch { props.onNotice('当前浏览器无法自动复制，请选择提示词复制'); }
  };
  const image = item.kind === 'image';
  const writeDisabled = !props.online || props.busy;
  return <Dialog.Root open onOpenChange={open => !open && props.onClose()}><Dialog.Portal>
    <Dialog.Overlay className="viewer-backdrop" />
    <Dialog.Content className={`study-viewer ${info ? 'has-info' : ''}`} aria-describedby={undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (focusRef.current?.isConnected) focusRef.current.focus(); }}
      onKeyDown={event => {
        if ((event.target as HTMLElement).closest('input,textarea,select,video')) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.onMove(event.key === 'ArrowLeft' ? -1 : 1); }
      }}>
      <header className="viewer-heading"><div><Dialog.Close asChild><Tool label="返回作品"><ArrowLeft size={20} /></Tool></Dialog.Close><Dialog.Title>{item.title}</Dialog.Title><span className="viewer-index">{props.index + 1} / {props.total}</span></div><div>
        <Tool label={item.saved ? '取消收藏' : '收藏作品'} disabled={writeDisabled} className={item.saved ? 'is-saved' : ''} onClick={props.onSave}><Bookmark size={18} fill={item.saved ? 'currentColor' : 'none'} /></Tool>
        <a className="tool" aria-label="下载原文件" title="下载原文件" aria-disabled={!props.online} href={props.online ? item.src : undefined} download={`${item.title.slice(0, 60)}.${mediaExtension(item)}`}><Download size={19} /></a>
        <Tool label="作品信息" aria-pressed={info} onClick={() => setInfo(!info)}><Info size={19} /></Tool>
      </div></header>
      <div className="viewer-workspace">
        <div className="viewer-stage" ref={stageRef} data-viewer-scale={gesture.scale}
          onDoubleClick={event => { if (image && !(event.target as HTMLElement).closest('button,a,video') && Date.now() - lastTap.current > 400) apply(transitionViewerGesture(gestureRef.current, { type: 'doubletap', layout: layout() })); }}
          onPointerDown={event => {
            if ((event.target as HTMLElement).closest('button,a,video')) return;
            apply(transitionViewerGesture(gestureRef.current, { type: 'pointerdown', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout() }));
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => { if (gestureRef.current.pointers.has(event.pointerId)) apply(transitionViewerGesture(gestureRef.current, { type: 'pointermove', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout() })); }}
          onPointerUp={event => {
            const transition = transitionViewerGesture(gestureRef.current, { type: 'pointerup', pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, layout: layout() });
            apply(transition);
            if (image && event.pointerType === 'touch' && transition.effect === 'tap') {
              const now = Date.now();
              if (now - lastTap.current < 320) apply(transitionViewerGesture(gestureRef.current, { type: 'doubletap', layout: layout() }));
              lastTap.current = now;
            }
          }}
          onPointerCancel={event => apply(transitionViewerGesture(gestureRef.current, { type: 'pointercancel', pointerId: event.pointerId }))}>
          {mediaError ? <p className="media-error" role="alert">原文件暂时无法加载<button className="quiet-command" onClick={() => setMediaError(false)}>重试</button></p> : image ? <img className="viewer-image" src={props.online ? item.src : item.thumbnail} alt={item.title} draggable={false} onError={() => setMediaError(true)} style={{ transform: `translate(${gesture.position.x}px, ${gesture.position.y}px) scale(${gesture.scale})` }} /> : props.online ? <video key={item.id} src={item.src} poster={item.poster ?? undefined} controls playsInline className="viewer-image" onError={() => setMediaError(true)} /> : <img className="viewer-image" src={item.poster ?? item.thumbnail} alt={item.title} />}
          <Tool label="上一张作品" className="viewer-arrow previous" disabled={props.total < 2} onClick={() => props.onMove(-1)}><ChevronLeft size={23} /></Tool>
          <Tool label="下一张作品" className="viewer-arrow next" disabled={props.total < 2} onClick={() => props.onMove(1)}><ChevronRight size={23} /></Tool>
          {image && <div className="zoom-tools"><Tool label="缩小" disabled={gesture.scale <= 1} onClick={() => zoom(gesture.scale - .5)}><ZoomOut size={17} /></Tool><span>{Math.round(gesture.scale * 100)}%</span><Tool label="放大" disabled={gesture.scale >= 4} onClick={() => zoom(gesture.scale + .5)}><ZoomIn size={17} /></Tool><Tool label="还原缩放" onClick={() => zoom(1)}><RotateCcw size={16} /></Tool></div>}
        </div>
        {info && <aside className="viewer-info"><header><h3>作品信息</h3><Tool label="关闭作品信息" onClick={() => setInfo(false)}><X size={17} /></Tool></header>
          <span className="muted-label">提示词</span><p>{item.prompt || '本地上传素材'}</p>{item.prompt && <button className="text-command" onClick={() => void copy()}><Copy size={15} />复制提示词</button>}
          <dl><div><dt>服务</dt><dd>{props.providerName}</dd></div><div><dt>模型</dt><dd>{item.model}</dd></div><div><dt>尺寸</dt><dd>{item.width} × {item.height}</dd></div><div><dt>类型</dt><dd>{item.mimeType || (image ? '图片' : '视频')}</dd></div>{item.durationSeconds !== null && <div><dt>时长</dt><dd>{item.durationSeconds.toFixed(1)} 秒</dd></div>}<div><dt>创建时间</dt><dd>{new Date(item.createdAt).toLocaleString()}</dd></div>{item.job && <div><dt>状态</dt><dd>{JOB_LABELS[item.job.status]}</dd></div>}</dl>
          {props.online && <Options label="加入项目" trigger={<><FolderPlus size={16} />加入项目</>}><div className="option-heading">项目</div>{props.projects.length ? props.projects.map(project => <Choice key={project.id} active={item.collectionIds.includes(project.id)} onClick={() => props.onProject(project.id, !item.collectionIds.includes(project.id))}><span>{project.name}</span>{item.collectionIds.includes(project.id) && <Check size={15} />}</Choice>) : <p className="menu-empty">还没有项目</p>}</Options>}
          {item.job && <details className="request-details"><summary>请求参数</summary><pre>{JSON.stringify(item.job.request, null, 2)}</pre></details>}
          <button className="text-command danger" disabled={writeDisabled} onClick={props.onDelete}><Trash2 size={15} />删除作品</button>
        </aside>}
      </div>
      <footer className="viewer-footer"><div className="continue-actions">
        {image && props.canVideo && <button className="primary-command" disabled={writeDisabled} onClick={() => props.onContinue('video')}><Video size={17} />让画面动起来</button>}
        {image && props.canEdit && <button className="quiet-command" disabled={writeDisabled} onClick={() => props.onContinue('edit')}><Pencil size={16} />修改图片</button>}
        {image && props.canMask && <Tool label="局部编辑" disabled={writeDisabled} onClick={props.onMask}><Brush size={18} /></Tool>}
        {image && <Tool label="用作参考图" disabled={writeDisabled} onClick={() => props.onContinue('reference')}><Plus size={19} /></Tool>}
        {!image && item.job && <button className="quiet-command" disabled={writeDisabled} onClick={() => props.onContinue('video', item.prompt)}><RotateCcw size={16} />再次创作</button>}
      </div>
        {image && props.canEdit && <form className="inline-edit" onSubmit={event => { event.preventDefault(); if (editPrompt.trim() && !writeDisabled) props.onContinue('edit', editPrompt.trim()); }}><input aria-label="继续创作描述" placeholder="描述你想修改的地方…" value={editPrompt} onChange={event => setEditPrompt(event.target.value)} /><button aria-label="继续生成" type="submit" disabled={!editPrompt.trim() || writeDisabled}><Pencil size={18} /></button></form>}
      </footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
