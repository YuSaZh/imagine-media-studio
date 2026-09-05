import { ModelParametersSchema, type JsonObject, type ModelParameter } from '@imagine/shared';
import type { WorkspaceModel } from './data';

export function managedParameters(model: WorkspaceModel | undefined): ModelParameter[] | undefined {
  const parsed = ModelParametersSchema.safeParse(model?.raw.capabilities.parameters);
  return parsed.success ? parsed.data : undefined;
}

export function ManagedParameters({ rules, values, onChange }: { rules: ModelParameter[]; values: JsonObject; onChange: (values: JsonObject) => void }) {
  const set = (rule: ModelParameter, value: string | number | boolean | undefined) => { const next = { ...values }; if (value === undefined) delete next[rule.path]; else next[rule.path] = value; onChange(next); };
  return <>{rules.filter(rule => rule.enabled && rule.visible).map(rule => {
    const value = rule.locked ? rule.defaultValue : values[rule.path] ?? rule.defaultValue;
    return <label className="setting-line" key={rule.path}><span>{rule.label}{rule.required ? ' *' : ''}</span>{rule.type === 'boolean' ? <select aria-label={rule.label} disabled={rule.locked} value={value === undefined ? '' : String(value)} onChange={event => set(rule, event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">默认</option><option value="true">开启</option><option value="false">关闭</option></select> : rule.type === 'select' && !rule.allowCustom ? <select aria-label={rule.label} disabled={rule.locked} value={value === undefined ? '' : String(value)} onChange={event => set(rule, rule.options?.find(option => String(option) === event.target.value))}><option value="">默认</option>{rule.options?.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : <input aria-label={rule.label} disabled={rule.locked} type={rule.type === 'number' ? 'number' : 'text'} min={rule.min} max={rule.max} step={rule.step ?? 'any'} value={typeof value === 'number' || typeof value === 'string' ? value : ''} placeholder="默认" onChange={event => set(rule, event.target.value === '' ? undefined : rule.type === 'number' ? Number(event.target.value) : event.target.value)} />}</label>;
  })}</>;
}
