import { applyModelParameters, imageDimensionsPreset, imagePresetDimensions, imageResolutionAllows, inferImageResolution, type ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';

export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;

export function imageResolutionLabel(value: string): string {
  if (!value || value === 'auto') return '自动';
  if (IMAGE_RESOLUTIONS.some(preset => preset === value.toUpperCase())) return value.toUpperCase();
  const mapped = imageDimensionsPreset(value);
  if (mapped) return mapped.preset;
  const size = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!size) return value;
  const edge = size ? Math.max(Number(size[1]), Number(size[2])) : 0;
  return edge === 3840 ? '4K' : [1024, 2048, 4096].includes(edge) ? `${edge / 1024}K` : '自定义';
}

export function acceptsImageOption(model: WorkspaceModel, rules: ModelParameter[] | undefined, path: 'count' | 'resolution', value: number | string): boolean {
  if (path === 'count') return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 32;
  if (typeof value !== 'string') return false;
  const capability = model.imageResolution ?? inferImageResolution(model.raw.capabilities, model.imageProfile);
  if (!imageResolutionAllows(value, capability)) return false;
  if (rules) {
    const rule = rules.find(rule => rule.path === path && rule.enabled && rule.visible);
    if (!rule || rule.locked) return false;
    try {
      applyModelParameters({ providerId: model.providerId, modelId: model.id, operation: 'image.generate', prompt: 'validate', inputs: [], [path]: value }, [rule]);
      return true;
    } catch { return false; }
  }
  // The workspace splits image batches into separate jobs when needed.
  return true;
}

export function imageResolutionValue(model: WorkspaceModel, rules: ModelParameter[] | undefined, preset: string, ratio: string): string | undefined {
  const rule = rules?.find(rule => rule.path === 'resolution');
  const capability = model.imageResolution ?? inferImageResolution(model.raw.capabilities, model.imageProfile);
  const options = [...(rules ? rule?.options?.map(String) ?? [] : []), ...model.capabilities.resolutions];
  const native = capability.mode !== 'native' ? undefined : options.find(value => value.toUpperCase() === preset.toUpperCase() && acceptsImageOption(model, rules, 'resolution', value));
  if (native) return native;
  const pixels = imagePresetDimensions(preset, ratio, capability.dimensions?.multipleOf);
  if (pixels && acceptsImageOption(model, rules, 'resolution', pixels)) return pixels;
  return undefined;
}

export function imagePresetRatioChoices(model: WorkspaceModel, rules: ModelParameter[] | undefined, preset: string): Array<{ ratio: string; resolution: string }> {
  if (imageResolutionValue(model, rules, preset, 'auto')) return [];
  const ratioRule = rules?.find(rule => rule.path === 'aspectRatio');
  if (rules && (!ratioRule?.enabled || !ratioRule.visible || ratioRule.locked)) return [];
  const ratios = rules ? ratioRule?.options?.map(String) ?? [] : model.capabilities.aspectRatios;
  return ratios.flatMap(ratio => {
    if (ratio === 'auto') return [];
    const resolution = imageResolutionValue(model, rules, preset, ratio);
    return resolution ? [{ ratio, resolution }] : [];
  });
}
