import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { MAX_MASK_BRUSH_DIAMETER, type AssetDto } from '@imagine/shared';
import { ArrowLeft, Brush, Check, Eraser, Eye, EyeOff, LoaderCircle, Redo2, Trash2, Undo2 } from 'lucide-react';
import { loadEditorAsset, uploadEditorMask, type LoadedEditorAsset } from '../image-editor/api/editor-assets';
import { MaskEditorController, createMaskEditorState, maskDocumentForRender } from '../image-editor/model/mask-editor';
import { createHtmlCanvasLayer, createHtmlCanvasLayerFactory, renderMaskEditorLayers, type DisplayContentRect } from '../image-editor/browser/canvas-renderer';
import { useOnlineStatus } from '../../hooks/use-runtime-state';
import { Panel, Tool } from './ui';

interface Session extends LoadedEditorAsset { controller: MaskEditorController; }

export function Editor({ assetId, onClose, onApply }: { assetId: string; onClose: () => void; onApply: (source: AssetDto, mask: AssetDto) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let loaded: Session | null = null;
    setSession(null); setError('');
    void loadEditorAsset(assetId, abort.signal).then(result => {
      if (abort.signal.aborted) { result.source.dispose(); return; }
      loaded = { ...result, controller: new MaskEditorController(createMaskEditorState({ width: result.source.naturalSize.width, height: result.source.naturalSize.height })) };
      setSession(loaded);
    }).catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '原图加载失败'); });
    return () => { abort.abort(); loaded?.controller.dispose(); loaded?.source.dispose(); };
  }, [assetId, attempt]);
  return session ? <EditorCanvas session={session} onClose={onClose} onApply={onApply} /> : <Panel open title="局部编辑" onClose={onClose}><div className="loading-state" role={error ? 'alert' : 'status'}>{error || '正在加载原图…'}{error && <button className="quiet-command" onClick={() => setAttempt(value => value + 1)}>重试</button>}</div></Panel>;
}

function EditorCanvas({ session, onClose, onApply }: { session: Session; onClose: () => void; onApply: (source: AssetDto, mask: AssetDto) => void }) {
  const state = useSyncExternalStore(session.controller.subscribe, session.controller.getSnapshot, session.controller.getSnapshot);
  const online = useOnlineStatus();
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [showMask, setShowMask] = useState(true);
  const [showOriginal, setShowOriginal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const mountStage = useCallback((element: HTMLDivElement | null) => { stageRef.current = element; setStage(element); }, []);
  const originalRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const contentRect = useRef<DisplayContentRect>({ left: 0, top: 0, width: 1, height: 1 });
  const abortRef = useRef<AbortController | null>(null);
  const dirty = state.document.cursor > 0;
  useEffect(() => { const abort = new AbortController(); abortRef.current = abort; return () => abort.abort(); }, []);
  useEffect(() => {
    if (!stage) return;
    const observer = new ResizeObserver(() => { const box = stage.getBoundingClientRect(); setSize({ width: Math.max(1, box.width), height: Math.max(1, box.height) }); });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stage]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!originalRef.current || !maskRef.current) return;
      try {
        const rendered = renderMaskEditorLayers({ displaySize: size, devicePixelRatio: window.devicePixelRatio || 1, factory: createHtmlCanvasLayerFactory(document), source: session.source, mask: maskDocumentForRender(state), sourceLayer: createHtmlCanvasLayer(originalRef.current), maskLayer: createHtmlCanvasLayer(maskRef.current) });
        contentRect.current = rendered.contentRect;
      } catch (failure) { setError(failure instanceof Error ? failure.message : '画布渲染失败'); }
    });
    return () => cancelAnimationFrame(frame);
  }, [session, size, state]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const clientRect = () => {
    const box = stageRef.current!.getBoundingClientRect();
    const rect = contentRect.current;
    return { left: box.left + rect.left, top: box.top + rect.top, width: rect.width, height: rect.height };
  };
  const close = () => { if (busy) return; if (dirty) setDiscardConfirm(true); else onClose(); };
  const apply = async () => {
    const abort = abortRef.current;
    if (!abort) return;
    setBusy(true); setError('');
    try {
      const mask = await uploadEditorMask({ document: state.document, sourceAsset: session.asset, signal: abort.signal });
      onApply(session.asset, mask);
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '蒙版保存失败'); }
    finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => !open && close()}><Dialog.Portal><Dialog.Overlay className="viewer-backdrop" /><Dialog.Content className="mask-workspace" aria-describedby={undefined} onEscapeKeyDown={event => { event.preventDefault(); close(); }}>
    <header className="viewer-heading"><div><Tool label="关闭局部编辑" disabled={busy} onClick={close}><ArrowLeft size={20} /></Tool><Dialog.Title>局部编辑</Dialog.Title><span className="viewer-index">{session.asset.width} × {session.asset.height}</span></div><button className="primary-command" disabled={busy || !online || !dirty || state.activeStroke !== null} onClick={() => void apply()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? '正在保存' : '应用蒙版'}</button></header>
    <div className="mask-tools" role="toolbar" aria-label="蒙版工具"><Tool label="画笔" disabled={busy} aria-pressed={state.tool === 'brush'} onClick={() => session.controller.setTool('brush')}><Brush size={19} /></Tool><Tool label="橡皮擦" disabled={busy} aria-pressed={state.tool === 'erase'} onClick={() => session.controller.setTool('erase')}><Eraser size={19} /></Tool><label className="brush-size"><span>大小</span><input type="range" aria-label="画笔大小" min={1} max={MAX_MASK_BRUSH_DIAMETER} value={state.diameter} disabled={busy} onChange={event => session.controller.setDiameter(Number(event.target.value))} /><output>{state.diameter}</output></label><Tool label="撤销笔画" disabled={busy || state.document.cursor === 0} onClick={() => session.controller.undo()}><Undo2 size={18} /></Tool><Tool label="重做笔画" disabled={busy || state.document.cursor === state.document.history.length} onClick={() => session.controller.redo()}><Redo2 size={18} /></Tool><Tool label="清空蒙版" disabled={busy || !dirty} onClick={() => setClearConfirm(true)}><Trash2 size={18} /></Tool><Tool label="显示蒙版" aria-pressed={showMask} onClick={() => setShowMask(!showMask)}>{showMask ? <Eye size={18} /> : <EyeOff size={18} />}</Tool><label className="check-line"><input type="checkbox" aria-label="显示原图" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />原图</label></div>
    {(error || state.error) && <p className="error-state mask-error" role="alert">{error || state.error?.message}</p>}
    <div className="mask-stage" ref={mountStage}
      onPointerDown={event => { if (busy || !online || (event.pointerType === 'mouse' && event.button !== 0)) return; const rect = clientRect(); if (event.clientX < rect.left || event.clientX > rect.left + rect.width || event.clientY < rect.top || event.clientY > rect.top + rect.height) return; event.currentTarget.setPointerCapture(event.pointerId); session.controller.pointerDown(event.pointerId, { x: event.clientX, y: event.clientY }, rect); }}
      onPointerMove={event => { if (!busy && state.activeStroke?.pointerId === event.pointerId) session.controller.pointerMove(event.pointerId, { x: event.clientX, y: event.clientY }, clientRect()); }}
      onPointerUp={event => { if (!busy && state.activeStroke?.pointerId === event.pointerId) session.controller.pointerUp(event.pointerId, { x: event.clientX, y: event.clientY }, clientRect()); }}
      onPointerCancel={event => session.controller.pointerCancel(event.pointerId)}>
      <canvas ref={originalRef} className="mask-source" aria-label="编辑原图" style={{ opacity: showOriginal ? 1 : 0 }} /><canvas ref={maskRef} className="mask-overlay" aria-label="编辑蒙版" style={{ opacity: showMask ? 1 : 0 }} />
    </div>
    {clearConfirm && <Panel open title="清空蒙版？" onClose={() => setClearConfirm(false)} className="compact-panel"><div className="confirmation-body"><p>清空后可以通过撤销恢复。</p><div><button className="quiet-command" onClick={() => setClearConfirm(false)}>取消</button><button className="primary-command" onClick={() => { session.controller.clear(); setClearConfirm(false); }}>确认清空</button></div></div></Panel>}
    {discardConfirm && <Panel open title="放弃这次修改？" onClose={() => setDiscardConfirm(false)} className="compact-panel"><div className="confirmation-body"><p>尚未应用的蒙版将丢失。</p><div><button className="quiet-command" onClick={() => setDiscardConfirm(false)}>继续编辑</button><button className="primary-command" onClick={onClose}>放弃修改</button></div></div></Panel>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
