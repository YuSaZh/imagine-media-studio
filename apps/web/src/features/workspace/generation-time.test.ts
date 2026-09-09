import { expect, it } from 'vitest';
import { formatGenerationTime, generationSeconds } from './generation-time';
it('uses persisted timestamps, handles missing values and formats minutes compactly', () => {
  const start = '2026-09-09T00:00:00.000Z';
  expect(generationSeconds(start, '2026-09-09T00:01:10.999Z')).toBe(70);
  expect(formatGenerationTime(70)).toBe('1m10s');
  expect(formatGenerationTime(30)).toBe('30s');
  expect(formatGenerationTime(48)).toBe('48s');
  expect(generationSeconds(undefined)).toBeNull();
  expect(generationSeconds(start, 'invalid')).toBeNull();
  expect(generationSeconds(start, Date.parse(start) - 1000)).toBe(0);
});
