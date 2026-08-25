import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { classifyMaskRgba } from '@imagine/shared';
import type { AssetDto, AssetInput, ClientRectLike, MaskDocument } from '@imagine/shared';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';

import { IconButton } from '../../../components/icon-button.js';
import { internalQueryKeys } from '../../../api/query-keys.js';
import { useUiStore } from '../../../stores/ui-store.js';
import {
  loadEditorAsset,
  uploadEditorMask,
} from '../api/image-editor-api.js';
import {
  createHtmlCanvasLayer,
  createHtmlCanvasLayerFactory,
  renderMaskEditorLayers,
  type DisplayContentRect,
  type RenderedLayerSize,
} from '../browser/canvas-renderer.js';
import type { LoadedSourceContent } from '../browser/source-content.js';
import {
  MaskEditorController,
  createMaskEditorState,
  maskDocumentForRender,
} from '../model/mask-editor.js';
import { MaskEditorToolbar } from './mask-editor-toolbar.js';

type LoadedEditorAsset = Awaited<ReturnType<typeof loadEditorAsset>>;

export interface MaskEditorIntegration {
  readonly addComposerInput: (input: AssetInput) => void;
  readonly assetId: string;
  readonly invalidateMedia: () => Promise<void>;
  readonly navigate: (destination: string | number) => void | Promise<void>;
  readonly setComposerExpanded: (expanded: boolean) => void;
  readonly setComposerMode: (mode: 'image' | 'video') => void;
  readonly setComposerPrimaryInput: (
    input: AssetInput & { readonly role: 'first_frame' | 'source' },
  ) => void;
}

export interface MaskEditorCanvasRenderInput {
  readonly displaySize: { readonly height: number; readonly width: number };
  readonly mask: MaskDocument;
  readonly maskCanvas: HTMLCanvasElement;
  readonly source: LoadedSourceContent;
  readonly sourceCanvas: HTMLCanvasElement;
}

export interface MaskEditorRuntime {
  readonly cancelFrame: (frameId: number) => void;
  readonly createController: (width: number, height: number) => MaskEditorController;
  readonly createResizeObserver: (callback: ResizeObserverCallback) => Pick<ResizeObserver, 'disconnect' | 'observe'>;
  readonly loadAsset: (assetId: string, signal: AbortSignal) => Promise<LoadedEditorAsset>;
  readonly render: (input: MaskEditorCanvasRenderInput) => RenderedLayerSize;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly uploadMask: typeof uploadEditorMask;
}

export interface MaskEditorPageProps {
  readonly integration?: MaskEditorIntegration;
  readonly runtime?: Partial<MaskEditorRuntime>;
}

interface EditorUiError {
  readonly code: string;
  readonly message: string;
}

interface EditorSession {
  readonly asset: AssetDto;
  readonly controller: MaskEditorController;
  readonly source: LoadedSourceContent;
}

type EditorLoadState =
  | { readonly status: 'loading' }
  | { readonly error: EditorUiError; readonly status: 'error' }
  | { readonly session: EditorSession; readonly status: 'ready' };

function errorDetails(error: unknown, fallbackCode: string, fallbackMessage: string): EditorUiError {
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : fallbackCode;
    const message = 'message' in error && typeof error.message === 'string'
      ? error.message
      : fallbackMessage;
    return { code, message };
  }
  return { code: fallbackCode, message: fallbackMessage };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function defaultRender(input: MaskEditorCanvasRenderInput): RenderedLayerSize {
  return renderMaskEditorLayers({
    devicePixelRatio: globalThis.devicePixelRatio || 1,
    displaySize: input.displaySize,
    factory: createHtmlCanvasLayerFactory(globalThis.document),
    mask: input.mask,
    maskLayer: createHtmlCanvasLayer(input.maskCanvas),
    source: input.source,
    sourceLayer: createHtmlCanvasLayer(input.sourceCanvas),
  });
}

const DEFAULT_RUNTIME: MaskEditorRuntime = {
  cancelFrame: (frameId) => globalThis.cancelAnimationFrame(frameId),
  createController: (width, height) => new MaskEditorController(
    createMaskEditorState({ height, width }),
  ),
  createResizeObserver: (callback) => new ResizeObserver(callback),
  loadAsset: (assetId, signal) => loadEditorAsset(assetId, signal),
  render: defaultRender,
  requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
  uploadMask: (input) => uploadEditorMask(input),
};

export function contentRectToClientRect(
  contentRect: DisplayContentRect,
  canvasRect: Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>,
  displaySize: { readonly height: number; readonly width: number },
): ClientRectLike {
  const scaleX = canvasRect.width / displaySize.width;
  const scaleY = canvasRect.height / displaySize.height;
  return {
    height: contentRect.height * scaleY,
    left: canvasRect.left + contentRect.left * scaleX,
    top: canvasRect.top + contentRect.top * scaleY,
    width: contentRect.width * scaleX,
  };
}

export function clientPointIsInsideRect(
  point: { readonly x: number; readonly y: number },
  rect: ClientRectLike,
): boolean {
  return point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height;
}

export async function uploadMaskAndContinue(options: {
  readonly document: MaskDocument;
  readonly integration: MaskEditorIntegration;
  readonly signal: AbortSignal;
  readonly sourceAsset: AssetDto;
  readonly uploadMask: typeof uploadEditorMask;
}): Promise<AssetDto> {
  const maskAsset = await options.uploadMask({
    document: options.document,
    signal: options.signal,
    sourceAsset: options.sourceAsset,
  });
  options.signal.throwIfAborted();
  await options.integration.invalidateMedia().catch(() => undefined);
  options.signal.throwIfAborted();
  options.integration.setComposerPrimaryInput({
    assetId: options.sourceAsset.id,
    role: 'source',
  });
  options.integration.addComposerInput({ assetId: maskAsset.id, role: 'mask' });
  options.integration.setComposerMode('image');
  options.integration.setComposerExpanded(true);
  await options.integration.navigate('/imagine');
  return maskAsset;
}

export function MaskEditorPage(props: MaskEditorPageProps) {
  if (props.integration) {
    return <MaskEditorWorkspace integration={props.integration} runtimeOverrides={props.runtime} />;
  }
  return <ConnectedMaskEditorPage runtimeOverrides={props.runtime} />;
}

function ConnectedMaskEditorPage({
  runtimeOverrides,
}: {
  readonly runtimeOverrides: Partial<MaskEditorRuntime> | undefined;
}) {
  const { assetId = '' } = useParams<{ assetId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const addComposerInput = useUiStore((state) => state.addComposerInput);
  const setComposerPrimaryInput = useUiStore((state) => state.setComposerPrimaryInput);
  const setComposerMode = useUiStore((state) => state.setComposerMode);
  const setComposerExpanded = useUiStore((state) => state.setComposerExpanded);
  const integration = useMemo<MaskEditorIntegration>(() => ({
    addComposerInput,
    assetId,
    invalidateMedia: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.assets }),
        queryClient.invalidateQueries({ queryKey: internalQueryKeys.gallery }),
      ]);
    },
    navigate: (destination) => {
      if (typeof destination === 'number') void navigate(destination);
      else void navigate(destination);
    },
    setComposerExpanded,
    setComposerMode,
    setComposerPrimaryInput,
  }), [
    addComposerInput,
    assetId,
    navigate,
    queryClient,
    setComposerExpanded,
    setComposerMode,
    setComposerPrimaryInput,
  ]);
  return <MaskEditorWorkspace integration={integration} runtimeOverrides={runtimeOverrides} />;
}

function MaskEditorWorkspace({
  integration,
  runtimeOverrides,
}: {
  readonly integration: MaskEditorIntegration;
  readonly runtimeOverrides: Partial<MaskEditorRuntime> | undefined;
}) {
  const runtime = useMemo(
    () => ({ ...DEFAULT_RUNTIME, ...runtimeOverrides }),
    [runtimeOverrides],
  );
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<EditorLoadState>({ status: 'loading' });

  useEffect(() => {
    const abortController = new AbortController();
    let session: EditorSession | null = null;
    if (!integration.assetId) {
      setLoadState({
        error: { code: 'asset_id_missing', message: 'No image asset was selected for editing.' },
        status: 'error',
      });
      return () => abortController.abort();
    }
    setLoadState({ status: 'loading' });
    void runtime.loadAsset(integration.assetId, abortController.signal).then(
      (loaded) => {
        if (abortController.signal.aborted) {
          loaded.source.dispose();
          return;
        }
        try {
          session = {
            asset: loaded.asset,
            controller: runtime.createController(
              loaded.source.naturalSize.width,
              loaded.source.naturalSize.height,
            ),
            source: loaded.source,
          };
          setLoadState({ session, status: 'ready' });
        } catch (error) {
          loaded.source.dispose();
          setLoadState({
            error: errorDetails(error, 'editor_initialization_failed', 'The editor could not be initialized.'),
            status: 'error',
          });
        }
      },
      (error: unknown) => {
        if (abortController.signal.aborted || isAbortError(error)) return;
        setLoadState({
          error: errorDetails(error, 'editor_load_failed', 'The image could not be loaded for editing.'),
          status: 'error',
        });
      },
    );
    return () => {
      abortController.abort();
      session?.controller.dispose();
      session?.source.dispose();
    };
  }, [attempt, integration.assetId, runtime]);

  if (loadState.status === 'loading') {
    return (
      <MaskEditorStatus
        message="Loading image"
        onClose={() => void integration.navigate('/imagine')}
        status="loading"
      />
    );
  }
  if (loadState.status === 'error') {
    return (
      <MaskEditorStatus
        error={loadState.error}
        message="Image editor unavailable"
        onClose={() => void integration.navigate('/imagine')}
        onRetry={() => setAttempt((current) => current + 1)}
        status="error"
      />
    );
  }
  return (
    <ReadyMaskEditor
      integration={integration}
      runtime={runtime}
      session={loadState.session}
    />
  );
}

export function MaskEditorStatus({
  error,
  message,
  onClose,
  onRetry,
  status,
}: {
  readonly error?: EditorUiError;
  readonly message: string;
  readonly onClose: () => void;
  readonly onRetry?: () => void;
  readonly status: 'error' | 'loading';
}) {
  return (
    <main className="mask-editor-page mask-editor-page--status">
      <h1 className="mask-editor-title">Edit image</h1>
      <div className="mask-editor-status" role={status === 'error' ? 'alert' : 'status'}>
        {status === 'loading'
          ? <LoaderCircle aria-hidden="true" className="is-spinning" size={22} />
          : <AlertCircle aria-hidden="true" size={22} />}
        <strong>{message}</strong>
        {error && <span data-error-code={error.code}>{error.message}</span>}
        {onRetry && (
          <IconButton
            className="mask-editor-touch-target"
            icon={<RotateCcw size={18} />}
            label="Retry loading image"
            onClick={onRetry}
          />
        )}
        <IconButton
          className="mask-editor-touch-target"
          icon={<X size={18} />}
            label="Cancel editing"
          onClick={onClose}
        />
      </div>
    </main>
  );
}

function ReadyMaskEditor({
  integration,
  runtime,
  session,
}: {
  readonly integration: MaskEditorIntegration;
  readonly runtime: MaskEditorRuntime;
  readonly session: EditorSession;
}) {
  const snapshot = useSyncExternalStore(
    session.controller.subscribe,
    session.controller.getSnapshot,
    session.controller.getSnapshot,
  );
  const stageRef = useRef<HTMLDivElement | null>(null);
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displaySizeRef = useRef<{ height: number; width: number } | null>(null);
  const clientContentRectRef = useRef<ClientRectLike | null>(null);
  const frameRef = useRef<number | null>(null);
  const applyAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [showOriginal, setShowOriginal] = useState(true);
  const [showMask, setShowMask] = useState(true);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [applying, setApplying] = useState(false);
  const [uiError, setUiError] = useState<EditorUiError | null>(null);

  const renderFrame = useCallback(() => {
    frameRef.current = null;
    const sourceCanvas = sourceCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const displaySize = displaySizeRef.current;
    if (!sourceCanvas || !maskCanvas || !displaySize) return;
    try {
      const rendered = runtime.render({
        displaySize,
        mask: maskDocumentForRender(session.controller.getSnapshot()),
        maskCanvas,
        source: session.source,
        sourceCanvas,
      });
      clientContentRectRef.current = contentRectToClientRect(
        rendered.contentRect,
        maskCanvas.getBoundingClientRect(),
        displaySize,
      );
      setUiError((current) => current?.code.startsWith('render:') ? null : current);
    } catch (error) {
      clientContentRectRef.current = null;
      const details = errorDetails(error, 'render_failed', 'The editor canvas could not be rendered.');
      setUiError({ code: `render:${details.code}`, message: details.message });
    }
  }, [runtime, session.controller, session.source]);

  const scheduleRender = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = runtime.requestFrame(renderFrame);
  }, [renderFrame, runtime]);

  useEffect(() => {
    scheduleRender();
  }, [scheduleRender, snapshot]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let observer: Pick<ResizeObserver, 'disconnect' | 'observe'>;
    try {
      observer = runtime.createResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
        displaySizeRef.current = {
          height: entry.contentRect.height,
          width: entry.contentRect.width,
        };
        scheduleRender();
      });
      observer.observe(stage);
      const initialRect = stage.getBoundingClientRect();
      if (initialRect.width > 0 && initialRect.height > 0) {
        displaySizeRef.current = { height: initialRect.height, width: initialRect.width };
        scheduleRender();
      }
    } catch (error) {
      setUiError(errorDetails(error, 'resize_observer_failed', 'The editor viewport is unavailable.'));
      return;
    }
    return () => observer.disconnect();
  }, [runtime, scheduleRender]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frameRef.current !== null) runtime.cancelFrame(frameRef.current);
      applyAbortRef.current?.abort();
    };
  }, [runtime]);

  const withPointerError = (command: () => void) => {
    try {
      command();
      setUiError((current) => current?.code.startsWith('pointer:') ? null : current);
    } catch (error) {
      const details = errorDetails(error, 'pointer_failed', 'The pointer action could not be applied.');
      setUiError({ code: `pointer:${details.code}`, message: details.message });
    }
  };
  const pointerRect = (): ClientRectLike | null => {
    const rect = clientContentRectRef.current;
    if (!rect) {
      setUiError({ code: 'pointer:not_ready', message: 'The editor is still preparing the image.' });
    }
    return rect;
  };
  const pointerPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => ({
    x: event.clientX,
    y: event.clientY,
  });
  const releasePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const apply = async () => {
    if (applying || snapshot.activeStroke) return;
    const abortController = new AbortController();
    applyAbortRef.current?.abort();
    applyAbortRef.current = abortController;
    setApplying(true);
    setUiError(null);
    try {
      await uploadMaskAndContinue({
        document: snapshot.document,
        integration,
        signal: abortController.signal,
        sourceAsset: session.asset,
        uploadMask: runtime.uploadMask,
      });
    } catch (error) {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        if (mountedRef.current) {
          setUiError(errorDetails(error, 'mask_apply_failed', 'The mask could not be applied.'));
        }
      }
    } finally {
      if (applyAbortRef.current === abortController) {
        applyAbortRef.current = null;
        if (mountedRef.current) setApplying(false);
      }
    }
  };

  const maskIsEmpty = useMemo(
    () => classifyMaskRgba(snapshot.document.rgba) === 'empty',
    [snapshot.document],
  );
  const liveError = uiError ?? snapshot.error;
  return (
    <main className="mask-editor-page" aria-busy={applying}>
      <header className="mask-editor-header">
        <h1 className="mask-editor-title">Edit image</h1>
        <MaskEditorToolbar
          applyDisabled={maskIsEmpty || snapshot.activeStroke !== null}
          applying={applying}
          canClear={!maskIsEmpty || snapshot.document.cursor > 0}
          canRedo={snapshot.document.cursor < snapshot.document.history.length}
          canUndo={snapshot.document.cursor > 0}
          clearConfirmation={clearConfirmation}
          diameter={snapshot.diameter}
          onApply={() => void apply()}
          onCancelClear={() => setClearConfirmation(false)}
          onClose={() => void integration.navigate('/imagine')}
          onConfirmClear={() => {
            session.controller.clear();
            setClearConfirmation(false);
          }}
          onDiameterChange={(diameter) => session.controller.setDiameter(diameter)}
          onRedo={() => session.controller.redo()}
          onRequestClear={() => setClearConfirmation(true)}
          onShowMaskChange={setShowMask}
          onShowOriginalChange={setShowOriginal}
          onToolChange={(tool) => session.controller.setTool(tool)}
          onUndo={() => session.controller.undo()}
          showMask={showMask}
          showOriginal={showOriginal}
          tool={snapshot.tool}
        />
      </header>

      <section className="mask-editor-stage" aria-label="Mask drawing workspace" ref={stageRef}>
        <canvas
          aria-hidden="true"
          className={`mask-editor-canvas mask-editor-canvas--source ${showOriginal ? 'is-visible' : 'is-hidden'}`}
          data-visible={showOriginal}
          ref={sourceCanvasRef}
        />
        <canvas
          aria-label="Mask canvas"
          className={`mask-editor-canvas mask-editor-canvas--mask ${showMask ? 'is-visible' : 'is-hidden'}`}
          data-visible={showMask}
          onPointerCancel={(event) => {
            event.preventDefault();
            withPointerError(() => session.controller.pointerCancel(event.pointerId));
            releasePointer(event);
          }}
          onPointerDown={(event) => {
            if (applying || event.button !== 0 || !event.isPrimary) return;
            const rect = pointerRect();
            if (!rect) return;
            const point = pointerPoint(event);
            if (!clientPointIsInsideRect(point, rect)) return;
            event.preventDefault();
            withPointerError(() => {
              event.currentTarget.setPointerCapture(event.pointerId);
              session.controller.pointerDown(event.pointerId, point, rect);
            });
          }}
          onPointerMove={(event) => {
            const rect = clientContentRectRef.current;
            if (applying || !rect) return;
            event.preventDefault();
            withPointerError(() =>
              session.controller.pointerMove(event.pointerId, pointerPoint(event), rect),
            );
          }}
          onPointerUp={(event) => {
            const rect = clientContentRectRef.current;
            if (applying) return;
            if (!rect) {
              withPointerError(() => session.controller.pointerCancel(event.pointerId));
              releasePointer(event);
              return;
            }
            event.preventDefault();
            withPointerError(() =>
              session.controller.pointerUp(event.pointerId, pointerPoint(event), rect),
            );
            releasePointer(event);
          }}
          ref={maskCanvasRef}
        />
      </section>

      <p
        aria-live="assertive"
        className="mask-editor-live-region"
        data-error-code={liveError?.code}
        role={liveError ? 'alert' : 'status'}
      >
        {liveError?.message ?? (applying ? 'Applying mask' : '')}
      </p>
    </main>
  );
}
