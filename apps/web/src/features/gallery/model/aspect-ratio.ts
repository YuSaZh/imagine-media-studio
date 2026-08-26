import type { FixtureAspectRatio } from './types.js';

// Keep provider-declared ratios useful for layout without allowing arbitrary numeric payloads.
const MAX_ASPECT_COMPONENT = 1_000;
const ASPECT_RATIO_PATTERN = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/;

export const COMMON_ASPECT_RATIOS: readonly FixtureAspectRatio[] = [
  '2:3',
  '3:2',
  '1:1',
  '9:16',
  '16:9',
  '4:3',
  '3:4',
];

export function parseAspectRatio(value: unknown): FixtureAspectRatio | undefined {
  if (typeof value !== 'string' || value.length > 9) return undefined;
  const match = ASPECT_RATIO_PATTERN.exec(value);
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator > MAX_ASPECT_COMPONENT ||
    denominator > MAX_ASPECT_COMPONENT
  ) return undefined;
  return `${numerator}:${denominator}`;
}

export function nearestAspectRatio(width: number, height: number): FixtureAspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1:1';
  }
  const ratio = width / height;
  return [...COMMON_ASPECT_RATIOS]
    .map((candidate) => {
      const [numerator, denominator] = candidate.split(':').map(Number);
      return {
        candidate,
        difference: Math.abs(ratio - (numerator ?? 1) / (denominator ?? 1)),
      };
    })
    .sort((left, right) => left.difference - right.difference)[0]?.candidate ?? '1:1';
}

export function dimensionsForAspectRatio(
  value: unknown,
  maxDimension = 1_024,
): { width: number; height: number } {
  const aspectRatio = parseAspectRatio(value) ?? '1:1';
  const [numerator, denominator] = aspectRatio.split(':').map(Number);
  if (!numerator || !denominator) return { width: maxDimension, height: maxDimension };
  return numerator >= denominator
    ? {
        width: maxDimension,
        height: Math.max(1, Math.round(maxDimension * denominator / numerator)),
      }
    : {
        width: Math.max(1, Math.round(maxDimension * numerator / denominator)),
        height: maxDimension,
      };
}
