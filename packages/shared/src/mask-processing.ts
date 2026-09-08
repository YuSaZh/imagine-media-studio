import { z } from 'zod';

export const MASK_OVERLAY_COLOR = Object.freeze({ red: 235, green: 64, blue: 82, alpha: 104 });
export const MASK_OVERLAY_INSTRUCTION = 'The translucent red marking indicates the region to edit. Apply the requested changes within that region, preserve the rest of the image as much as possible, and remove the marking color from the final image.';
// Server-owned snapshot. Version 1 fixes both the overlay color and its guidance.
export const MaskProcessingSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['native', 'overlay']),
  sourceAssetId: z.string().min(1),
  outputMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  maxOutputBytes: z.number().int().positive().optional(),
}).strict();
export type MaskProcessing = z.infer<typeof MaskProcessingSchema>;
