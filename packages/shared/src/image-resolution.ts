import { z } from 'zod';

export const ImageDimensionConstraintsSchema = z.object({
  multipleOf: z.number().int().min(1).max(16384).optional(),
  minPixels: z.number().int().positive().max(100_000_000).optional(),
  maxPixels: z.number().int().positive().max(100_000_000).optional(),
  minWidth: z.number().int().positive().max(16384).optional(),
  minHeight: z.number().int().positive().max(16384).optional(),
  maxWidth: z.number().int().positive().max(16384).optional(),
  maxHeight: z.number().int().positive().max(16384).optional(),
  maxAspectRatio: z.number().finite().min(1).optional(),
}).strict().refine(value => value.minPixels === undefined || value.maxPixels === undefined || value.minPixels <= value.maxPixels, 'Minimum pixels exceed maximum pixels')
  .refine(value => value.minWidth === undefined || value.maxWidth === undefined || value.minWidth <= value.maxWidth, 'Minimum width exceeds maximum width')
  .refine(value => value.minHeight === undefined || value.maxHeight === undefined || value.minHeight <= value.maxHeight, 'Minimum height exceeds maximum height');
export const ImageResolutionCapabilitySchema = z.object({
  mode: z.enum(['native', 'pixels']),
  values: z.array(z.string().trim().min(1).max(64)).max(100),
  allowCustomDimensions: z.boolean().default(false),
  dimensions: ImageDimensionConstraintsSchema.optional(),
}).strict();
export type ImageResolutionCapability = z.infer<typeof ImageResolutionCapabilitySchema>;
export type ImageDimensionConstraints = z.infer<typeof ImageDimensionConstraintsSchema>;

export const IMAGE_RESOLUTION_PRESETS = ['1K', '2K', '4K'] as const;
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

export function imageDimensionsAllowed(value: string, constraints: ImageDimensionConstraints = {}): boolean {
  const match = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  return width >= (constraints.minWidth ?? 1) && height >= (constraints.minHeight ?? 1) && width <= (constraints.maxWidth ?? 16384) && height <= (constraints.maxHeight ?? 16384)
    && width % (constraints.multipleOf ?? 1) === 0 && height % (constraints.multipleOf ?? 1) === 0
    && Math.max(width / height, height / width) <= (constraints.maxAspectRatio ?? Infinity)
    && pixels >= (constraints.minPixels ?? 1) && pixels <= (constraints.maxPixels ?? 100_000_000);
}

export function inferImageResolution(capabilities: { imageResolution?: unknown; resolutions?: unknown; customFields?: unknown; parameters?: unknown }, profile?: string): ImageResolutionCapability {
  if (capabilities.imageResolution !== undefined) return ImageResolutionCapabilitySchema.parse(capabilities.imageResolution);
  const resolutionRule = Array.isArray(capabilities.parameters) ? capabilities.parameters.find(rule => rule?.path === 'resolution' && rule.enabled !== false) as { options?: unknown; allowCustom?: unknown; type?: unknown } | undefined : undefined;
  const declared = capabilities.resolutions ?? resolutionRule?.options;
  const values = Array.isArray(declared) ? declared.filter((value): value is string => typeof value === 'string') : [];
  const nativeProtocol = ['openai-chat-image-v1', 'gemini-generate-content-image-v1', 'gemini-interactions-image-v1', 'xai-imagine-image-v1'].includes(profile ?? '');
  const pixelProtocol = ['openai-images-v1', 'openai-responses-image-v1'].includes(profile ?? '');
  const mode = nativeProtocol || !pixelProtocol && values.some(value => value !== 'auto' && !/^\d+x\d+$/.test(value)) ? 'native' : 'pixels';
  const custom = capabilities.customFields as { properties?: { size?: { type?: unknown; enum?: unknown; const?: unknown } } } | undefined;
  const size = custom?.properties?.size;
  return { mode, values: [...values], allowCustomDimensions: size?.type === 'string' && size.enum === undefined && size.const === undefined || resolutionRule?.allowCustom === true || resolutionRule?.type === 'text' };
}

export function imageResolutionAllows(value: string, capability: ImageResolutionCapability): boolean {
  if (value === 'auto' || value === '') return true;
  if (/^\d+x\d+$/.test(value)) {
    if (!imageDimensionsAllowed(value, capability.dimensions)) return false;
    if (capability.values.includes(value)) return true;
    if (!capability.allowCustomDimensions) return false;
    if (capability.mode === 'pixels') return true;
    const mapped = imageDimensionsPreset(value, capability.dimensions?.multipleOf);
    return !!mapped && capability.values.some(option => option.toUpperCase() === mapped.preset);
  }
  return capability.mode === 'native' && capability.values.includes(value);
}

export function assertImageResolution(request: { resolution?: string | undefined; width?: number | undefined; height?: number | undefined; extra?: Record<string, unknown> | undefined }, capability: ImageResolutionCapability): void {
  for (const value of [request.resolution, request.extra?.size]) {
    if (value !== undefined && (typeof value !== 'string' || !imageResolutionAllows(value, capability))) throw new Error('分辨率不符合模型能力配置');
  }
  if (request.width !== undefined || request.height !== undefined) {
    if (request.width === undefined || request.height === undefined || !imageResolutionAllows(`${request.width}x${request.height}`, capability)) throw new Error('图片尺寸不符合模型能力配置');
  }
}

export function prepareNativeImageResolution<T extends { resolution?: string | undefined; aspectRatio?: string | undefined; width?: number | undefined; height?: number | undefined; extra?: Record<string, unknown> | undefined }>(request: T, capability: ImageResolutionCapability, lowerCase = false): { request: T; capability: ImageResolutionCapability } {
  assertImageResolution(request, capability);
  if (capability.mode !== 'native' || !request.resolution || !/^\d+x\d+$/.test(request.resolution)) return { request, capability };
  const mapped = imageDimensionsPreset(request.resolution, capability.dimensions?.multipleOf);
  if (!mapped) throw new Error('像素尺寸无法映射到原生分辨率档位');
  if (request.aspectRatio && request.aspectRatio !== 'auto' && request.aspectRatio !== mapped.ratio) throw new Error('像素尺寸与所选画幅冲突');
  const resolution = capability.values.find(value => value.toUpperCase() === mapped.preset) ?? (lowerCase ? mapped.preset.toLowerCase() : mapped.preset);
  return { request: { ...request, resolution, aspectRatio: mapped.ratio }, capability: { ...capability, values: [...new Set([...capability.values, resolution])] } };
}

export function imagePresetDimensions(preset: string, ratio: string, multipleOf = 16): string | undefined {
  if (!IMAGE_RESOLUTION_PRESETS.some(value => value === preset)) return undefined;
  const match = /^([1-9]\d{0,3}):([1-9]\d{0,3})$/.exec(ratio);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const wide = width / height === 16 / 9 || height / width === 16 / 9;
  const target = ({ '1K': wide ? 1280 : 1024, '2K': 2048, '4K': 3840 } as Record<string, number>)[preset]!;
  const edge = Math.max(multipleOf, Math.round(target / multipleOf) * multipleOf);
  const shorter = Math.max(multipleOf, Math.round(edge * Math.min(width, height) / Math.max(width, height) / multipleOf) * multipleOf);
  return width >= height ? `${edge}x${shorter}` : `${shorter}x${edge}`;
}

export function imageDimensionsPreset(value: string, multipleOf = 16): { preset: string; ratio: string } | undefined {
  for (const preset of IMAGE_RESOLUTION_PRESETS) {
    for (const ratio of RATIOS) {
      if (imagePresetDimensions(preset, ratio, multipleOf) === value) return { preset, ratio };
      // Existing saved sizes used 1024 pixels per K for every aspect ratio.
      const [width, height] = ratio.split(':').map(Number) as [number, number];
      const edge = Number(preset.slice(0, -1)) * 1024;
      const legacy = width >= height ? `${edge}x${Math.round(edge * height / width)}` : `${Math.round(edge * width / height)}x${edge}`;
      if (legacy === value) return { preset, ratio };
    }
  }
  return undefined;
}
