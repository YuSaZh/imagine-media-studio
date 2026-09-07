import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import type { ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { allowsCustomSize } from './generation-options';
import { acceptsImageOption, IMAGE_RESOLUTIONS, imageResolutionLabel, imageResolutionValue } from './image-options';
import { CustomDimensions } from './custom-dimensions';

interface ResolutionProps {
  model: WorkspaceModel | undefined;
  rules?: ModelParameter[] | undefined;
  value: string;
  ratio: string;
  onChange: (value: string) => void;
  onUnlock: () => void;
}

export function ImageResolutionPicker({ model, rules, value, ratio, onChange, onUnlock, label = '分辨率', trigger, className = '' }: ResolutionProps & { label?: string; trigger?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const rule = rules?.find(rule => rule.path === 'resolution');
  const fixedRatio = rules?.some(rule => rule.path === 'aspectRatio' && rule.enabled && rule.locked && rule.defaultValue !== 'auto') ?? false;
  const disabled = !model || (rules ? !rule?.enabled || !rule.visible || rule.locked : !model.capabilities.resolutions.length && !allowsCustomSize(model));
  const customAllowed = !!model && !disabled && (rules ? rule?.type === 'text' || rule?.allowCustom === true : allowsCustomSize(model));
  const selected = imageResolutionLabel(value);
  const commit = (value: string) => { onChange(value); setOpen(false); };
  return <Popover.Root open={open} onOpenChange={open => { setOpen(open); setCustom(false); }}>
    <Popover.Trigger asChild><button type="button" className={`option-trigger ${className}`} aria-label={label} disabled={disabled}>{trigger ?? <span>{selected}</span>}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="options image-resolution-options" aria-label="图片分辨率" sideOffset={10} collisionPadding={12}>
      <div className="option-heading">图片分辨率</div>
      {['auto', ...IMAGE_RESOLUTIONS].map(preset => {
        const next = preset === 'auto' ? 'auto' : model ? imageResolutionValue(model, rules, preset, ratio) : undefined;
        const active = preset === 'auto' ? !value || value === 'auto' : selected === preset;
        return <button key={preset} type="button" className={`choice ${active && !custom ? 'is-active' : ''}`} aria-pressed={active && !custom} disabled={!next} onClick={() => next && commit(next)}><span>{preset}</span>{active && !custom && <Check size={15} />}</button>;
      })}
      <button type="button" className={`choice ${custom || selected === '自定义' ? 'is-active' : ''}`} aria-pressed={custom || selected === '自定义'} disabled={!customAllowed} onClick={() => setCustom(true)}>自定义</button>
      {custom && <CustomDimensions value={value} ratio={ratio} accepts={value => !!model && acceptsImageOption(model, rules, 'resolution', value)} onApply={commit} onUnlock={onUnlock} unlockDisabled={fixedRatio} />}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function ImageResolutionSetting(props: ResolutionProps) {
  const rule = props.rules?.find(rule => rule.path === 'resolution');
  if (props.rules ? !rule?.enabled || !rule.visible : !props.model?.capabilities.resolutions.length && !allowsCustomSize(props.model)) return null;
  return <div className="setting-line"><span>{rule?.label ?? '分辨率'}</span><ImageResolutionPicker {...props} label={rule?.label ?? '分辨率'} /></div>;
}
