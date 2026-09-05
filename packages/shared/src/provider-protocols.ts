import { z } from 'zod';

export const NativeProviderProfileSchema = z.enum([
  'openai-images-v1', 'openai-responses-image-v1', 'openai-videos-v1-compatible',
  'gemini-generate-content-image-v1', 'gemini-interactions-image-v1', 'gemini-veo-operation-v1', 'gemini-omni-interactions-video-v1',
  'xai-imagine-image-v1', 'xai-imagine-video-v1',
]);
export type NativeProviderProfile = z.infer<typeof NativeProviderProfileSchema>;
export type ProviderFamily = 'openai' | 'gemini' | 'xai';

export const PROVIDER_FAMILIES = [
  { value: 'openai', label: 'OpenAI / OpenAI 兼容' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'xai', label: 'xAI' },
] as const;
export const MODEL_PROTOCOLS: ReadonlyArray<{ value: NativeProviderProfile; family: ProviderFamily; kind: 'image' | 'video'; label: string }> = [
  { value: 'openai-images-v1', family: 'openai', kind: 'image', label: 'Images API' },
  { value: 'openai-responses-image-v1', family: 'openai', kind: 'image', label: 'Responses Image Tool' },
  { value: 'openai-videos-v1-compatible', family: 'openai', kind: 'video', label: 'Videos API' },
  { value: 'gemini-generate-content-image-v1', family: 'gemini', kind: 'image', label: 'Generate Content' },
  { value: 'gemini-interactions-image-v1', family: 'gemini', kind: 'image', label: 'Interactions Image' },
  { value: 'gemini-veo-operation-v1', family: 'gemini', kind: 'video', label: 'Veo Operations' },
  { value: 'gemini-omni-interactions-video-v1', family: 'gemini', kind: 'video', label: 'Interactions Video' },
  { value: 'xai-imagine-image-v1', family: 'xai', kind: 'image', label: 'Imagine Images' },
  { value: 'xai-imagine-video-v1', family: 'xai', kind: 'video', label: 'Imagine Videos' },
];

export function providerFamily(type: string): ProviderFamily | null {
  return type === 'openai' || type.startsWith('openai-') ? 'openai'
    : type === 'gemini' || type.startsWith('gemini-') ? 'gemini'
      : type === 'xai' || type.startsWith('xai-') ? 'xai' : null;
}

export function resolveModelProfile(providerType: string, operation: string, modelId: string, declared?: NativeProviderProfile): NativeProviderProfile | undefined {
  const family = providerFamily(providerType);
  if (!family) return undefined;
  const kind = operation.startsWith('video.') ? 'video' : 'image';
  if (declared) {
    const profile = MODEL_PROTOCOLS.find(profile => profile.value === declared);
    if (!profile || profile.family !== family || profile.kind !== kind) throw new Error('模型调用协议与提供商或创作类型不匹配');
    return declared;
  }
  const legacy = MODEL_PROTOCOLS.find(profile => profile.value === providerType);
  if (legacy) return legacy.value;
  if (family === 'openai') return kind === 'video' ? 'openai-videos-v1-compatible' : 'openai-images-v1';
  if (family === 'xai') return kind === 'video' ? 'xai-imagine-video-v1' : 'xai-imagine-image-v1';
  return kind === 'image' ? 'gemini-generate-content-image-v1'
    : /gemini.*omni/i.test(modelId) ? 'gemini-omni-interactions-video-v1' : 'gemini-veo-operation-v1';
}
