import { t, rich } from '../../i18n/index';
import { Select, SelectItem } from './select';
import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileCode2, Play, Plus, RefreshCw, Save, ShieldCheck, Trash2, Upload } from 'lucide-react';
import {
  adapterWorkspaceDisabledState, applyImportedAdapterDocument, applyImportedTrustedManifest,
  createLatestImportSequence, DEFAULT_CUSTOM_HTTP_DRAFT, DEFAULT_TRUSTED_JS_DRAFT,
  mapCustomHttpDraftToPayload, mapCustomHttpPathTestToPayload, mapTrustedJsDraftToPayload,
  parseJsonText, redactCustomHttpPreview, settleLatestImport,
  type CustomAdapterWorkspaceActions, type CustomAdapterWorkspaceProps, type CustomHttpDraft, type TrustedJsDraft,
} from '../settings/model/adapter-workspace';
import { Tool } from './ui';

export function CustomAdapterWorkspace(props: CustomAdapterWorkspaceProps) {
  const [tab, setTab] = useState('definition');
  const [http, setHttp] = useState<CustomHttpDraft>({ ...DEFAULT_CUSTOM_HTTP_DRAFT, ...props.customHttp });
  const [trusted, setTrusted] = useState<TrustedJsDraft>({ ...DEFAULT_TRUSTED_JS_DRAFT, ...props.trustedJs });
  const [source, setSource] = useState<File | null>(null);
  const [lookup, setLookup] = useState('');
  const [busy, setBusy] = useState(false);
  const [importPending, setImportPending] = useState(false);
  const [message, setMessage] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(createLatestImportSequence());
  const actions: CustomAdapterWorkspaceActions = { ...props, ...props.actions };
  const js = props.mode === 'trusted-js';
  const status = props.online === false ? 'offline' : props.status ?? props.state ?? 'success';
  const disabled = adapterWorkspaceDisabledState({ adminAvailable: props.adminAvailable ?? true, disabled: props.disabled ?? false, importPending, mode: js ? 'trusted-js' : 'custom-http', status });
  const commandDisabled = disabled.remoteDisabled || busy;
  const updateHttp = (next: CustomHttpDraft) => { setHttp(next); actions.onCustomHttpChange?.(next); setMessage(''); };
  const updateTrusted = (next: TrustedJsDraft) => { setTrusted(next); actions.onTrustedJsChange?.(next); setMessage(''); };
  useEffect(() => { const active = sequence.current; return () => active.invalidate(); }, []);
  const run = async (action: () => unknown | Promise<unknown>) => {
    if (commandDisabled) return;
    setBusy(true); setMessage('');
    try { const result = await action(); if (result === false) setMessage(t("操作已取消")); }
    catch (error) { setMessage(error instanceof Error ? error.message : t("操作失败")); }
    finally { setBusy(false); }
  };
  const importDocument = async (file: File) => {
    if (importPending || disabled.localDisabled) return;
    setImportPending(true); setMessage('');
    const token = sequence.current.begin();
    const result = await settleLatestImport(sequence.current, token, async () => {
      if (js) return actions.onManifestFileImport?.(file);
      return actions.onImportDocument?.(file);
    }, value => {
      if (js && typeof value === 'string') updateTrusted(applyImportedTrustedManifest(trusted, value));
      if (!js && value && typeof value === 'object' && 'document' in value) updateHttp(applyImportedAdapterDocument(http, value));
      if (!js && typeof value === 'string') updateHttp({ ...http, document: value });
    });
    if (result.state === 'stale') return;
    setImportPending(false);
    if (result.state === 'error') setMessage(result.error instanceof Error ? result.error.message : t("文件导入失败"));
  };
  const payload = () => mapCustomHttpDraftToPayload(http, props.providerId);
  const revisionRows = props.revisions ?? [];
  const output = tab === 'debug' ? { preview: props.preview ? redactCustomHttpPreview(props.preview) : null, capabilities: props.capabilityPreview, dryRun: props.dryRunResult, simulation: props.simulationResult, path: props.pathTestResult } : null;

  return <div className="adapter-workbench">
    <div className="adapter-tabs" role="tablist" aria-label={t("适配器管理")}>{[{ key: 'definition', label: js ? t("安装与绑定") : t("请求定义") }, ...(!js ? [{ key: 'debug', label: t("调试") }] : []), { key: 'revisions', label: t("版本记录") }].map(item => <button role="tab" aria-selected={tab === item.key} key={item.key} onClick={() => setTab(item.key)}>{item.label}</button>)}</div>
    {(message || props.statusMessage) && <p className={message ? 'error-state' : 'adapter-status'} role={message ? 'alert' : 'status'}>{message || props.statusMessage}</p>}
    {status === 'offline' && <p className="offline-banner">{t("离线时无法修改适配器")}</p>}
    {props.adminAvailable === false && <p className="error-state" role="alert">{t("适配器管理需要应用密码认证")}</p>}
    <input ref={fileRef} hidden aria-label={js ? t("导入 Manifest") : t("导入适配器文件")} type="file" accept={js ? '.json' : '.json,.yaml,.yml'} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importDocument(file); }} />
    {tab === 'definition' && !js && <>
      <div className="adapter-toolbar"><label>{t("格式")}<Select aria-label={t("适配器格式")} value={http.format} disabled={disabled.localDisabled || importPending} onChange={event => updateHttp({ ...http, format: event.target.value as 'json' | 'yaml' })}><SelectItem value="json">JSON</SelectItem><SelectItem value="yaml">YAML</SelectItem></Select></label><label>{t("版本")}<input aria-label={t("适配器版本")} value={http.version} maxLength={64} disabled={disabled.localDisabled || importPending} onChange={event => updateHttp({ ...http, version: event.target.value })} /></label><span /><Tool label={t("导入定义")} disabled={disabled.localDisabled || importPending || busy} onClick={() => fileRef.current?.click()}><Upload size={18} /></Tool><Tool label={t("导出定义")} disabled={commandDisabled} onClick={() => void run(() => actions.onExport?.({ format: http.format }))}><Download size={18} /></Tool><Tool label={t("验证定义")} disabled={commandDisabled} onClick={() => void run(() => actions.onValidate?.(payload()))}><Check size={18} /></Tool><button className="primary-command" disabled={commandDisabled} onClick={() => void run(() => actions.onSave?.(payload()))}><Save size={16} />{t("保存定义")}</button></div>
      <label className="adapter-document"><span className="muted-label">{t("请求定义")}</span><textarea aria-label={t("适配器定义")} className="code-input" rows={22} spellCheck={false} disabled={disabled.localDisabled || importPending} maxLength={256 * 1024} value={http.document} onChange={event => { sequence.current.invalidate(); updateHttp({ ...http, document: event.target.value }); }} /></label>
      <button className="text-command" disabled={commandDisabled} onClick={() => void run(() => actions.onCapabilitiesPreview?.(payload()))}>{t("查看模型能力")}</button>
      {props.capabilityPreview !== undefined && <pre className="adapter-result">{JSON.stringify(props.capabilityPreview, null, 2)}</pre>}
    </>}
    {tab === 'debug' && !js && <>
      <div className="form-columns"><label>Base URL<input aria-label={t("调试 Base URL")} value={http.baseUrl} onChange={event => updateHttp({ ...http, baseUrl: event.target.value })} /></label><label>{t("测试请求 JSON")}<textarea className="code-input" aria-label={t("测试请求 JSON")} rows={6} value={http.requestJson} onChange={event => updateHttp({ ...http, requestJson: event.target.value })} /></label></div>
      <div className="adapter-toolbar"><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onPreview?.(payload()))}><FileCode2 size={16} />{t("请求预览")}</button><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onDryRun?.(payload()))}><Play size={16} />Dry Run</button></div>
      <details className="form-advanced"><summary>{t("响应模拟与路径检查")}</summary><label>{t("响应状态")}<input type="number" aria-label={t("模拟响应状态")} min={100} max={599} value={http.simulationStatus} onChange={event => updateHttp({ ...http, simulationStatus: event.target.value })} /></label><label>{t("响应 JSON")}<textarea className="code-input" aria-label={t("模拟响应 JSON")} rows={5} value={http.simulationJson} onChange={event => updateHttp({ ...http, simulationJson: event.target.value })} /></label><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onSimulate?.({ ...payload(), response: { status: Number(http.simulationStatus), json: parseJsonText(http.simulationJson, 'Response') } }))}>{t("模拟响应")}</button><label>JSON Pointer<input aria-label="JSON Pointer" value={http.path} onChange={event => updateHttp({ ...http, path: event.target.value })} /></label><label>{t("路径测试 JSON")}<textarea className="code-input" aria-label={t("路径测试 JSON")} rows={5} value={http.pathTestJson} onChange={event => updateHttp({ ...http, pathTestJson: event.target.value })} /></label><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onPathTest?.(mapCustomHttpPathTestToPayload(http, props.providerId)))}>{t("检查路径")}</button></details>
      <pre className="adapter-result" aria-label={t("调试结果")}>{JSON.stringify(output, null, 2)}</pre>
    </>}
    {tab === 'definition' && js && <>
      <div className="adapter-toolbar"><Tool label={t("导入 Manifest")} disabled={disabled.localDisabled || importPending || busy} onClick={() => fileRef.current?.click()}><Upload size={18} /></Tool><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onListTrusted?.())}><RefreshCw size={16} />{t("刷新已安装版本")}</button></div>
      <label>Manifest JSON<textarea className="code-input" aria-label="Manifest JSON" rows={12} value={trusted.manifest} disabled={disabled.localDisabled || importPending} onChange={event => updateTrusted({ ...trusted, manifest: event.target.value })} /></label>
      <label className="source-picker">{t("JavaScript 源文件")}<input type="file" aria-label={t("JavaScript 源文件")} accept=".js,.mjs,.cjs" disabled={commandDisabled} onChange={event => { const file = event.target.files?.[0]; if (file) { setSource(file); void actions.onSourceFileSelect?.(file); } }} /></label>
      <button className="primary-command" disabled={commandDisabled || !source} onClick={() => void run(() => { const input = mapTrustedJsDraftToPayload({ ...trusted, providerId: props.providerId ?? '' }, source); if (!input.source || !input.sourceFile) throw new Error(t("请选择 JavaScript 源文件")); return actions.onInstall?.({ ...input, source: input.source, sourceFile: input.sourceFile }); })}><ShieldCheck size={16} />{t("安装并绑定")}</button>
      <div className="adapter-lookup"><input aria-label={t("查找适配器 ID")} placeholder={t("适配器 ID")} value={lookup} onChange={event => setLookup(event.target.value)} /><button className="quiet-command" disabled={commandDisabled || !lookup.trim()} onClick={() => void run(() => actions.onGetTrusted?.(lookup.trim()))}>{t("查看版本")}</button></div>
      <div className="installed-adapters">{props.trustedAdapters?.map(item => <div className="adapter-revision" key={item.adapterId}><div><strong>{item.displayName ?? item.adapterId}</strong><small>{item.version}</small><code>{item.ref?.digest}</code></div><Tool label={t("绑定 {0}", [item.adapterId])} disabled={commandDisabled || !item.ref} onClick={() => void run(() => actions.onBindProvider?.({ providerId: props.providerId ?? '', ...(item.ref ? { ref: item.ref } : {}) }))}><Plus size={17} /></Tool><Tool label={t("移除 {0}", [item.adapterId])} disabled={commandDisabled} onClick={() => void run(() => actions.onRemoveTrusted?.(item.adapterId))}><Trash2 size={17} /></Tool></div>)}</div>
      {props.trustedBinding?.ref && <div className="binding-actions"><strong>{rich("当前绑定：{0}", [props.trustedBinding.displayName ?? props.trustedBinding.adapterId])}</strong><button className="quiet-command" disabled={commandDisabled || props.trustedBindingDisabled} onClick={() => void run(() => actions.onDisableProviderBinding?.(props.trustedBinding!.ref))}>{t("停用绑定")}</button><button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onUnbindProvider?.(props.trustedBinding!.ref!))}>{t("解除绑定")}</button></div>}
    </>}
    {tab === 'revisions' && <><div className="adapter-revisions">{revisionRows.length ? revisionRows.map(revision => <div className="adapter-revision" key={revision.digest}><div><strong>{revision.version}{revision.current ? t(" · 当前") : ''}{revision.disabled ? t(" · 已停用") : ''}</strong><small>{revision.adapterId}</small><code>{revision.digest}</code></div><Tool label={t("加载版本 {0}", [revision.version])} disabled={commandDisabled} onClick={() => void run(() => actions.onLoadRevision?.(revision))}><RefreshCw size={17} /></Tool>{!js && <><Tool label={t("导出版本 {0}", [revision.version])} disabled={commandDisabled} onClick={() => void run(() => actions.onExport?.({ format: http.format, ref: revision }))}><Download size={17} /></Tool><button className="text-command" disabled={commandDisabled || revision.disabled} onClick={() => void run(() => actions.onDisable?.(revision))}>{t("停用")}</button>{revision.current && <Tool label={t("删除版本 {0}", [revision.version])} disabled={commandDisabled} onClick={() => void run(() => actions.onDelete?.(revision))}><Trash2 size={17} /></Tool>}</>}</div>) : <p className="menu-empty">{t("暂无版本记录")}</p>}</div>{props.revisionsCursor && <button className="quiet-command" disabled={commandDisabled} onClick={() => void run(() => actions.onLoadMoreRevisions?.(props.revisionsCursor))}>{t("加载更多版本")}</button>}</>}
  </div>;
}
