import { BrandingSettings } from './branding-settings';
import { t, rich } from '../../i18n/index';
import { Select, SelectItem } from './select';
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
import { AccountSettings, useAccount } from './account-settings';

const AdapterController = lazy(() => import('../settings/controllers/adapter-controller').then(module => ({ default: module.CustomAdapterWorkspaceContainer })));

function exportConnection(provider: ProviderDto, models: readonly ModelDto[]) {
  const document = { schemaVersion: 1, provider: { name: provider.name, type: provider.type, baseUrl: provider.baseUrl, config: provider.config, enabled: provider.enabled, isDefault: false }, models: models.map(model => ({ modelId: model.modelId, displayName: model.displayName, capabilities: model.capabilities, enabled: model.enabled })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
  const link = globalThis.document.createElement('a');
  link.href = url; link.download = 'imagine-connection.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Settings({ online }: { online: boolean }) {
  const account = useAccount();
  const path = useLocation().pathname;
  const section = account.data?.user?.role === 'user' && !['/pwa', '/account'].some(suffix => path.endsWith(suffix)) ? 'general' : path.endsWith('/models') ? 'models' : path.endsWith('/providers') ? 'providers' : path.endsWith('/storage') ? 'storage' : path.endsWith('/pwa') ? 'pwa' : path.endsWith('/account') ? 'account' : 'general';
  const catalog = useWorkspaceCatalog();
  const refresh = useRefreshWorkspace();
  const [editor, setEditor] = useState<ProviderDto | 'new' | null>(null);
  const [modelEditor, setModelEditor] = useState<{ model: ModelDto | null; providerId: string } | null>(null);
  const [adapter, setAdapter] = useState<ProviderDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => Promise<unknown> } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const run = async (action: () => Promise<unknown>, success = t("操作完成")) => {
    if (!online || busy) return;
    setBusy(true); setFeedback(null);
    try { await action(); await refresh(); setFeedback({ message: success, error: false }); }
    catch (error) { setFeedback({ message: error instanceof Error ? error.message : t("操作失败，请重试"), error: true }); }
    finally { setBusy(false); }
  };
  const importFile = async (file: File) => {
    if (file.size > 1024 * 1024) throw new Error(t("连接配置文件不能超过 1 MB"));
    const document: unknown = JSON.parse(await file.text());
    if (!document || typeof document !== 'object' || !('schemaVersion' in document) || document.schemaVersion !== 1 || !('provider' in document) || !document.provider || typeof document.provider !== 'object') throw new Error(t("连接配置文件格式无效"));
    if ('apiKey' in document.provider || 'headers' in document.provider) throw new Error(t("配置文件不能包含密钥或请求头，请在连接表单中单独填写"));
    const provider = ProviderCreateSchema.parse(document.provider);
    const models = 'models' in document && Array.isArray(document.models) ? document.models.map(value => ManualModelCreateSchema.parse({ ...value, providerId: 'import' })) : [];
    const created = await internalClient.createProvider({ name: provider.name, type: provider.type, config: provider.config, enabled: provider.enabled, isDefault: provider.isDefault, baseUrl: provider.baseUrl ?? null });
    for (const model of models) await internalClient.createModel({ ...model, providerId: created.provider.id });
  };
  const sections = [{ key: 'account', path: '/settings/account', label: t("账号管理"), icon: KeyRound }, { key: 'general', path: '/settings', label: t("偏好"), icon: Settings2 }, { key: 'providers', path: '/settings/providers', label: t("连接"), icon: PlugZap }, { key: 'models', path: '/settings/models', label: t("模型"), icon: Code2 }, { key: 'storage', path: '/settings/storage', label: t("数据"), icon: Database }, { key: 'pwa', path: '/settings/pwa', label: t("应用"), icon: Smartphone }];

  return <div className="workspace-settings"><nav className="workspace-settings-nav" aria-label={t("设置分类")}>{sections.filter(item => account.data?.user?.role !== 'user' || ['general', 'account', 'pwa'].includes(item.key)).map(item => <NavLink end key={item.key} to={item.path}><item.icon size={17} />{item.label}</NavLink>)}</nav><div className="workspace-settings-body">
    <div className="settings-page-heading"><h1>{sections.find(item => item.key === section)?.label}</h1>{section === 'providers' && <div><Tool label={t("导入连接")} disabled={!online || busy} onClick={() => importRef.current?.click()}><Upload size={18} /></Tool><button className="primary-command" disabled={!online || busy} onClick={() => setEditor('new')}><Plus size={16} />{t("添加连接")}</button></div>}</div>
    {feedback && <p className={feedback.error ? 'error-state' : 'success-state'} role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
    {section === 'providers' && <>
      <input ref={importRef} aria-label={t("导入连接文件")} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => importFile(file), t("连接已导入，请配置密钥")); }} />
      {(catalog.providers.isPending || catalog.models.isPending) && <p className="loading-state" role="status">{t("正在加载连接…")}</p>}
      {(catalog.providers.isError || catalog.models.isError) && <p className="error-state" role="alert">{t("连接加载失败")}<button className="quiet-command" onClick={() => void refresh()}>{t("重试")}</button></p>}
      {!catalog.providers.isPending && !catalog.providers.isError && !catalog.providers.data?.length && <div className="empty-state"><PlugZap size={32} /><h3>{t("还没有生成连接")}</h3><button className="primary-command" disabled={!online} onClick={() => setEditor('new')}><Plus size={16} />{t("添加连接")}</button></div>}
      <div className="connections-list">{catalog.providers.data?.map(provider => {
        const models = catalog.models.data?.filter(model => model.providerId === provider.id) ?? [];
        const custom = provider.type === 'custom-http-v1' || provider.type === 'custom-js-v1';
        return <section className="connection-item" key={provider.id} aria-label={t("连接 {0}", [provider.name])}>
          <div className="connection-item-heading"><span className="connection-logo">{provider.name.slice(0, 1).toUpperCase()}</span><div><h2>{provider.name}</h2><p>{PROVIDER_FAMILIES.find(family => family.value === providerFamily(provider.type))?.label ?? provider.type}</p></div><span className={`connection-state ${provider.enabled ? 'enabled' : ''}`}>{provider.isDefault ? t("默认") : provider.enabled ? t("已启用") : t("已停用")}</span><Tool label={t("编辑连接 {0}", [provider.name])} disabled={!online || busy} onClick={() => setEditor(provider)}><Pencil size={17} /></Tool><Options label={t("{0} 更多操作", [provider.name])} trigger={<MoreHorizontal size={19} />}>
            <Choice active={false} onClick={() => void run(() => internalClient.patchProvider(provider.id, { enabled: !provider.enabled }), provider.enabled ? t("连接已停用") : t("连接已启用"))}><Power size={15} />{provider.enabled ? t("停用") : t("启用")}</Choice>
            {!provider.isDefault && <Choice active={false} onClick={() => void run(() => internalClient.patchProvider(provider.id, { isDefault: true }), t("已设为默认连接"))}><Check size={15} />{t("设为默认")}</Choice>}
            <Choice active={false} onClick={() => exportConnection(provider, models)}><Download size={15} />{t("导出配置")}</Choice>
            {provider.type !== 'mock' && <Choice active={false} onClick={() => setConfirmation({ title: t("删除连接？"), description: t("将删除「{0}」的配置及已存储的密钥。", [provider.name]), action: () => internalClient.deleteProvider(provider.id) })}><Trash2 size={15} />{t("删除连接")}</Choice>}
          </Options></div>
          <div className="connection-summary"><span>{provider.baseUrl ?? t("内置连接")}</span><span><KeyRound size={13} />{provider.hasApiKey ? t("密钥已存储") : t("未配置密钥")}</span></div>
          <div className="connection-commands"><button className="quiet-command" disabled={!online || busy || !provider.enabled} onClick={() => void run(async () => { const result = await internalClient.testProvider(provider.id); if (!result.ok) throw new Error(result.message); }, t("连接测试通过"))}><PlugZap size={15} />{t("测试连接")}</button>{custom ? <button className="quiet-command" disabled={!online || busy} onClick={() => setAdapter(provider)}><Code2 size={15} />{t("管理适配器")}</button> : <><button className="text-command" disabled={!online || busy} onClick={() => setModelEditor({ providerId: provider.id, model: null })}><Plus size={15} />{t("添加模型")}</button></>}</div>
          <div className="connection-models">{models.length === 0 ? <p className="menu-empty">{t("尚未发现模型")}</p> : models.map(model => <div className="connection-model" key={model.id}><div><strong>{model.displayName}</strong><small>{model.modelId}</small></div><span>{model.enabled ? t("可用") : t("已停用")}</span>{!custom && <><Tool label={t("编辑模型 {0}", [model.displayName])} disabled={!online || busy} onClick={() => setModelEditor({ model, providerId: provider.id })}><Pencil size={15} /></Tool><Tool label={t("删除模型 {0}", [model.displayName])} disabled={!online || busy} onClick={() => setConfirmation({ title: t("删除模型？"), description: model.displayName, action: () => internalClient.deleteModel(model.id) })}><Trash2 size={15} /></Tool></>}</div>)}</div>
        </section>;
      })}</div>
    </>}
    {section === 'general' && <Preferences online={online} />}
    {section === 'account' && <><AccountSettings online={online} /><div className="settings-session"><button className="quiet-command" disabled={!online} onClick={() => void internalClient.logout()}><LogOut size={16} />{t("退出登录")}</button></div></>}
    {section === 'models' && <ModelManagement models={catalog.models.data ?? []} providers={catalog.providers.data ?? []} online={online} refresh={refresh} />}
    {section === 'storage' && <Storage online={online} />}
    {section === 'pwa' && <ApplicationSettings online={online} />}
    {editor && <ProviderEditor provider={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onSaved={provider => { setEditor(null); void refresh(); if (provider.type.startsWith('custom-')) setAdapter(provider); }} />}
    {modelEditor && <ModelEditor {...modelEditor} providerType={catalog.providers.data?.find(provider => provider.id === modelEditor.providerId)?.type ?? ''} onClose={() => setModelEditor(null)} onSaved={() => { setModelEditor(null); void refresh(); }} />}
    {adapter && <Suspense fallback={<p className="loading-state">{t("正在加载适配器…")}</p>}><AdapterController open fixtureMode={false} provider={adapter} onOpenChange={open => { if (!open) { setAdapter(null); void refresh(); } }} /></Suspense>}
    {confirmation && <Confirm {...confirmation} busy={busy} onClose={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); void run(action, t("已删除")); }} />}
  </div></div>;
}

function Preferences({ online }: { online: boolean }) {
  const account = useAccount();
  const query = useSettingsQuery();
  const patch = usePatchSettings();
  const values = readGeneralSettings(query.data?.settings);
  const disabled = !online || query.isPending || patch.isPending;
  return <div className="preferences">
    {account.data?.user?.role === 'admin' && <BrandingSettings disabled={disabled || query.isError} />}
    <label className="setting-line"><span>{t("界面主题")}</span><Select aria-label={t("界面主题")} value={values.theme} disabled={disabled} onChange={event => patch.mutate({ 'ui.theme': event.target.value })}><SelectItem value="light">{t("浅色")}</SelectItem><SelectItem value="dark">{t("深色")}</SelectItem><SelectItem value="system">{t("跟随系统")}</SelectItem></Select></label>
    <label className="setting-line"><span>{t("界面语言")}</span><Select aria-label={t("界面语言")} value={values.language} disabled={disabled} onChange={event => patch.mutate({ 'ui.language': event.target.value })}><SelectItem value="zh-CN">{"简体中文"}</SelectItem><SelectItem value="en">English</SelectItem><SelectItem value="ja">{"日本語"}</SelectItem></Select></label>
    {(query.isError || patch.isError) && <p className="error-state" role="alert">{t("设置保存或读取失败，请重试。")}</p>}
    {account.data?.user?.role === 'admin' && <label className="setting-line"><span>{t("是否允许 HTTP 内容")}<small className="setting-description">{t("同时允许 HTTP 提供商连接和媒体下载；HTTP 不加密传输。")}</small></span><input type="checkbox" aria-label={t("是否允许 HTTP 内容")} checked={query.data?.settings['network.allow_http_content'] === true} disabled={disabled || query.isError} onChange={event => patch.mutate({ 'network.allow_http_content': event.target.checked })} /></label>}
    <label className="setting-line"><span>{t("默认创作类型")}</span><Select aria-label={t("默认创作类型")} disabled={disabled} value={values.defaultMode} onChange={event => patch.mutate({ 'composer.default_mode': event.target.value })}><SelectItem value="image">{t("图片")}</SelectItem><SelectItem value="video">{t("视频")}</SelectItem></Select></label>
    <label className="setting-line"><span>{t("提交后清空提示词")}</span><input type="checkbox" aria-label={t("提交后清空提示词")} checked={values.clearPromptAfterSubmit} disabled={disabled} onChange={event => patch.mutate({ 'composer.clear_prompt_after_submit': event.target.checked })} /></label>
    <label className="setting-line"><span>{t("初始作品类型")}</span><Select aria-label={t("初始作品类型")} value={values.initialFilter} disabled={disabled} onChange={event => patch.mutate({ 'gallery.initial_filter': event.target.value })}><SelectItem value="all">{t("全部作品")}</SelectItem><SelectItem value="image">{t("图片")}</SelectItem><SelectItem value="video">{t("视频")}</SelectItem></Select></label>
    <label className="setting-line"><span>{t("按照系列显示")}</span><input type="checkbox" aria-label={t("按照系列显示")} checked={values.groupBySeries} disabled={disabled} onChange={event => patch.mutate({ 'gallery.group_by_series': event.target.checked })} /></label>
    {values.groupBySeries && <label className="setting-line setting-suboption"><span>{t("并发生图作为系列显示")}<small className="setting-description">{t("将同一次提交生成的多张图片合并为一个系列。")}</small></span><input type="checkbox" aria-label={t("并发生图作为系列显示")} checked={values.groupConcurrentImages} disabled={disabled} onChange={event => patch.mutate({ 'gallery.group_concurrent_images': event.target.checked })} /></label>}
    {values.groupBySeries && <label className="setting-line setting-suboption"><span>{t("上传参考图加入系列")}<small className="setting-description">{t("开启后，上传的参考图与生成结果一起显示；关闭时参考图独立显示。")}</small></span><input type="checkbox" aria-label={t("上传参考图加入系列")} checked={values.groupUploadedReferences} disabled={disabled} onChange={event => patch.mutate({ 'gallery.group_uploaded_references': event.target.checked })} /></label>}
    {values.groupBySeries && <label className="setting-line setting-suboption"><span>{t("系列封面")}</span><Select aria-label={t("系列封面")} value={values.seriesCover} disabled={disabled} onChange={event => patch.mutate({ 'gallery.series_cover': event.target.value })}><SelectItem value="recent">{t("最近查看的作品")}</SelectItem><SelectItem value="latest">{t("最新生成的作品")}</SelectItem><SelectItem value="original">{t("最开始的原图")}</SelectItem></Select></label>}
    <label className="setting-line"><span>{t("减少动效")}</span><Select aria-label={t("减少动效")} value={values.reduceMotion} disabled={disabled} onChange={event => patch.mutate({ 'ui.reduce_motion': event.target.value })}><SelectItem value="system">{t("跟随系统")}</SelectItem><SelectItem value="always">{t("开启")}</SelectItem><SelectItem value="never">{t("关闭")}</SelectItem></Select></label>
    <div className="settings-session"><button className="quiet-command" disabled={!online} onClick={() => void internalClient.logout()}><LogOut size={16} />{t("退出登录")}</button></div>
  </div>;
}

function Storage({ online }: { online: boolean }) {
  const integrity = useQuery({ queryKey: ['internal', 'maintenance', 'integrity'], queryFn: () => internalClient.getDatabaseIntegrity(), enabled: online });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const action = async (task: () => Promise<string>) => {
    setBusy(true); setError('');
    try { setResult(await task()); } catch (failure) { setError(failure instanceof Error ? failure.message : t("维护操作失败")); } finally { setBusy(false); }
  };
  return <div className="preferences"><div className="setting-line"><span>{t("数据库完整性")}</span><strong>{integrity.isPending ? t("检查中") : integrity.isError ? t("检查失败") : integrity.data?.integrity.ok ? t("正常") : t("发现异常")}</strong></div><div className="maintenance-actions">
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { const { backup } = await internalClient.createDatabaseBackup(); return t("备份已创建：{0}（{1} KB）", [backup.id, Math.ceil(backup.size / 1024)]); })}><Database size={16} />{t("创建数据库备份")}</button>
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { const { media } = await internalClient.getMediaConsistency(); return t("已检查 {0} 件作品、{1} 个文件，发现 {2} 项问题", [media.assetCount, media.fileCount, media.issueCount]); })}><Check size={16} />{t("检查媒体文件")}</button>
    <button className="quiet-command" disabled={!online || busy} onClick={() => void action(async () => { await internalClient.reconcileMediaConsistency(); const { repairs } = await internalClient.runMediaRepairs(); return t("已修复 {0} 项，{1} 项等待重试，{2} 项需要人工处理", [repairs.repaired, repairs.retried, repairs.manual]); })}><RefreshCw size={16} />{t("修复缺失预览")}</button>
  </div>{busy && <p className="loading-state" role="status">{t("正在处理…")}</p>}{result && <p className="success-state" role="status">{result}</p>}{error && <p className="error-state" role="alert">{error}</p>}</div>;
}

function ApplicationSettings({ online }: { online: boolean }) {
  const state = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const standalone = useStandaloneMode();
  const settings = useSettingsQuery();
  const patch = usePatchSettings();
  const values = readPwaSettings(settings.data?.settings);
  return <div className="preferences"><div className="setting-line"><span>{t("网络")}</span><strong>{online ? t("在线") : t("离线")}</strong></div><div className="setting-line"><span>{t("应用安装")}</span><strong>{standalone || state.installed ? t("已安装") : !window.isSecureContext ? t("需要 HTTPS") : state.installPromptAvailable ? t("可安装") : t("浏览器模式")}</strong></div>
    {state.installPromptAvailable && <button className="quiet-command" disabled={state.installPromptPending} onClick={() => void promptPwaInstall()}><Download size={16} />{t("安装应用")}</button>}
    {isIosSafari() && !standalone && <p className="platform-note">{t("Safari：分享 → 添加到主屏幕")}</p>}
    <label className="setting-line"><span>{t("应用更新提醒")}</span><input type="checkbox" aria-label={t("应用更新提醒")} checked={values.updateNotifications} disabled={!online || patch.isPending} onChange={event => patch.mutate({ 'pwa.update_notifications': event.target.checked })} /></label>
    <div className="setting-line"><span>{t("应用版本")}</span><strong>{state.updateAvailable ? t("有可用更新") : t("当前版本")}</strong></div>{state.updateAvailable && <button className="quiet-command" disabled={state.updating} onClick={() => void activatePwaUpdate()}>{rich("{0}应用更新", [state.updating ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />])}</button>}
    {state.error && window.isSecureContext && <p className="error-state" role="alert">{state.error}</p>}
  </div>;
}
