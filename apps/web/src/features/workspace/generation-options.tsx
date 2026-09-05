import type { JsonObject, JsonValue } from '@imagine/shared';
import type { WorkspaceModel } from './data';

function object(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
export function parameterFields(model: WorkspaceModel | undefined): JsonObject {
  return object(object(model?.raw.capabilities.customFields).properties);
}
export function allowsCustomSize(model: WorkspaceModel | undefined): boolean {
  return object(parameterFields(model).size).type === 'string';
}
const labels: Record<string, string> = { quality: '质量', output_format: '输出格式', output_compression: '压缩质量', background: '背景', input_fidelity: '输入保真度', moderation: '内容审核', stream: '流式返回', partial_images: '中间预览数量' };

export function ExtraParameters({ model, values, onChange }: { model: WorkspaceModel | undefined; values: JsonObject; onChange: (values: JsonObject) => void }) {
  const set = (key: string, value: JsonValue | undefined) => { const next = { ...values }; if (value === undefined) delete next[key]; else next[key] = value; onChange(next); };
  return <>{Object.entries(parameterFields(model)).filter(([key]) => key !== 'size').map(([key, value]) => {
    const field = object(value);
    const options = Array.isArray(field.enum) ? field.enum.filter(item => ['string', 'number', 'boolean'].includes(typeof item)) : null;
    const label = typeof field.title === 'string' ? field.title : labels[key] ?? key;
    return <label className="setting-line" key={key}><span>{label}</span>{options ? <select aria-label={label} value={values[key] === undefined ? '' : String(values[key])} onChange={event => set(key, options.find(item => String(item) === event.target.value))}><option value="">默认</option>{options.map(item => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select> : field.type === 'boolean' ? <input type="checkbox" aria-label={label} checked={values[key] === true} onChange={event => set(key, event.target.checked || undefined)} /> : <input aria-label={label} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} min={typeof field.minimum === 'number' ? field.minimum : undefined} max={typeof field.maximum === 'number' ? field.maximum : undefined} step={field.type === 'integer' ? 1 : 'any'} value={typeof values[key] === 'string' || typeof values[key] === 'number' ? values[key] : ''} placeholder="默认" onChange={event => set(key, event.target.value === '' ? undefined : field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value)} />}</label>;
  })}</>;
}
