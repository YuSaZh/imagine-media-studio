export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface PageCursor {
  readonly timestampMs: number;
  readonly id: string;
}

export interface PageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NormalizedPageRequest {
  readonly cursor: PageCursor | null;
  readonly limit: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export class InvalidPageCursorError extends Error {
  public override readonly name = 'InvalidPageCursorError';
}

export function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.timestampMs, cursor.id]), 'utf8').toString('base64url');
}

export function decodePageCursor(value: string): PageCursor {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'number' ||
      !Number.isSafeInteger(decoded[0]) ||
      decoded[0] < 0 ||
      typeof decoded[1] !== 'string' ||
      decoded[1].length === 0
    ) {
      throw new InvalidPageCursorError('The page cursor payload is invalid.');
    }
    return { timestampMs: decoded[0], id: decoded[1] };
  } catch (error) {
    if (error instanceof InvalidPageCursorError) throw error;
    throw new InvalidPageCursorError('The page cursor is invalid.');
  }
}

export function normalizePageRequest(request: PageRequest = {}): NormalizedPageRequest {
  const rawLimit = request.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    throw new RangeError(`Page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
  }
  return {
    cursor: request.cursor === undefined ? null : decodePageCursor(request.cursor),
    limit: rawLimit,
  };
}

export function toCursorPage<T>(
  rows: readonly T[],
  limit: number,
  cursorFor: (row: T) => PageCursor,
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : [...rows];
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: hasNextPage && lastItem !== undefined ? encodePageCursor(cursorFor(lastItem)) : null,
  };
}
