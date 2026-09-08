import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import type { ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { allowsCustomSize } from './generation-options';
import { acceptsImageOption, IMAGE_RESOLUTIONS, imageResolutionLabel, imageResolutionValue, imagePresetRatioChoices } from './image-options';
import { CustomDimensions } from './custom-dimensions';
import { AspectRatioChoices } from './aspect-ratio-options';
import { SettingValue } from './ui';

interface ResolutionProps {
  model: WorkspaceModel | undefined;
  rules?: ModelParameter[] | undefined;
  value: string;
  ratio: string;
  onChange: (value: string, ratio?: string) => void;
  onUnlock: () => void;
}

export function ImageResolutionPicker({ model, rules, value, ratio, onChange, onUnlock, label = '分辨率', trigger, className = '' }: ResolutionProps & { label?: string; trigger?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [pendingPreset, setPendingPreset] = useState('');
  const rule = rules?.find(rule => rule.path === 'resolution');
  const fixedRatio = rules?.some(rule => rule.path === 'aspectRatio' && rule.enabled && rule.locked && rule.defaultValue !== 'auto') ?? false;
  const disabled = !model || (rules ? !rule?.enabled || !rule.visible || rule.locked : !model.capabilities.resolutions.length && !allowsCustomSize(model));
  const customAllowed = !!model && !disabled && allowsCustomSize(model) && (!rules || rule?.type === 'text' || rule?.allowCustom === true);
  const selected = imageResolutionLabel(value);
  const commit = (value: string, selectedRatio?: string) => { onChange(value, selectedRatio); setOpen(false); setPendingPreset(''); };
  const pendingChoices = model ? imagePresetRatioChoices(model, rules, pendingPreset) : [];
  return <Popover.Root open={open} onOpenChange={open => { setOpen(open); setCustom(false); setPendingPreset(''); }}>
    <Popover.Trigger asChild><button type="button" className={`option-trigger ${className}`} aria-label={label} disabled={disabled}>{trigger ?? <span>{selected}</span>}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="options image-resolution-options" aria-label="图片分辨率" sideOffset={10} collisionPadding={12}>
      <div className="option-heading">{pendingPreset ? `${pendingPreset} · 画幅` : '图片分辨率'}</div>
      {pendingPreset ? <AspectRatioChoices options={pendingChoices.map(choice => choice.ratio)} value="" onChange={ratio => { const choice = pendingChoices.find(choice => choice.ratio === ratio); if (choice) commit(choice.resolution, choice.ratio); }} /> : <>
      {[...new Set(['auto', ...IMAGE_RESOLUTIONS, ...(model?.imageResolution?.mode === 'native' ? model.imageResolution.values.filter(value => !/^\d+x\d+$/.test(value)).map(value => /^\d+k$/i.test(value) ? value.toUpperCase() : value) : [])])].map(preset => {
        const next = preset === 'auto' ? 'auto' : model ? imageResolutionValue(model, rules, preset, ratio) : undefined;
        const active = preset === 'auto' ? !value || value === 'auto' : selected === preset;
        const canChooseRatio = !next && model && (!ratio || ratio === 'auto') && imagePresetRatioChoices(model, rules, preset).length > 0;
        return <button key={preset} type="button" className={`choice ${active && !custom ? 'is-active' : ''}`} aria-pressed={active && !custom} disabled={!next && !canChooseRatio} onClick={() => { if (next) commit(next); else if (canChooseRatio) setPendingPreset(preset); }}><span>{preset}</span>{active && !custom && <Check size={15} />}</button>;
      })}
      <button type="button" className={`choice ${custom || selected === '自定义' ? 'is-active' : ''}`} aria-pressed={custom || selected === '自定义'} disabled={!customAllowed} onClick={() => setCustom(true)}>自定义</button>
      {custom && <CustomDimensions value={value} ratio={ratio} constraints={model?.imageResolution?.dimensions} accepts={value => !!model && acceptsImageOption(model, rules, 'resolution', value)} onApply={commit} onUnlock={onUnlock} unlockDisabled={fixedRatio} />}
      </>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function ImageResolutionSetting(props: ResolutionProps) {
  const rule = props.rules?.find(rule => rule.path === 'resolution');
  if (props.rules ? !rule?.enabled || !rule.visible : !props.model?.capabilities.resolutions.length && !allowsCustomSize(props.model)) return null;
  return <div className="setting-line"><span>{rule?.label ?? '分辨率'}</span><ImageResolutionPicker {...props} label={rule?.label ?? '分辨率'} trigger={<SettingValue>{imageResolutionLabel(props.value)}</SettingValue>} /></div>;
}
