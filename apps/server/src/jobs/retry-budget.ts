export type RetriableWorkKind = 'poll' | 'download' | 'process';

export interface StageRetryCounts {
  readonly poll: number;
  readonly download: number;
  readonly process: number;
}

export const EMPTY_STAGE_RETRY_COUNTS: StageRetryCounts = Object.freeze({
  download: 0,
  poll: 0,
  process: 0,
});

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Job ${label} retry count must be a non-negative safe integer.`);
  }
  return value as number;
}

export function parseStageRetryCounts(value: unknown): StageRetryCounts {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Job stage retry budget must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  return {
    poll: nonNegativeInteger(record.poll ?? 0, 'poll'),
    download: nonNegativeInteger(record.download ?? 0, 'download'),
    process: nonNegativeInteger(record.process ?? 0, 'process'),
  };
}

export function nextStageRetryCounts(
  current: StageRetryCounts,
  kind: RetriableWorkKind,
): StageRetryCounts {
  return { ...current, [kind]: current[kind] + 1 };
}

export function clearStageRetryCount(
  current: StageRetryCounts,
  kind: RetriableWorkKind,
): StageRetryCounts {
  return current[kind] === 0 ? current : { ...current, [kind]: 0 };
}
