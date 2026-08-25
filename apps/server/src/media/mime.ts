import { fileTypeFromBuffer } from 'file-type';

import type { MediaKind } from './types.js';

export interface AllowedMediaType {
  extension: string;
  kind: MediaKind;
  mimeType: string;
}

const ALLOWED_MEDIA = new Map<string, AllowedMediaType>([
  ['image/avif', { extension: 'avif', kind: 'image', mimeType: 'image/avif' }],
  ['image/gif', { extension: 'gif', kind: 'image', mimeType: 'image/gif' }],
  ['image/jpeg', { extension: 'jpg', kind: 'image', mimeType: 'image/jpeg' }],
  ['image/png', { extension: 'png', kind: 'image', mimeType: 'image/png' }],
  ['image/webp', { extension: 'webp', kind: 'image', mimeType: 'image/webp' }],
  ['video/mp4', { extension: 'mp4', kind: 'video', mimeType: 'video/mp4' }],
  ['video/quicktime', { extension: 'mov', kind: 'video', mimeType: 'video/quicktime' }],
  ['video/webm', { extension: 'webm', kind: 'video', mimeType: 'video/webm' }],
]);

export class UnsupportedMediaTypeError extends Error {
  public override readonly name = 'UnsupportedMediaTypeError';
}

export function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function allowedMediaType(mimeType: string): AllowedMediaType | null {
  return ALLOWED_MEDIA.get(normalizeMimeType(mimeType)) ?? null;
}

export async function detectAllowedMedia(
  prefix: Uint8Array,
  options: { claimedMimeType?: string; expectedKind?: MediaKind } = {},
): Promise<AllowedMediaType> {
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(prefix);
  } catch {
    throw new UnsupportedMediaTypeError('Media signature is truncated or malformed.');
  }
  if (!detected) {
    throw new UnsupportedMediaTypeError('Media signature is not recognized.');
  }

  const allowed = allowedMediaType(detected.mime);
  if (!allowed) {
    throw new UnsupportedMediaTypeError(`Media type ${detected.mime} is not supported.`);
  }
  if (options.expectedKind && allowed.kind !== options.expectedKind) {
    throw new UnsupportedMediaTypeError(
      `Expected ${options.expectedKind} media but detected ${allowed.kind}.`,
    );
  }

  if (options.claimedMimeType) {
    const claimed = normalizeMimeType(options.claimedMimeType);
    if (claimed !== 'application/octet-stream' && claimed !== allowed.mimeType) {
      throw new UnsupportedMediaTypeError(
        `Claimed media type ${claimed} does not match ${allowed.mimeType}.`,
      );
    }
  }
  return allowed;
}

export function mimeTypeForDerivedVariant(variant: 'poster' | 'thumbnail'): string {
  return variant === 'poster' ? 'image/jpeg' : 'image/webp';
}
