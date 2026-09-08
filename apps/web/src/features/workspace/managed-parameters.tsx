import { Select, SelectItem } from './select';
import { ModelParametersSchema, type JsonObject, type ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';
import { AspectRatioSetting } from './aspect-ratio-options';
import { Fragment, type ReactNode } from 'react';

export function managedParameters(model: WorkspaceModel | undefined): ModelParameter[] | undefined {
  const parsed = ModelParametersSchema.safeParse(model?.raw.capabilities.parameters);
  return parsed.success ? parsed.data.filter(rule => rule.path !== 'count').map(rule => {
    if (rule.path !== 'aspectRatio') return rule;
    const options = [...new Set(['auto', ...(rule.options?.length ? rule.options : model?.capabilities.aspectRatios ?? []), rule.defaultValue]
      .filter((value): value is string => typeof value === 'string' && /^(auto|[1-9]\d*:[1-9]\d*)$/.test(value)))];
    return { ...rule, type: 'select' as const, allowCustom: false, options };
  }) : undefined;
}

export function ManagedParameters({ rules, values, onChange, resolutionControl }: { rules: ModelParameter[]; values: JsonObject; onChange: (values: JsonObject) => void; resolutionControl?: ReactNode }) {
  const set = (rule: ModelParameter, value: string | number | boolean | undefined) => { const next = { ...values }; if (value === undefined) delete next[rule.path]; else next[rule.path] = value; onChange(next); };
  return <>{rules.filter(rule => rule.enabled && rule.visible).map(rule => {
    if (rule.path === 'resolution' && resolutionControl) return <Fragment key={rule.path}>{resolutionControl}</Fragment>;
    const options = ['aspectRatio', 'resolution'].includes(rule.path) ? ['auto', ...rule.options?.filter(option => option !== 'auto') ?? []] : rule.options;
    const value = rule.locked ? rule.defaultValue : values[rule.path] ?? rule.defaultValue;
    if (rule.path === 'aspectRatio') return <AspectRatioSetting key={rule.path} label={rule.label} options={options?.map(String) ?? []} value={String(value ?? 'auto')} disabled={rule.locked} onChange={value => set(rule, value)} />;
    return <label className="setting-line" key={rule.path}><span>{rule.label}{rule.required ? ' *' : ''}</span>{rule.type === 'boolean' ? <Select aria-label={rule.label} disabled={rule.locked} value={value === undefined ? '' : String(value)} onChange={event => set(rule, event.target.value === '' ? undefined : event.target.value === 'true')}><SelectItem value="">默认</SelectItem><SelectItem value="true">开启</SelectItem><SelectItem value="false">关闭</SelectItem></Select> : rule.type === 'select' && !rule.allowCustom ? <Select aria-label={rule.label} disabled={rule.locked} value={value === undefined ? '' : String(value)} onChange={event => set(rule, options?.find(option => String(option) === event.target.value))}><SelectItem value="">默认</SelectItem>{options?.map(option => <SelectItem key={String(option)} value={String(option)}>{String(option)}</SelectItem>)}</Select> : <input aria-label={rule.label} disabled={rule.locked} type={rule.type === 'number' ? 'number' : 'text'} min={rule.min} max={rule.max} step={rule.step ?? 'any'} value={typeof value === 'number' || typeof value === 'string' ? value : ''} placeholder="默认" onChange={event => set(rule, event.target.value === '' ? undefined : rule.type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>;
  })}</>;
}
