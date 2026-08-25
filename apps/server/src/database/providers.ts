import { randomUUID } from 'node:crypto';

import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { changeEvents, providers } from './schema.js';

export interface ProviderStorageRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly baseUrl: string | null;
  readonly apiKeyCiphertext: string | null;
  readonly headersCiphertext: string | null;
  readonly config: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProviderInput {
  readonly id?: string;
  readonly name: string;
  readonly type: string;
  readonly baseUrl?: string | null;
  readonly apiKeyCiphertext?: string | null;
  readonly headersCiphertext?: string | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
}

export interface UpdateProviderInput {
  readonly name?: string;
  readonly type?: string;
  readonly baseUrl?: string | null;
  readonly apiKeyCiphertext?: string | null;
  readonly headersCiphertext?: string | null;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
}

export interface ProviderPageRequest extends PageRequest {
  readonly enabled?: boolean;
  readonly type?: string;
}

function parseObject(value: string, label: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function mapProvider(row: typeof providers.$inferSelect): ProviderStorageRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    apiKeyCiphertext: row.encryptedApiKey,
    headersCiphertext: row.headersEncryptedJson,
    config: parseObject(row.configJson, `Provider ${row.id} config`),
    enabled: row.enabled,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function providerCursorCondition(cursor: { timestampMs: number; id: string }): SQL {
  const timestamp = new Date(cursor.timestampMs);
  return or(
    lt(providers.updatedAt, timestamp),
    and(eq(providers.updatedAt, timestamp), lt(providers.id, cursor.id)),
  )!;
}

export class ProviderRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(id: string): ProviderStorageRecord | null {
    const row = this.database.select().from(providers).where(eq(providers.id, id)).get();
    return row ? mapProvider(row) : null;
  }

  public page(request: ProviderPageRequest = {}): CursorPage<ProviderStorageRecord> {
    const page = normalizePageRequest(request);
    const conditions: SQL[] = [];
    if (page.cursor) conditions.push(providerCursorCondition(page.cursor));
    if (request.enabled !== undefined) conditions.push(eq(providers.enabled, request.enabled));
    if (request.type !== undefined) conditions.push(eq(providers.type, request.type));
    const rows = this.database
      .select()
      .from(providers)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(providers.updatedAt), desc(providers.id))
      .limit(page.limit + 1)
      .all()
      .map(mapProvider);
    return toCursorPage(rows, page.limit, (provider) => ({
      timestampMs: provider.updatedAt.getTime(),
      id: provider.id,
    }));
  }

  public create(input: CreateProviderInput): ProviderStorageRecord {
    const id = input.id ?? randomUUID();
    const now = new Date();
    return this.database.transaction((transaction) => {
      if (input.isDefault === true) {
        transaction.update(providers).set({ isDefault: false, updatedAt: now }).run();
      }
      transaction
        .insert(providers)
        .values({
          id,
          name: input.name,
          type: input.type,
          baseUrl: input.baseUrl ?? null,
          encryptedApiKey: input.apiKeyCiphertext ?? null,
          headersEncryptedJson: input.headersCiphertext ?? null,
          configJson: JSON.stringify(input.config ?? {}),
          enabled: input.enabled ?? true,
          isDefault: input.isDefault ?? false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider',
            aggregateId: id,
            eventType: 'provider.created',
            payload: { id, type: input.type },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(providers).where(eq(providers.id, id)).get();
      if (!row) throw new Error('Provider creation did not return a row.');
      return mapProvider(row);
    });
  }

  public update(id: string, input: UpdateProviderInput): ProviderStorageRecord | null {
    return this.database.transaction((transaction) => {
      const current = transaction.select().from(providers).where(eq(providers.id, id)).get();
      if (!current) return null;
      const now = new Date();
      if (input.isDefault === true) {
        transaction
          .update(providers)
          .set({ isDefault: false, updatedAt: now })
          .where(eq(providers.isDefault, true))
          .run();
      }
      const changes: Partial<typeof providers.$inferInsert> = { updatedAt: now };
      if (input.name !== undefined) changes.name = input.name;
      if (input.type !== undefined) changes.type = input.type;
      if ('baseUrl' in input) changes.baseUrl = input.baseUrl ?? null;
      if ('apiKeyCiphertext' in input) changes.encryptedApiKey = input.apiKeyCiphertext ?? null;
      if ('headersCiphertext' in input) {
        changes.headersEncryptedJson = input.headersCiphertext ?? null;
      }
      if (input.config !== undefined) changes.configJson = JSON.stringify(input.config);
      if (input.enabled !== undefined) changes.enabled = input.enabled;
      if (input.isDefault !== undefined) changes.isDefault = input.isDefault;
      transaction.update(providers).set(changes).where(eq(providers.id, id)).run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider',
            aggregateId: id,
            eventType: 'provider.updated',
            payload: { id },
            createdAt: now,
          }),
        )
        .run();
      const row = transaction.select().from(providers).where(eq(providers.id, id)).get();
      return row ? mapProvider(row) : null;
    });
  }

  public setDefault(id: string): ProviderStorageRecord | null {
    return this.update(id, { isDefault: true });
  }

  public delete(id: string): boolean {
    return this.database.transaction((transaction) => {
      const deleted = transaction.delete(providers).where(eq(providers.id, id)).run();
      if (deleted.changes === 0) return false;
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider',
            aggregateId: id,
            eventType: 'provider.deleted',
            payload: { id },
          }),
        )
        .run();
      return true;
    });
  }
}
