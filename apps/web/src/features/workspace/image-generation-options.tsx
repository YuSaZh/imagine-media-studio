import { Copy, ScanLine } from 'lucide-react';
import type { JsonObject } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { managedParameters } from './managed-parameters';
import { imageResolutionLabel } from './image-options';
import { ImageResolutionPicker } from './image-resolution-setting';
import { GenerationCount } from './generation-count';

export function ImageGenerationOptions({ model, ratio, resolution, count, parameters, onResolution, onCount, onParameters, onUnlock }: {
  model: WorkspaceModel | undefined;
  ratio: string;
  resolution: string;
  count: number;
  parameters: JsonObject;
  onResolution: (value: string) => void;
  onCount: (value: number) => void;
  onParameters: (values: JsonObject) => void;
  onUnlock: () => void;
}) {
  const rules = managedParameters(model);
  const rule = rules?.find(rule => rule.path === 'resolution');
  const selected = String(rules ? (rule?.locked ? rule.defaultValue : parameters.resolution ?? rule?.defaultValue) ?? '' : resolution);
  return <>
    <ImageResolutionPicker model={model} rules={rules} value={selected} ratio={ratio} onChange={value => { if (rules) onParameters({ ...parameters, resolution: value }); else onResolution(value); }} onUnlock={onUnlock} label="选择图片分辨率" className="desktop-image-option" trigger={<><ScanLine size={16} /><span>{imageResolutionLabel(selected)}</span></>} />
    <GenerationCount value={count} onChange={onCount} className="desktop-image-option" trigger={<><Copy size={16} /><span>×{count}</span></>} />
  </>;
}
