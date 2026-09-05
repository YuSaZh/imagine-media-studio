import { z } from 'zod';
import { NativeProviderProfileSchema } from './provider-protocols.js';

export const MediaOperationSchema = z.enum([
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
  'video.edit',
  'video.extend',
]);

/** Central batch bound shared by HTTP validation, persistence, and runners. */
export const MAX_GENERATION_COUNT = 32;

export type MediaOperation = z.infer<typeof MediaOperationSchema>;

export const AssetInputSchema = z.object({
  assetId: z.string().trim().min(1),
  role: z.enum(['source', 'reference', 'mask', 'first_frame', 'last_frame']),
}).strict();

export type AssetInput = z.infer<typeof AssetInputSchema>;

export const GenerationRequestSchema = z.object({
  operation: MediaOperationSchema,
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  profile: NativeProviderProfileSchema.optional(),
  prompt: z.string().trim().min(1),
  negativePrompt: z.string().optional(),
  inputs: z.array(AssetInputSchema).default([]),
  aspectRatio: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  resolution: z.string().optional(),
  count: z.number().int().min(1).max(MAX_GENERATION_COUNT).optional(),
  durationSeconds: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  quality: z.string().optional(),
  format: z.string().optional(),
  seed: z.number().int().optional(),
  audio: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type GenerationRequest = z.infer<typeof GenerationRequestSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'submitting',
  'remote_pending',
  'remote_running',
  'downloading',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'expired',
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;
