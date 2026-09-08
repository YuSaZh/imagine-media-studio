import type { MediaOperation, OperationPolicy } from '@imagine/shared';

const inherited = ['aspectRatio', 'resolution', 'width', 'height', 'quality', 'format', 'fps', 'seed', 'audio', 'extra.audio', 'negativePrompt'];
const source = { mimeTypes: ['video/mp4'], maxBytes: 64 * 1024 * 1024, source: 'uploaded-or-generated' as const, requireLiveSource: false, allowUploaded: false };
export function videoOperationPolicies(profile: string, modelId: string): Partial<Record<MediaOperation, OperationPolicy>> {
  if (profile === 'xai-imagine-video-v1' && modelId === 'grok-imagine-video') return {
    'video.edit': { inputRoles: ['source'], unsupportedParameters: [...inherited, 'durationSeconds'], video: { ...source, maxDurationSeconds: 8.7 } },
    'video.extend': { inputRoles: ['source'], unsupportedParameters: inherited, durations: { min: 2, max: 10, step: 1 }, video: { ...source, minDurationSeconds: 2, maxDurationSeconds: 15 } },
  };
  if (profile === 'openai-videos-v1-compatible' && /^sora-2(?:-pro)?(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return {
    'video.edit': { inputRoles: ['source'], unsupportedParameters: [...inherited, 'durationSeconds'], video: { ...source, source: 'same-provider-model', requireLiveSource: true } },
    'video.extend': { inputRoles: ['source'], unsupportedParameters: inherited, durations: { min: 1, max: 20, step: 1 }, video: { ...source, source: 'same-provider-model', requireLiveSource: true, maxDurationSeconds: 100 } },
  };
  if (profile === 'gemini-veo-operation-v1' && ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview'].includes(modelId)) return {
    'video.image_to_video': { inputRoles: ['first_frame', 'last_frame'] },
    'video.extend': { inputRoles: ['source'], unsupportedParameters: [...inherited, 'durationSeconds', 'extra.personGeneration'], video: { ...source, source: 'same-provider', requireLiveSource: true, maxDurationSeconds: 141, maxHeight: 1280 } },
  };
  if (profile === 'gemini-omni-interactions-video-v1' && ['gemini-omni-1.1-flash', 'gemini-omni-flash-preview'].includes(modelId)) return {
    'video.image_to_video': { inputRoles: ['first_frame', 'last_frame'] },
    'video.edit': { inputRoles: ['source'], unsupportedParameters: ['aspectRatio', 'width', 'height', 'fps', 'seed', 'quality', 'audio', 'durationSeconds', 'negativePrompt', 'format'], resolutions: ['360p', '720p', '1080p', '4k'], video: { ...source, maxUploadedDurationSeconds: 10 } },
    'video.extend': { inputRoles: ['source'], unsupportedParameters: ['aspectRatio', 'width', 'height', 'fps', 'seed', 'quality', 'audio', 'durationSeconds', 'negativePrompt', 'format'], resolutions: ['360p', '720p', '1080p', '4k'], video: { ...source, maxUploadedDurationSeconds: 10 } },
  };
  return {};
}
