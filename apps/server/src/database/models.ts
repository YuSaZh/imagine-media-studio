import { randomUUID } from 'node:crypto';

import {
  ManualModelCreateSchema,
  ModelCapabilitiesSchema,
  ModelCapabilitySourceSchema,
  MODEL_PROTOCOLS,
  type NativeProviderProfile,
  type ModelCapabilitySource,
} from '@imagine/shared';
import { and, desc, eq, lt, ne, notInArray, or, type SQL } from 'drizzle-orm';

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
  readonly capabilitySource: ModelCapabilitySource;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RefreshModelInput {
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly capabilitySource: ModelCapabilitySource;
  readonly enabled?: boolean;
}

export interface ManualModelInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
}

export interface ManualModelUpdate {
  readonly modelId?: string;
  readonly displayName?: string;
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly enabled?: boolean;
}

export class ModelRepositoryError extends Error {
  public override readonly name = 'ModelRepositoryError';

  public constructor(
    public readonly code: 'invalid_model' | 'invalid_capabilities' | 'invalid_source',
    message: string,
  ) {
    super(message);
  }
}

export interface ModelPageRequest extends PageRequest {
  readonly providerId?: string;
  readonly enabled?: boolean;
}

function mapModel(row: typeof models.$inferSelect): ModelRecord {
  let capabilitiesJson: unknown;
  try {
    capabilitiesJson = JSON.parse(row.capabilitiesJson);
  } catch {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      `Model ${row.id} has invalid stored capabilities.`,
    );
  }
  const capabilities = ModelCapabilitiesSchema.safeParse(capabilitiesJson);
  if (!capabilities.success) {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      `Model ${row.id} has invalid stored capabilities.`,
    );
  }
  const source = ModelCapabilitySourceSchema.safeParse(row.capabilitySource);
  if (!source.success) {
    throw new ModelRepositoryError(
      'invalid_source',
      `Model ${row.id} has an invalid capability source.`,
    );
  }
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    capabilities: capabilities.data,
    capabilitySource: source.data,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseManualInput(input: ManualModelInput): ManualModelInput {
  const parsed = ManualModelCreateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ModelRepositoryError('invalid_model', 'Manual model input is invalid.');
  }
  return parsed.data;
}

function parseManualUpdate(input: ManualModelUpdate): ManualModelUpdate {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelRepositoryError('invalid_model', 'Manual model update is invalid.');
  }
  const allowed = new Set(['modelId', 'displayName', 'capabilities', 'enabled']);
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new ModelRepositoryError('invalid_model', 'Manual model update is invalid.');
  }
  if (input.modelId !== undefined &&
    (typeof input.modelId !== 'string' || input.modelId.trim().length === 0 || input.modelId.trim().length > 255)) {
    throw new ModelRepositoryError('invalid_model', 'Manual model update is invalid.');
  }
  if (input.displayName !== undefined &&
    (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.trim().length > 255)) {
    throw new ModelRepositoryError('invalid_model', 'Manual model update is invalid.');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new ModelRepositoryError('invalid_model', 'Manual model update is invalid.');
  }
  if (input.capabilities !== undefined && !ModelCapabilitiesSchema.safeParse(input.capabilities).success) {
    throw new ModelRepositoryError('invalid_capabilities', 'Manual model capabilities are invalid.');
  }
  return {
    ...(input.modelId === undefined ? {} : { modelId: input.modelId.trim() }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
    ...(input.capabilities === undefined ? {} : { capabilities: ModelCapabilitiesSchema.parse(input.capabilities) }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
}

function parseRefreshInput(input: RefreshModelInput): RefreshModelInput {
  if (typeof input.modelId !== 'string' || input.modelId.trim().length === 0 || input.modelId.trim().length > 255) {
    throw new ModelRepositoryError('invalid_model', 'Provider model input is invalid.');
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0 || input.displayName.trim().length > 255) {
    throw new ModelRepositoryError('invalid_model', 'Provider model input is invalid.');
  }
  if (!ModelCapabilitiesSchema.safeParse(input.capabilities).success) {
    throw new ModelRepositoryError('invalid_capabilities', 'Provider model capabilities are invalid.');
  }
  if (!ModelCapabilitySourceSchema.safeParse(input.capabilitySource).success) {
    throw new ModelRepositoryError('invalid_source', 'Provider model source is invalid.');
  }
  return {
    modelId: input.modelId.trim(),
    displayName: input.displayName.trim(),
    capabilities: ModelCapabilitiesSchema.parse(input.capabilities),
    capabilitySource: input.capabilitySource,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
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

  public preserveLegacyProtocol(providerId: string, profile: NativeProviderProfile): void {
    const kind = MODEL_PROTOCOLS.find(item => item.value === profile)!.kind;
    this.database.transaction(transaction => {
      for (const model of this.listForProvider(providerId)) {
        const capabilities = ModelCapabilitiesSchema.parse(model.capabilities);
        if (capabilities.profile || !capabilities.operations.every(operation => operation.startsWith(`${kind}.`))) continue;
        transaction.update(models).set({ capabilitiesJson: JSON.stringify({ ...capabilities, profile }), updatedAt: new Date() }).where(eq(models.id, model.id)).run();
      }
    });
  }

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

  public saveManual(input: ManualModelInput): ModelRecord {
    const normalized = parseManualInput(input);
    return this.database.transaction((transaction) => {
      const now = new Date();
      transaction
        .insert(models)
        .values({
          id: randomUUID(),
          providerId: normalized.providerId,
          modelId: normalized.modelId,
          displayName: normalized.displayName,
          capabilitiesJson: JSON.stringify(normalized.capabilities),
          capabilitySource: 'manual',
          enabled: normalized.enabled,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [models.providerId, models.modelId],
          set: {
            displayName: normalized.displayName,
            capabilitiesJson: JSON.stringify(normalized.capabilities),
            capabilitySource: 'manual',
            enabled: normalized.enabled,
            updatedAt: now,
          },
        })
        .run();
      const row = transaction
        .select()
        .from(models)
        .where(and(eq(models.providerId, normalized.providerId), eq(models.modelId, normalized.modelId)))
        .get();
      if (!row) throw new Error('Manual model save did not return a row.');
      transaction
        .insert(changeEvents)
        .values(toChangeEventValues({
          aggregateType: 'model',
          aggregateId: row.id,
          eventType: 'model.manual_saved',
          payload: { providerId: normalized.providerId, modelId: normalized.modelId },
          createdAt: now,
        }))
        .run();
      return mapModel(row);
    });
  }

  public updateManual(id: string, input: ManualModelUpdate): ModelRecord | null {
    const normalized = parseManualUpdate(input);
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(models).where(eq(models.id, id)).get();
      if (!existing || existing.capabilitySource !== 'manual') return null;
      const now = new Date();
      const changed = transaction
        .update(models)
        .set({
          ...(normalized.modelId === undefined ? {} : { modelId: normalized.modelId }),
          ...(normalized.displayName === undefined ? {} : { displayName: normalized.displayName }),
          ...(normalized.capabilities === undefined
            ? {}
            : { capabilitiesJson: JSON.stringify(normalized.capabilities) }),
          ...(normalized.enabled === undefined ? {} : { enabled: normalized.enabled }),
          updatedAt: now,
        })
        .where(and(eq(models.id, id), eq(models.capabilitySource, 'manual')))
        .run();
      if (changed.changes === 0) return null;
      transaction
        .insert(changeEvents)
        .values(toChangeEventValues({
          aggregateType: 'model',
          aggregateId: existing.id,
          eventType: 'model.manual_updated',
          payload: { providerId: existing.providerId, modelId: normalized.modelId ?? existing.modelId },
          createdAt: now,
        }))
        .run();
      const row = transaction.select().from(models).where(eq(models.id, id)).get();
      return row ? mapModel(row) : null;
    });
  }

  public deleteManual(id: string): boolean {
    return this.database.transaction((transaction) => {
      const existing = transaction.select().from(models).where(eq(models.id, id)).get();
      if (!existing || existing.capabilitySource !== 'manual') return false;
      const deleted = transaction
        .delete(models)
        .where(and(eq(models.id, id), eq(models.capabilitySource, 'manual')))
        .run();
      if (deleted.changes === 0) return false;
      transaction
        .insert(changeEvents)
        .values(toChangeEventValues({
          aggregateType: 'model',
          aggregateId: existing.id,
          eventType: 'model.manual_deleted',
          payload: { providerId: existing.providerId, modelId: existing.modelId },
        }))
        .run();
      return true;
    });
  }

  public replaceForProvider(
    providerId: string,
    inputs: readonly RefreshModelInput[],
  ): readonly ModelRecord[] {
    const normalizedInputs = inputs.map(parseRefreshInput);
    const duplicateIds = new Set<string>();
    for (const input of normalizedInputs) {
      if (duplicateIds.has(input.modelId)) throw new ModelRepositoryError('invalid_model', 'Provider returned duplicate model IDs.');
      duplicateIds.add(input.modelId);
    }

    this.database.transaction((transaction) => {
      const now = new Date();
      const manualModelIds = new Set(
        transaction
          .select({ modelId: models.modelId })
          .from(models)
          .where(and(eq(models.providerId, providerId), eq(models.capabilitySource, 'manual')))
          .all()
          .map((row) => row.modelId),
      );
      const providerInputs = normalizedInputs.filter((input) => !manualModelIds.has(input.modelId));
      const modelIds = providerInputs.map((input) => input.modelId);
      if (modelIds.length === 0) {
        transaction
          .update(models)
          .set({ enabled: false, updatedAt: now })
          .where(and(eq(models.providerId, providerId), ne(models.capabilitySource, 'manual')))
          .run();
      } else {
        transaction
          .update(models)
          .set({ enabled: false, updatedAt: now })
          .where(and(
            eq(models.providerId, providerId),
            ne(models.capabilitySource, 'manual'),
            notInArray(models.modelId, modelIds),
          ))
          .run();
      }
      for (const input of providerInputs) {
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
