import { t } from '../../i18n/index';
import { Select, SelectItem } from './select';
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
  const run = async (action: () => Promise<unknown>) => { setBusy(true); setError(''); try { await action(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : t("模型操作失败")); } finally { setBusy(false); } };
  const filtered = models.filter(model => (!providerId || model.providerId === providerId) && (!kind || Array.isArray(model.capabilities.operations) && model.capabilities.operations.some(operation => typeof operation === 'string' && operation.startsWith(`${kind}.`))) && `${model.modelId} ${model.displayName}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="model-management" aria-label={t("模型管理")}><div className="model-management-toolbar"><label className="model-search"><Search size={16} /><input aria-label={t("搜索模型")} placeholder={t("搜索模型")} value={search} onChange={event => setSearch(event.target.value)} /></label><Select aria-label={t("筛选连接")} value={providerId} onChange={event => setProviderId(event.target.value)}><SelectItem value="">{t("全部连接")}</SelectItem>{providers.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}</Select><Select aria-label={t("筛选模型类型")} value={kind} onChange={event => setKind(event.target.value)}><SelectItem value="">{t("全部类型")}</SelectItem><SelectItem value="image">{t("图片")}</SelectItem><SelectItem value="video">{t("视频")}</SelectItem></Select><button className="primary-command" disabled={!online || busy || !editable.length} onClick={() => setEditor({ model: null, providerId: editable.find(provider => provider.id === providerId)?.id ?? editable[0]!.id })}><Plus size={16} />{t("添加模型")}</button></div>
    {error && <p className="error-state" role="alert">{error}</p>}
    <div className="model-table-scroll"><table className="model-table"><thead><tr><th>{t("模型")}</th><th>{t("连接")}</th><th>{t("调用协议")}</th><th>{t("参数")}</th><th>{t("状态")}</th><th><span className="sr-only">{t("操作")}</span></th></tr></thead><tbody>{filtered.map(model => {
      const provider = providers.find(provider => provider.id === model.providerId);
      const caps = ModelCapabilitiesSchema.safeParse(model.capabilities);
      const custom = provider?.type.startsWith('custom-');
      return <tr key={model.id}><td><strong>{model.displayName}</strong><small>{model.modelId}</small></td><td>{provider?.name ?? model.providerId}</td><td>{caps.success ? MODEL_PROTOCOLS.find(protocol => protocol.value === caps.data.profile)?.label ?? t("自动") : t("未配置")}</td><td>{caps.success && caps.data.parameters ? t("{0} 项", [caps.data.parameters.filter(rule => rule.enabled).length]) : t("模型默认")}</td><td>{model.enabled ? t("已启用") : t("已停用")}</td><td><div className="model-row-actions">{!custom && <><Tool label={t("编辑模型 {0}", [model.displayName])} disabled={!online || busy} onClick={() => setEditor({ model, providerId: model.providerId })}><Pencil size={16} /></Tool><Tool label={t("复制模型 {0}", [model.displayName])} disabled={!online || busy} onClick={() => setEditor({ model: { ...model, id: '', modelId: `${model.modelId}-copy`, displayName: t("{0} 副本", [model.displayName]), capabilitySource: 'provider' }, providerId: model.providerId })}><Copy size={16} /></Tool><Tool label={t("{0}模型 {1}", [model.enabled ? t("停用") : t("启用"), model.displayName])} disabled={!online || busy} onClick={() => void run(() => internalClient.createModel({ providerId: model.providerId, modelId: model.modelId, displayName: model.displayName, capabilities: ModelCapabilitiesSchema.parse(model.capabilities), enabled: !model.enabled }))}><Power size={16} /></Tool><Tool label={t("删除模型 {0}", [model.displayName])} disabled={!online || busy} onClick={() => setPendingDelete(model)}><Trash2 size={16} /></Tool></>}</div></td></tr>;
    })}</tbody></table></div>
    {!filtered.length && <p className="empty-state">{t("没有符合条件的模型")}</p>}
    {editor && <><ModelEditor key={`${editor.providerId}:${editor.model?.id ?? 'new'}`} {...editor} providerType={providers.find(provider => provider.id === editor.providerId)?.type ?? ''} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void refresh(); }} /></>}
    {pendingDelete && <Confirm title={t("删除模型？")} description={pendingDelete.displayName} busy={busy} onClose={() => setPendingDelete(null)} onConfirm={() => { const model = pendingDelete; setPendingDelete(null); void run(() => internalClient.deleteModel(model.id)); }} />}
  </section>;
}
