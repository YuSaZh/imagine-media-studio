import { inferImageResolution, type ImageResolutionCapability } from '@imagine/shared';

const GEMINI_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  'gemini-2.5-flash-image': ['1K'],
  'gemini-3.1-flash-lite-image': ['1K'],
  'gemini-3.1-flash-image': ['512', '1K', '2K', '4K'],
  'gemini-3-pro-image': ['1K', '2K', '4K'],
};

export function builtinImageResolution(modelId: string, profile?: string): ImageResolutionCapability | undefined {
  const canonical = modelId.replace(/^models\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-preview$/, '');
  if (profile === 'openai-images-v1' && canonical === 'gpt-image-2') return {
    mode: 'pixels', values: ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840'],
    allowCustomDimensions: true, dimensions: { multipleOf: 16, maxWidth: 3840, maxHeight: 3840, minPixels: 655360, maxPixels: 8294400, maxAspectRatio: 3 },
  };
  const values = GEMINI_DEFAULTS[canonical];
  if (values && ['openai-chat-image-v1', 'gemini-generate-content-image-v1', 'gemini-interactions-image-v1'].includes(profile ?? '')) {
    return { mode: 'native', values: ['auto', ...values], allowCustomDimensions: profile === 'openai-chat-image-v1' };
  }
  return undefined;
}

export function storedImageResolution(capabilities: { imageResolution?: unknown; resolutions?: unknown; customFields?: unknown; parameters?: unknown }, modelId: string, profile?: string): ImageResolutionCapability {
  if (capabilities.imageResolution !== undefined) return inferImageResolution(capabilities, profile);
  const inferred = inferImageResolution(capabilities, profile);
  const defaults = builtinImageResolution(modelId, profile);
  const hasResolutionRule = Array.isArray(capabilities.parameters) && capabilities.parameters.some(rule => rule && typeof rule === 'object' && rule.path === 'resolution' && rule.enabled !== false && Array.isArray(rule.options));
  // Defaults fill missing metadata; declared values and custom-size permissions remain authoritative.
  return { ...inferred, ...(defaults?.dimensions ? { dimensions: defaults.dimensions } : {}),
    ...(capabilities.resolutions === undefined && !hasResolutionRule && defaults ? { values: defaults.values } : {}) };
}
