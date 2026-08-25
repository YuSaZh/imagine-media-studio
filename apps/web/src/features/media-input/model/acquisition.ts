import type {
  AcquiredImage,
  AcquisitionRejection,
} from './types.js';

export const SUPPORTED_REFERENCE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const DEFAULT_MAX_REFERENCE_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_REFERENCE_TOTAL_BYTES = 128 * 1024 * 1024;

export interface AcquisitionOptions {
  allowDuplicateFingerprints?: boolean;
  allowedMimeTypes?: readonly string[];
  createId?: () => string;
  existingCount?: number;
  existingFingerprints?: ReadonlySet<string>;
  existingTotalBytes?: number;
  maxFileBytes?: number;
  maxItems: number;
  maxTotalBytes?: number;
}

export interface AcquisitionResult {
  accepted: readonly AcquiredImage[];
  rejected: readonly AcquisitionRejection[];
}

export interface TransferFiles {
  files: readonly File[];
  rejected: readonly AcquisitionRejection[];
}

export function fileFingerprint(file: File): string {
  return [file.name, file.type.toLowerCase(), file.size, file.lastModified].join('\0');
}

export function filesFromDataTransfer(dataTransfer: DataTransfer): TransferFiles {
  const files: File[] = [];
  const rejected: AcquisitionRejection[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      rejected.push({ name: 'Folder', reason: 'directory' });
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) files.push(...dataTransfer.files);
  return { files, rejected };
}

export function filesFromClipboard(clipboardData: DataTransfer): TransferFiles & { hasText: boolean } {
  const files: File[] = [];
  let hasText = false;
  for (const item of clipboardData.items) {
    if (item.kind === 'string' && item.type === 'text/plain') hasText = true;
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, hasText, rejected: [] };
}

export function acquireImageFiles(
  files: readonly File[],
  options: AcquisitionOptions,
): AcquisitionResult {
  const accepted: AcquiredImage[] = [];
  const rejected: AcquisitionRejection[] = [];
  const fingerprints = new Set(options.existingFingerprints ?? []);
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const allowedMimeTypes = new Set(
    options.allowedMimeTypes?.map((mimeType) => mimeType.trim().toLowerCase()) ??
      SUPPORTED_REFERENCE_MIME_TYPES,
  );
  for (const mimeType of allowedMimeTypes) {
    if (!SUPPORTED_REFERENCE_MIME_TYPES.has(mimeType)) allowedMimeTypes.delete(mimeType);
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_REFERENCE_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_REFERENCE_TOTAL_BYTES;
  let count = options.existingCount ?? 0;
  let totalBytes = options.existingTotalBytes ?? 0;

  for (const file of files) {
    const name = file.name || 'Pasted image';
    const fingerprint = fileFingerprint(file);
    if (file.size === 0) {
      rejected.push({ name, reason: 'empty' });
    } else if (!SUPPORTED_REFERENCE_MIME_TYPES.has(file.type.toLowerCase())) {
      rejected.push({ name, reason: 'unsupported_type' });
    } else if (!allowedMimeTypes.has(file.type.toLowerCase())) {
      rejected.push({ name, reason: 'normalized_type_unsupported' });
    } else if (file.size > maxFileBytes) {
      rejected.push({ name, reason: 'file_too_large' });
    } else if (!options.allowDuplicateFingerprints && fingerprints.has(fingerprint)) {
      rejected.push({ name, reason: 'duplicate' });
    } else if (count >= Math.max(0, Math.trunc(options.maxItems))) {
      rejected.push({ name, reason: 'item_limit' });
    } else if (totalBytes + file.size > maxTotalBytes) {
      rejected.push({ name, reason: 'total_too_large' });
    } else {
      accepted.push({ clientId: createId(), file, fingerprint });
      fingerprints.add(fingerprint);
      count += 1;
      totalBytes += file.size;
    }
  }
  return { accepted, rejected };
}
