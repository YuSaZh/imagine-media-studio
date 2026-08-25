import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, exists, isNull, lt, ne, or, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { assets, changeEvents, collectionAssets } from './schema.js';

export interface AssetRecord {
  readonly id: string;
  readonly jobId: string | null;
  readonly parentAssetId: string | null;
  readonly type: string;
  readonly role: string;
  readonly filePath: string;
  readonly thumbnailPath: string | null;
  readonly posterPath: string | null;
  readonly originalFilename: string | null;
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly fileSize: number;
  readonly sha256: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly favorite: boolean;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

export interface CreateAssetInput {
  readonly jobId?: string | null;
  readonly parentAssetId?: string | null;
  readonly type: 'image' | 'video';
  readonly role: string;
  readonly filePath: string;
  readonly thumbnailPath?: string | null;
  readonly posterPath?: string | null;
  readonly originalFilename?: string | null;
  readonly mimeType: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly fileSize: number;
  readonly sha256: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly favorite?: boolean;
}

export interface AssetPageRequest extends PageRequest {
  readonly type?: 'image' | 'video';
  readonly role?: string;
  readonly favorite?: boolean;
  readonly jobId?: string;
  readonly collectionId?: string;
  readonly includeDeleted?: boolean;
}

export interface UpdateAssetDerivativesInput {
  readonly thumbnailPath?: string | null;
  readonly posterPath?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function mapAssetRow(row: typeof assets.$inferSelect): AssetRecord {
  const metadata: unknown = JSON.parse(row.metadataJson);
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw new Error(`Asset ${row.id} metadata must be a JSON object.`);
  }
  return {
    id: row.id,
    jobId: row.jobId,
    parentAssetId: row.parentAssetId,
    type: row.type,
    role: row.role,
    filePath: row.filePath,
    thumbnailPath: row.thumbnailPath,
    posterPath: row.posterPath,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    fileSize: row.fileSize,
    sha256: row.sha256,
    metadata: metadata as Readonly<Record<string, unknown>>,
    favorite: row.favorite,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function assetCursorCondition(cursor: { timestampMs: number; id: string }): SQL {
  const timestamp = new Date(cursor.timestampMs);
  return or(
    lt(assets.createdAt, timestamp),
    and(eq(assets.createdAt, timestamp), lt(assets.id, cursor.id)),
  )!;
}

export class AssetRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(id: string, includeDeleted = false): AssetRecord | null {
    const condition = includeDeleted
      ? eq(assets.id, id)
      : and(eq(assets.id, id), isNull(assets.deletedAt));
    const row = this.database.select().from(assets).where(condition).get();
    return row ? mapAssetRow(row) : null;
  }

  public page(request: AssetPageRequest = {}): CursorPage<AssetRecord> {
    const page = normalizePageRequest(request);
    const conditions: SQL[] = [];
    if (!request.includeDeleted) conditions.push(isNull(assets.deletedAt));
    if (page.cursor) conditions.push(assetCursorCondition(page.cursor));
    if (request.type !== undefined) conditions.push(eq(assets.type, request.type));
    if (request.role !== undefined) conditions.push(eq(assets.role, request.role));
    else conditions.push(ne(assets.role, 'mask'));
    if (request.favorite !== undefined) conditions.push(eq(assets.favorite, request.favorite));
    if (request.jobId !== undefined) conditions.push(eq(assets.jobId, request.jobId));
    const collectionId = request.collectionId;
    if (collectionId !== undefined) {
      conditions.push(
        exists(
          this.database
            .select({ assetId: collectionAssets.assetId })
            .from(collectionAssets)
            .where(
              and(
                eq(collectionAssets.collectionId, collectionId),
                eq(collectionAssets.assetId, assets.id),
              ),
            ),
        ),
      );
    }
    const rows = this.database
      .select()
      .from(assets)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(page.limit + 1)
      .all()
      .map(mapAssetRow);
    return toCursorPage(rows, page.limit, (asset) => ({
      timestampMs: asset.createdAt.getTime(),
      id: asset.id,
    }));
  }

  public create(input: CreateAssetInput): AssetRecord {
    const id = randomUUID();
    const now = new Date();
    return this.database.transaction((transaction) => {
      transaction
        .insert(assets)
        .values({
          id,
          jobId: input.jobId ?? null,
          parentAssetId: input.parentAssetId ?? null,
          type: input.type,
          role: input.role,
          filePath: input.filePath,
          thumbnailPath: input.thumbnailPath ?? null,
          posterPath: input.posterPath ?? null,
          originalFilename: input.originalFilename ?? null,
          mimeType: input.mimeType,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
          fileSize: input.fileSize,
          sha256: input.sha256,
          metadataJson: JSON.stringify(input.metadata ?? {}),
          favorite: input.favorite ?? false,
          createdAt: now,
          deletedAt: null,
        })
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'asset',
            aggregateId: id,
            eventType: 'asset.created',
            payload: { id, jobId: input.jobId ?? null, type: input.type },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(assets).where(eq(assets.id, id)).get();
      if (!row) throw new Error('Asset creation did not return a row.');
      return mapAssetRow(row);
    });
  }

  public createIfMissing(input: CreateAssetInput): string {
    const existing = this.database
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.filePath, input.filePath))
      .get();
    return existing?.id ?? this.create(input).id;
  }

  public setFavorite(id: string, favorite: boolean): AssetRecord | null {
    return this.database.transaction((transaction) => {
      const changed = transaction
        .update(assets)
        .set({ favorite })
        .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
        .run();
      if (changed.changes === 0) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'asset',
            aggregateId: id,
            eventType: 'asset.updated',
            payload: { id, favorite },
          }),
        )
        .run();
      const row = transaction.select().from(assets).where(eq(assets.id, id)).get();
      return row ? mapAssetRow(row) : null;
    });
  }

  public updateDerivatives(id: string, input: UpdateAssetDerivativesInput): AssetRecord | null {
    const changes: Partial<typeof assets.$inferInsert> = {};
    if ('thumbnailPath' in input) changes.thumbnailPath = input.thumbnailPath ?? null;
    if ('posterPath' in input) changes.posterPath = input.posterPath ?? null;
    if ('width' in input) changes.width = input.width ?? null;
    if ('height' in input) changes.height = input.height ?? null;
    if ('durationMs' in input) changes.durationMs = input.durationMs ?? null;
    if (input.metadata !== undefined) changes.metadataJson = JSON.stringify(input.metadata);
    if (Object.keys(changes).length === 0) return this.get(id);
    return this.database.transaction((transaction) => {
      const changed = transaction
        .update(assets)
        .set(changes)
        .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
        .run();
      if (changed.changes === 0) return null;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'asset',
            aggregateId: id,
            eventType: 'asset.updated',
            payload: { id, derivatives: true },
          }),
        )
        .run();
      const row = transaction.select().from(assets).where(eq(assets.id, id)).get();
      return row ? mapAssetRow(row) : null;
    });
  }

  public softDelete(id: string): boolean {
    return this.database.transaction((transaction) => {
      const deletedAt = new Date();
      const changed = transaction
        .update(assets)
        .set({ deletedAt })
        .where(and(eq(assets.id, id), isNull(assets.deletedAt)))
        .run();
      if (changed.changes === 0) return false;
      transaction.delete(collectionAssets).where(eq(collectionAssets.assetId, id)).run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'asset',
            aggregateId: id,
            eventType: 'asset.deleted',
            payload: { id },
            createdAt: deletedAt,
          }),
        )
        .run();
      return true;
    });
  }

  public countForJob(jobId: string): number {
    return this.database
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.jobId, jobId), isNull(assets.deletedAt)))
      .all().length;
  }

  public collectionIdsForAsset(assetId: string): readonly string[] {
    return this.database
      .select({ collectionId: collectionAssets.collectionId })
      .from(collectionAssets)
      .where(eq(collectionAssets.assetId, assetId))
      .orderBy(collectionAssets.collectionId)
      .all()
      .map((row) => row.collectionId);
  }

  public listForMaintenance(): readonly AssetRecord[] {
    return this.database
      .select()
      .from(assets)
      .orderBy(asc(assets.createdAt), asc(assets.id))
      .all()
      .map(mapAssetRow);
  }
}
