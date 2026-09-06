import { applyModelParameters, type ModelParameter } from '@imagine/shared';
import { dimensionsForAspectRatio } from '../gallery/model/aspect-ratio';
import type { WorkspaceModel } from './data';
import { allowsCustomSize } from './generation-options';

export const IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;

export function imageResolutionLabel(value: string): string {
  if (!value || value === 'auto') return '自动';
  if (IMAGE_RESOLUTIONS.some(preset => preset === value.toUpperCase())) return value.toUpperCase();
  const size = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  const edge = size ? Math.max(Number(size[1]), Number(size[2])) : 0;
  return [1024, 2048, 4096].includes(edge) ? `${edge / 1024}K` : '自定义';
}

export function acceptsImageOption(model: WorkspaceModel, rules: ModelParameter[] | undefined, path: 'count' | 'resolution', value: number | string): boolean {
  if (path === 'count' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32)) return false;
  const dimensions = typeof value === 'string' ? /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(value) : null;
  if (dimensions && (Number(dimensions[1]) > 16384 || Number(dimensions[2]) > 16384 || Number(dimensions[1]) * Number(dimensions[2]) > 100_000_000)) return false;
  if (rules) {
    const rule = rules.find(rule => rule.path === path && rule.enabled && rule.visible);
    if (!rule || rule.locked) return false;
    try {
      applyModelParameters({ providerId: model.providerId, modelId: model.id, operation: 'image.generate', prompt: 'validate', inputs: [], [path]: value }, [rule]);
      return true;
    } catch { return false; }
  }
  // The workspace splits image batches into separate jobs when needed.
  return path === 'count' || model.capabilities.resolutions.includes(String(value)) || allowsCustomSize(model) && dimensions !== null;
}

export function imageResolutionValue(model: WorkspaceModel, rules: ModelParameter[] | undefined, preset: string, ratio: string): string | undefined {
  const rule = rules?.find(rule => rule.path === 'resolution');
  const options = rules ? rule?.options?.map(String) ?? [] : model.capabilities.resolutions;
  const native = options.find(value => value.toUpperCase() === preset);
  if (native && acceptsImageOption(model, rules, 'resolution', native)) return native;
  const { width, height } = dimensionsForAspectRatio(ratio, Number(preset.slice(0, -1)) * 1024);
  const pixels = `${width}x${height}`;
  if (acceptsImageOption(model, rules, 'resolution', pixels)) return pixels;
  return undefined;
}
