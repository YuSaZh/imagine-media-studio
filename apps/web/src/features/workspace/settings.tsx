import { lazy, Suspense, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, useLocation } from 'react-router-dom';
import { PROVIDER_FAMILIES, providerFamily, ManualModelCreateSchema, ProviderCreateSchema, type ModelDto, type ProviderDto } from '@imagine/shared';
import { Check, Code2, Database, Download, KeyRound, LoaderCircle, LogOut, MoreHorizontal, Pencil, PlugZap, Plus, Power, RefreshCw, Settings2, Smartphone, Trash2, Upload } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { getPwaState, subscribeToPwaState, activatePwaUpdate, promptPwaInstall } from '../../pwa-registration';
import { isIosSafari, useStandaloneMode } from '../../hooks/use-runtime-state';
import { readGeneralSettings, readPwaSettings, usePatchSettings, useSettingsQuery } from '../settings/api/settings-query';
import { useRefreshWorkspace, useWorkspaceCatalog } from './queries';
import { ModelEditor, ProviderEditor } from './provider-editor';
import { Choice, Confirm, Options, Tool } from './ui';
import { ModelManagement } from './model-management';

const AdapterController = lazy(() => import('../settings/controllers/adapter-controller').then(module => ({ default: module.CustomAdapterWorkspaceContainer })));

function exportConnection(provider: ProviderDto, models: readonly ModelDto[]) {
  const document = { schemaVersion: 1, provider: { name: provider.name, type: provider.type, baseUrl: provider.baseUrl, config: provider.config, enabled: provider.enabled, isDefault: false }, models: models.map(model => ({ modelId: model.modelId, displayName: model.displayName, capabilities: model.capabilities, enabled: model.enabled })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
  const link = globalThis.document.createElement('a');
  link.href = url; link.download = 'imagine-connection.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Settings({ online }: { online: boolean }) {
  const path = useLocation().pathname;
  const section = path.endsWith('/models') ? 'models' : path.endsWith('/providers') ? 'providers' : path.endsWith('/storage') ? 'storage' : path.endsWith('/pwa') ? 'pwa' : 'general';
  const catalog = useWorkspaceCatalog();
  const refresh = useRefreshWorkspace();
  const [editor, setEditor] = useState<ProviderDto | 'new' | null>(null);
  const [modelEditor, setModelEditor] = useState<{ model: ModelDto | null; providerId: string } | null>(null);
  const [adapter, setAdapter] = useState<ProviderDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => Promise<unknown> } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const run = async (action: () => Promise<unknown>, success = '操作完成') => {
    if (!online || busy) return;
    setBusy(true); setFeedback(null);
    try { await action(); await refresh(); setFeedback({ message: success, error: false }); }
    catch (error) { setFeedback({ message: error instanceof Error ? error.message : '操作失败，请重试', error: true }); }
    finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    if (file.size > 1024 * 1024) throw new Error('连接配置文件不能超过 1 MB');
    const document: unknown = JSON.parse(await file.text());
    if (!document || typeof document !== 'object' || !('schemaVersion' in document) || document.schemaVersion !== 1 || !('provider' in document) || !document.provider || typeof document.provider !== 'object') throw new Error('连接配置文件格式无效');
    if ('apiKey' in document.provider || 'headers' in document.provider) throw new Error('配置文件不能包含密钥或请求头，请在连接表单中单独填写');
    const provider = ProviderCreateSchema.parse(document.provider);
    const models = 'models' in document && Array.isArray(document.models) ? document.models.map(value => ManualModelCreateSchema.parse({ ...value, providerId: 'import' })) : [];
    const created = await internalClient.createProvider({ name: provider.name, type: provider.type, config: provider.config, enabled: provider.enabled, isDefault: provider.isDefault, baseUrl: provider.baseUrl ?? null });
    for (const model of models) await internalClient.createModel({ ...model, providerId: created.provider.id });
  };
  const sections = [{ key: 'general', path: '/settings', label: '偏好', icon: Settings2 }, { key: 'providers', path: '/settings/providers', label: '连接', icon: PlugZap }, { key: 'models', path: '/settings/models', label: '模型', icon: Code2 }, { key: 'storage', path: '/settings/storage', label: '数据', icon: Database }, { key: 'pwa', path: '/settings/pwa', label: '应用', icon: Smartphone }];

  return <div className="workspace-settings"><nav className="workspace-settings-nav" aria-label="设置分类">{sections.map(item => <NavLink end key={item.key} to={item.path}><item.icon size={17} />{item.label}</NavLink>)}</nav><div className="workspace-settings-body">
    <div className="settings-page-heading"><h1>{sections.find(item => item.key === section)?.label}</h1>{section === 'providers' && <div><Tool label="导入连接" disabled={!online || busy} onClick={() => importRef.current?.click()}><Upload size={18} /></Tool><button className="primary-command" disabled={!online || busy} onClick={() => setEditor('new')}><Plus size={16} />添加连接</button></div>}</div>
    {feedback && <p className={feedback.error ? 'error-state' : 'success-state'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {section === 'providers' && <>
      <input ref={importRef} aria-label="导入连接文件" hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => importFile(file), '连接已导入，请配置密钥'); }} />
      {(catalog.providers.isPending || catalog.models.isPending) && <p className="loading-state" role="status">正在加载连接…</p>}
      {(catalog.providers.isError || catalog.models.isError) && <p className="error-state" role="alert">连接加载失败<button className="quiet-command" onClick={() => void refresh()}>重试</button></p>}
      {!catalog.providers.isPending && !catalog.providers.isError && !catalog.providers.data?.length && <div className="empty-state"><PlugZap size={32} /><h3>还没有生成连接</h3><button className="primary-command" disabled={!online} onClick={() => setEditor('new')}><Plus size={16} />添加连接</button></div>}
      <div className="connections-list">{catalog.providers.data?.map(provider => {
        const models = catalog.models.data?.filter(model => model.providerId === provider.id) ?? [];
        const custom = provider.type === 'custom-http-v1' || provider.type === 'custom-js-v1';
        return <section className="connection-item" key={provider.id} aria-label={`连接 ${provider.name}`}>
          <div className="connection-item-heading"><span className="connection-logo">{provider.name.slice(0, 1).toUpperCase()}</span><div><h2>{provider.name}</h2><p>{PROVIDER_FAMILIES.find(family => family.value === providerFamily(provider.type))?.label ?? provider.type}</p></div><span className={`connection-state ${provider.enabled ? 'enabled' : ''}`}>{provider.isDefault ? '默认' : provider.enabled ? '已启用' : '已停用'}</span><Tool label={`编辑连接 ${provider.name}`} disabled={!online || busy} onClick={() => setEditor(provider)}><Pencil size={17} /></Tool><Options label={`${provider.name} 更多操作`} trigger={<MoreHorizontal size={19} />}>
            <Choice active={false} onClick={() => void run(() => internalClient.patchProvider(provider.id, { enabled: !provider.enabled }), provider.enabled ? '连接已停用' : '连接已启用')}><Power size={15} />{provider.enabled ? '停用' : '启用'}</Choice>
            {!provider.isDefault && <Choice active={false} onClick={() => void run(() => internalClient.patchProvider(provider.id, { isDefault: true }), '已设为默认连接')}><Check size={15} />设为默认</Choice>}
            <Choice active={false} onClick={() => exportConnection(provider, models)}><Download size={15} />导出配置</Choice>
            {provider.type !== 'mock' && <Choice active={false} onClick={() => setConfirmation({ title: '删除连接？', description: `将删除「${provider.name}」的配置及已存储的密钥。`, action: () => internalClient.deleteProvider(provider.id) })}><Trash2 size={15} />删除连接</Choice>}
          </Options></div>
          <div className="connection-summary"><span>{provider.baseUrl ?? '内置连接'}</span><span><KeyRound size={13} />{provider.hasApiKey ? '密钥已存储' : '未配置密钥'}</span></div>
          <div className="connection-commands"><button className="quiet-command" disabled={!online || busy || !provider.enabled} onClick={() => void run(async () => { const result = await internalClient.testProvider(provider.id); if (!result.ok) throw new Error(result.message); }, '连接测试通过')}><PlugZap size={15} />测试连接</button>{custom ? <button className="quiet-command" disabled={!online || busy} onClick={() => setAdapter(provider)}><Code2 size={15} />管理适配器</button> : <><button className="text-command" disabled={!online || busy || !provider.enabled} onClick={() => void run(() => internalClient.refreshProviderModels(provider.id), '模型目录已刷新')}><RefreshCw size={15} />刷新模型</button><button className="text-command" disabled={!online || busy} onClick={() => setModelEditor({ providerId: provider.id, model: null })}><Plus size={15} />添加模型</button></>}</div>
          <div className="connection-models">{models.length === 0 ? <p className="menu-empty">尚未发现模型</p> : models.map(model => <div className="connection-model" key={model.id}><div><strong>{model.displayName}</strong><small>{model.modelId}</small></div><span>{model.enabled ? '可用' : '已停用'}</span>{!custom && <><Tool label={`编辑模型 ${model.displayName}`} disabled={!online || busy} onClick={() => setModelEditor({ model, providerId: provider.id })}><Pencil size={15} /></Tool>{model.capabilitySource === 'manual' && <Tool label={`删除模型 ${model.displayName}`} disabled={!online || busy} onClick={() => setConfirmation({ title: '删除手动模型？', description: model.displayName, action: () => internalClient.deleteModel(model.id) })}><Trash2 size={15} /></Tool>}</>}</div>)}</div>
        </section>;
      })}</div>
    </>}
    {section === 'general' && <Preferences online={online} />}
    {section === 'models' && <ModelManagement models={catalog.models.data ?? []} providers={catalog.providers.data ?? []} online={online} refresh={refresh} />}
    {section === 'storage' && <Storage online={online} />}
    {section === 'pwa' && <ApplicationSettings online={online} />}
    {editor && <ProviderEditor provider={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSaved={provider => { setEditor(null); void refresh(); if (provider.type.startsWith('custom-')) setAdapter(provider); }} />}
    {modelEditor && <ModelEditor {...modelEditor} providerType={catalog.providers.data?.find(provider => provider.id === modelEditor.providerId)?.type ?? ''} onClose={() => setModelEditor(null)} onSaved={() => { setModelEditor(null); void refresh(); }} />}
    {adapter && <Suspense fallback={<p className="loading-state">正在加载适配器…</p>}><AdapterController open fixtureMode={false} provider={adapter} onOpenChange={open => { if (!open) { setAdapter(null); void refresh(); } }} /></Suspense>}
    {confirmation && <Confirm {...confirmation} busy={busy} onClose={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); void run(action, '已删除'); }} />}
  </div></div>;
}

function Preferences({ online }: { online: boolean }) {
  const query = useSettingsQuery();
  const patch = usePatchSettings();
  const values = readGeneralSettings(query.data?.settings);
  const disabled = !online || query.isPending || patch.isPending;
  return <div className="preferences">
    {(query.isError || patch.isError) && <p className="error-state" role="alert">设置保存或读取失败，请重试。</p>}
    <label className="setting-line"><span>默认创作类型</span><select aria-label="默认创作类型" disabled={disabled} value={values.defaultMode} onChange={event => patch.mutate({ 'composer.default_mode': event.target.value })}><option value="image">图片</option><option value="video">视频</option></select></label>
    <label className="setting-line"><span>提交后清空提示词</span><input type="checkbox" aria-label="提交后清空提示词" checked={values.clearPromptAfterSubmit} disabled={disabled} onChange={event => patch.mutate({ 'composer.clear_prompt_after_submit': event.target.checked })} /></label>
    <label className="setting-line"><span>初始作品类型</span><select aria-label="初始作品类型" value={values.initialFilter} disabled={disabled} onChange={event => patch.mutate({ 'gallery.initial_filter': event.target.value })}><option value="all">全部作品</option><option value="image">图片</option><option value="video">视频</option></select></label>
    <label className="setting-line"><span>减少动效</span><select aria-label="减少动效" value={values.reduceMotion} disabled={disabled} onChange={event => patch.mutate({ 'ui.reduce_motion': event.target.value })}><option value="system">跟随系统</option><option value="always">开启</option><option value="never">关闭</option></select></label>
    <div className="settings-session"><button className="quiet-command" disabled={!online} onClick={() => void internalClient.logout()}><LogOut size={16} />退出登录</button></div>
  </div>;
}

function Storage({ online }: { online: boolean }) {
  const integrity = useQuery({ queryKey: ['internal', 'maintenance', 'integrity'], queryFn: () => internalClient.getDatabaseIntegrity(), enabled: online });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const action = async (task: () => Promise<string>) => {
    setBusy(true); setError('');
    try { setResult(await task()); } catch (failure) { setError(failure instanceof Error ? failure.message : '维护操作失败'); } finally { setBusy(false); }
  };
  return <div className="preferences"><div className="setting-line"><span>数据库完整性</span><strong>{integrity.isPending ? '检查中' : integrity.isError ? '检查失败' : integrity.data?.integrity.ok ? '正常' : '发现异常'}</strong></div><div className="maintenance-actions">
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { const { backup } = await internalClient.createDatabaseBackup(); return `备份已创建：${backup.id}（${Math.ceil(backup.size / 1024)} KB）`; })}><Database size={16} />创建数据库备份</button>
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { const { media } = await internalClient.getMediaConsistency(); return `已检查 ${media.assetCount} 件作品、${media.fileCount} 个文件，发现 ${media.issueCount} 项问题`; })}><Check size={16} />检查媒体文件</button>
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { await internalClient.reconcileMediaConsistency(); const { repairs } = await internalClient.runMediaRepairs(); return `已修复 ${repairs.repaired} 项，${repairs.retried} 项等待重试，${repairs.manual} 项需要人工处理`; })}><RefreshCw size={16} />修复缺失预览</button>
  </div>{busy && <p className="loading-state" role="status">正在处理…</p>}{result && <p className="success-state" role="status">{result}</p>}{error && <p className="error-state" role="alert">{error}</p>}</div>;
}

function ApplicationSettings({ online }: { online: boolean }) {
  const state = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const standalone = useStandaloneMode();
  const settings = useSettingsQuery();
  const patch = usePatchSettings();
  const values = readPwaSettings(settings.data?.settings);
  return <div className="preferences"><div className="setting-line"><span>网络</span><strong>{online ? '在线' : '离线'}</strong></div><div className="setting-line"><span>应用安装</span><strong>{standalone || state.installed ? '已安装' : !window.isSecureContext ? '需要 HTTPS' : state.installPromptAvailable ? '可安装' : '浏览器模式'}</strong></div>
    {state.installPromptAvailable && <button className="quiet-command" disabled={state.installPromptPending} onClick={() => void promptPwaInstall()}><Download size={16} />安装应用</button>}
    {isIosSafari() && !standalone && <p className="platform-note">Safari：分享 → 添加到主屏幕</p>}
    <label className="setting-line"><span>应用更新提醒</span><input type="checkbox" aria-label="应用更新提醒" checked={values.updateNotifications} disabled={!online || patch.isPending} onChange={event => patch.mutate({ 'pwa.update_notifications': event.target.checked })} /></label>
    <div className="setting-line"><span>应用版本</span><strong>{state.updateAvailable ? '有可用更新' : '当前版本'}</strong></div>{state.updateAvailable && <button className="quiet-command" disabled={state.updating} onClick={() => void activatePwaUpdate()}>{state.updating ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}应用更新</button>}
    {state.error && window.isSecureContext && <p className="error-state" role="alert">{state.error}</p>}
  </div>;
}
