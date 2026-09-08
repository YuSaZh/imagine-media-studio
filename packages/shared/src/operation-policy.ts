import { z } from 'zod';
import { ModelParametersSchema } from './model-parameters.js';

export const OperationPolicySchema = z.object({
  maxReferenceImages: z.number().int().nonnegative().max(100).optional(),
  parameters: z.lazy(() => ModelParametersSchema).optional(),
  unsupportedParameters: z.array(z.string().min(1).max(80)).max(32).optional(),
  inputRoles: z.array(z.enum(['source', 'reference', 'mask', 'first_frame', 'last_frame'])).optional(),
  resolutions: z.array(z.string().min(1).max(64)).optional(),
  aspectRatios: z.array(z.string().min(1).max(32)).optional(),
  durations: z.union([z.array(z.number().positive()), z.object({ min: z.number().positive(), max: z.number().positive(), step: z.number().positive().optional() }).strict()]).optional(),
  video: z.object({
    mimeTypes: z.array(z.string().min(1)).min(1).default(['video/mp4']),
    maxBytes: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
    minDurationSeconds: z.number().nonnegative().optional(),
    maxDurationSeconds: z.number().positive().optional(),
    maxUploadedDurationSeconds: z.number().positive().optional(),
    source: z.enum(['uploaded-or-generated', 'same-provider', 'same-provider-model']).default('uploaded-or-generated'),
    requireLiveSource: z.boolean().default(false),
    allowUploaded: z.boolean().default(false),
    maxHeight: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type OperationPolicy = z.infer<typeof OperationPolicySchema>;
export const OperationPoliciesSchema = z.partialRecord(z.enum(['image.generate', 'image.edit', 'video.generate', 'video.image_to_video', 'video.reference_to_video', 'video.edit', 'video.extend']), OperationPolicySchema);

export function assertOperationParameters(request: Record<string, unknown>, policy: OperationPolicy): void {
  for (const path of policy.unsupportedParameters ?? []) {
    const value = path.startsWith('extra.') ? (request.extra as Record<string, unknown> | undefined)?.[path.slice(6)] : request[path];
    if (value !== undefined && value !== 'auto') throw new Error(`当前操作不支持参数 ${path}`);
  }
  if (request.resolution && request.resolution !== 'auto' && policy.resolutions && !policy.resolutions.includes(String(request.resolution))) throw new Error('当前操作不支持此分辨率');
  if (request.aspectRatio && request.aspectRatio !== 'auto' && policy.aspectRatios && !policy.aspectRatios.includes(String(request.aspectRatio))) throw new Error('当前操作不支持此画幅');
  if (request.durationSeconds !== undefined && policy.durations) {
    const duration = Number(request.durationSeconds);
    const bounds = policy.durations;
    if (Array.isArray(bounds) ? !bounds.includes(duration) : duration < bounds.min || duration > bounds.max || (bounds.step !== undefined && Math.abs((duration - bounds.min) / bounds.step - Math.round((duration - bounds.min) / bounds.step)) > 1e-8)) throw new Error('当前操作不支持此时长');
  }
}
