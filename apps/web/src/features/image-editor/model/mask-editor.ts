import {
  MAX_INTERPOLATED_MASK_POINTS,
  MAX_MASK_BRUSH_DIAMETER,
  MAX_MASK_COMMAND_RASTER_WORK,
  MAX_MASK_STROKE_POINTS,
  applyMaskStroke,
  clearMaskDocument,
  clientPointToCanvasPoint,
  createMaskDocument,
  redoMaskDocument,
  undoMaskDocument,
} from '@imagine/shared';
import type {
  ClientRectLike,
  MaskDocument,
  MaskPoint,
  MaskTool,
  Point,
} from '@imagine/shared';

import {
  MAX_EDITOR_HISTORY_LIMIT,
  MAX_IMAGE_EDITOR_NATURAL_PIXELS,
} from './limits.js';

export { MAX_EDITOR_HISTORY_LIMIT } from './limits.js';
export const DEFAULT_EDITOR_BRUSH_DIAMETER = 48;

export interface ActiveMaskStroke {
  readonly diameter: number;
  readonly interpolatedPoints: number;
  readonly pointerId: number;
  readonly points: readonly MaskPoint[];
  readonly tool: MaskTool;
}

export interface MaskEditorState {
  readonly activeStroke: ActiveMaskStroke | null;
  readonly diameter: number;
  readonly document: MaskDocument;
  readonly error: MaskEditorStateError | null;
  readonly tool: MaskTool;
}

export type MaskEditorStateErrorCode =
  | 'stroke_point_limit_exceeded'
  | 'stroke_work_exceeded';

export interface MaskEditorStateError {
  readonly code: MaskEditorStateErrorCode;
  readonly message: string;
}

export type MaskEditorAction =
  | { readonly diameter: number; readonly type: 'set_diameter' }
  | { readonly pointerId: number; readonly point: MaskPoint; readonly type: 'pointer_start' }
  | { readonly pointerId: number; readonly point: MaskPoint; readonly type: 'pointer_move' }
  | { readonly pointerId: number; readonly type: 'pointer_end' | 'pointer_cancel' }
  | { readonly tool: MaskTool; readonly type: 'set_tool' }
  | { readonly type: 'clear' | 'clear_error' | 'redo' | 'undo' };

export type MaskEditorErrorCode =
  | 'controller_disposed'
  | 'invalid_brush_diameter'
  | 'invalid_history_limit'
  | 'invalid_image_dimensions'
  | 'invalid_point'
  | 'invalid_pointer_id';

export class MaskEditorError extends Error {
  public override readonly name = 'MaskEditorError';

  public constructor(
    public readonly code: MaskEditorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertDiameter(diameter: number): void {
  if (!Number.isFinite(diameter) || diameter < 1 || diameter > MAX_MASK_BRUSH_DIAMETER) {
    throw new MaskEditorError(
      'invalid_brush_diameter',
      `Brush diameter must be from 1 through ${MAX_MASK_BRUSH_DIAMETER}.`,
    );
  }
}

function assertPointerId(pointerId: number): void {
  if (!Number.isSafeInteger(pointerId) || pointerId < 0) {
    throw new MaskEditorError('invalid_pointer_id', 'Pointer ID must be a non-negative integer.');
  }
}

function samePoint(first: MaskPoint, second: MaskPoint): boolean {
  return first.x === second.x && first.y === second.y;
}

function strokeStepCount(first: MaskPoint, second: MaskPoint, diameter: number): number {
  const spacing = Math.max(0.5, diameter / 4);
  return Math.max(1, Math.ceil(Math.hypot(second.x - first.x, second.y - first.y) / spacing));
}

function strokeBudgetError(
  stroke: ActiveMaskStroke,
  nextPoint: MaskPoint,
): MaskEditorStateError | null {
  if (stroke.points.length >= MAX_MASK_STROKE_POINTS) {
    return Object.freeze({
      code: 'stroke_point_limit_exceeded',
      message: `A single stroke cannot contain more than ${MAX_MASK_STROKE_POINTS} pointer points.`,
    });
  }
  const interpolatedPoints =
    stroke.interpolatedPoints + strokeStepCount(stroke.points.at(-1)!, nextPoint, stroke.diameter);
  const stampSpan = Math.ceil(stroke.diameter) + 2;
  const rasterWork = interpolatedPoints * stampSpan * stampSpan;
  if (
    interpolatedPoints > MAX_INTERPOLATED_MASK_POINTS ||
    !Number.isSafeInteger(rasterWork) ||
    rasterWork > MAX_MASK_COMMAND_RASTER_WORK
  ) {
    return Object.freeze({
      code: 'stroke_work_exceeded',
      message: 'The stroke is too long for the selected brush diameter. Try a shorter stroke.',
    });
  }
  return null;
}

function normalizePoint(point: MaskPoint, document: MaskDocument): MaskPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new MaskEditorError('invalid_point', 'Pointer coordinates must be finite.');
  }
  return Object.freeze({
    x: Math.min(document.width - 1, Math.max(0, point.x)),
    y: Math.min(document.height - 1, Math.max(0, point.y)),
  });
}

function commitActiveStroke(state: MaskEditorState): MaskEditorState {
  const stroke = state.activeStroke;
  if (!stroke) return state;
  return {
    ...state,
    activeStroke: null,
    document: applyMaskStroke(state.document, {
      diameter: stroke.diameter,
      points: stroke.points,
      tool: stroke.tool,
    }),
  };
}

export function createMaskEditorState(options: {
  readonly diameter?: number;
  readonly height: number;
  readonly historyLimit?: number;
  readonly tool?: MaskTool;
  readonly width: number;
}): MaskEditorState {
  const diameter = options.diameter ?? DEFAULT_EDITOR_BRUSH_DIAMETER;
  const historyLimit = options.historyLimit ?? MAX_EDITOR_HISTORY_LIMIT;
  assertDiameter(diameter);
  if (
    !Number.isSafeInteger(options.width) ||
    !Number.isSafeInteger(options.height) ||
    options.width <= 0 ||
    options.height <= 0 ||
    options.width > Math.floor(MAX_IMAGE_EDITOR_NATURAL_PIXELS / options.height)
  ) {
    throw new MaskEditorError(
      'invalid_image_dimensions',
      `Editor dimensions must contain at most ${MAX_IMAGE_EDITOR_NATURAL_PIXELS} pixels.`,
    );
  }
  if (
    !Number.isSafeInteger(historyLimit) ||
    historyLimit <= 0 ||
    historyLimit > MAX_EDITOR_HISTORY_LIMIT
  ) {
    throw new MaskEditorError(
      'invalid_history_limit',
      `Editor history limit must be from 1 through ${MAX_EDITOR_HISTORY_LIMIT}.`,
    );
  }
  return {
    activeStroke: null,
    diameter,
    document: createMaskDocument({
      height: options.height,
      historyLimit,
      width: options.width,
    }),
    error: null,
    tool: options.tool ?? 'brush',
  };
}

export function maskEditorReducer(
  state: MaskEditorState,
  action: MaskEditorAction,
): MaskEditorState {
  switch (action.type) {
    case 'set_tool':
      return action.tool === state.tool ? state : { ...state, tool: action.tool };
    case 'set_diameter':
      assertDiameter(action.diameter);
      return action.diameter === state.diameter ? state : { ...state, diameter: action.diameter };
    case 'pointer_start': {
      assertPointerId(action.pointerId);
      if (state.activeStroke) return state;
      const point = normalizePoint(action.point, state.document);
      return {
        ...state,
        activeStroke: Object.freeze({
          diameter: state.diameter,
          interpolatedPoints: 1,
          pointerId: action.pointerId,
          points: Object.freeze([point]),
          tool: state.tool,
        }),
        error: null,
      };
    }
    case 'pointer_move': {
      assertPointerId(action.pointerId);
      const stroke = state.activeStroke;
      if (!stroke || stroke.pointerId !== action.pointerId) return state;
      const point = normalizePoint(action.point, state.document);
      const lastPoint = stroke.points.at(-1)!;
      if (samePoint(lastPoint, point)) return state;
      const error = strokeBudgetError(stroke, point);
      if (error) {
        return {
          ...state,
          activeStroke: null,
          error,
        };
      }
      return {
        ...state,
        activeStroke: Object.freeze({
          ...stroke,
          interpolatedPoints:
            stroke.interpolatedPoints + strokeStepCount(lastPoint, point, stroke.diameter),
          points: Object.freeze([...stroke.points, point]),
        }),
      };
    }
    case 'pointer_end':
      assertPointerId(action.pointerId);
      return state.activeStroke?.pointerId === action.pointerId ? commitActiveStroke(state) : state;
    case 'pointer_cancel':
      assertPointerId(action.pointerId);
      return state.activeStroke?.pointerId === action.pointerId
        ? { ...state, activeStroke: null }
        : state;
    case 'undo':
      return {
        ...state,
        activeStroke: null,
        document: undoMaskDocument(state.document),
      };
    case 'redo':
      return {
        ...state,
        activeStroke: null,
        document: redoMaskDocument(state.document),
      };
    case 'clear':
      return {
        ...state,
        activeStroke: null,
        document: clearMaskDocument(state.document),
      };
    case 'clear_error':
      return state.error ? { ...state, error: null } : state;
  }
}

export function maskDocumentForRender(state: MaskEditorState): MaskDocument {
  const stroke = state.activeStroke;
  if (!stroke) return state.document;
  return applyMaskStroke(state.document, {
    diameter: stroke.diameter,
    points: stroke.points,
    tool: stroke.tool,
  });
}

export class MaskEditorController {
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #state: MaskEditorState;

  public constructor(initialState: MaskEditorState) {
    this.#state = initialState;
  }

  public readonly getSnapshot = (): MaskEditorState => this.#state;

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #assertActive(): void {
    if (this.#disposed) {
      throw new MaskEditorError('controller_disposed', 'Mask editor controller is disposed.');
    }
  }

  #dispatch(action: MaskEditorAction): void {
    this.#assertActive();
    const next = maskEditorReducer(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #canvasPoint(clientPoint: Point, rect: ClientRectLike): MaskPoint {
    return clientPointToCanvasPoint(rect, clientPoint, {
      height: this.#state.document.height,
      width: this.#state.document.width,
    });
  }

  public setTool(tool: MaskTool): void {
    this.#dispatch({ tool, type: 'set_tool' });
  }

  public setDiameter(diameter: number): void {
    this.#dispatch({ diameter, type: 'set_diameter' });
  }

  public pointerDown(pointerId: number, clientPoint: Point, rect: ClientRectLike): void {
    this.#dispatch({
      pointerId,
      point: this.#canvasPoint(clientPoint, rect),
      type: 'pointer_start',
    });
  }

  public pointerMove(pointerId: number, clientPoint: Point, rect: ClientRectLike): void {
    this.#dispatch({
      pointerId,
      point: this.#canvasPoint(clientPoint, rect),
      type: 'pointer_move',
    });
  }

  public pointerUp(pointerId: number, clientPoint: Point, rect: ClientRectLike): void {
    this.pointerMove(pointerId, clientPoint, rect);
    this.#dispatch({ pointerId, type: 'pointer_end' });
  }

  public pointerCancel(pointerId: number): void {
    this.#dispatch({ pointerId, type: 'pointer_cancel' });
  }

  public undo(): void {
    this.#dispatch({ type: 'undo' });
  }

  public redo(): void {
    this.#dispatch({ type: 'redo' });
  }

  public clear(): void {
    this.#dispatch({ type: 'clear' });
  }

  public clearError(): void {
    this.#dispatch({ type: 'clear_error' });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }
}
