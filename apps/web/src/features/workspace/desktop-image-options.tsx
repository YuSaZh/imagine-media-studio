import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Copy, ScanLine } from 'lucide-react';
import type { JsonObject } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { managedParameters } from './managed-parameters';
import { allowsCustomSize } from './generation-options';
import { acceptsImageOption, IMAGE_RESOLUTIONS, imageResolutionLabel, imageResolutionValue } from './image-options';
import { Choice, Options } from './ui';

export function DesktopImageOptions({ model, ratio, resolution, count, parameters, onResolution, onCount, onParameters }: {
  model: WorkspaceModel | undefined;
  ratio: string;
  resolution: string;
  count: number;
  parameters: JsonObject;
  onResolution: (value: string) => void;
  onCount: (value: number) => void;
  onParameters: (values: JsonObject) => void;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [width, setWidth] = useState('1024');
  const [height, setHeight] = useState('1024');
  const [invalid, setInvalid] = useState(false);
  const rules = managedParameters(model);
  const resolutionRule = rules?.find(rule => rule.path === 'resolution' && rule.enabled && rule.visible);
  const countRule = rules?.find(rule => rule.path === 'count' && rule.enabled && rule.visible);
  const selectedResolution = String(rules ? (resolutionRule?.locked ? resolutionRule.defaultValue : parameters.resolution ?? resolutionRule?.defaultValue) ?? '' : resolution);
  const selectedCount = Number(rules ? (countRule?.locked ? countRule.defaultValue : parameters.count ?? countRule?.defaultValue) ?? 1 : count);
  const resolutionDisabled = !model || (rules ? !resolutionRule || resolutionRule.locked : !model.capabilities.resolutions.length && !allowsCustomSize(model));
  const countDisabled = !model || !!rules && (!countRule || countRule.locked);
  const customAllowed = !!model && !resolutionDisabled && (rules ? resolutionRule?.type === 'text' || resolutionRule?.allowCustom === true : allowsCustomSize(model));
  const commitResolution = (value: string) => {
    if (rules) onParameters({ ...parameters, resolution: value }); else onResolution(value);
    setOpen(false);
  };
  return <>
    <Popover.Root open={open} onOpenChange={open => { setOpen(open); setCustom(false); setInvalid(false); }}>
      <Popover.Trigger asChild><button type="button" className="option-trigger desktop-image-option" aria-label="选择图片分辨率" title="图片分辨率" disabled={resolutionDisabled}><ScanLine size={16} /><span>{imageResolutionLabel(selectedResolution)}</span></button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="options desktop-image-options" aria-label="图片分辨率" sideOffset={10} collisionPadding={12}>
        <div className="option-heading">图片分辨率</div>
        {IMAGE_RESOLUTIONS.map(preset => {
          const value = model ? imageResolutionValue(model, rules, preset, ratio) : undefined;
          const active = imageResolutionLabel(selectedResolution) === preset;
          return <button key={preset} type="button" className={`choice ${active ? 'is-active' : ''}`} aria-pressed={active} disabled={!value} title={!value ? '当前模型不支持这个值' : undefined} onClick={() => value && commitResolution(value)}><span>{preset}</span>{active && <Check size={14} />}</button>;
        })}
        <button type="button" className={`choice ${custom || imageResolutionLabel(selectedResolution) === '自定义' ? 'is-active' : ''}`} aria-pressed={custom || imageResolutionLabel(selectedResolution) === '自定义'} disabled={!customAllowed} title={!customAllowed ? '当前模型不支持自定义尺寸' : undefined} onClick={() => {
          const size = /^([1-9]\d*)x([1-9]\d*)$/.exec(selectedResolution);
          setWidth(size?.[1] ?? '1024'); setHeight(size?.[2] ?? '1024'); setInvalid(false); setCustom(true);
        }}>自定义</button>
        {custom && <div className="desktop-image-custom">
          <div className="custom-dimensions"><label>宽度<input autoFocus aria-label="自定义图片宽度" type="number" min={1} max={16384} step={1} value={width} onChange={event => { setWidth(event.target.value); setInvalid(false); }} /></label><span>×</span><label>高度<input aria-label="自定义图片高度" type="number" min={1} max={16384} step={1} value={height} onChange={event => { setHeight(event.target.value); setInvalid(false); }} /></label></div>
          <button type="button" className="quiet-command" onClick={() => {
            const value = `${Number(width)}x${Number(height)}`;
            if (!model || !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(value) || !acceptsImageOption(model, rules, 'resolution', value)) { setInvalid(true); return; }
            commitResolution(value);
          }}>应用</button>
          {invalid && <p role="alert">图片尺寸超出当前模型允许范围</p>}
        </div>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    <Options label="选择图片生成数量" className="desktop-image-option" contentClassName="desktop-image-options" disabled={countDisabled} trigger={<><Copy size={16} /><span>×{selectedCount}</span></>}>
      <div className="option-heading">生成数量</div><div className="desktop-image-counts">{Array.from({ length: 32 }, (_, index) => index + 1).filter(value => model && acceptsImageOption(model, rules, 'count', value)).map(value => <Choice key={value} active={selectedCount === value} onClick={() => { if (rules) onParameters({ ...parameters, count: value }); else onCount(value); }}>×{value}</Choice>)}</div>
    </Options>
  </>;
}
