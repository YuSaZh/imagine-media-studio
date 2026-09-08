import type { OperationPolicy } from '@imagine/shared';

export function videoPixelSize(resolution: string, ratio: string): string | undefined {
  const pixels = /^(\d{1,5})x(\d{1,5})$/.exec(resolution);
  if (pixels) {
    const width = Number(pixels[1]), height = Number(pixels[2]);
    return width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 67108864 ? resolution : undefined;
  }
  const shortEdge = ({ '480p': 480, '720p': 720, '1080p': 1080, '4k': 2160 })[resolution.toLowerCase()];
  const match = /^(\d+):(\d+)$/.exec(ratio);
  if (!shortEdge || !match) return undefined;
  const aspect = Number(match[1]) / Number(match[2]);
  if (!Number.isFinite(aspect) || aspect < 1 / 16 || aspect > 16) return undefined;
  const width = Math.round(shortEdge * Math.max(1, aspect) / 2) * 2;
  const height = Math.round(shortEdge * Math.max(1, 1 / aspect) / 2) * 2;
  return videoPixelSize(`${width}x${height}`, ratio);
}
export function videoPolicySizes(policy: OperationPolicy): string[] | undefined {
  if (!policy.resolutions) return undefined;
  return [...new Set(policy.resolutions.flatMap(resolution => (policy.aspectRatios ?? ['16:9', '9:16']).flatMap(ratio => {
    const size = videoPixelSize(resolution, ratio); return size ? [size] : [];
  })))];
}
export function videoDurationAllowed(value: number, durations: NonNullable<OperationPolicy['durations']>): boolean {
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  return Array.isArray(durations) ? durations.includes(value) : value >= durations.min && value <= durations.max && (durations.step === undefined || Math.abs((value - durations.min) / durations.step - Math.round((value - durations.min) / durations.step)) < 1e-8);
}
