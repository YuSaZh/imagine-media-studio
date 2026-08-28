import { z } from 'zod';

export const DATA_ARCHIVE_FORMAT = 'imagine-media-studio/data-bundle' as const;
export const DATA_ARCHIVE_VERSION = 1 as const;
export const DATA_ARCHIVE_MANIFEST_FILENAME = 'manifest.json' as const;

export const ARCHIVE_HASH_CHUNK_BYTES = 64 * 1024;
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_MANIFEST_BYTES = 2 * 1024 * 1024;

export const ARCHIVE_EXCLUDED_PATHS = [
  'adapters/.staging',
  'backups',
  'logs',
  'media/temp',
  'app.db-shm',
  'app.db-wal',
  '.offline-maintenance.lock',
] as const;

const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const ARCHIVE_PATH = /^(?:database\/app\.db|media\/(?:originals|thumbnails|posters|uploads|masks)\/[A-Za-z0-9][A-Za-z0-9._/-]*|adapters\/[a-z0-9][a-z0-9._-]{0,62}\/(?:manifest\.json|adapter\.mjs))$/u;

export interface DataArchiveEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DataArchiveManifest {
  readonly format: typeof DATA_ARCHIVE_FORMAT;
  readonly version: typeof DATA_ARCHIVE_VERSION;
  readonly createdAt: string;
  readonly entries: readonly DataArchiveEntry[];
  readonly excluded: readonly string[];
}

export class DataArchiveFormatError extends Error {
  public override readonly name = 'DataArchiveFormatError';
}

const EntrySchema = z.object({
  path: z.string().min(1).max(512),
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(HEX_SHA256),
}).strict();

const ManifestSchema = z.object({
  format: z.literal(DATA_ARCHIVE_FORMAT),
  version: z.literal(DATA_ARCHIVE_VERSION),
  createdAt: z.string().datetime({ offset: true }),
  entries: z.array(EntrySchema).max(MAX_ARCHIVE_ENTRIES),
  excluded: z.array(z.string()).length(ARCHIVE_EXCLUDED_PATHS.length),
}).strict();

function fail(message: string): never {
  throw new DataArchiveFormatError(message);
}

/** JavaScript relational string ordering is deterministic UTF-16 code-unit order. */
export function compareArchivePath(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertEntryPath(path: string): void {
  if (
    !ARCHIVE_PATH.test(path)
    || path.includes('\\')
    || path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail('Archive entry path is not allowlisted.');
  }
}

function assertManifestValues(manifest: DataArchiveManifest): void {
  if (manifest.excluded.some((path, index) => path !== ARCHIVE_EXCLUDED_PATHS[index])) {
    fail('Archive excluded paths do not match the format.');
  }
  let previous: string | undefined;
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    assertEntryPath(entry.path);
    if (previous !== undefined && compareArchivePath(previous, entry.path) >= 0) fail('Archive entries must be strictly sorted.');
    previous = entry.path;
    if (paths.has(entry.path)) fail('Archive entries must be unique.');
    paths.add(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('Archive entry size is invalid.');
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) {
      fail('Archive payload exceeds the size limit.');
    }
  }
  if (!paths.has('database/app.db')) fail('Archive must contain database/app.db.');
}

export function createDataArchiveManifest(input: {
  readonly createdAt: Date;
  readonly entries: readonly DataArchiveEntry[];
}): DataArchiveManifest {
  if (!(input.createdAt instanceof Date) || Number.isNaN(input.createdAt.getTime())) {
    fail('Archive clock returned an invalid date.');
  }
  const entries = [...input.entries]
    .sort((left, right) => compareArchivePath(left.path, right.path))
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
  const manifest: DataArchiveManifest = {
    createdAt: input.createdAt.toISOString(),
    entries,
    excluded: [...ARCHIVE_EXCLUDED_PATHS],
    format: DATA_ARCHIVE_FORMAT,
    version: DATA_ARCHIVE_VERSION,
  };
  assertManifestValues(manifest);
  return manifest;
}

export function serializeDataArchiveManifest(manifest: DataArchiveManifest): Uint8Array {
  assertManifestValues(manifest);
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) fail('Archive manifest does not match the strict schema.');
  const text = `${JSON.stringify({
    format: manifest.format,
    version: manifest.version,
    createdAt: manifest.createdAt,
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
    })),
    excluded: manifest.excluded,
  })}\n`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) fail('Archive manifest exceeds the size limit.');
  return bytes;
}

export function parseDataArchiveManifest(bytes: Uint8Array): DataArchiveManifest {
  if (bytes.byteLength > MAX_ARCHIVE_MANIFEST_BYTES) fail('Archive manifest exceeds the size limit.');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail('Archive manifest is not valid UTF-8 JSON.');
  }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) fail('Archive manifest does not match the strict schema.');
  const manifest: DataArchiveManifest = {
    createdAt: parsed.data.createdAt,
    entries: parsed.data.entries,
    excluded: parsed.data.excluded,
    format: parsed.data.format,
    version: parsed.data.version,
  };
  assertManifestValues(manifest);
  const canonical = serializeDataArchiveManifest(manifest);
  if (canonical.byteLength !== bytes.byteLength || !canonical.every((value, index) => value === bytes[index])) {
    fail('Archive manifest is not in canonical form.');
  }
  return manifest;
}

export function archiveEntryMap(manifest: DataArchiveManifest): ReadonlyMap<string, DataArchiveEntry> {
  assertManifestValues(manifest);
  return new Map(manifest.entries.map((entry) => [entry.path, entry]));
}
