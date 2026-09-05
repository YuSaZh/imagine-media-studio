import { useState } from 'react';
import { MODEL_PROTOCOLS, ModelCapabilitiesSchema, type ModelDto, type ProviderDto } from '@imagine/shared';
import { Copy, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { ModelEditor } from './provider-editor';
import { Confirm, Tool } from './ui';

export function ModelManagement({ models, providers, online, refresh }: { models: ModelDto[]; providers: ProviderDto[]; online: boolean; refresh: () => Promise<unknown> }) {
  const [search, setSearch] = useState('');
  const [providerId, setProviderId] = useState('');
  const [kind, setKind] = useState('');
  const [editor, setEditor] = useState<{ model: ModelDto | null; providerId: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = providers.filter(provider => !provider.type.startsWith('custom-'));
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : '模型操作失败'); } finally { setBusy(false); } };
  const filtered = models.filter(model => (!providerId || model.providerId === providerId) && (!kind || Array.isArray(model.capabilities.operations) && model.capabilities.operations.some(operation => typeof operation === 'string' && operation.startsWith(`${kind}.`))) && `${model.modelId} ${model.displayName}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="model-management" aria-label="模型管理"><div className="model-management-toolbar"><label className="model-search"><Search size={16} /><input aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="筛选连接" value={providerId} onChange={event => setProviderId(event.target.value)}><option value="">全部连接</option>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select><select aria-label="筛选模型类型" value={kind} onChange={event => setKind(event.target.value)}><option value="">全部类型</option><option value="image">图片</option><option value="video">视频</option></select><button className="primary-command" disabled={!online || busy || !editable.length} onClick={() => setEditor({ model: null, providerId: editable.find(provider => provider.id === providerId)?.id ?? editable[0]!.id })}><Plus size={16} />添加模型</button></div>
    {error && <p className="error-state" role="alert">{error}</p>}
    <div className="model-table-scroll"><table className="model-table"><thead><tr><th>模型</th><th>连接</th><th>调用协议</th><th>参数</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{filtered.map(model => {
      const provider = providers.find(provider => provider.id === model.providerId);
      const caps = ModelCapabilitiesSchema.safeParse(model.capabilities);
      const custom = provider?.type.startsWith('custom-');
      return <tr key={model.id}><td><strong>{model.displayName}</strong><small>{model.modelId}</small></td><td>{provider?.name ?? model.providerId}</td><td>{caps.success ? MODEL_PROTOCOLS.find(protocol => protocol.value === caps.data.profile)?.label ?? '自动' : '未配置'}</td><td>{caps.success && caps.data.parameters ? `${caps.data.parameters.filter(rule => rule.enabled).length} 项` : '模型默认'}</td><td>{model.enabled ? '已启用' : '已停用'}</td><td><div className="model-row-actions">{!custom && <><Tool label={`编辑模型 ${model.displayName}`} disabled={!online || busy} onClick={() => setEditor({ model, providerId: model.providerId })}><Pencil size={16} /></Tool><Tool label={`复制模型 ${model.displayName}`} disabled={!online || busy} onClick={() => setEditor({ model: { ...model, id: '', modelId: `${model.modelId}-copy`, displayName: `${model.displayName} 副本`, capabilitySource: 'provider' }, providerId: model.providerId })}><Copy size={16} /></Tool><Tool label={`${model.enabled ? '停用' : '启用'}模型 ${model.displayName}`} disabled={!online || busy} onClick={() => void run(() => internalClient.createModel({ providerId: model.providerId, modelId: model.modelId, displayName: model.displayName, capabilities: ModelCapabilitiesSchema.parse(model.capabilities), enabled: !model.enabled }))}><Power size={16} /></Tool>{model.capabilitySource === 'manual' && <Tool label={`删除模型 ${model.displayName}`} disabled={!online || busy} onClick={() => setPendingDelete(model)}><Trash2 size={16} /></Tool>}</>}</div></td></tr>;
    })}</tbody></table></div>
    {!filtered.length && <p className="empty-state">没有符合条件的模型</p>}
    {editor && <><ModelEditor key={`${editor.providerId}:${editor.model?.id ?? 'new'}`} {...editor} providerType={providers.find(provider => provider.id === editor.providerId)?.type ?? ''} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void refresh(); }} /></>}
    {pendingDelete && <Confirm title="删除模型？" description={pendingDelete.displayName} busy={busy} onClose={() => setPendingDelete(null)} onConfirm={() => { const model = pendingDelete; setPendingDelete(null); void run(() => internalClient.deleteModel(model.id)); }} />}
  </section>;
}
