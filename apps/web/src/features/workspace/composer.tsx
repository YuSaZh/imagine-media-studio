import { useEffect, useRef, useState } from 'react';
import { DEFAULT_IMAGE_INPUT_POLICY, type JsonObject } from '@imagine/shared';
import { ArrowUp, Check, ChevronDown, Image as ImageIcon, LoaderCircle, Plus, Ratio, RefreshCw, SlidersHorizontal, SquareDashed, Upload, Video, X } from 'lucide-react';
import { COMPOSER_DRAFT_MAX_PROMPT_LENGTH } from '../composer/model/composer-draft';
import type { useReferenceUploads } from '../media-input/hooks/use-reference-uploads';
import { filesFromClipboard, filesFromDataTransfer } from '../media-input/model/acquisition';
import { storedInputAvailability, descriptorsExceedingTotalBytes } from '../media-input/model/input-compatibility';
import type { AcquisitionRejection } from '../media-input/model/types';
import { Choice, Options, Tool } from './ui';
import { operationFor, type Creation, type MediaKind, type ReferenceInput, type WorkspaceModel } from './data';
import { allowsCustomSize, ExtraParameters } from './generation-options';
import { managedParameters, ManagedParameters } from './managed-parameters';
import { useSettingsQuery, usePatchSettings } from '../settings/api/settings-query';
import { memoryObject, readGenerationMemory, updateGenerationMemory } from './generation-memory';
import { DesktopVideoOptions } from './desktop-video-options';
import type { WorkspaceLayout } from './workspace-layout';

interface ComposerProps {
  layout: WorkspaceLayout;
  projectId: string | null;
  prompt: string;
  onPrompt: (prompt: string) => void;
  mode: MediaKind;
  onMode: (mode: MediaKind) => void;
  videoMode: 'text' | 'first_frame' | 'references';
  onVideoMode: (mode: 'text' | 'first_frame' | 'references') => void;
  models: WorkspaceModel[];
  model: WorkspaceModel | undefined;
  onModel: (key: string) => void;
  references: readonly ReferenceInput[];
  uploads: ReturnType<typeof useReferenceUploads>;
  onFiles: (files: readonly File[], rejected?: readonly AcquisitionRejection[]) => void;
  onRemove: (assetId: string) => void;
  onCreate: (creation: Creation) => void;
  onConnections: () => void;
  onLibrary: () => void;
  online: boolean;
  submitting: boolean;
  loading: boolean;
  focusToken: number;
}

const UPLOAD_STATUS = { queued: '等待上传', preprocessing: '准备图片', uploading: '正在上传', ready: '已上传', error: '上传失败' };

export function Composer(props: ComposerProps) {
  const { model, mode, prompt, references, uploads, videoMode } = props;
  const [ratio, setRatio] = useState('auto');
  const [resolution, setResolution] = useState('');
  const [customWidth, setCustomWidth] = useState(1024);
  const [customHeight, setCustomHeight] = useState(1024);
  const [extra, setExtra] = useState<JsonObject>({});
  const [parameters, setParameters] = useState<JsonObject>({});
  const rules = managedParameters(model);
  const ratioRule = rules?.find(rule => rule.path === 'aspectRatio' && rule.enabled && rule.visible);
  const ratioOptions = rules ? ratioRule?.options?.map(String) ?? [] : ['auto', ...model?.capabilities.aspectRatios.filter(value => value !== 'auto') ?? []];
  const selectedRatio = ratioRule ? String(ratioRule.locked ? ratioRule.defaultValue ?? 'auto' : parameters.aspectRatio ?? ratioRule.defaultValue ?? 'auto') : ratio;
  const [count, setCount] = useState(1);
  const [duration, setDuration] = useState(5);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [seed, setSeed] = useState('');
  const [audio, setAudio] = useState(false);
  const [dragging, setDragging] = useState(false);
  const savedSettings = useSettingsQuery();
  const saveSettings = usePatchSettings();
  const hydratedModel = useRef('');
  const [hydrated, setHydrated] = useState(false);
  const lastSaved = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const dragDepth = useRef(0);
  const operation = operationFor(mode, videoMode, references);
  const policy = model?.capabilities.inputImagePolicy ?? DEFAULT_IMAGE_INPUT_POLICY;
  const descriptors = references.map(input => ({ fileSize: input.asset.fileSize, mimeType: input.asset.mimeType, width: input.asset.width ?? 0, height: input.asset.height ?? 0 }));
  const referenceCount = references.filter(input => input.role === 'reference').length;
  const hasSource = references.some(input => input.role === 'source');
  const invalidReferences = references.some((input, index) => {
    if (storedInputAvailability({ persistedAsset: true, inputDescriptor: descriptors[index]! }, policy, true) !== 'ready') return true;
    if (mode === 'image') {
      if (input.role === 'mask') return !hasSource || !model?.capabilities.supportsMask;
      return !['source', 'reference'].includes(input.role);
    }
    return videoMode === 'text' || (videoMode === 'first_frame' ? input.role !== 'first_frame' : input.role !== 'reference');
  }) || referenceCount > (model?.capabilities.maxReferenceImages ?? 0) ||
    (mode === 'video' && videoMode === 'first_frame' && references.length !== 1) ||
    (mode === 'video' && videoMode === 'references' && references.length === 0) ||
    descriptorsExceedingTotalBytes(descriptors, policy).size > 0;
  const preparing = uploads.state.entries.some(entry => entry.status !== 'ready' || !references.some(input => input.asset.id === entry.assetId));
  const canSubmit = hydrated && !!model && props.online && !!prompt.trim() && !preparing && !invalidReferences && !props.submitting && !props.loading;
  const uploadMaximum = mode === 'video' && videoMode === 'first_frame' ? 1 : model?.capabilities.maxReferenceImages ?? 0;
  const uploadAllowed = !!model && props.online && uploadMaximum > 0 && !(mode === 'video' && videoMode === 'text');
  const localAssetIds = new Set(uploads.state.entries.map(entry => entry.assetId));

  useEffect(() => {
    if (!model || !savedSettings.data || hydratedModel.current === model.key) return;
    hydratedModel.current = model.key;
    const raw = memoryObject(readGenerationMemory(savedSettings.data.settings, props.projectId, mode).models)[model.key]
      ?? (props.projectId === null ? savedSettings.data.settings[`model.${model.key}`] : undefined);
    const saved: JsonObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as JsonObject : {};
    const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
    setRatio(typeof saved.ratio === 'string' && (saved.ratio === 'auto' || model.capabilities.aspectRatios.includes(saved.ratio)) ? saved.ratio : 'auto');
    setResolution(typeof saved.resolution === 'string' && (model.capabilities.resolutions.includes(saved.resolution) || saved.resolution === 'custom' && allowsCustomSize(model)) ? saved.resolution : '');
    setCount(typeof saved.count === 'number' ? Math.max(1, Math.min(saved.count, 32)) : 1);
    const range = model.capabilities.durationRange;
    const duration = typeof saved.duration === 'number' ? saved.duration : 5;
    setDuration(range ? Math.max(range.min, Math.min(range.max, duration)) : model.capabilities.durations.includes(duration) ? duration : model.capabilities.durations[0] ?? 5);
    setCustomWidth(typeof saved.customWidth === 'number' ? saved.customWidth : 1024);
    setCustomHeight(typeof saved.customHeight === 'number' ? saved.customHeight : 1024);
    const savedParameters = { ...object(saved.parameters) };
    const aspectRule = managedParameters(model)?.find(rule => rule.path === 'aspectRatio');
    if (aspectRule && !aspectRule.options?.includes(String(savedParameters.aspectRatio))) delete savedParameters.aspectRatio;
    setExtra(object(saved.extra)); setParameters(savedParameters);
    setNegativePrompt(typeof saved.negativePrompt === 'string' ? saved.negativePrompt : '');
    setSeed(typeof saved.seed === 'string' ? saved.seed : ''); setAudio(saved.audio === true);
    setHydrated(true);
  }, [model, savedSettings.data, props.projectId, mode]);
  useEffect(() => {
    if (!hydrated || !model || !savedSettings.data) return;
    const options = { ratio, resolution, count, duration, customWidth, customHeight, extra, parameters, negativePrompt, seed, audio };
    const serialized = JSON.stringify(options);
    if (!lastSaved.current) { lastSaved.current = serialized; return; }
    if (lastSaved.current === serialized) return;
    lastSaved.current = serialized;
    const memory = readGenerationMemory(savedSettings.data.settings, props.projectId, mode);
    saveSettings.mutate(updateGenerationMemory(savedSettings.data.settings, props.projectId, mode, { models: { ...memoryObject(memory.models), [model.key]: options } }));
  }, [hydrated, model, savedSettings.data, props.projectId, mode, ratio, resolution, count, duration, customWidth, customHeight, extra, parameters, negativePrompt, seed, audio, saveSettings]);
  useEffect(() => {
    if (resolution !== 'custom' || !Number.isInteger(customWidth) || !Number.isInteger(customHeight) || customWidth < 1 || customHeight < 1) return;
    let divisor = customWidth;
    let remainder = customHeight;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    setRatio(`${customWidth / divisor}:${customHeight / divisor}`);
  }, [customWidth, customHeight, resolution]);
  useEffect(() => { if (props.focusToken) textareaRef.current?.focus(); }, [props.focusToken]);
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => document.documentElement.style.setProperty('--composer-size', `${element.offsetHeight}px`));
    observer.observe(element);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--composer-size'); };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => document.documentElement.style.setProperty('--keyboard-lift', `${viewport ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0}px`);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => { viewport?.removeEventListener('resize', update); viewport?.removeEventListener('scroll', update); document.documentElement.style.removeProperty('--keyboard-lift'); };
  }, []);

  const submit = () => {
    if (!canSubmit || !model) return;
    props.onCreate({ model, operation, prompt, inputs: references, ratio, resolution: resolution === 'custom' ? `${customWidth}x${customHeight}` : resolution, count, duration, negativePrompt, seed, audio, extra, parameters });
  };
  const modelOptions = props.models.filter(candidate => candidate.capabilities.operations.includes(operation));
  const sizeLabel = rules ? selectedRatio : resolution === 'custom' ? `${customWidth}×${customHeight}` : resolution || ratio;
  const chooseRatio = (value: string) => {
    if (ratioRule) { if (!ratioRule.locked) setParameters({ ...parameters, aspectRatio: value }); }
    else { setRatio(value); if (mode === 'image' && (resolution === 'custom' || /^\d+x\d+$/.test(resolution))) setResolution(''); }
  };
  const videoModes = [
    { key: 'text' as const, label: '文字', operation: 'video.generate' as const },
    { key: 'first_frame' as const, label: '首帧', operation: 'video.image_to_video' as const },
    { key: 'references' as const, label: '参考图', operation: 'video.reference_to_video' as const },
  ].filter(option => props.models.some(candidate => candidate.capabilities.operations.includes(option.operation)));
  const videoInputChoices = mode === 'video' && videoModes.length > 1 ? <div className="video-input-choices segments" aria-label="视频输入方式" role="group">{videoModes.map(option => <button type="button" key={option.key} aria-pressed={videoMode === option.key} onClick={() => props.onVideoMode(option.key)}>{option.label}</button>)}</div> : null;

  return <form className={`creation-composer composer-${props.layout} ${dragging ? 'is-dragging' : ''}`} ref={composerRef} aria-label="生成工作区" onSubmit={event => { event.preventDefault(); submit(); }}
    onDragEnter={event => { event.preventDefault(); dragDepth.current += 1; setDragging(true); }}
    onDragOver={event => event.preventDefault()}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); const files = filesFromDataTransfer(event.dataTransfer); props.onFiles(files.files, files.rejected); }}>
    {dragging && <div className="drop-target"><Plus size={28} /></div>}
    {saveSettings.isError && <p className="composer-notice" role="alert">模型设置保存失败</p>}
    {(references.length > 0 || uploads.state.entries.length > 0) && <div className="reference-tray">
      {references.filter(input => !localAssetIds.has(input.asset.id)).map((input, index) => <div className="reference" key={input.asset.id}>
        <img src={input.asset.thumbnailUrl ?? input.asset.contentUrl} alt={input.asset.originalFilename ?? '参考图片'} /><span>{{ source: '原图', reference: '参考', first_frame: '首帧', last_frame: '尾帧', mask: '蒙版' }[input.role]}</span>
        <Tool label={`移除参考图 ${index + 1}`} onClick={() => props.onRemove(input.asset.id)}><X size={13} /></Tool>
      </div>)}
      {uploads.state.entries.map((entry, index) => <div className={`reference upload-${entry.status}`} key={entry.clientId}>
        <img src={entry.previewUrl} alt={entry.file.name} /><span>{UPLOAD_STATUS[entry.status]}</span><Tool label={`移除上传图片 ${index + 1}`} onClick={() => uploads.remove(entry.clientId)}><X size={13} /></Tool>
        {entry.status === 'error' && <button className="upload-retry" type="button" aria-label="重试上传" title={entry.error ?? '重试上传'} onClick={() => uploads.retry(entry.clientId)}><RefreshCw size={15} /></button>}
      </div>)}
    </div>}
    <textarea ref={textareaRef} aria-label="创作描述" placeholder={mode === 'image' ? (hasSource ? '想怎样修改这张图片？' : '描述你想创作的画面…') : (videoMode === 'text' ? '描述场景、镜头与动作…' : '让这个画面怎样动起来？')}
      maxLength={COMPOSER_DRAFT_MAX_PROMPT_LENGTH} value={prompt} rows={2} onChange={event => props.onPrompt(event.target.value)}
      onPaste={event => { const files = filesFromClipboard(event.clipboardData); if (files.files.length) { if (!files.hasText) event.preventDefault(); props.onFiles(files.files, files.rejected); } }}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
    {!props.online ? <p className="composer-notice" role="status">当前离线，草稿已保留</p> : !model && !props.loading ? <div className="composer-notice" role="status"><span>没有支持当前创作类型的模型</span><button type="button" onClick={props.onConnections}>配置连接</button></div> : null}
    {uploads.state.rejections.length > 0 && <div className="composer-notice" role="alert"><span>{uploads.state.rejections.map(item => `${item.name}：${item.reason}`).join('；')}</span><button type="button" onClick={uploads.clearRejections}>关闭</button></div>}
    {invalidReferences && references.length > 0 && <p className="composer-notice" role="alert">参考图的角色、数量或大小与当前模型不兼容，请移除或切换模型。</p>}
    {props.layout === 'desktop' && videoInputChoices && <div className="desktop-video-mode-row">{videoInputChoices}</div>}
    <div className="creation-controls">
      <input ref={inputRef} hidden type="file" aria-label="上传参考图" accept="image/*" multiple onChange={event => { props.onFiles([...event.target.files ?? []]); event.target.value = ''; }} />
      {uploadAllowed ? <Options label="添加参考图" className="reference-trigger" trigger={<Plus size={20} />}><Choice active={false} onClick={() => inputRef.current?.click()}><Upload size={16} />上传新图片</Choice><Choice active={false} onClick={props.onLibrary}><ImageIcon size={16} />从资源库选择</Choice></Options> : <Tool label="添加参考图" className="reference-trigger" disabled><Plus size={20} /></Tool>}
      <div className="segments mode-segments" role="group" aria-label="创作类型"><button type="button" aria-label="图片" aria-pressed={mode === 'image'} onClick={() => props.onMode('image')}><ImageIcon size={15} /><span>图片</span></button><button type="button" aria-label="视频" aria-pressed={mode === 'video'} onClick={() => props.onMode('video')}><Video size={16} /><span>视频</span></button></div>
      {props.layout === 'mobile' && <div className="video-input-row">{videoInputChoices}</div>}
      <Options label="选择生成模型" className="model-trigger" trigger={<><span className="model-dot" /><span>{model?.name ?? '选择模型'}</span><ChevronDown size={13} /></>}><div className="option-heading">模型与服务</div>{modelOptions.map(option => <Choice key={option.key} active={model?.key === option.key} onClick={() => props.onModel(option.key)}><span className="choice-copy"><strong>{option.name}</strong><small>{option.providerName}</small></span>{model?.key === option.key && <Check size={15} />}</Choice>)}</Options>
      {model && ratioOptions.length > 0 && <Options label="选择画幅" className="ratio-trigger" trigger={<><Ratio size={15} /><span>{selectedRatio}</span><ChevronDown size={12} /></>}><div className="option-heading">画幅</div>{ratioRule?.locked ? <ManagedParameters rules={[ratioRule]} values={parameters} onChange={setParameters} /> : <div className="ratio-options">{ratioOptions.map(value => <Choice key={value} active={selectedRatio === value} onClick={() => chooseRatio(value)}>{value === 'auto' ? <SquareDashed className="ratio-auto" size={24} strokeWidth={1.5} aria-hidden="true" /> : <i style={{ aspectRatio: value.replace(':', '/') }} />}<span>{value}</span></Choice>)}</div>}</Options>}
      {props.layout === 'desktop' && mode === 'video' && <DesktopVideoOptions model={model} resolution={resolution} duration={duration} parameters={parameters} onResolution={setResolution} onDuration={setDuration} onParameters={setParameters} />}
      <Options label="生成设置" className="generation-settings-trigger" trigger={<SlidersHorizontal size={18} />}>
        <div className="option-heading">生成设置</div>
        <label className="setting-line mobile-control"><span>模型与服务</span><select aria-label="模型与服务" value={model?.key ?? ''} onChange={event => props.onModel(event.target.value)}>{modelOptions.map(option => <option key={option.key} value={option.key}>{option.providerName} · {option.name}</option>)}</select></label>
        {rules ? <ManagedParameters rules={rules} values={parameters} onChange={setParameters} /> : <>
        <label className="setting-line"><span>画幅</span><select aria-label="画幅" value={ratio} onChange={event => chooseRatio(event.target.value)}>{!ratioOptions.includes(ratio) && <option value={ratio} disabled>{ratio}</option>}{ratioOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        {<label className="setting-line"><span>生成数量</span><select aria-label="生成数量" value={count} onChange={event => setCount(Number(event.target.value))}>{Array.from({ length: 32 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value} {mode === 'image' ? '张' : '个'}</option>)}</select></label>}
        {!!model?.capabilities.resolutions.length && <label className="setting-line"><span>分辨率</span><select aria-label="分辨率" value={resolution} onChange={event => setResolution(event.target.value)}><option value="">跟随画幅</option>{model.capabilities.resolutions.map(value => <option key={value}>{value}</option>)}{allowsCustomSize(model) && <option value="custom">自定义尺寸</option>}</select></label>}
        {resolution === 'custom' && <div className="custom-dimensions"><label>宽度<input type="number" aria-label="像素宽度" min={1} max={16384} value={customWidth} onChange={event => setCustomWidth(Number(event.target.value))} /></label><span>×</span><label>高度<input type="number" aria-label="像素高度" min={1} max={16384} value={customHeight} onChange={event => setCustomHeight(Number(event.target.value))} /></label></div>}
        <ExtraParameters model={model} values={extra} onChange={setExtra} />
        {mode === 'video' && (!!model?.capabilities.durations.length || model?.capabilities.durationRange) && <label className="setting-line"><span>视频时长</span>{model?.capabilities.durationRange ? <input aria-label="视频时长" type="number" min={model.capabilities.durationRange.min} max={model.capabilities.durationRange.max} value={duration} onChange={event => setDuration(Number(event.target.value))} /> : <select aria-label="视频时长" value={duration} onChange={event => setDuration(Number(event.target.value))}>{model?.capabilities.durations.map(value => <option key={value} value={value}>{value} 秒</option>)}</select>}</label>}
        {model?.raw.capabilities.supportsNegativePrompt === true && <label className="setting-line stacked"><span>负面提示词</span><textarea aria-label="负面提示词" value={negativePrompt} onChange={event => setNegativePrompt(event.target.value)} /></label>}
        {model?.raw.capabilities.supportsSeed === true && <label className="setting-line"><span>种子</span><input aria-label="种子" value={seed} inputMode="numeric" onChange={event => setSeed(event.target.value)} placeholder="随机" /></label>}
        {mode === 'video' && model?.raw.capabilities.supportsAudio === true && <label className="setting-line"><span>生成音频</span><input type="checkbox" aria-label="生成音频" checked={audio} onChange={event => setAudio(event.target.checked)} /></label>}
        </>}
      </Options>
      <span className="composer-spacer" />
      <button type="submit" className="generate-button" aria-label="开始生成" disabled={!canSubmit}>{props.submitting ? <LoaderCircle className="spin" size={20} /> : <ArrowUp size={21} strokeWidth={2.5} />}</button>
    </div>
    <div className="mobile-model-status"><span>{model ? `${model.providerName} · ${model.name}` : props.loading ? '正在加载模型' : '尚未配置模型'}</span><span>{sizeLabel}{mode === 'image' ? ` · ${rules ? parameters.count ?? rules.find(rule => rule.path === 'count')?.defaultValue ?? 1 : count} 张` : ''}</span></div>
  </form>;
}
