import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { assets, changeEvents, collectionAssets, collections } from './schema.js';

export interface CollectionRecord {
  readonly id: string;
  readonly name: string;
  readonly itemCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class CollectionRepositoryError extends Error {
  public override readonly name = 'CollectionRepositoryError';

  public constructor(
    public readonly code: 'asset_not_found' | 'collection_not_found',
    message: string,
  ) {
    super(message);
  }
}

function collectionCursorCondition(cursor: { timestampMs: number; id: string }): SQL {
  const timestamp = new Date(cursor.timestampMs);
  return or(
    lt(collections.updatedAt, timestamp),
    and(eq(collections.updatedAt, timestamp), lt(collections.id, cursor.id)),
  )!;
}

export class CollectionRepository {
  public constructor(private readonly database: AppDatabase) {}

  private map(row: typeof collections.$inferSelect): CollectionRecord {
    const itemCount = this.database
      .select({ value: count() })
      .from(collectionAssets)
      .innerJoin(assets, eq(collectionAssets.assetId, assets.id))
      .where(and(eq(collectionAssets.collectionId, row.id), isNull(assets.deletedAt)))
      .get()?.value ?? 0;
    return { ...row, itemCount };
  }

  public get(id: string): CollectionRecord | null {
    const row = this.database.select().from(collections).where(eq(collections.id, id)).get();
    return row ? this.map(row) : null;
  }

  public page(request: PageRequest = {}): CursorPage<CollectionRecord> {
    const page = normalizePageRequest(request);
    const rows = this.database
      .select()
      .from(collections)
      .where(page.cursor ? collectionCursorCondition(page.cursor) : undefined)
      .orderBy(desc(collections.updatedAt), desc(collections.id))
      .limit(page.limit + 1)
      .all()
      .map((row) => this.map(row));
    return toCursorPage(rows, page.limit, (collection) => ({
      timestampMs: collection.updatedAt.getTime(),
      id: collection.id,
    }));
  }

  public create(name: string): CollectionRecord {
    const id = randomUUID();
    const now = new Date();
    this.database.transaction((transaction) => {
      transaction.insert(collections).values({ id, name, createdAt: now, updatedAt: now }).run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'collection',
            aggregateId: id,
            eventType: 'collection.created',
            payload: { id, name },
            createdAt: now,
          }),
        )
        .run();
    });
    const collection = this.get(id);
    if (!collection) throw new Error('Collection creation did not return a row.');
    return collection;
  }

  public rename(id: string, name: string): CollectionRecord | null {
    const updatedAt = new Date();
    const changed = this.database.transaction((transaction) => {
      const result = transaction
        .update(collections)
        .set({ name, updatedAt })
        .where(eq(collections.id, id))
        .run();
      if (result.changes === 0) return false;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'collection',
            aggregateId: id,
            eventType: 'collection.updated',
            payload: { id, name },
            createdAt: updatedAt,
          }),
        )
        .run();
      return true;
    });
    return changed ? this.get(id) : null;
  }

  public delete(id: string): boolean {
    return this.database.transaction((transaction) => {
      const result = transaction.delete(collections).where(eq(collections.id, id)).run();
      if (result.changes === 0) return false;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'collection',
            aggregateId: id,
            eventType: 'collection.deleted',
            payload: { id },
          }),
        )
        .run();
      return true;
    });
  }

  public addAssets(collectionId: string, assetIds: readonly string[]): number {
    const uniqueAssetIds = [...new Set(assetIds)];
    if (uniqueAssetIds.length === 0) return 0;
    return this.database.transaction((transaction) => {
      const collection = transaction
        .select({ id: collections.id })
        .from(collections)
        .where(eq(collections.id, collectionId))
        .get();
      if (!collection) {
        throw new CollectionRepositoryError('collection_not_found', 'Collection not found.');
      }
      const activeAssets = transaction
        .select({ id: assets.id })
        .from(assets)
        .where(and(inArray(assets.id, uniqueAssetIds), isNull(assets.deletedAt)))
        .all();
      if (activeAssets.length !== uniqueAssetIds.length) {
        throw new CollectionRepositoryError('asset_not_found', 'One or more assets were not found.');
      }
      const now = new Date();
      let added = 0;
      for (const assetId of uniqueAssetIds) {
        added += transaction
          .insert(collectionAssets)
          .values({ collectionId, assetId, createdAt: now })
          .onConflictDoNothing()
          .run().changes;
      }
      transaction.update(collections).set({ updatedAt: now }).where(eq(collections.id, collectionId)).run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'collection',
            aggregateId: collectionId,
            eventType: 'collection.assets-added',
            payload: { collectionId, assetIds: uniqueAssetIds, added },
            createdAt: now,
          }),
        )
        .run();
      return added;
    });
  }

  public removeAsset(collectionId: string, assetId: string): boolean {
    return this.database.transaction((transaction) => {
      const removed = transaction
        .delete(collectionAssets)
        .where(
          and(
            eq(collectionAssets.collectionId, collectionId),
            eq(collectionAssets.assetId, assetId),
          ),
        )
        .run();
      if (removed.changes === 0) return false;
      const now = new Date();
      transaction.update(collections).set({ updatedAt: now }).where(eq(collections.id, collectionId)).run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'collection',
            aggregateId: collectionId,
            eventType: 'collection.asset-removed',
            payload: { collectionId, assetId },
            createdAt: now,
          }),
        )
        .run();
      return true;
    });
  }

  public listAssetIds(collectionId: string): readonly string[] {
    return this.database
      .select({ id: collectionAssets.assetId })
      .from(collectionAssets)
      .innerJoin(assets, eq(collectionAssets.assetId, assets.id))
      .where(and(eq(collectionAssets.collectionId, collectionId), isNull(assets.deletedAt)))
      .all()
      .map((row) => row.id);
  }
}
