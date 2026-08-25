export type MaskTool = 'brush' | 'erase';

export interface MaskPoint {
  readonly x: number;
  readonly y: number;
}

export interface MaskStrokeCommand {
  readonly type: 'stroke';
  readonly tool: MaskTool;
  readonly diameter: number;
  readonly points: readonly MaskPoint[];
}

export interface MaskClearCommand {
  readonly type: 'clear';
}

export type MaskCommand = MaskStrokeCommand | MaskClearCommand;

export interface MaskDocument {
  readonly width: number;
  readonly height: number;
  readonly historyLimit: number;
  readonly compactedRgba: Uint8ClampedArray;
  readonly rgba: Uint8ClampedArray;
  readonly history: readonly MaskCommand[];
  readonly cursor: number;
}

export type MaskDocumentErrorCode =
  | 'invalid_dimensions'
  | 'invalid_history_limit'
  | 'invalid_serialization'
  | 'invalid_stroke';

export class MaskDocumentError extends Error {
  public override readonly name = 'MaskDocumentError';

  public constructor(
    public readonly code: MaskDocumentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_MASK_HISTORY_LIMIT = 50;
export const MAX_MASK_HISTORY_LIMIT = 1_000;
export const MAX_MASK_DOCUMENT_PIXELS = 16_777_216;
export const MAX_MASK_STROKE_POINTS = 2_048;
export const MAX_MASK_BRUSH_DIAMETER = 1_024;
export const MAX_INTERPOLATED_MASK_POINTS = 100_000;
export const MAX_MASK_COMMAND_RASTER_WORK = 4_000_000;
export const MAX_MASK_RENDER_WORK = 25_000_000;
export const MAX_SERIALIZED_MASK_DOCUMENT_CHARS = 8 * 1024 * 1024;

interface SerializedMaskDocument {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly historyLimit: number;
  readonly baseAlphaRle: readonly (readonly [number, number])[];
  readonly history: readonly MaskCommand[];
  readonly cursor: number;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > Math.floor(MAX_MASK_DOCUMENT_PIXELS / height)
  ) {
    throw new MaskDocumentError(
      'invalid_dimensions',
      `Mask dimensions must contain at most ${MAX_MASK_DOCUMENT_PIXELS} pixels.`,
    );
  }
}

function assertHistoryLimit(historyLimit: number): void {
  if (
    !Number.isSafeInteger(historyLimit) ||
    historyLimit <= 0 ||
    historyLimit > MAX_MASK_HISTORY_LIMIT
  ) {
    throw new MaskDocumentError(
      'invalid_history_limit',
      `Mask history limit must be from 1 through ${MAX_MASK_HISTORY_LIMIT}.`,
    );
  }
}

function blankRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  return rgba;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizePoint(point: MaskPoint, width: number, height: number): MaskPoint {
  if (!finite(point.x) || !finite(point.y)) {
    throw new MaskDocumentError('invalid_stroke', 'Mask stroke points must be finite.');
  }
  return {
    x: clamp(point.x, 0, width - 1),
    y: clamp(point.y, 0, height - 1),
  };
}

function normalizeCommand(
  command: MaskCommand,
  width: number,
  height: number,
): MaskCommand {
  if (command.type === 'clear') return Object.freeze({ type: 'clear' });
  if (
    !finite(command.diameter) ||
    command.diameter <= 0 ||
    command.diameter > MAX_MASK_BRUSH_DIAMETER ||
    command.points.length === 0 ||
    command.points.length > MAX_MASK_STROKE_POINTS ||
    (command.tool !== 'brush' && command.tool !== 'erase')
  ) {
    throw new MaskDocumentError('invalid_stroke', 'Mask stroke parameters are invalid.');
  }
  const points = command.points.map((point) =>
    Object.freeze(normalizePoint(point, width, height)),
  );
  return Object.freeze({
    type: 'stroke',
    tool: command.tool,
    diameter: command.diameter,
    points: Object.freeze(points),
  });
}

export function interpolateMaskStroke(
  points: readonly MaskPoint[],
  diameter: number,
  size: { readonly width: number; readonly height: number },
): readonly MaskPoint[] {
  assertDimensions(size.width, size.height);
  const normalized = normalizeCommand(
    { type: 'stroke', tool: 'brush', diameter, points },
    size.width,
    size.height,
  );
  if (normalized.type !== 'stroke') return [];
  const output: MaskPoint[] = [normalized.points[0]!];
  const spacing = Math.max(0.5, diameter / 4);
  for (let index = 1; index < normalized.points.length; index += 1) {
    const start = normalized.points[index - 1]!;
    const end = normalized.points[index]!;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    if (output.length + steps > MAX_INTERPOLATED_MASK_POINTS) {
      throw new MaskDocumentError(
        'invalid_stroke',
        `Interpolated stroke exceeds ${MAX_INTERPOLATED_MASK_POINTS} points.`,
      );
    }
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      output.push({
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      });
    }
  }
  return output;
}

function stamp(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  point: MaskPoint,
  diameter: number,
  alpha: 0 | 255,
): void {
  const radius = Math.max(0.5, diameter / 2);
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  const minimumX = Math.max(0, Math.floor(centerX - radius));
  const maximumX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minimumY = Math.max(0, Math.floor(centerY - radius));
  const maximumY = Math.min(height - 1, Math.ceil(centerY + radius));
  const squaredRadius = radius * radius;
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > squaredRadius) continue;
      const offset = (y * width + x) * 4;
      rgba[offset] = 255;
      rgba[offset + 1] = 255;
      rgba[offset + 2] = 255;
      rgba[offset + 3] = alpha;
    }
  }
}

function renderCommand(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  command: MaskCommand,
): number {
  if (command.type === 'clear') {
    rgba.fill(255);
    return width * height;
  }
  const alpha = command.tool === 'brush' ? 0 : 255;
  const points = interpolateMaskStroke(command.points, command.diameter, { width, height });
  const stampSpan = Math.ceil(command.diameter) + 2;
  const rasterWork = points.length * stampSpan * stampSpan;
  if (!Number.isSafeInteger(rasterWork) || rasterWork > MAX_MASK_COMMAND_RASTER_WORK) {
    throw new MaskDocumentError(
      'invalid_stroke',
      `Mask stroke exceeds ${MAX_MASK_COMMAND_RASTER_WORK} raster operations.`,
    );
  }
  for (const point of points) {
    stamp(rgba, width, height, point, command.diameter, alpha);
  }
  return rasterWork;
}

function renderDocument(
  compactedRgba: Uint8ClampedArray,
  history: readonly MaskCommand[],
  cursor: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  const rgba = compactedRgba.slice();
  let rasterWork = 0;
  for (const command of history.slice(0, cursor)) {
    rasterWork += renderCommand(rgba, width, height, command);
    if (rasterWork > MAX_MASK_RENDER_WORK) {
      throw new MaskDocumentError(
        'invalid_stroke',
        `Mask history exceeds ${MAX_MASK_RENDER_WORK} raster operations.`,
      );
    }
  }
  return rgba;
}

export function createMaskDocument(options: {
  readonly width: number;
  readonly height: number;
  readonly historyLimit?: number;
}): MaskDocument {
  assertDimensions(options.width, options.height);
  const historyLimit = options.historyLimit ?? DEFAULT_MASK_HISTORY_LIMIT;
  assertHistoryLimit(historyLimit);
  const rgba = blankRgba(options.width, options.height);
  return {
    width: options.width,
    height: options.height,
    historyLimit,
    compactedRgba: rgba.slice(),
    rgba,
    history: Object.freeze([]),
    cursor: 0,
  };
}

export function applyMaskCommand(
  document: MaskDocument,
  rawCommand: MaskCommand,
): MaskDocument {
  const command = normalizeCommand(rawCommand, document.width, document.height);
  const activeHistory = document.history.slice(0, document.cursor);
  const compactedRgba = document.compactedRgba.slice();
  while (activeHistory.length >= document.historyLimit) {
    const compacted = activeHistory.shift();
    if (compacted) renderCommand(compactedRgba, document.width, document.height, compacted);
  }
  const history = Object.freeze([...activeHistory, command]);
  const cursor = history.length;
  return {
    ...document,
    compactedRgba,
    history,
    cursor,
    rgba: renderDocument(compactedRgba, history, cursor, document.width, document.height),
  };
}

export function applyMaskStroke(
  document: MaskDocument,
  input: Omit<MaskStrokeCommand, 'type'>,
): MaskDocument {
  return applyMaskCommand(document, { type: 'stroke', ...input });
}

export function clearMaskDocument(document: MaskDocument): MaskDocument {
  return applyMaskCommand(document, { type: 'clear' });
}

export function undoMaskDocument(document: MaskDocument): MaskDocument {
  if (document.cursor === 0) return document;
  const cursor = document.cursor - 1;
  return {
    ...document,
    cursor,
    rgba: renderDocument(
      document.compactedRgba,
      document.history,
      cursor,
      document.width,
      document.height,
    ),
  };
}

export function redoMaskDocument(document: MaskDocument): MaskDocument {
  if (document.cursor >= document.history.length) return document;
  const cursor = document.cursor + 1;
  return {
    ...document,
    cursor,
    rgba: renderDocument(
      document.compactedRgba,
      document.history,
      cursor,
      document.width,
      document.height,
    ),
  };
}

function encodeAlphaRle(rgba: ArrayLike<number>): readonly (readonly [number, number])[] {
  const runs: Array<readonly [number, number]> = [];
  let current = rgba[3] ?? 255;
  let count = 0;
  for (let index = 3; index < rgba.length; index += 4) {
    const alpha = rgba[index] ?? 255;
    if (alpha === current) {
      count += 1;
      continue;
    }
    runs.push([current, count]);
    current = alpha;
    count = 1;
  }
  runs.push([current, count]);
  return runs;
}

export function serializeMaskDocument(document: MaskDocument): string {
  const serialized: SerializedMaskDocument = {
    version: 1,
    width: document.width,
    height: document.height,
    historyLimit: document.historyLimit,
    baseAlphaRle: encodeAlphaRle(document.compactedRgba),
    history: document.history,
    cursor: document.cursor,
  };
  const json = JSON.stringify(serialized);
  if (json.length > MAX_SERIALIZED_MASK_DOCUMENT_CHARS) {
    throw new MaskDocumentError(
      'invalid_serialization',
      `Serialized mask exceeds ${MAX_SERIALIZED_MASK_DOCUMENT_CHARS} characters.`,
    );
  }
  return json;
}

function decodeAlphaRle(
  value: unknown,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (!Array.isArray(value)) {
    throw new MaskDocumentError('invalid_serialization', 'Mask alpha RLE must be an array.');
  }
  const rgba = blankRgba(width, height);
  let pixel = 0;
  for (const run of value) {
    if (
      !Array.isArray(run) ||
      run.length !== 2 ||
      !Number.isInteger(run[0]) ||
      !Number.isSafeInteger(run[1]) ||
      (run[0] !== 0 && run[0] !== 255) ||
      (run[1] as number) <= 0
    ) {
      throw new MaskDocumentError('invalid_serialization', 'Mask alpha RLE is malformed.');
    }
    for (let count = 0; count < (run[1] as number); count += 1) {
      if (pixel >= width * height) {
        throw new MaskDocumentError('invalid_serialization', 'Mask alpha RLE is too long.');
      }
      rgba[pixel * 4 + 3] = run[0] as number;
      pixel += 1;
    }
  }
  if (pixel !== width * height) {
    throw new MaskDocumentError('invalid_serialization', 'Mask alpha RLE is incomplete.');
  }
  return rgba;
}

function parseSerializedCommand(value: unknown, width: number, height: number): MaskCommand {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new MaskDocumentError('invalid_serialization', 'Mask command must be an object.');
  }
  const command = value as Record<string, unknown>;
  if (command.type === 'clear') {
    if (Object.keys(command).join(',') !== 'type') {
      throw new MaskDocumentError('invalid_serialization', 'Clear command is malformed.');
    }
    return normalizeCommand({ type: 'clear' }, width, height);
  }
  if (
    command.type !== 'stroke' ||
    Object.keys(command).sort().join(',') !== 'diameter,points,tool,type' ||
    !Array.isArray(command.points) ||
    command.points.some((point) =>
      point === null ||
      Array.isArray(point) ||
      typeof point !== 'object' ||
      Object.keys(point).sort().join(',') !== 'x,y'
    )
  ) {
    throw new MaskDocumentError('invalid_serialization', 'Stroke command is malformed.');
  }
  return normalizeCommand(
    {
      type: 'stroke',
      tool: command.tool as MaskTool,
      diameter: command.diameter as number,
      points: command.points as readonly MaskPoint[],
    },
    width,
    height,
  );
}

export function deserializeMaskDocument(serialized: string): MaskDocument {
  try {
    if (serialized.length === 0 || serialized.length > MAX_SERIALIZED_MASK_DOCUMENT_CHARS) {
      throw new Error('Serialized mask size is invalid.');
    }
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !==
        'baseAlphaRle,cursor,height,history,historyLimit,version,width'
    ) {
      throw new Error('Serialized mask envelope is invalid.');
    }
    if (value.version !== 1) throw new Error('Unsupported version.');
    const width = value.width as number;
    const height = value.height as number;
    const historyLimit = value.historyLimit as number;
    assertDimensions(width, height);
    assertHistoryLimit(historyLimit);
    if (
      !Array.isArray(value.history) ||
      value.history.length > historyLimit ||
      !Number.isSafeInteger(value.cursor)
    ) {
      throw new Error('Invalid history.');
    }
    const history = Object.freeze(
      value.history.map((command) => parseSerializedCommand(command, width, height)),
    );
    const cursor = value.cursor as number;
    if (cursor < 0 || cursor > history.length) {
      throw new Error('Invalid history cursor.');
    }
    const compactedRgba = decodeAlphaRle(value.baseAlphaRle, width, height);
    return {
      width,
      height,
      historyLimit,
      compactedRgba,
      history,
      cursor,
      rgba: renderDocument(compactedRgba, history, cursor, width, height),
    };
  } catch (error) {
    if (error instanceof MaskDocumentError) throw error;
    throw new MaskDocumentError('invalid_serialization', 'Mask document JSON is invalid.');
  }
}
