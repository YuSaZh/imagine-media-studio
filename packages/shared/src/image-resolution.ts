export const IMAGE_RESOLUTION_PRESETS = ['1K', '2K', '4K'] as const;
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

export function imagePresetDimensions(preset: string, ratio: string): string | undefined {
  if (!IMAGE_RESOLUTION_PRESETS.some(value => value === preset)) return undefined;
  const match = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/.exec(ratio === 'auto' || !ratio ? '1:1' : ratio);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const wide = width / height === 16 / 9 || height / width === 16 / 9;
  const edge = wide ? ({ '1K': 1280, '2K': 2048, '4K': 3840 } as Record<string, number>)[preset]! : Number(preset.slice(0, -1)) * 1024;
  return width >= height ? `${edge}x${Math.max(1, Math.round(edge * height / width))}` : `${Math.max(1, Math.round(edge * width / height))}x${edge}`;
}

export function imageDimensionsPreset(value: string): { preset: string; ratio: string } | undefined {
  for (const preset of IMAGE_RESOLUTION_PRESETS) {
    for (const ratio of RATIOS) {
      if (imagePresetDimensions(preset, ratio) === value) return { preset, ratio };
      // Existing saved sizes used 1024 pixels per K for every aspect ratio.
      const [width, height] = ratio.split(':').map(Number) as [number, number];
      const edge = Number(preset.slice(0, -1)) * 1024;
      const legacy = width >= height ? `${edge}x${Math.round(edge * height / width)}` : `${Math.round(edge * width / height)}x${edge}`;
      if (legacy === value) return { preset, ratio };
    }
  }
  return undefined;
}
