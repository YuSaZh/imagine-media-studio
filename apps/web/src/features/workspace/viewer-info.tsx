import { formatDateTime, t, rich } from '../../i18n/index';
import { useCallback, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, FolderPlus, Trash2, X } from 'lucide-react';
import type { ViewerProps } from './viewer';
import { JOB_LABELS } from './data';
import { Choice, Options, Tool } from './ui';
import { copyPrompt } from './copy-prompt';
import { formatGenerationTime, generationSeconds } from './generation-time';

type Props = Pick<ViewerProps, 'item' | 'projects' | 'online' | 'providerName' | 'onDelete' | 'onProject' | 'onNotice'> & {
  id: string;
  writeDisabled: boolean;
  onClose: () => void;
};

export function ViewerInfo(props: Props) {
  const { item } = props;
  const card = useRef<HTMLElement>(null), header = useRef<HTMLElement>(null), body = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), prompt = useRef<HTMLParagraphElement>(null);
  const [preview, setPreview] = useState({ lines: 1, overflow: false }), [expanded, setExpanded] = useState(false);
  const canCollapse = preview.overflow;
  const promptId = useId();
  const measure = useCallback(() => {
    if (!card.current || !header.current || !content.current || !prompt.current) return;
    const cardStyle = getComputedStyle(card.current);
    const maximum = parseFloat(cardStyle.maxHeight);
    const lineHeight = parseFloat(getComputedStyle(prompt.current).lineHeight);
    const fullPrompt = prompt.current.scrollHeight;
    // The content wrapper measures intrinsic content, even when the scroll body
    // fills the card. Reserve the header, actions and metadata before assigning
    // every remaining complete line to the prompt.
    const otherHeight = header.current.getBoundingClientRect().height + content.current.getBoundingClientRect().height - prompt.current.getBoundingClientRect().height
      + parseFloat(cardStyle.borderTopWidth) + parseFloat(cardStyle.borderBottomWidth);
    const lines = Math.max(1, Math.floor((maximum - otherHeight) / lineHeight));
    const overflow = fullPrompt > lines * lineHeight + 1;
    setPreview(current => current.lines === lines && current.overflow === overflow ? current : { lines, overflow });
  }, []);
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [card.current, header.current, content.current, prompt.current]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [measure, item.prompt, item.job, expanded]);
  const elapsed = item.job?.completedAt ? generationSeconds(item.job.createdAt, item.job.completedAt) : null;
  return <aside className={`viewer-info ${canCollapse ? 'has-overflowing-prompt' : ''}`} id={props.id} aria-label={t("作品信息")} ref={card} style={{ '--viewer-prompt-lines': preview.lines } as CSSProperties}>
    <header ref={header}><h3>{t("作品信息")}</h3><Tool label={t("关闭作品信息")} onClick={props.onClose}><X size={17} /></Tool></header>
    <div className="viewer-info-body" ref={body}>
    <div className="viewer-info-content" ref={content}>
      <span className="muted-label">{t("提示词")}</span>
      <p id={promptId} ref={prompt} className={`viewer-info-prompt ${canCollapse && !expanded ? 'is-collapsed' : ''}`}>{item.prompt || t("本地上传素材")}</p>
      {item.prompt && <div className="viewer-prompt-actions">
        {canCollapse && <button type="button" className="text-command viewer-prompt-toggle" aria-controls={promptId} aria-expanded={expanded} onClick={() => { if (expanded) body.current?.scrollTo({ top: 0 }); setExpanded(!expanded); }}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{expanded ? t("收起") : t("展开全部")}</button>}
        <button className="text-command" onClick={() => void copyPrompt(item.prompt, props.onNotice)}><Copy size={15} />{t("复制提示词")}</button>
      </div>}
      <dl><div><dt>{t("服务")}</dt><dd>{props.providerName}</dd></div><div><dt>{t("模型")}</dt><dd>{item.model}</dd></div><div><dt>{t("尺寸")}</dt><dd>{item.width} × {item.height}</dd></div><div><dt>{t("类型")}</dt><dd>{item.mimeType || (item.kind === 'image' ? t("图片") : t("视频"))}</dd></div>{item.durationSeconds !== null && <div><dt>{t("时长")}</dt><dd>{rich("{0} 秒", [item.durationSeconds.toFixed(1)])}</dd></div>}<div><dt>{t("生成时间")}</dt><dd>{elapsed === null ? '—' : formatGenerationTime(elapsed)}</dd></div><div><dt>{t("创建时间")}</dt><dd>{formatDateTime(item.createdAt)}</dd></div>{item.job && <div><dt>{t("状态")}</dt><dd>{JOB_LABELS[item.job.status]}</dd></div>}</dl>
      {props.online && <Options label={t("加入项目")} contentClassName="viewer-info-projects" trigger={<><FolderPlus size={16} />{t("加入项目")}</>}><div className="option-heading">{t("项目")}</div>{props.projects.length ? props.projects.map(project => <Choice key={project.id} active={item.collectionIds.includes(project.id)} onClick={() => props.onProject(project.id, !item.collectionIds.includes(project.id))}><span>{project.name}</span>{item.collectionIds.includes(project.id) && <Check size={15} />}</Choice>) : <p className="menu-empty">{t("还没有项目")}</p>}</Options>}
      {item.job && <details className="request-details" onToggle={measure}><summary>{t("请求参数")}</summary><pre>{JSON.stringify(item.job.request, null, 2)}</pre></details>}
      <button className="text-command danger" disabled={props.writeDisabled} onClick={props.onDelete}><Trash2 size={15} />{t("删除作品")}</button>
    </div>
    </div>
  </aside>;
}
