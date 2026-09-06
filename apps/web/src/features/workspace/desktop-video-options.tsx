import { useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, Clock3, ScanLine } from 'lucide-react';
import { applyModelParameters, type JsonObject, type ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { managedParameters } from './managed-parameters';

type VideoParameter = 'resolution' | 'durationSeconds';

function accepts(model: WorkspaceModel, rules: ModelParameter[] | undefined, path: VideoParameter, value: string | number): boolean {
  if (rules) {
    const rule = rules.find(rule => rule.path === path && rule.enabled && rule.visible);
    if (!rule || rule.locked) return false;
    try {
      applyModelParameters({ providerId: model.providerId, modelId: model.id, operation: 'video.generate', prompt: 'validate', inputs: [], [path]: value }, [rule]);
      return true;
    } catch { return false; }
  }
  if (path === 'resolution') return model.capabilities.resolutions.includes(String(value));
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  const range = model.capabilities.durationRange;
  return range ? value >= range.min && value <= range.max && Math.abs((value - range.min) / (range.step ?? 1) - Math.round((value - range.min) / (range.step ?? 1))) < 1e-8
    : model.capabilities.durations.includes(value);
}

interface VideoOptionProps {
  path: VideoParameter;
  icon: ReactNode;
  value: string | number | undefined;
  disabled: boolean;
  accepts: (value: string | number) => boolean;
  onChange: (value: string | number) => void;
}

function VideoOption({ path, icon, value, disabled, accepts, onChange }: VideoOptionProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const resolution = path === 'resolution';
  const label = resolution ? '视频分辨率' : '视频时长';
  const presets: Array<string | number> = resolution ? ['480p', '720p', '1080p'] : [6, 10, 15];
  const format = (value: string | number) => resolution ? String(value) : `${value}s`;
  const customSelected = value !== undefined && value !== '' && value !== 'auto' && !presets.includes(value);
  const commit = (value: string | number) => { onChange(value); setOpen(false); };
  const openCustom = () => { setCustom(true); setDraft(String(value ?? (resolution ? 480 : 6)).replace(/p$/, '')); setInvalid(false); };
  return <Popover.Root open={open} onOpenChange={value => { setOpen(value); setCustom(false); setInvalid(false); }}>
    <Popover.Trigger asChild><button type="button" className="option-trigger desktop-video-option" aria-label={`选择${label}`} title={label} disabled={disabled}>{icon}<span>{value === undefined || value === '' || value === 'auto' ? '自动' : format(value)}</span></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="options desktop-video-options" aria-label={label} sideOffset={10} collisionPadding={12}>
      <div className="option-heading">{label}</div>
      {presets.map(option => <button className={`choice ${value === option ? 'is-active' : ''}`} type="button" key={option} aria-pressed={value === option} disabled={!accepts(option)} title={!accepts(option) ? '当前模型不支持这个值' : undefined} onClick={() => commit(option)}><span>{format(option)}</span>{value === option && <Check size={14} />}</button>)}
      <button className={`choice ${custom || customSelected ? 'is-active' : ''}`} type="button" aria-pressed={custom || customSelected} onClick={openCustom}>自定义</button>
      {custom && <div className="desktop-video-custom">
        <label><span>{resolution ? '垂直分辨率 (px)' : '时长 (s)'}</span><input autoFocus aria-label={`自定义${label}`} type="number" min={1} step={resolution ? 1 : 'any'} value={draft} onChange={event => { setDraft(event.target.value); setInvalid(false); }} /></label>
        <button type="button" className="quiet-command" onClick={() => {
          const number = Number(draft);
          const value = resolution ? `${number}p` : number;
          if (!draft || !Number.isFinite(number) || number <= 0 || resolution && !Number.isInteger(number) || !accepts(value)) { setInvalid(true); return; }
          commit(value);
        }}>应用</button>
        {invalid && <p role="alert">{label}超出当前模型允许范围</p>}
      </div>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function DesktopVideoOptions({ model, resolution, duration, parameters, onResolution, onDuration, onParameters }: {
  model: WorkspaceModel | undefined;
  resolution: string;
  duration: number;
  parameters: JsonObject;
  onResolution: (value: string) => void;
  onDuration: (value: number) => void;
  onParameters: (values: JsonObject) => void;
}) {
  const rules = managedParameters(model);
  return <>{(['resolution', 'durationSeconds'] as const).map(path => {
    const rule = rules?.find(rule => rule.path === path && rule.enabled && rule.visible);
    const value = rules ? rule?.locked ? rule.defaultValue : parameters[path] ?? rule?.defaultValue : path === 'resolution' ? resolution : duration;
    const disabled = !model || (rules !== undefined ? !rule || rule.locked : path === 'resolution' ? !model.capabilities.resolutions.length : !model.capabilities.durations.length && !model.capabilities.durationRange);
    return <VideoOption key={path} path={path} icon={path === 'resolution' ? <ScanLine size={16} /> : <Clock3 size={16} />}
      value={typeof value === 'string' || typeof value === 'number' ? value : undefined} disabled={disabled}
      accepts={value => !!model && accepts(model, rules, path, value)}
      onChange={value => { if (rules) onParameters({ ...parameters, [path]: value }); else if (path === 'resolution') onResolution(String(value)); else onDuration(Number(value)); }} />;
  })}</>;
}
