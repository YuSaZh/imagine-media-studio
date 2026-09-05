import { useState } from 'react';
import type { ModelDto, ProviderDto } from '@imagine/shared';
import { internalClient } from '../../api/internal-client';
import { buildManualModelWriteInput, buildProviderWriteInput, modelToForm, providerToForm, PROVIDER_PROFILE_OPTIONS, type ProviderFormState } from '../settings/model/provider-form';
import { Panel } from './ui';

export function ProviderApiKeyField({ hasStoredKey, onChange, value }: { hasStoredKey: boolean; onChange: (value: string) => void; value: string }) {
  return <label><span>API Key</span><input aria-label="API Key" autoComplete="new-password" type="password" value={value} onChange={event => onChange(event.target.value)} placeholder={hasStoredKey ? '留空保留已存储的密钥' : '输入 API Key'} /></label>;
}

export function ManualModelCapabilityField({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  return <label><span>模型能力 JSON</span><textarea aria-label="模型能力 JSON" className="code-input" rows={12} spellCheck={false} value={value} onChange={event => onChange(event.target.value)} /></label>;
}

export function ProviderEditor({ provider, onClose, onSaved }: { provider: ProviderDto | null; onClose: () => void; onSaved: (provider: ProviderDto) => void }) {
  const [form, setForm] = useState(() => providerToForm(provider));
  const [clearKey, setClearKey] = useState(false);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => setForm(current => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true); setError('');
    try {
      const input = buildProviderWriteInput(form);
      const result = provider
        ? await internalClient.patchProvider(provider.id, { ...input, ...(clearKey ? { apiKey: null } : {}), ...(clearHeaders ? { headers: null } : {}) })
        : await internalClient.createProvider(input);
      setForm(current => ({ ...current, apiKey: '', headersJson: '' }));
      onSaved(result.provider);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '连接保存失败'); }
    finally { setSaving(false); }
  };
  return <Panel title={provider ? '编辑连接' : '添加连接'} open onClose={() => !saving && onClose()} className="connection-editor">
    <form className="connection-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="form-columns"><label><span>连接名称</span><input aria-label="连接名称" maxLength={120} required value={form.name} onChange={event => update('name', event.target.value)} /></label><label><span>接口类型</span><select aria-label="接口类型" value={form.profile} disabled={provider?.type === 'mock'} onChange={event => setForm(current => ({ ...current, profile: event.target.value as ProviderFormState['profile'], type: event.target.value, unsupportedType: false }))}>{PROVIDER_PROFILE_OPTIONS.filter(option => option.value !== 'mock' || provider?.type === 'mock').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div>
      <label><span>Base URL</span><input aria-label="Base URL" type="url" value={form.baseUrl} onChange={event => update('baseUrl', event.target.value)} placeholder="https://api.example.com/v1" /></label>
      <ProviderApiKeyField hasStoredKey={provider?.hasApiKey ?? false} value={form.apiKey} onChange={value => { setClearKey(false); update('apiKey', value); }} />
      {provider?.hasApiKey && <label className="check-line"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />清除已存储的 API Key</label>}
      <details className="form-advanced"><summary>高级配置</summary><label><span>自定义请求头 JSON</span><textarea className="code-input" aria-label="自定义请求头 JSON" value={form.headersJson} placeholder={provider?.hasCustomHeaders ? '留空保留现有请求头' : '{}'} rows={4} onChange={event => { setClearHeaders(false); update('headersJson', event.target.value); }} /></label>{provider?.hasCustomHeaders && <label className="check-line"><input type="checkbox" checked={clearHeaders} onChange={event => setClearHeaders(event.target.checked)} />清除自定义请求头</label>}<label><span>接口配置 JSON</span><textarea className="code-input" aria-label="接口配置 JSON" value={form.configJson} rows={5} onChange={event => update('configJson', event.target.value)} /></label></details>
      <div className="form-options"><label className="check-line"><input type="checkbox" checked={form.enabled} onChange={event => update('enabled', event.target.checked)} />启用连接</label><label className="check-line"><input type="checkbox" checked={form.isDefault} onChange={event => update('isDefault', event.target.checked)} />设为默认</label></div>
      {error && <p className="error-state" role="alert">{error}</p>}
      <div className="form-footer"><button className="quiet-command" type="button" disabled={saving} onClick={onClose}>取消</button><button className="primary-command" type="submit" disabled={saving || !form.name.trim()}>{saving ? '正在保存' : '保存连接'}</button></div>
    </form>
  </Panel>;
}

export function ModelEditor({ model, providerId, onClose, onSaved }: { model: ModelDto | null; providerId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState(() => modelToForm(model, providerId));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <Panel title={model ? '编辑模型' : '添加模型'} open onClose={() => !saving && onClose()} className="connection-editor"><form className="connection-form" onSubmit={event => {
    event.preventDefault(); setSaving(true); setError('');
    void (async () => {
      try {
        const input = buildManualModelWriteInput(form);
        if (model) await internalClient.patchModel(model.id, { modelId: input.modelId, displayName: input.displayName, capabilities: input.capabilities, enabled: input.enabled });
        else await internalClient.createModel(input);
        onSaved();
      } catch (failure) { setError(failure instanceof Error ? failure.message : '模型保存失败'); }
      finally { setSaving(false); }
    })();
  }}><div className="form-columns"><label><span>模型 ID</span><input aria-label="模型 ID" required value={form.modelId} onChange={event => setForm(current => ({ ...current, modelId: event.target.value }))} /></label><label><span>显示名称</span><input aria-label="模型显示名称" required value={form.displayName} onChange={event => setForm(current => ({ ...current, displayName: event.target.value }))} /></label></div><ManualModelCapabilityField value={form.capabilitiesJson} onChange={value => setForm(current => ({ ...current, capabilitiesJson: value }))} /><label className="check-line"><input type="checkbox" checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} />启用模型</label>{error && <p className="error-state" role="alert">{error}</p>}<div className="form-footer"><button type="button" className="quiet-command" disabled={saving} onClick={onClose}>取消</button><button className="primary-command" type="submit" disabled={saving}>{saving ? '正在保存' : '保存模型'}</button></div></form></Panel>;
}
