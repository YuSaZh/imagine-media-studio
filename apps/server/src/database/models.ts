import { randomUUID } from 'node:crypto';

import { and, desc, eq, lt, notInArray, or, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import {
  normalizePageRequest,
  toCursorPage,
  type CursorPage,
  type PageRequest,
} from './pagination.js';
import { changeEvents, models } from './schema.js';

export interface ModelRecord {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capabilitySource: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RefreshModelInput {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capabilitySource: string;
  readonly enabled?: boolean;
}

export interface ModelPageRequest extends PageRequest {
  readonly providerId?: string;
  readonly enabled?: boolean;
}

function mapModel(row: typeof models.$inferSelect): ModelRecord {
  const capabilities: unknown = JSON.parse(row.capabilitiesJson);
  if (capabilities === null || Array.isArray(capabilities) || typeof capabilities !== 'object') {
    throw new Error(`Model ${row.id} capabilities must be a JSON object.`);
  }
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: capabilities as Readonly<Record<string, unknown>>,
    capabilitySource: row.capabilitySource,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function modelCursorCondition(cursor: { timestampMs: number; id: string }): SQL {
  const timestamp = new Date(cursor.timestampMs);
  return or(
    lt(models.updatedAt, timestamp),
    and(eq(models.updatedAt, timestamp), lt(models.id, cursor.id)),
  )!;
}

export class ModelRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(id: string): ModelRecord | null {
    const row = this.database.select().from(models).where(eq(models.id, id)).get();
    return row ? mapModel(row) : null;
  }

  public page(request: ModelPageRequest = {}): CursorPage<ModelRecord> {
    const page = normalizePageRequest(request);
    const conditions: SQL[] = [];
    if (page.cursor) conditions.push(modelCursorCondition(page.cursor));
    if (request.providerId !== undefined) conditions.push(eq(models.providerId, request.providerId));
    if (request.enabled !== undefined) conditions.push(eq(models.enabled, request.enabled));
    const rows = this.database
      .select()
      .from(models)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(models.updatedAt), desc(models.id))
      .limit(page.limit + 1)
      .all()
      .map(mapModel);
    return toCursorPage(rows, page.limit, (model) => ({
      timestampMs: model.updatedAt.getTime(),
      id: model.id,
    }));
  }

  public listForProvider(providerId: string): readonly ModelRecord[] {
    return this.database
      .select()
      .from(models)
      .where(eq(models.providerId, providerId))
      .orderBy(desc(models.updatedAt), desc(models.id))
      .all()
      .map(mapModel);
  }

  public replaceForProvider(
    providerId: string,
    inputs: readonly RefreshModelInput[],
  ): readonly ModelRecord[] {
    const duplicateIds = new Set<string>();
    for (const input of inputs) {
      if (duplicateIds.has(input.modelId)) throw new Error(`Duplicate model ID ${input.modelId}.`);
      duplicateIds.add(input.modelId);
    }

    this.database.transaction((transaction) => {
      const now = new Date();
      const modelIds = inputs.map((input) => input.modelId);
      if (modelIds.length === 0) {
        transaction
          .update(models)
          .set({ enabled: false, updatedAt: now })
          .where(eq(models.providerId, providerId))
          .run();
      } else {
        transaction
          .update(models)
          .set({ enabled: false, updatedAt: now })
          .where(and(eq(models.providerId, providerId), notInArray(models.modelId, modelIds)))
          .run();
      }
      for (const input of inputs) {
        transaction
          .insert(models)
          .values({
            id: randomUUID(),
            providerId,
            modelId: input.modelId,
            displayName: input.displayName,
            capabilitiesJson: JSON.stringify(input.capabilities),
            capabilitySource: input.capabilitySource,
            enabled: input.enabled ?? true,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [models.providerId, models.modelId],
            set: {
              displayName: input.displayName,
              capabilitiesJson: JSON.stringify(input.capabilities),
              capabilitySource: input.capabilitySource,
              enabled: input.enabled ?? true,
              updatedAt: now,
            },
          })
          .run();
      }
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider',
            aggregateId: providerId,
            eventType: 'models.refreshed',
            payload: { providerId, modelIds },
            createdAt: now,
          }),
        )
        .run();
    });

    return this.listForProvider(providerId);
  }
}
