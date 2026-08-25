import type {
  AssetRecord,
  AssetRepository,
  CreateAssetInput,
} from '../database/assets.js';
import type {
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  AssetRole,
  MediaKind,
  NewAssetMediaRecord,
} from './types.js';

type DatabaseAssetRepositoryPort = Pick<
  AssetRepository,
  'create' | 'get' | 'listForMaintenance' | 'softDelete'
>;

const ASSET_ROLES = [
  'first_frame',
  'last_frame',
  'mask',
  'output',
  'reference',
  'upload',
] as const satisfies readonly AssetRole[];

export class AssetMediaMappingError extends Error {
  public override readonly name = 'AssetMediaMappingError';
}

function mapType(value: string): MediaKind {
  if (value === 'image' || value === 'video') return value;
  throw new AssetMediaMappingError(`Asset type '${value}' is not supported.`);
}

function mapRole(value: string): AssetRole {
  const role = ASSET_ROLES.find((candidate) => candidate === value);
  if (role !== undefined) return role;
  throw new AssetMediaMappingError(`Asset role '${value}' is not supported.`);
}

function assertJsonValue(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new AssetMediaMappingError('Asset metadata numbers must be finite.');
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new AssetMediaMappingError('Asset metadata cannot be circular.');
    seen.add(value);
    for (const item of value) assertJsonValue(item, seen);
    seen.delete(value);
    return;
  }
  if (typeof value !== 'object') {
    throw new AssetMediaMappingError('Asset metadata must contain only JSON values.');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AssetMediaMappingError('Asset metadata must contain only plain JSON objects.');
  }
  if (seen.has(value)) throw new AssetMediaMappingError('Asset metadata cannot be circular.');
  seen.add(value);
  for (const item of Object.values(value)) assertJsonValue(item, seen);
  seen.delete(value);
}

function mapMetadata(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new AssetMediaMappingError('Asset metadata must be a JSON object.');
  }
  assertJsonValue(value, new Set());
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, unknown>>;
}

function toDatabaseInput(input: NewAssetMediaRecord): CreateAssetInput {
  return {
    durationMs: input.durationMs,
    filePath: input.filePath,
    fileSize: input.fileSize,
    height: input.height,
    jobId: input.jobId,
    metadata: mapMetadata(input.metadata),
    mimeType: input.mimeType,
    originalFilename: input.originalFilename,
    parentAssetId: input.parentAssetId,
    posterPath: input.posterPath,
    role: input.role,
    sha256: input.sha256,
    thumbnailPath: input.thumbnailPath,
    type: input.type,
    width: input.width,
  };
}

export function toAssetMediaRecord(record: AssetRecord): AssetMediaRecord {
  return {
    createdAt: record.createdAt,
    deletedAt: record.deletedAt,
    durationMs: record.durationMs,
    filePath: record.filePath,
    fileSize: record.fileSize,
    height: record.height,
    id: record.id,
    jobId: record.jobId,
    metadata: mapMetadata(record.metadata),
    mimeType: record.mimeType,
    originalFilename: record.originalFilename,
    parentAssetId: record.parentAssetId,
    posterPath: record.posterPath,
    role: mapRole(record.role),
    sha256: record.sha256,
    thumbnailPath: record.thumbnailPath,
    type: mapType(record.type),
    width: record.width,
  };
}

export class AssetMediaRepositoryAdapter implements AssetMediaRepositoryPort {
  public constructor(private readonly repository: DatabaseAssetRepositoryPort) {}

  public create(input: NewAssetMediaRecord): AssetMediaRecord {
    return toAssetMediaRecord(this.repository.create(toDatabaseInput(input)));
  }

  public get(id: string, includeDeleted = false): AssetMediaRecord | null {
    const record = this.repository.get(id, includeDeleted);
    return record === null ? null : toAssetMediaRecord(record);
  }

  public listForMaintenance(): readonly AssetMediaRecord[] {
    return this.repository.listForMaintenance().map(toAssetMediaRecord);
  }

  public softDelete(id: string): boolean {
    return this.repository.softDelete(id);
  }
}
