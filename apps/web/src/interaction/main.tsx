import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserId } from '../browser-id';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowUpRight, Bookmark, Check, CheckCheck, Clock3, Copy, Folder, FolderPlus, Grid2X2, Image as ImageIcon, Layers3, LoaderCircle, Menu, MoreHorizontal, Pencil, Play, Plus, Search, Settings2, Sparkles, Trash2, Undo2, X } from 'lucide-react';
import { Composer, type Creation } from './composer';
import { INITIAL_STUDIES, readDraft, readLibrary, type DemoJob, type MediaKind, type Project, type Study } from './data';
import { Choice, Options, Panel, Tool } from './ui';
import { Viewer } from './viewer';
import './interaction.css';

type Section = 'create' | 'library' | 'saved' | 'projects';
const NAVIGATION = [
  { key: 'create', label: '创作', icon: Sparkles },
  { key: 'library', label: '全部作品', icon: Grid2X2 },
  { key: 'saved', label: '收藏', icon: Bookmark },
  { key: 'projects', label: '项目', icon: Folder },
] as const;
const initialLibrary = readLibrary();

function App() {
  const [section, setSection] = useState<Section>('create');
  const [studies, setStudies] = useState(initialLibrary.studies);
  const [projects, setProjects] = useState(initialLibrary.projects);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(readDraft);
  const [mode, setMode] = useState<MediaKind>('image');
  const [references, setReferences] = useState<Study[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionsEnabled, setConnectionsEnabled] = useState(true);
  const [projectEditor, setProjectEditor] = useState<Project | 'new' | null>(null);
  const [projectName, setProjectName] = useState('');
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [jobs, setJobs] = useState<DemoJob[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const objectUrls = useRef(new Set<string>());
  const mainRef = useRef<HTMLElement>(null);
  const showNotice = (text: string) => setNotice({ text });
  const currentProject = projects.find(project => project.id === projectId);
  const activeJobs = jobs.filter(job => ['queued', 'running'].includes(job.status));
  const viewerItem = studies.find(item => item.id === viewerId);
  const visibleItems = useMemo(() => studies.filter(item =>
    (section !== 'saved' || item.saved) &&
    (!projectId || item.projectId === projectId) &&
    (filter === 'all' || item.kind === filter) &&
    (!search.trim() || `${item.title} ${item.prompt} ${item.model}`.toLowerCase().includes(search.trim().toLowerCase())),
  ), [studies, section, projectId, filter, search]);

  useEffect(() => {
    try {
      localStorage.setItem('imagine.interaction.library.v1', JSON.stringify({ studies: studies.filter(item => item.src.startsWith('/interaction-media/')).slice(0, 150), projects }));
    } catch { /* The prototype remains usable when browser storage is unavailable. */ }
  }, [studies, projects]);
  useEffect(() => { try { localStorage.setItem('imagine.interaction.draft', prompt); } catch { /* Draft remains in memory. */ } }, [prompt]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { const ownedTimers = timers.current; return () => ownedTimers.forEach(timer => clearTimeout(timer)); }, []);
  useEffect(() => {
    const retained = new Set([...studies, ...references].map(item => item.src));
    retained.forEach(url => { if (url.startsWith('blob:')) objectUrls.current.add(url); });
    for (const url of objectUrls.current) {
      if (!retained.has(url)) { URL.revokeObjectURL(url); objectUrls.current.delete(url); }
    }
  }, [studies, references]);
  useEffect(() => { const urls = objectUrls.current; return () => urls.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => {
    const restore = () => {
      const [page, project] = location.hash.slice(1).split('/');
      if (NAVIGATION.some(item => item.key === page)) { setSection(page as Section); setProjectId(project ?? null); setViewerId(null); setSelected([]); setSelecting(false); setFilter('all'); setSearch(''); }
    };
    restore();
    addEventListener('hashchange', restore);
    return () => removeEventListener('hashchange', restore);
  }, []);

  const navigate = (next: Section, project: string | null = null) => {
    setSection(next); setProjectId(project); setSearch(''); setFilter('all'); setSelected([]); setSelecting(false); setMenuOpen(false); setViewerId(null);
    const hash = `#${project ? `${next}/${project}` : next}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    mainRef.current?.scrollTo({ top: 0 });
  };
  const save = (id: string) => setStudies(items => items.map(item => item.id === id ? { ...item, saved: !item.saved } : item));
  const moveToProject = (id: string, project: string | null) => {
    setStudies(items => items.map(item => item.id === id ? { ...item, projectId: project } : item));
    showNotice(project ? `已移入「${projects.find(item => item.id === project)?.name}」` : '已移出项目');
  };
  const remove = (ids: string[]) => {
    const removed = studies.filter(item => ids.includes(item.id));
    setStudies(items => items.filter(item => !ids.includes(item.id))); setSelected([]); setSelecting(false);
    if (viewerId && ids.includes(viewerId)) setViewerId(null);
    setNotice({ text: `已删除 ${removed.length} 件作品`, undo: () => { setStudies(items => [...removed, ...items]); showNotice('已恢复作品'); } });
  };
  const create = (creation: Creation) => {
    const id = createBrowserId();
    const source = creation.references[0];
    const destination = projectId;
    const job: DemoJob = { id, prompt: creation.prompt, kind: creation.kind, model: creation.model, count: creation.count, status: 'queued' };
    setJobs(items => [job, ...items]);
    setFilter('all'); setSearch('');
    timers.current.set(id, setTimeout(() => {
      setJobs(items => items.map(item => item.id === id ? { ...item, status: 'running' } : item));
      timers.current.set(id, setTimeout(() => {
        const sample = source ?? INITIAL_STUDIES[0]!;
        const outputs = Array.from({ length: creation.count }, (_, index): Study => ({
          id: `${id}-${index}`, title: creation.prompt.slice(0, 28), prompt: creation.prompt,
          src: creation.kind === 'video' ? '/interaction-media/coast.webp' : sample.src,
          kind: creation.kind, ratio: creation.ratio, model: creation.model,
          quality: creation.quality, durationSeconds: creation.durationSeconds,
          mimeType: creation.kind === 'video' ? 'video/mp4' : sample.mimeType ?? 'image/webp',
          saved: false, projectId: destination, ...(source ? { parentId: source.id } : {}),
        }));
        setStudies(items => [...outputs, ...items]);
        setJobs(items => items.map(item => item.id === id ? { ...item, status: 'completed' } : item));
        timers.current.delete(id);
        showNotice(`${creation.kind === 'image' ? `${creation.count} 张图片` : '视频'}已就绪`);
      }, 2400));
    }, 650));
  };
  const cancel = (id: string) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setJobs(items => items.map(item => item.id === id ? { ...item, status: 'cancelled' } : item));
    showNotice('任务已取消，创作描述已保留');
  };
  const continueWith = (item: Study, intent: 'edit' | 'reference' | 'video', nextPrompt?: string) => {
    navigate('create');
    setMode(intent === 'video' ? 'video' : 'image');
    setReferences([item]);
    setPrompt(nextPrompt ?? (intent === 'reference' ? prompt : ''));
    setFocusToken(value => value + 1);
    if (nextPrompt) showNotice('已带入原图，确认参数后即可生成');
  };
  const editProject = (project: Project | 'new') => { setProjectEditor(project); setProjectName(project === 'new' ? '' : project.name); };
  const saveProject = () => {
    const name = projectName.trim();
    if (!name) return;
    if (projectEditor === 'new') {
      const project = { id: createBrowserId(), name };
      setProjects(items => [...items, project]); navigate('projects', project.id);
    } else if (projectEditor) setProjects(items => items.map(item => item.id === projectEditor.id ? { ...item, name } : item));
    setProjectEditor(null);
  };
  const deleteProject = (project: Project) => {
    const memberIds = studies.filter(item => item.projectId === project.id).map(item => item.id);
    setProjects(items => items.filter(item => item.id !== project.id));
    setStudies(items => items.map(item => item.projectId === project.id ? { ...item, projectId: null } : item));
    navigate('projects');
    setNotice({ text: '项目已删除，作品仍在全部作品中', undo: () => { setProjects(items => [...items, project]); setStudies(items => items.map(item => memberIds.includes(item.id) ? { ...item, projectId: project.id } : item)); showNotice('已恢复项目'); } });
  };
  const navigation = <>{NAVIGATION.map(({ key, label, icon: Icon }) => <button type="button" aria-current={section === key ? 'page' : undefined} key={key} onClick={() => navigate(key)}><Icon size={20} /><span>{label}</span></button>)}</>;

  return <Tooltip.Provider delayDuration={250}><div className="imagine-app">
    <aside className="side-rail"><button className="identity" aria-label="Imagine 首页" onClick={() => navigate('create')}><Sparkles size={25} strokeWidth={1.7} /></button><nav aria-label="主导航">{NAVIGATION.map(({ key, label, icon: Icon }) => <Tool label={label} key={key} className={section === key ? 'is-active' : ''} aria-current={section === key ? 'page' : undefined} onClick={() => navigate(key)}><Icon size={21} strokeWidth={1.6} /></Tool>)}</nav><div className="rail-bottom"><Tool label="连接与偏好" onClick={() => setSettingsOpen(true)}><Settings2 size={21} strokeWidth={1.6} /></Tool><span className="avatar">Y</span></div></aside>
    <main ref={mainRef} className={`workspace section-${section}`}>
      <header className="workspace-header"><div className="workspace-location"><Tool label="打开导航" className="mobile-menu" onClick={() => setMenuOpen(true)}><Menu size={21} /></Tool><span className="wordmark" onClick={() => navigate('create')}>Imagine<span className="wordmark-dot">.</span></span><span className="header-divider" /><span className="current-location">{currentProject?.name ?? NAVIGATION.find(item => item.key === section)?.label}</span></div><div className="header-actions"><span className="preview-badge">交互预览</span><button className="task-indicator" aria-label="生成任务" onClick={() => setTaskOpen(true)}>{activeJobs.length ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={17} />}<span>任务</span>{activeJobs.length > 0 && <b>{activeJobs.length}</b>}</button><Tool className="mobile-settings" label="连接与偏好" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /></Tool></div></header>
      {section === 'create' && <section className="creation-area"><div className="creation-heading"><h1>Imagine</h1><span className="creation-mark"><Sparkles size={22} strokeWidth={1.3} /></span></div><Composer prompt={prompt} setPrompt={setPrompt} mode={mode} setMode={setMode} references={references} setReferences={setReferences} onCreate={create} connectionsEnabled={connectionsEnabled} onConnections={() => setSettingsOpen(true)} focusToken={focusToken} /></section>}
      <section className="library-area" aria-label="作品库">
        <div className="library-heading"><div className="library-title">{section === 'create' ? <><h2>最近创作</h2><span>{studies.length}</span></> : <><h1>{currentProject?.name ?? (section === 'library' ? '全部作品' : section === 'saved' ? '收藏' : '项目')}</h1><span>{section === 'projects' && !projectId ? projects.length : visibleItems.length}</span></>}</div><div className="library-tools">{section === 'projects' && !projectId ? <button className="quiet-command" onClick={() => editProject('new')}><Plus size={16} />新建项目</button> : <><label className="library-search"><Search size={16} /><input aria-label="搜索作品" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索作品" /></label><Tool label={selecting ? '退出多选' : '选择作品'} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setSelected([]); }}><CheckCheck size={19} /></Tool>{currentProject && <Options label="项目操作" trigger={<MoreHorizontal size={19} />}><Choice active={false} onClick={() => editProject(currentProject)}><Pencil size={15} />重命名</Choice><Choice active={false} onClick={() => deleteProject(currentProject)}><Trash2 size={15} />删除项目</Choice></Options>}</>}</div></div>
        {section === 'projects' && !projectId ? <div className="project-grid">{projects.map(project => {
          const members = studies.filter(item => item.projectId === project.id);
          return <article className="project-tile" key={project.id}><button className="project-open" onClick={() => navigate('projects', project.id)}><div className="project-cover">{members.slice(0, 3).map(item => <img key={item.id} src={item.src} alt="" />)}{members.length === 0 && <Folder size={36} strokeWidth={1} />}</div><span><strong>{project.name}</strong><small>{members.length} 件作品</small></span><ArrowUpRight size={18} /></button></article>;
        })}<button className="new-project-tile" onClick={() => editProject('new')}><FolderPlus size={26} strokeWidth={1.4} /><span>新建项目</span></button></div> : <>
          <div className="library-filter" role="group" aria-label="作品类型">{[{ key: 'all', label: '全部' }, { key: 'image', label: '图片' }, { key: 'video', label: '视频' }].map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}{selecting && <button className="select-all" onClick={() => setSelected(selected.length === visibleItems.length ? [] : visibleItems.map(item => item.id))}>{selected.length === visibleItems.length ? '取消全选' : '全选'}</button>}</div>
          {activeJobs.length > 0 && section === 'create' && <div className="pending-jobs" aria-live="polite">{activeJobs.map(job => <div className="pending-job" key={job.id}><span className="pending-glyph"><LoaderCircle size={19} className="spin" /></span><div><strong>{job.status === 'queued' ? '等待生成' : '正在创作'}</strong><p>{job.prompt}</p></div><span>{job.kind === 'image' ? `${job.count} 张图片` : '视频'}</span><Tool label="取消生成" onClick={() => cancel(job.id)}><X size={17} /></Tool></div>)}</div>}
          {visibleItems.length > 0 ? <div className="study-grid">{visibleItems.map((item, index) => <article className={`study-card ${selected.includes(item.id) ? 'is-selected' : ''}`} key={item.id} data-study-id={item.id}>
            <button className="study-open" aria-label={`查看 ${item.title}`} onClick={() => selecting ? setSelected(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id]) : setViewerId(item.id)} style={{ aspectRatio: item.ratio.replace(':', '/') }}><img src={item.src} alt={item.title} loading={index < 5 ? 'eager' : 'lazy'} draggable={false} />{item.kind === 'video' && <span className="video-tag"><Play size={11} fill="currentColor" />0:06</span>}<span className="study-caption"><strong>{item.title}</strong><span>{item.model}</span></span>{selecting && <span className="select-mark">{selected.includes(item.id) && <Check size={17} />}</span>}</button>
            {!selecting && <><button className={`card-bookmark ${item.saved ? 'is-saved' : ''}`} aria-label={item.saved ? `取消收藏 ${item.title}` : `收藏 ${item.title}`} onClick={() => save(item.id)}><Bookmark size={17} fill={item.saved ? 'currentColor' : 'none'} /></button><Options label={`${item.title} 更多操作`} className="card-more" trigger={<MoreHorizontal size={19} />}><Choice active={false} onClick={() => continueWith(item, 'reference')}><Copy size={15} />用作参考</Choice><Choice active={false} onClick={() => { setSelected([item.id]); setSelecting(true); }}><CheckCheck size={15} />选择作品</Choice><Choice active={false} onClick={() => remove([item.id])}><Trash2 size={15} />删除</Choice></Options></>}
          </article>)}</div> : <div className="empty-state"><ImageIcon size={34} strokeWidth={1.2} /><h3>{search ? '没有找到相关作品' : section === 'saved' ? '还没有收藏' : projectId ? '这个项目还没有作品' : '还没有作品'}</h3>{search ? <button className="quiet-command" onClick={() => setSearch('')}>清除搜索</button> : <button className="primary-command" onClick={() => { navigate('create'); setFocusToken(value => value + 1); }}><Plus size={16} />开始创作</button>}</div>}
          {visibleItems.length > 0 && <div className="library-end"><span />{visibleItems.length} 件作品<span /></div>}
        </>}
      </section>
    </main>
    {selecting && <div className="batch-toolbar"><span>已选 {selected.length} 件</span><Tool label="收藏所选作品" disabled={!selected.length} onClick={() => { setStudies(items => items.map(item => selected.includes(item.id) ? { ...item, saved: true } : item)); showNotice('已加入收藏'); }}><Bookmark size={18} /></Tool><Options label="将所选作品移入项目" trigger={<FolderPlus size={18} />}><div className="option-heading">移动到项目</div>{projects.map(project => <Choice active={false} key={project.id} onClick={() => { setStudies(items => items.map(item => selected.includes(item.id) ? { ...item, projectId: project.id } : item)); showNotice(`已移入「${project.name}」`); setSelected([]); setSelecting(false); }}>{project.name}</Choice>)}</Options><Tool label="删除所选作品" disabled={!selected.length} onClick={() => remove(selected)}><Trash2 size={18} /></Tool><Tool label="关闭多选" onClick={() => { setSelected([]); setSelecting(false); }}><X size={18} /></Tool></div>}
    {viewerItem && <Viewer item={viewerItem} items={visibleItems} projects={projects} onClose={() => setViewerId(null)} onMove={setViewerId} onSave={save} onDelete={id => remove([id])} onContinue={continueWith} onProject={moveToProject} onNotice={showNotice} />}
    <Panel title="Imagine" open={menuOpen} onClose={() => setMenuOpen(false)} className="navigation-panel"><nav aria-label="手机导航">{navigation}</nav><div className="mobile-project-list"><span className="muted-label">项目</span>{projects.map(project => <button key={project.id} onClick={() => navigate('projects', project.id)}><Folder size={17} />{project.name}</button>)}</div></Panel>
    <Panel title="生成任务" open={taskOpen} onClose={() => setTaskOpen(false)} className="task-panel"><div className="panel-body">{jobs.length === 0 ? <div className="empty-state"><Clock3 size={30} strokeWidth={1.3} /><h3>暂无生成任务</h3></div> : jobs.map(job => <div className="task-row" key={job.id}><span className={`task-state state-${job.status}`}>{['queued', 'running'].includes(job.status) ? <LoaderCircle size={18} className="spin" /> : job.status === 'completed' ? <Check size={18} /> : <X size={18} />}</span><div><strong>{{ queued: '等待生成', running: '正在创作', completed: '已完成', failed: '生成失败', cancelled: '已取消' }[job.status]}</strong><p>{job.prompt}</p><small>{job.model} · {job.kind === 'image' ? `${job.count} 张图片` : '视频'}</small></div>{['queued', 'running'].includes(job.status) ? <Tool label="取消此任务" onClick={() => cancel(job.id)}><X size={17} /></Tool> : job.status === 'cancelled' ? <Tool label="重新编辑任务" onClick={() => { setPrompt(job.prompt); setMode(job.kind); setTaskOpen(false); navigate('create'); setFocusToken(value => value + 1); }}><Pencil size={17} /></Tool> : <Tool label="查看生成结果" onClick={() => { setTaskOpen(false); navigate('create'); setViewerId(`${job.id}-0`); }}><ArrowUpRight size={18} /></Tool>}</div>)}</div></Panel>
    <Panel title={projectEditor === 'new' ? '新建项目' : '重命名项目'} open={projectEditor !== null} onClose={() => setProjectEditor(null)} className="compact-panel"><form className="project-form" onSubmit={event => { event.preventDefault(); saveProject(); }}><label>项目名称<input aria-label="项目名称" placeholder="给这组作品起个名字" value={projectName} maxLength={40} onChange={event => setProjectName(event.target.value)} autoFocus /></label><div><button type="button" className="quiet-command" onClick={() => setProjectEditor(null)}>取消</button><button type="submit" className="primary-command" disabled={!projectName.trim()}>保存项目</button></div></form></Panel>
    <Panel title="连接与偏好" open={settingsOpen} onClose={() => setSettingsOpen(false)} className="settings-panel"><div className="panel-body"><div className="settings-section-title"><Layers3 size={19} /><h3>生成连接</h3><span className="preview-badge">本地演示</span></div><div className="connection-row"><span className="connection-logo">G</span><div><strong>xAI / OpenAI / Google</strong><small>示例模型 · 无外部请求</small></div><label className="switch"><input aria-label="启用生成连接" type="checkbox" checked={connectionsEnabled} onChange={event => setConnectionsEnabled(event.target.checked)} /><span /></label></div><div className="setting-line"><span>默认创作类型</span><div className="segments"><button aria-pressed={mode === 'image'} onClick={() => setMode('image')}>图片</button><button aria-pressed={mode === 'video'} onClick={() => setMode('video')}>视频</button></div></div><div className="setting-line"><span>提示词草稿</span><button className="text-command" onClick={() => { setPrompt(''); setReferences([]); showNotice('草稿已清空'); }}>清空草稿</button></div><div className="settings-footnote">原型中的生成使用固定素材演示。</div></div></Panel>
    {notice && <div className="feedback-toast" role="status"><Check size={17} /><span>{notice.text}</span>{notice.undo && <button aria-label="撤销操作" onClick={notice.undo}><Undo2 size={17} />撤销</button>}<button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </div></Tooltip.Provider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
