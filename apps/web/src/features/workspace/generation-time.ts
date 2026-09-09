export function generationSeconds(createdAt: string | undefined, end: string | number = Date.now()): number | null {
  const start = Date.parse(createdAt ?? '');
  const finish = typeof end === 'number' ? end : Date.parse(end);
  return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, Math.floor((finish - start) / 1000)) : null;
}
export function formatGenerationTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return value < 60 ? `${value}s` : `${Math.floor(value / 60)}m${value % 60}s`;
}
