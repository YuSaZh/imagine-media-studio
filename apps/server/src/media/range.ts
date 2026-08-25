import parseRange from 'range-parser';

export interface MediaResponsePlan {
  body: boolean;
  end: number | null;
  headers: Record<string, string>;
  start: number | null;
  statusCode: 200 | 206 | 416;
}

export interface PlanMediaResponseOptions {
  etag: string;
  ifRange?: string;
  lastModified?: Date;
  method: 'GET' | 'HEAD';
  range?: string;
  size: number;
}

function ifRangeMatches(options: PlanMediaResponseOptions): boolean {
  if (options.ifRange === undefined) return true;
  if (options.ifRange.startsWith('"')) return options.ifRange === options.etag;
  if (options.ifRange.startsWith('W/')) return false;
  if (options.lastModified === undefined) return false;
  const validatorTime = Date.parse(options.ifRange);
  if (!Number.isFinite(validatorTime)) return false;
  return Math.floor(options.lastModified.getTime() / 1_000) * 1_000 <= validatorTime;
}

function fullResponse(options: PlanMediaResponseOptions): MediaResponsePlan {
  return {
    body: options.method === 'GET',
    end: options.size === 0 ? null : options.size - 1,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(options.size),
      etag: options.etag,
    },
    start: options.size === 0 ? null : 0,
    statusCode: 200,
  };
}

/** Plans a single byte range. Multipart ranges are deliberately ignored. */
export function planMediaResponse(options: PlanMediaResponseOptions): MediaResponsePlan {
  if (
    options.range === undefined ||
    options.size === 0 ||
    options.range.includes(',') ||
    !ifRangeMatches(options)
  ) {
    return fullResponse(options);
  }

  const parsed = parseRange(options.size, options.range, { combine: true });
  if (parsed === -2 || (Array.isArray(parsed) && parsed.length !== 1)) {
    return fullResponse(options);
  }
  if (parsed === -1) {
    return {
      body: false,
      end: null,
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${options.size}`,
        etag: options.etag,
      },
      start: null,
      statusCode: 416,
    };
  }

  const range = parsed[0];
  if (range === undefined) {
    return fullResponse(options);
  }
  const length = range.end - range.start + 1;
  return {
    body: options.method === 'GET',
    end: range.end,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': String(length),
      'content-range': `bytes ${range.start}-${range.end}/${options.size}`,
      etag: options.etag,
    },
    start: range.start,
    statusCode: 206,
  };
}
