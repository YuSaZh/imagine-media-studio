export type MediaKind = 'image' | 'video';
export interface Study {
  id: string;
  title: string;
  prompt: string;
  src: string;
  kind: MediaKind;
  ratio: string;
  model: string;
  projectId: string | null;
  saved: boolean;
  parentId?: string;
  quality?: string;
  durationSeconds?: number | null;
  mimeType?: string;
}
export interface Project { id: string; name: string; }
export interface DemoJob {
  id: string;
  prompt: string;
  kind: MediaKind;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  model: string;
  count: number;
}
export const MODEL_OPTIONS = [
  { key: 'xai:imagine-image', provider: 'xAI', name: 'Grok Imagine', kind: 'image', badge: 'G', references: 5 },
  { key: 'openai:gpt-image', provider: 'OpenAI', name: 'GPT Image', kind: 'image', badge: 'O', references: 4 },
  { key: 'gemini:image', provider: 'Google', name: 'Gemini Image', kind: 'image', badge: 'G', references: 3 },
  { key: 'xai:imagine-video', provider: 'xAI', name: 'Grok Imagine Video', kind: 'video', badge: 'G', references: 1 },
] as const;
export const RATIOS = ['1:1', '2:3', '3:2', '9:16', '16:9'];
export const INITIAL_PROJECTS: Project[] = [{ id: 'travel', name: '山海之间' }, { id: 'objects', name: '日常之物' }];
const media = (name: string) => `/interaction-media/${name}.webp`;
export const INITIAL_STUDIES: Study[] = [
  { id: 'coast', title: '海岸来信', prompt: '从高处看海浪缓缓涌向岸边，海水由深蓝过渡到透明的青绿色，细腻的胶片颗粒，自然光。', src: media('coast'), kind: 'image', ratio: '3:2', model: 'Grok Imagine', projectId: 'travel', saved: true },
  { id: 'portrait', title: '午后的光', prompt: '自然光人像，柔和的逆光穿过发梢，安静的神情，浅景深，保留真实的皮肤质感。', src: media('portrait'), kind: 'image', ratio: '2:3', model: 'GPT Image', projectId: null, saved: false },
  { id: 'mountain', title: '群山渐醒', prompt: '层层山峦延伸向远方，清晨的光越过山脊，冷暖交错的空气透视，宽银幕电影构图。', src: media('mountain'), kind: 'image', ratio: '3:2', model: 'Grok Imagine', projectId: 'travel', saved: true },
  { id: 'watch', title: '时间的形状', prompt: '极简腕表产品摄影，干净的浅灰背景，柔和的侧光呈现金属边缘，精确克制的构图。', src: media('watch'), kind: 'image', ratio: '1:1', model: 'Gemini Image', projectId: 'objects', saved: false },
  { id: 'lake', title: '静水无声', prompt: '松林、山脉与湖面的倒影，清晨雾气轻轻停在水面，冷绿色调，安静而通透的自然风景。', src: media('lake'), kind: 'image', ratio: '3:2', model: 'Grok Imagine', projectId: 'travel', saved: false },
  { id: 'botanical', title: '一片绿色', prompt: '热带植物的叶片近景，层次丰富的绿色，柔和漫射光，植物纹理清晰，自然杂志摄影。', src: media('botanical'), kind: 'image', ratio: '2:3', model: 'GPT Image', projectId: 'objects', saved: true },
  { id: 'interior', title: '留白的房间', prompt: '阳光洒入安静的客厅，原木、织物与绿植，温和的明暗关系，建筑杂志摄影，空间自然舒展。', src: media('interior'), kind: 'image', ratio: '3:2', model: 'Gemini Image', projectId: 'objects', saved: false },
  { id: 'architecture', title: '向上的线条', prompt: '仰视现代建筑，玻璃与天空构成简洁的几何关系，清晰的垂直线条，冷调建筑摄影。', src: media('architecture'), kind: 'image', ratio: '2:3', model: 'Grok Imagine', projectId: null, saved: false },
  { id: 'motion', title: '海风经过', prompt: '镜头缓慢靠近海岸，平稳的推进，海面在画面中展开。', src: media('coast'), kind: 'video', ratio: '16:9', model: 'Grok Imagine Video', projectId: 'travel', saved: false },
];

export function readDraft(): string {
  try { return localStorage.getItem('imagine.interaction.draft')?.slice(0, 6000) ?? ''; } catch { return ''; }
}

export function readLibrary(): { studies: Study[]; projects: Project[] } {
  const fallback = { studies: INITIAL_STUDIES, projects: INITIAL_PROJECTS };
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('imagine.interaction.library.v1') ?? 'null');
    if (!raw || typeof raw !== 'object' || !('studies' in raw) || !('projects' in raw)) return fallback;
    if (!Array.isArray(raw.studies) || !Array.isArray(raw.projects)) return fallback;
    const validStudies = raw.studies.every((s: unknown) => s && typeof s === 'object' &&
      'id' in s && typeof s.id === 'string' && 'title' in s && typeof s.title === 'string' &&
      'prompt' in s && typeof s.prompt === 'string' && 'src' in s && typeof s.src === 'string' &&
      s.src.startsWith('/interaction-media/') && 'kind' in s && ['image', 'video'].includes(String(s.kind)) &&
      'ratio' in s && RATIOS.includes(String(s.ratio)) && 'model' in s && typeof s.model === 'string' &&
      'saved' in s && typeof s.saved === 'boolean' && 'projectId' in s && (s.projectId === null || typeof s.projectId === 'string'));
    const validProjects = raw.projects.every((p: unknown) => p && typeof p === 'object' &&
      'id' in p && typeof p.id === 'string' && 'name' in p && typeof p.name === 'string');
    return validStudies && validProjects ? { studies: raw.studies.slice(0, 150), projects: raw.projects.slice(0, 30) } : fallback;
  } catch { return fallback; }
}
