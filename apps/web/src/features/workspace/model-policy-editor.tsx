import { matchModelProtocol, MODEL_PROTOCOLS, MediaOperationSchema, ModelParametersSchema, PARAMETER_KEYS, providerFamily, type ModelParameter, type JsonObject } from '@imagine/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Tool } from './ui';

const numericPaths = new Set(['width', 'height', 'count', 'durationSeconds', 'fps', 'seed']);

export function parameterPresets(capabilities: JsonObject, providerType = '', modelId = ''): ModelParameter[] {
  const rules: Array<Record<string, unknown>> = [];
  const list = (path: string, label: string, options: unknown) => { if (Array.isArray(options) && options.length) rules.push({ path, label, type: 'select', options }); };
  list('aspectRatio', '画幅', capabilities.aspectRatios);
  list('resolution', '分辨率', capabilities.resolutions);
  list('durationSeconds', '视频时长', capabilities.durations);
  if (capabilities.durations && !Array.isArray(capabilities.durations) && typeof capabilities.durations === 'object') rules.push({ path: 'durationSeconds', label: '视频时长', type: 'number', ...capabilities.durations });
  if (capabilities.supportsBatchCount) rules.push({ path: 'count', label: '生成数量', type: 'number', min: 1, max: capabilities.maxBatchCount ?? 1, step: 1 });
  for (const [capability, path, label, type] of [['supportsSeed', 'seed', '种子', 'number'], ['supportsNegativePrompt', 'negativePrompt', '负面提示词', 'text'], ['supportsAudio', 'audio', '生成音频', 'boolean']]) if (capabilities[capability!]) rules.push({ path, label, type });
  const custom = capabilities.customFields;
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    const properties = (custom as JsonObject).properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) for (const [key, value] of Object.entries(properties)) {
      const field = value as JsonObject;
      if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
      if (key === 'size' || 'const' in field) continue;
      const path = providerFamily(String(capabilities.profile ?? matchModelProtocol(modelId) ?? providerType)) === 'xai' && ['quality', 'audio'].includes(key) ? key : `extra.${key}`;
      if (rules.some(rule => rule.path === path)) continue;
      rules.push({ path, label: typeof field.title === 'string' ? field.title : key, type: Array.isArray(field.enum) ? 'select' : field.type === 'boolean' ? 'boolean' : ['integer', 'number'].includes(String(field.type)) ? 'number' : 'text', ...(Array.isArray(field.enum) ? { options: field.enum } : {}), ...(typeof field.minimum === 'number' ? { min: field.minimum } : {}), ...(typeof field.maximum === 'number' ? { max: field.maximum } : {}) });
    }
  }
  return ModelParametersSchema.parse(rules);
}

export function ModelPolicyEditor({ value, onChange, providerType, modelId = '' }: { value: string; onChange: (value: string) => void; providerType: string; modelId?: string }) {
  let capabilities: JsonObject;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid capabilities');
    capabilities = parsed as JsonObject;
    if (Array.isArray(capabilities.parameters) && capabilities.parameters.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule) || typeof (rule as JsonObject).path !== 'string' || typeof (rule as JsonObject).label !== 'string' || (typeof (rule as JsonObject).options !== 'undefined' && !Array.isArray((rule as JsonObject).options)))) throw new Error('Invalid parameters');
  } catch { return <label>模型能力 JSON<textarea aria-label="模型能力 JSON" value={value} onChange={event => onChange(event.target.value)} /></label>; }
  const rules = Array.isArray(capabilities.parameters) ? capabilities.parameters as unknown as ModelParameter[] : undefined;
  const update = (next: Record<string, unknown>) => onChange(JSON.stringify(next, null, 2));
  const setRules = (next: ModelParameter[]) => update({ ...capabilities, parameters: next });
  const changeRule = (index: number, next: Partial<ModelParameter>) => setRules((rules ?? []).map((rule, i) => i === index ? { ...rule, ...next } : rule));
  const family = providerFamily(providerType);
  const matched = MODEL_PROTOCOLS.find(profile => profile.value === matchModelProtocol(modelId));
  const operations = Array.isArray(capabilities.operations) ? capabilities.operations as string[] : [];
  return <div className="model-policy-editor">
    {family && <label><span>模型调用协议</span><select aria-label="模型调用协议" value={typeof capabilities.profile === 'string' ? capabilities.profile : ''} onChange={event => { const next = { ...capabilities }; if (event.target.value) next.profile = event.target.value; else delete next.profile; update(next); }}><option value="">{matched ? `自动匹配（${{ openai: "OpenAI", xai: "xAI", gemini: "Gemini" }[matched.family]} · ${matched.label}）` : `提供商默认（${{ openai: "OpenAI", xai: "xAI", gemini: "Gemini" }[family]}）`}</option>{[...MODEL_PROTOCOLS].sort((a, b) => Number(b.family === family) - Number(a.family === family)).map(profile => <option key={profile.value} value={profile.value}>{{ openai: 'OpenAI', xai: 'xAI', gemini: 'Gemini' }[profile.family]} · {profile.label}{profile.family === family ? '（默认接口）' : ''}</option>)}</select></label>}
    <fieldset className="capability-operations"><legend>支持的操作</legend>{MediaOperationSchema.options.map(operation => <label className="check-line" key={operation}><input type="checkbox" checked={operations.includes(operation)} onChange={event => update({ ...capabilities, operations: event.target.checked ? [...operations, operation] : operations.filter(item => item !== operation) })} />{({ 'image.generate': '文生图', 'image.edit': '图片编辑', 'video.generate': '文生视频', 'video.image_to_video': '首帧视频', 'video.reference_to_video': '参考图视频', 'video.edit': '视频编辑', 'video.extend': '视频续写' })[operation]}</label>)}</fieldset>
    <div className="form-columns"><label><span>最大参考图数量</span><input aria-label="最大参考图数量" type="number" min={0} value={Number(capabilities.maxReferenceImages ?? 0)} onChange={event => update({ ...capabilities, maxReferenceImages: Number(event.target.value) })} /></label><label className="check-line"><input type="checkbox" checked={capabilities.supportsMask === true} onChange={event => update({ ...capabilities, supportsMask: event.target.checked })} />支持蒙版</label></div>
    <div className="parameter-heading"><h3>生成参数</h3><button type="button" className="quiet-command" onClick={() => setRules(parameterPresets(capabilities, providerType, modelId))}>从模型能力载入</button></div>
    <label className="check-line"><input type="checkbox" checked={rules !== undefined} onChange={event => { const next: Record<string, unknown> = { ...capabilities }; if (event.target.checked) next.parameters = parameterPresets(capabilities, providerType, modelId); else delete next.parameters; update(next); }} />使用自定义参数规则</label>
    {rules?.map((rule, index) => <fieldset className="parameter-editor" key={index}><legend>{rule.label || `参数 ${index + 1}`}</legend><div className="form-columns"><label><span>参数路径</span><input aria-label={`参数路径 ${index + 1}`} list="model-parameter-paths" value={rule.path} onChange={event => changeRule(index, { path: event.target.value })} /></label><label><span>显示名称</span><input aria-label={`参数名称 ${index + 1}`} value={rule.label} onChange={event => changeRule(index, { label: event.target.value })} /></label><label><span>控件类型</span><select value={rule.type} onChange={event => { const next = { ...rule, type: event.target.value as ModelParameter['type'] }; delete next.defaultValue; if (next.type === 'select') next.options = ['']; setRules(rules.map((item, i) => i === index ? next : item)); }}><option value="text">文本</option><option value="select">选项</option><option value="number">数值</option><option value="boolean">开关</option></select></label><label><span>默认值</span>{rule.type === 'boolean' ? <select value={rule.defaultValue === undefined ? '' : String(rule.defaultValue)} onChange={event => { const next = { ...rule }; if (event.target.value === '') delete next.defaultValue; else next.defaultValue = event.target.value === 'true'; setRules(rules.map((item, i) => i === index ? next : item)); }}><option value="">不发送</option><option value="true">开启</option><option value="false">关闭</option></select> : <input aria-label={`参数默认值 ${index + 1}`} type={rule.type === 'number' ? 'number' : 'text'} placeholder="不发送" value={String(rule.defaultValue ?? '')} onChange={event => { const next = { ...rule }; if (!event.target.value) delete next.defaultValue; else next.defaultValue = rule.type === 'number' || numericPaths.has(rule.path) || typeof rule.options?.[0] === 'number' ? Number(event.target.value) : event.target.value; setRules(rules.map((item, i) => i === index ? next : item)); }} />}</label></div>
      {rule.type === 'select' && <label><span>可选值（逗号分隔）</span><input value={rule.options?.join(', ') ?? ''} onChange={event => changeRule(index, { options: event.target.value.split(/[,，]/).map(item => numericPaths.has(rule.path) || typeof rule.options?.[0] === 'number' ? Number(item.trim()) : item.trim()) })} /></label>}
      {rule.type === 'number' && <div className="form-columns">{(['min', 'max', 'step'] as const).map(key => <label key={key}><span>{{ min: '最小值', max: '最大值', step: '步长' }[key]}</span><input type="number" value={rule[key] ?? ''} onChange={event => { const next = { ...rule }; if (event.target.value === '') delete next[key]; else next[key] = Number(event.target.value); setRules(rules.map((item, i) => i === index ? next : item)); }} /></label>)}</div>}
      <div className="parameter-flags">{(['enabled', 'visible', 'required', 'locked', ...(rule.type === 'select' ? ['allowCustom' as const] : [])] as const).map(key => <label className="check-line" key={key}><input type="checkbox" checked={rule[key]} onChange={event => changeRule(index, { [key]: event.target.checked })} />{{ enabled: '启用', visible: '用户可见', required: '必填', locked: '固定默认值', allowCustom: '允许自定义' }[key]}</label>)}<Tool label={`删除参数 ${index + 1}`} onClick={() => setRules(rules.filter((_, i) => i !== index))}><Trash2 size={16} /></Tool></div>
    </fieldset>)}
    {rules && <button type="button" className="quiet-command" onClick={() => setRules([...rules, { path: 'quality', label: '质量', type: 'text', enabled: true, visible: true, required: false, locked: false, allowCustom: false }])}><Plus size={16} />添加参数</button>}
    <datalist id="model-parameter-paths">{PARAMETER_KEYS.map(key => <option value={key} key={key} />)}</datalist>
    <details className="form-advanced"><summary>高级能力 JSON</summary><textarea aria-label="模型能力 JSON" className="code-input" rows={10} value={value} onChange={event => onChange(event.target.value)} /></details>
  </div>;
}
