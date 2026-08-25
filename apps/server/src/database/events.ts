import type { InternalEvent } from '@imagine/shared';
import { and, asc, desc, eq, gt, max } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { changeEvents } from './schema.js';

export interface ChangeEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt?: Date;
}

export interface ChangeEventRecord {
  readonly id: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export function toChangeEventValues(
  input: ChangeEventInput,
): typeof changeEvents.$inferInsert {
  return {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.createdAt ?? new Date(),
  };
}

export function mapChangeEventRow(row: typeof changeEvents.$inferSelect): ChangeEventRecord {
  const payload: unknown = JSON.parse(row.payloadJson);
  if (payload === null || Array.isArray(payload) || typeof payload !== 'object') {
    throw new Error(`Change event ${row.id} contains an invalid payload.`);
  }
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: payload as Readonly<Record<string, unknown>>,
    createdAt: row.createdAt,
  };
}

function internalEventType(record: ChangeEventRecord): InternalEvent['type'] {
  if (record.eventType === 'job.created') return 'job.created';
  if (record.eventType === 'job.deleted') return 'job.deleted';
  if (record.aggregateType === 'job') return 'job.updated';
  if (record.eventType === 'asset.created') return 'asset.created';
  if (record.eventType === 'asset.deleted') return 'asset.deleted';
  if (record.aggregateType === 'asset') return 'asset.updated';
  if (record.aggregateType === 'collection') return 'collection.updated';
  if (record.eventType === 'models.refreshed' || record.aggregateType === 'model') {
    return 'model.updated';
  }
  if (record.aggregateType === 'provider') return 'provider.updated';
  return 'reset';
}

function toInternalEvent(record: ChangeEventRecord): InternalEvent {
  const revision = record.payload.revision;
  return {
    version: 1,
    id: record.id,
    type: internalEventType(record),
    entityId: internalEventType(record) === 'reset' ? 'all' : record.aggregateId,
    revision:
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : 0,
    occurredAt: record.createdAt.toISOString(),
  };
}

export class ChangeEventRepository {
  public constructor(private readonly database: AppDatabase) {}

  public append(input: ChangeEventInput): ChangeEventRecord {
    const result = this.database.insert(changeEvents).values(toChangeEventValues(input)).run();
    const row = this.database
      .select()
      .from(changeEvents)
      .where(eq(changeEvents.id, Number(result.lastInsertRowid)))
      .get();
    if (!row) throw new Error('The change event insert did not return a row.');
    return mapChangeEventRow(row);
  }

  public replay(afterId = 0, limit = 100): readonly ChangeEventRecord[] {
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new RangeError('afterId must be a non-negative safe integer.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Event replay limit must be between 1 and 1000.');
    }
    return this.database
      .select()
      .from(changeEvents)
      .where(gt(changeEvents.id, afterId))
      .orderBy(asc(changeEvents.id))
      .limit(limit)
      .all()
      .map(mapChangeEventRow);
  }

  public latestId(): number {
    return this.database.select({ value: max(changeEvents.id) }).from(changeEvents).get()?.value ?? 0;
  }

  public listAfter(id: number, limit: number): readonly InternalEvent[] {
    return this.replay(id, limit).map(toInternalEvent);
  }

  public latestForAggregate(
    aggregateType: string,
    aggregateId: string,
    afterId = 0,
  ): ChangeEventRecord | null {
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new RangeError('afterId must be a non-negative safe integer.');
    }
    const row = this.database
      .select()
      .from(changeEvents)
      .where(
        and(
          eq(changeEvents.aggregateType, aggregateType),
          eq(changeEvents.aggregateId, aggregateId),
          gt(changeEvents.id, afterId),
        ),
      )
      .orderBy(desc(changeEvents.id))
      .get();
    return row ? mapChangeEventRow(row) : null;
  }
}
