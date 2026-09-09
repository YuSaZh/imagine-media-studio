import { randomUUID } from 'node:crypto';
import { assetOutsidePrivateProjects } from './recent-visibility.js';
import type { ProviderVideoSource } from '@imagine/provider-contract';

import { and, asc, desc, eq, exists, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { assets, assetVideoSources, changeEvents, collectionAssets, jobInputs, jobs } from './schema.js';

export interface AssetRecord {
  readonly series?: { id: string; count: number };
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
  readonly groupBySeries?: boolean;
  readonly seriesCover?: 'recent' | 'latest' | 'original';
  readonly lastViewed?: Readonly<Record<string, number>>;
  readonly excludePrivate?: boolean;
  readonly type?: 'image' | 'video';
  readonly role?: string;
  readonly favorite?: boolean;
  readonly jobId?: string;
  readonly collectionId?: string;
  readonly includeDeleted?: boolean;
  readonly search?: string;
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
  public getVideoSource(id: string): ProviderVideoSource | undefined {
    if (!this.get(id)) return undefined;
    const source = this.database.select().from(assetVideoSources).where(eq(assetVideoSources.assetId, id)).get();
    return source ? { providerId: source.providerId, modelId: source.modelId, profile: source.profile, remoteJobId: source.remoteJobId,
      ...(source.resultId ? { resultId: source.resultId } : {}), ...(source.expiresAt ? { expiresAt: source.expiresAt } : {}) } : undefined;
  }
  public constructor(private readonly database: AppDatabase, private readonly owner?: () => string) {}

  private scope(): SQL | undefined { return this.owner ? eq(assets.ownerId, this.owner()) : undefined; }

  public get(id: string, includeDeleted = false): AssetRecord | null {
    const condition = includeDeleted
      ? eq(assets.id, id)
      : and(eq(assets.id, id), isNull(assets.deletedAt));
    const row = this.database.select().from(assets).where(and(condition, this.scope())).get();
    return row ? mapAssetRow(row) : null;
  }

  public page(request: AssetPageRequest = {}): CursorPage<AssetRecord> {
    const page = normalizePageRequest(request);
    const conditions: SQL[] = [sql`coalesce(json_extract(${assets.metadataJson}, '$.temporaryVideoFrame'), 0) != 1`];
    if (request.excludePrivate) conditions.push(assetOutsidePrivateProjects());
    const scope = this.scope(); if (scope) conditions.push(scope);
    if (!request.includeDeleted) conditions.push(isNull(assets.deletedAt));
    if (page.cursor && !request.groupBySeries) conditions.push(assetCursorCondition(page.cursor));
    if (request.type !== undefined) conditions.push(eq(assets.type, request.type));
    if (request.role !== undefined) conditions.push(eq(assets.role, request.role));
    else conditions.push(ne(assets.role, 'mask'));
    if (request.favorite !== undefined) conditions.push(eq(assets.favorite, request.favorite));
    if (request.jobId !== undefined) conditions.push(eq(assets.jobId, request.jobId));
    const search = request.search?.trim().toLowerCase();
    if (search) {
      conditions.push(or(
        sql`instr(lower(coalesce(${assets.originalFilename}, '')), ${search}) > 0`,
        exists(this.database.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.id, assets.jobId),
          or(
            sql`instr(lower(${jobs.prompt}), ${search}) > 0`,
            sql`instr(lower(${jobs.modelId}), ${search}) > 0`,
          ),
        ))),
      )!);
    }
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
    if (request.groupBySeries) return this.seriesPage(request, and(...conditions)!);
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

  private seriesPage(request: AssetPageRequest, filter: SQL): CursorPage<AssetRecord> {
    const page = normalizePageRequest(request);
    const owner = this.owner?.() ?? 'admin';
    // Follow one primary parent per node. UNION also terminates malformed cycles.
    // Filter before ranking covers/counts, but preserve deleted nodes for ancestry.
    const rows = this.database.all<{ id: string; seriesId: string; count: number; anchorId: string; anchorTime: number }>(sql`
      WITH RECURSIVE
      owned_assets AS (SELECT * FROM assets WHERE owner_id = ${owner}),
      owned_jobs AS (SELECT * FROM jobs WHERE owner_id = ${owner}),
      ranked_inputs AS (
        SELECT i.job_id, i.asset_id, row_number() OVER (
          PARTITION BY i.job_id ORDER BY CASE i.role WHEN 'source' THEN 0 WHEN 'first_frame' THEN 1 ELSE 2 END, i.sort_order, i.asset_id
        ) AS rank FROM job_inputs i JOIN owned_jobs j ON j.id = i.job_id JOIN owned_assets a ON a.id = i.asset_id
        WHERE i.role IN ('source', 'first_frame', 'reference')
      ),
      parents(child, parent) AS (
        SELECT 'a:' || a.id, 'j:' || j.id FROM owned_assets a JOIN owned_jobs j ON j.id = a.job_id WHERE a.role = 'output'
        UNION SELECT 'j:' || job_id, 'a:' || asset_id FROM ranked_inputs WHERE rank = 1
        UNION SELECT 'a:' || a.id, 'a:' || p.id FROM owned_assets a JOIN owned_assets p ON p.id = a.parent_asset_id
          WHERE a.role != 'output' AND coalesce(json_extract(a.metadata_json, '$.temporaryVideoFrame'), 0) = 1
      ),
      eligible AS (SELECT assets.id, assets.created_at FROM assets WHERE ${filter}),
      ancestry(id, node) AS (
        SELECT id, 'a:' || id FROM eligible
        UNION SELECT a.id, p.parent FROM ancestry a JOIN parents p ON p.child = a.node
      ),
      roots AS (
        SELECT a.id, coalesce(min(CASE WHEN p.child IS NULL THEN a.node END), min(a.node)) AS series_id
        FROM ancestry a LEFT JOIN parents p ON p.child = a.node GROUP BY a.id
      ),
      ranked AS (
        SELECT e.id, r.series_id,
          count(*) OVER (PARTITION BY r.series_id) AS count,
          first_value(e.id) OVER (PARTITION BY r.series_id ORDER BY e.created_at DESC, e.id DESC) AS anchor_id,
          max(e.created_at) OVER (PARTITION BY r.series_id) AS anchor_time,
          row_number() OVER (PARTITION BY r.series_id ORDER BY
            CASE WHEN ${Number(request.seriesCover === 'recent')} THEN coalesce((SELECT value FROM json_each(${JSON.stringify(request.lastViewed ?? {})}) WHERE key = e.id), 0) ELSE 0 END DESC,
            CASE WHEN ${Number(request.seriesCover === 'original')} THEN e.created_at END ASC,
            CASE WHEN ${Number(request.seriesCover === 'original')} THEN e.id END ASC,
            e.created_at DESC, e.id DESC) AS cover_rank
        FROM eligible e JOIN roots r ON r.id = e.id
      )
      SELECT id, series_id AS seriesId, count, anchor_id AS anchorId, anchor_time AS anchorTime FROM ranked
      WHERE cover_rank = 1 ${page.cursor ? sql`AND (anchor_time < ${page.cursor.timestampMs} OR (anchor_time = ${page.cursor.timestampMs} AND anchor_id < ${page.cursor.id}))` : sql``}
      ORDER BY anchor_time DESC, anchor_id DESC LIMIT ${page.limit + 1}
    `);
    const result = toCursorPage(rows, page.limit, row => ({ timestampMs: row.anchorTime, id: row.anchorId }));
    return { nextCursor: result.nextCursor, items: result.items.map(row => ({ ...this.get(row.id)!, series: { id: row.seriesId, count: row.count } })) };
  }

  public create(input: CreateAssetInput): AssetRecord {
    const parent = input.parentAssetId ? this.get(input.parentAssetId) : null;
    if (input.parentAssetId && !parent) throw new Error('Parent asset not found.');
    const temporary = input.metadata?.temporaryVideoFrame === true || input.role === 'mask' && parent?.metadata.temporaryVideoFrame === true;
    const id = randomUUID();
    const now = new Date();
    return this.database.transaction((transaction) => {
      transaction
        .insert(assets)
        .values({
          id,
          ownerId: this.owner?.() ?? (input.jobId ? this.database.select({ ownerId: jobs.ownerId }).from(jobs).where(eq(jobs.id, input.jobId)).get()?.ownerId : undefined) ?? 'admin',
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
          metadataJson: JSON.stringify({ ...input.metadata, ...(temporary ? { temporaryVideoFrame: true } : {}) }),
          favorite: input.favorite ?? false,
          createdAt: now,
          deletedAt: null,
        })
        .run();
      // Derived references (such as video frames) inherit privacy before becoming visible.
      if (input.role === 'reference' && input.parentAssetId) {
        const memberships = transaction.select().from(collectionAssets).where(eq(collectionAssets.assetId, input.parentAssetId)).all();
        for (const membership of memberships) transaction.insert(collectionAssets).values({ ...membership, assetId: id }).run();
      }
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
    if (!this.get(id)) return null;
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
    if (!this.get(id)) return null;
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

  /** Claim before asynchronous file removal so new submissions cannot reuse retired inputs. */
  public claimTemporaryFrames(now = Date.now()): AssetRecord[] {
    return this.database.transaction(transaction => {
      const roots = transaction.select().from(assets).where(and(eq(assets.role, 'reference'), sql`json_extract(${assets.metadataJson}, '$.temporaryVideoFrame') = 1`, sql`(coalesce(json_extract(${assets.metadataJson}, '$.temporaryPurged'), 0) != 1 OR EXISTS (SELECT 1 FROM assets AS temporary_child WHERE temporary_child.parent_asset_id = ${assets.id} AND json_extract(temporary_child.metadata_json, '$.temporaryVideoFrame') = 1 AND coalesce(json_extract(temporary_child.metadata_json, '$.temporaryPurged'), 0) != 1))`)).all();
      const claimed: AssetRecord[] = [];
      for (const root of roots) {
        const group = transaction.select().from(assets).where(or(eq(assets.id, root.id), and(eq(assets.parentAssetId, root.id), eq(assets.role, 'mask'), sql`json_extract(${assets.metadataJson}, '$.temporaryVideoFrame') = 1`))).all();
        const ids = group.map(row => row.id);
        const linked = transaction.select({ status: jobs.status }).from(jobInputs).innerJoin(jobs, eq(jobs.id, jobInputs.jobId)).where(inArray(jobInputs.assetId, ids)).all();
        if (linked.some(job => !['completed', 'failed', 'cancelled', 'rejected', 'expired'].includes(job.status))) continue;
        if (!root.deletedAt && !linked.length && now - root.createdAt.getTime() < 24 * 60 * 60 * 1000) continue;
        for (const row of group) {
          this.softDelete(row.id);
          if (JSON.parse(row.metadataJson).temporaryPurged !== true) claimed.push(mapAssetRow(row));
        }
      }
      return claimed;
    });
  }

  public markTemporaryPurged(id: string): void {
    this.database.update(assets).set({ metadataJson: sql`json_set(${assets.metadataJson}, '$.temporaryPurged', json('true'))` }).where(and(eq(assets.id, id), sql`json_extract(${assets.metadataJson}, '$.temporaryVideoFrame') = 1`)).run();
  }

  public softDelete(id: string): boolean {
    if (!this.get(id)) return false;
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

  public series(id: string): { assets: AssetRecord[]; jobIds: string[]; truncated: boolean } | null {
    if (!this.get(id)) return null;
    const owner = this.owner?.() ?? 'admin';
    // Only the primary editing input forms lineage. Extra references and masks do not.
    // Deleted frame records remain traversal nodes, never visible gallery items.
    const nodes = this.database.all<{ node: string }>(sql`
      WITH RECURSIVE
      owned_assets AS (SELECT * FROM assets WHERE owner_id = ${owner}),
      owned_jobs AS (SELECT * FROM jobs WHERE owner_id = ${owner}),
      ranked_inputs AS (
        SELECT i.job_id, i.asset_id, row_number() OVER (
          PARTITION BY i.job_id ORDER BY CASE i.role WHEN 'source' THEN 0 WHEN 'first_frame' THEN 1 ELSE 2 END, i.sort_order, i.asset_id
        ) AS rank
        FROM job_inputs i JOIN owned_jobs j ON j.id = i.job_id JOIN owned_assets a ON a.id = i.asset_id
        WHERE i.role IN ('source', 'first_frame', 'reference')
      ),
      links(a, b) AS (
        SELECT 'a:' || asset_id, 'j:' || job_id FROM ranked_inputs WHERE rank = 1
        UNION SELECT 'j:' || j.id, 'a:' || a.id FROM owned_assets a JOIN owned_jobs j ON j.id = a.job_id WHERE a.role = 'output'
        UNION SELECT 'a:' || p.id, 'a:' || a.id FROM owned_assets a JOIN owned_assets p ON p.id = a.parent_asset_id
          WHERE coalesce(json_extract(a.metadata_json, '$.temporaryVideoFrame'), 0) = 1
      ),
      edges(a, b) AS (SELECT a, b FROM links UNION SELECT b, a FROM links),
      family(node) AS (SELECT 'a:' || ${id} UNION SELECT e.b FROM edges e JOIN family f ON e.a = f.node LIMIT 1001)
      SELECT node FROM family
    `);
    const visible = nodes.slice(0, 1000);
    const assetIds = visible.filter(row => row.node.startsWith('a:')).map(row => row.node.slice(2));
    const rows = assetIds.length ? this.database.select().from(assets).where(and(
      inArray(assets.id, assetIds), eq(assets.ownerId, owner), isNull(assets.deletedAt),
      ne(assets.role, 'mask'), sql`coalesce(json_extract(${assets.metadataJson}, '$.temporaryVideoFrame'), 0) != 1`,
    )).orderBy(asc(assets.createdAt), asc(assets.id)).all() : [];
    return { assets: rows.map(mapAssetRow), jobIds: visible.filter(row => row.node.startsWith('j:')).map(row => row.node.slice(2)), truncated: nodes.length > 1000 };
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

  public listForMaintenance(options: { readonly limit?: number } = {}): readonly AssetRecord[] {
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100_001)
    ) {
      throw new RangeError('Maintenance asset limit must be an integer between 1 and 100001.');
    }
    const query = this.database
      .select()
      .from(assets)
      .orderBy(asc(assets.createdAt), asc(assets.id));
    return (options.limit === undefined ? query : query.limit(options.limit)).all().map(mapAssetRow);
  }
}
