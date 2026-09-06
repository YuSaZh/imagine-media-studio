import { z } from 'zod';
import type { NativeProviderProfile } from './provider-protocols.js';

export const RemoteModelCatalogSchema = z.object({ models: z.array(z.object({
  id: z.string().min(1).max(255).refine(value => ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)),
  displayName: z.string().min(1).max(255),
})).max(4096) });

const MODEL_NAMES: Readonly<Record<string, string>> = {
  'gpt-image-2': 'GPT Image 2',
  'gpt-image-1.5': 'GPT Image 1.5',
  'gpt-image-1': 'GPT Image 1',
  'gpt-image-1-mini': 'GPT Image 1 Mini',
  'dall-e-3': 'DALL-E 3',
  'dall-e-2': 'DALL-E 2',
  'gemini-3.1-flash-image': 'Nano Banana 2',
  'gemini-3.1-flash-image-preview': 'Nano Banana 2',
  'gemini-3-pro-image-preview': 'Nano Banana Pro',
  'gemini-2.5-flash-image': 'Nano Banana',
  'grok-imagine-image': 'Grok Imagine Image',
  'grok-imagine-image-pro': 'Grok Imagine Image Pro',
  'grok-imagine-video': 'Grok Imagine Video',
  'sora-2': 'Sora 2',
  'sora-2-pro': 'Sora 2 Pro',
  'veo-3.1-generate-preview': 'Veo 3.1',
  'veo-3.1-fast-generate-preview': 'Veo 3.1 Fast',
  'veo-3.0-generate-001': 'Veo 3',
  'veo-3.0-fast-generate-001': 'Veo 3 Fast',
};

export function modelDisplayName(modelId: string): string {
  const id = modelId.replace(/^models\//, '');
  return Object.hasOwn(MODEL_NAMES, id) ? MODEL_NAMES[id]! : modelId;
}

export function matchModelProtocol(modelId: string): NativeProviderProfile | undefined {
  const id = modelId.trim().replace(/^models\//i, '').toLowerCase();
  if (/^(gpt-image-|dall-e-)/.test(id)) return 'openai-images-v1';
  if (/^(gpt-|o[134](?:-|$))/.test(id)) return 'openai-responses-image-v1';
  if (/^sora(?:-|$)/.test(id)) return 'openai-videos-v1-compatible';
  if (/^(grok|xai)(?:-|$)/.test(id)) return /(?:^|-)video(?:-|$)/.test(id) ? 'xai-imagine-video-v1' : 'xai-imagine-image-v1';
  if (/^gemini-.*omni/.test(id)) return 'gemini-omni-interactions-video-v1';
  if (/^gemini-.*-image(?:-|$)/.test(id)) return 'gemini-generate-content-image-v1';
  if (/^veo(?:-|$)/.test(id)) return 'gemini-veo-operation-v1';
  return undefined;
}
