import { inferImageResolution, type ImageDimensionConstraints, type ImageResolutionCapability, type JsonObject } from '@imagine/shared';
import { Select, SelectItem } from './select';
import { useEffect, useState } from 'react';

export function ImageResolutionPolicyEditor({ capabilities, onChange }: { capabilities: JsonObject; onChange: (value: Record<string, unknown>) => void }) {
  const legacy = { ...capabilities };
  delete legacy.imageResolution;
  const fallback = inferImageResolution(legacy, typeof capabilities.profile === 'string' ? capabilities.profile : undefined);
  const raw = capabilities.imageResolution;
  const configured = !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const record = configured ? raw as JsonObject : {};
  const dimensions = record.dimensions && typeof record.dimensions === 'object' && !Array.isArray(record.dimensions) ? record.dimensions as ImageDimensionConstraints : {};
  const policy: ImageResolutionCapability = configured ? {
    mode: record.mode === 'native' ? 'native' : 'pixels',
    values: Array.isArray(record.values) ? record.values.filter((value): value is string => typeof value === 'string') : [],
    allowCustomDimensions: record.allowCustomDimensions === true,
    dimensions,
  } : fallback;
  const serializedValues = policy.values.join(', ');
  const [valuesDraft, setValuesDraft] = useState(serializedValues);
  useEffect(() => setValuesDraft(serializedValues), [serializedValues]);
  const update = (next: ImageResolutionCapability) => onChange({ ...capabilities, imageResolution: next, resolutions: next.values });
  const fields: Array<{ key: keyof ImageDimensionConstraints; label: string }> = [
    { key: 'multipleOf', label: '边长对齐倍数' }, { key: 'minWidth', label: '最小宽度' }, { key: 'minHeight', label: '最小高度' }, { key: 'maxWidth', label: '最大宽度' }, { key: 'maxHeight', label: '最大高度' },
    { key: 'minPixels', label: '最小总像素' }, { key: 'maxPixels', label: '最大总像素' }, { key: 'maxAspectRatio', label: '最大长短边比例' },
  ];
  return <fieldset className="parameter-editor"><legend>分辨率能力</legend>
      <div className="form-columns">
        <label><span>分辨率参数类型</span><Select aria-label="分辨率参数类型" value={policy.mode} onChange={event => update({ ...policy, mode: event.target.value as ImageResolutionCapability['mode'] })}><SelectItem value="native">原生档位</SelectItem><SelectItem value="pixels">像素尺寸</SelectItem></Select></label>
        <label><span>分辨率允许值（逗号分隔）</span><input aria-label="分辨率允许值" value={valuesDraft} onChange={event => setValuesDraft(event.target.value)} onBlur={() => update({ ...policy, values: valuesDraft.split(/[,，]/).map(value => value.trim()).filter(Boolean) })} /></label>
      </div>
      <label className="check-line"><input type="checkbox" checked={policy.allowCustomDimensions} onChange={event => update({ ...policy, allowCustomDimensions: event.target.checked })} />允许自定义像素尺寸</label>
      <div className="form-columns">{fields.map(({ key, label }) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min={1} step={key === 'maxAspectRatio' ? 'any' : 1} value={dimensions[key] ?? ''} onChange={event => {
        const next = { ...dimensions };
        if (event.target.value === '') delete next[key]; else next[key] = Number(event.target.value);
        update({ ...policy, dimensions: next });
      }} /></label>)}</div>
  </fieldset>;
}
