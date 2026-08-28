import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  CustomAdapterRefSchema,
  assertSafeCustomFields,
  type CustomAdapterRef,
} from '@imagine/shared';
import { and, asc, desc, eq, isNotNull, isNull, notExists, or } from 'drizzle-orm';

import {
  canonicalDeclarativeSpec,
  isCredentialLikeQueryName,
  isSecretTemplate,
  parseDeclarativeJson,
} from '../providers/custom-http/index.js';
import type { AppDatabase } from './client.js';
import { mapChangeEventRow, toChangeEventValues, type ChangeEventRecord } from './events.js';
import {
  changeEvents,
  jobs,
  providers,
  providerAdapterDefinitions,
  trustedAdapterInstallations,
  trustedAdapterTombstones,
} from './schema.js';

export const MAX_ADAPTER_DEFINITION_BYTES = 128 * 1024;
const CUSTOM_FIELDS_SECURITY_OPTIONS = { isSecretTemplate } as const;

export interface ProviderAdapterDefinitionRecord {
  readonly providerId: string;
  readonly ref: CustomAdapterRef;
  /** Declarative JSON is safe configuration, never source or credentials. */
  readonly definition: Readonly<Record<string, unknown>> | null;
  readonly isCurrent: boolean;
  readonly disabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TrustedAdapterTombstoneRecord {
  readonly adapterId: string;
  readonly version: string;
  readonly digest: string;
  readonly removedAt: Date;
}

export interface TrustedAdapterInstallationRecord {
  readonly adapterId: string;
  readonly version: string;
  readonly digest: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TrustedAdapterInstallationInput {
  readonly ref: CustomAdapterRef;
  readonly providerId?: string;
  readonly now?: Date;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface TrustedAdapterInstallResult {
  readonly installation: TrustedAdapterInstallationRecord;
  readonly definition: ProviderAdapterDefinitionRecord | null;
  readonly events: readonly ChangeEventRecord[];
}

export interface PutProviderAdapterDefinitionInput {
  readonly ref: CustomAdapterRef;
  readonly definition?: unknown | null;
}

export class ProviderAdapterDefinitionError extends Error {
  public override readonly name = 'ProviderAdapterDefinitionError';

  public constructor(
    public readonly code:
      | 'invalid_reference'
      | 'invalid_definition'
      | 'definition_too_large'
      | 'digest_mismatch'
      | 'provider_not_found'
      | 'already_exists'
      | 'current_conflict'
      | 'disabled_revision'
      | 'not_found'
      | 'referenced_jobs'
      | 'referenced_definitions'
      | 'tombstoned'
      | 'persisted_invalid',
    message: string,
  ) {
    super(message);
  }
}

function digestDefinition(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function parseRef(value: unknown): CustomAdapterRef {
  const parsed = CustomAdapterRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderAdapterDefinitionError('invalid_reference', 'Adapter reference is invalid.');
  }
  return parsed.data;
}

function expectedKind(providerType: string): 'declarative-http' | 'trusted-javascript' | null {
  if (providerType === 'custom-http-v1') return 'declarative-http';
  if (providerType === 'custom-js-v1') return 'trusted-javascript';
  return null;
}

function assertRawDefinitionSize(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderAdapterDefinitionError(
      'invalid_definition',
      'Declarative adapter definition must be a JSON object.',
    );
  }
  const seen = new Set<object>();
  const assertPlain = (current: unknown, depth: number): void => {
    if (depth > 12) {
      throw new ProviderAdapterDefinitionError(
        'invalid_definition',
        'Declarative adapter definition is too deeply nested.',
      );
    }
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      return;
    }
    if (typeof current !== 'object') {
      throw new ProviderAdapterDefinitionError(
        'invalid_definition',
        'Declarative adapter definition contains an unsupported value.',
      );
    }
    if (seen.has(current)) {
      throw new ProviderAdapterDefinitionError(
        'invalid_definition',
        'Declarative adapter definition contains a cycle.',
      );
    }
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new ProviderAdapterDefinitionError(
        'invalid_definition',
        'Declarative adapter definition must contain plain objects.',
      );
    }
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) assertPlain(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(current)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new ProviderAdapterDefinitionError(
            'invalid_definition',
            'Declarative adapter definition contains a forbidden key.',
          );
        }
        if (key === 'customFields') {
          try {
            assertSafeCustomFields(item, CUSTOM_FIELDS_SECURITY_OPTIONS);
          } catch {
            throw new ProviderAdapterDefinitionError(
              'invalid_definition',
              'Custom field metadata must not contain static credential values or secret templates.',
            );
          }
          continue;
        }
        assertPlain(item, depth + 1);
      }
    }
    seen.delete(current);
  };
  assertPlain(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProviderAdapterDefinitionError(
      'invalid_definition',
      'Declarative adapter definition is not serializable.',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ADAPTER_DEFINITION_BYTES) {
    throw new ProviderAdapterDefinitionError(
      'definition_too_large',
      'Declarative adapter definition is too large.',
    );
  }
  return serialized;
}

const STATIC_CREDENTIAL_HEADER = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:x[-_])?api[-_]?key|access[-_]?token|oauth[-_]?token|auth(?:[-_]?token)?|credential|signature|password|secret|token|x[-_]?(?:amz|goog|ms)[-_])/iu;
const CREDENTIAL_FIELD_NAME = /(?:^|[-_.])(?:token|key|api[-_.]?key|authorization|auth|cookie|password|secret|credential|credentials|signature|sig|access[-_.]?token|oauth[-_.]?token|idempotency[-_.]?key|headers?)(?:$|[-_.])/iu;

export function isCredentialLikeFieldName(value: string): boolean {
  return CREDENTIAL_FIELD_NAME.test(value) || isCredentialLikeQueryName(value);
}

/**
 * Applies the same credential placement policy to drafts and persisted
 * definitions. It intentionally returns no transformed value so management
 * callers can validate before compiling or persisting a draft.
 */
export function assertNoStaticCredentialLiterals(value: unknown): void {
  const inspectPayload = (node: unknown): void => {
    if (typeof node === 'string') {
      if (isSecretTemplate(node)) {
        throw new ProviderAdapterDefinitionError(
          'invalid_definition',
          'Secrets may only be used through the adapter authentication secret reference.',
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) inspectPayload(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (isCredentialLikeFieldName(key)) {
        throw new ProviderAdapterDefinitionError(
          'invalid_definition',
          'Credential-like fields must use the adapter authentication secret reference.',
        );
      }
      inspectPayload(child);
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'string') {
      if (isSecretTemplate(node)) {
        throw new ProviderAdapterDefinitionError(
          'invalid_definition',
          'Secrets may only be used through the adapter authentication secret reference.',
        );
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'body') inspectPayload(child);
      if (key === 'customFields') {
        try {
          assertSafeCustomFields(child, CUSTOM_FIELDS_SECURITY_OPTIONS);
        } catch {
          throw new ProviderAdapterDefinitionError(
            'invalid_definition',
            'Custom field metadata must not contain static credential values or secret templates.',
          );
        }
      }
      if (key === 'files' && Array.isArray(child)) {
        for (const file of child) {
          if (file !== null && typeof file === 'object' && !Array.isArray(file)) {
            const field = (file as Record<string, unknown>).field;
            if (typeof field === 'string' && isCredentialLikeFieldName(field)) {
              throw new ProviderAdapterDefinitionError(
                'invalid_definition',
                'Credential-like multipart fields are not allowed in adapter definitions.',
              );
            }
          }
        }
      }
      if (key === 'headers' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        for (const [headerName, headerValue] of Object.entries(child)) {
          if (STATIC_CREDENTIAL_HEADER.test(headerName)) {
            throw new ProviderAdapterDefinitionError(
              'invalid_definition',
              'Credential headers must use the adapter authentication secret reference.',
            );
          }
          if (typeof headerValue === 'string' && isSecretTemplate(headerValue)) {
            throw new ProviderAdapterDefinitionError(
              'invalid_definition',
              'Secrets may only be used through the adapter authentication secret reference.',
            );
          }
        }
      }
      if (key === 'query' && child !== null && typeof child === 'object' && !Array.isArray(child)) {
        for (const [queryName, queryValue] of Object.entries(child)) {
          if (
            isCredentialLikeQueryName(queryName) ||
            (typeof queryValue === 'string' && isSecretTemplate(queryValue))
          ) {
            throw new ProviderAdapterDefinitionError(
              'invalid_definition',
              'Credential-like query parameters are not allowed in adapter definitions.',
            );
          }
        }
      }
      visit(child);
    }
  };
  visit(value);
}

function normalizeDefinition(ref: CustomAdapterRef, definition: unknown | null | undefined): {
  readonly canonical: string | null;
  readonly value: Readonly<Record<string, unknown>> | null;
} {
  if (ref.kind === 'trusted-javascript') {
    if (definition !== undefined && definition !== null) {
      throw new ProviderAdapterDefinitionError(
        'invalid_definition',
        'Trusted JavaScript adapters do not store definitions.',
      );
    }
    // The trusted adapter digest is checked against AdapterStore by Registry/Service.
    return { canonical: null, value: null };
  }
  const serialized = assertRawDefinitionSize(definition);
  let parsed: ReturnType<typeof parseDeclarativeJson>;
  try {
    parsed = parseDeclarativeJson(serialized);
    assertNoStaticCredentialLiterals(parsed);
  } catch (error) {
    if (error instanceof ProviderAdapterDefinitionError) throw error;
    throw new ProviderAdapterDefinitionError('invalid_definition', 'Declarative adapter definition is invalid.');
  }
  if (parsed.id !== ref.adapterId) {
    throw new ProviderAdapterDefinitionError(
      'invalid_definition',
      'Declarative adapter definition id must match the adapter reference.',
    );
  }
  let canonical: string;
  try {
    canonical = canonicalDeclarativeSpec(parsed);
  } catch {
    throw new ProviderAdapterDefinitionError(
      'definition_too_large',
      'Declarative adapter definition is too large.',
    );
  }
  if (digestDefinition(canonical) !== ref.digest) {
    throw new ProviderAdapterDefinitionError(
      'digest_mismatch',
      'Adapter definition digest does not match the reference.',
    );
  }
  return { canonical, value: parsed as unknown as Readonly<Record<string, unknown>> };
}

function persistedRecord(row: typeof providerAdapterDefinitions.$inferSelect): ProviderAdapterDefinitionRecord {
  const ref = parseRef({
    kind: row.kind,
    adapterId: row.adapterId,
    version: row.version,
    digest: row.digest,
  });
  if (ref.kind === 'trusted-javascript') {
    if (row.definitionJson !== null) {
      throw new ProviderAdapterDefinitionError('persisted_invalid', 'Stored adapter definition is invalid.');
    }
    return {
      providerId: row.providerId,
      ref,
      definition: null,
      isCurrent: row.isCurrent,
      disabled: row.disabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  if (
    row.definitionJson === null ||
    Buffer.byteLength(row.definitionJson, 'utf8') > MAX_ADAPTER_DEFINITION_BYTES
  ) {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Stored adapter definition is invalid.');
  }
  let parsed: ReturnType<typeof parseDeclarativeJson>;
  try {
    parsed = parseDeclarativeJson(row.definitionJson);
    assertNoStaticCredentialLiterals(parsed);
    if (parsed.id !== ref.adapterId) throw new Error('invalid persisted id');
    const canonical = canonicalDeclarativeSpec(parsed);
    if (canonical !== row.definitionJson || digestDefinition(canonical) !== ref.digest) {
      throw new Error('invalid persisted digest');
    }
  } catch {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Stored adapter definition is invalid.');
  }
  return {
    providerId: row.providerId,
    ref,
    definition: parsed as unknown as Readonly<Record<string, unknown>>,
    isCurrent: row.isCurrent,
    disabled: row.disabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function persistedTombstone(
  row: typeof trustedAdapterTombstones.$inferSelect,
): TrustedAdapterTombstoneRecord {
  return {
    adapterId: row.adapterId,
    version: row.version,
    digest: row.digest,
    removedAt: row.removedAt,
  };
}

function persistedInstallation(
  row: typeof trustedAdapterInstallations.$inferSelect,
): TrustedAdapterInstallationRecord {
  return {
    adapterId: row.adapterId,
    version: row.version,
    digest: row.digest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function transactionDate(value: Date | undefined): Date {
  const result = value === undefined ? new Date() : cloneDate(value);
  if (!Number.isFinite(result.getTime())) {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Adapter lifecycle timestamp is invalid.');
  }
  return result;
}

function exactRefCondition(ref: CustomAdapterRef) {
  return and(
    eq(providerAdapterDefinitions.kind, ref.kind),
    eq(providerAdapterDefinitions.adapterId, ref.adapterId),
    eq(providerAdapterDefinitions.version, ref.version),
    eq(providerAdapterDefinitions.digest, ref.digest),
  );
}

function currentRef(transaction: AppDatabase, providerId: string): CustomAdapterRef | null {
  const row = transaction
    .select({
      kind: providerAdapterDefinitions.kind,
      adapterId: providerAdapterDefinitions.adapterId,
      version: providerAdapterDefinitions.version,
      digest: providerAdapterDefinitions.digest,
    })
    .from(providerAdapterDefinitions)
    .where(and(eq(providerAdapterDefinitions.providerId, providerId), eq(providerAdapterDefinitions.isCurrent, true)))
    .get();
  return row === undefined ? null : parseRef(row);
}

function hasReferencedJobs(
  transaction: AppDatabase,
  providerId: string,
  ref: CustomAdapterRef,
): boolean {
  const rows = transaction
    .select({
      adapterKind: jobs.adapterKind,
      adapterId: jobs.adapterId,
      adapterVersion: jobs.adapterVersion,
      adapterDigest: jobs.adapterDigest,
    })
    .from(jobs)
    .where(and(eq(jobs.providerId, providerId), isNull(jobs.deletedAt)))
    .all();
  for (const row of rows) {
    const values = [row.adapterKind, row.adapterId, row.adapterVersion, row.adapterDigest];
    if (values.every((value) => value === null)) continue;
    const parsed = CustomAdapterRefSchema.safeParse({
      kind: row.adapterKind,
      adapterId: row.adapterId,
      version: row.adapterVersion,
      digest: row.adapterDigest,
    });
    if (!parsed.success || parsed.data.kind !== ref.kind || parsed.data.adapterId !== ref.adapterId || parsed.data.version !== ref.version || parsed.data.digest !== ref.digest) {
      // A malformed or different retained reference is not a reason to delete
      // this revision, except malformed data: it is safer to preserve rows.
      if (!parsed.success) return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Retained references that prevent deleting one exact adapter revision.
 *
 * The database trigger normally keeps all four job columns populated or all
 * four null. The incomplete branch remains deliberately conservative for
 * legacy/corrupt rows, matching hasReferencedJobs's fail-closed behavior.
 */
function retainedJobReferenceCondition(providerId: string, ref: CustomAdapterRef) {
  const anyReference = or(
    isNotNull(jobs.adapterKind),
    isNotNull(jobs.adapterId),
    isNotNull(jobs.adapterVersion),
    isNotNull(jobs.adapterDigest),
  );
  const incompleteReference = and(
    anyReference,
    or(
      isNull(jobs.adapterKind),
      isNull(jobs.adapterId),
      isNull(jobs.adapterVersion),
      isNull(jobs.adapterDigest),
    ),
  );
  const exactReference = and(
    eq(jobs.adapterKind, ref.kind),
    eq(jobs.adapterId, ref.adapterId),
    eq(jobs.adapterVersion, ref.version),
    eq(jobs.adapterDigest, ref.digest),
  );
  return and(
    eq(jobs.providerId, providerId),
    isNull(jobs.deletedAt),
    or(incompleteReference, exactReference),
  );
}

function eventPayload(providerId: string, ref: CustomAdapterRef): Record<string, string> {
  return {
    providerId,
    kind: ref.kind,
    adapterId: ref.adapterId,
    version: ref.version,
    digest: ref.digest,
  };
}

function appendEvent(
  transaction: AppDatabase,
  input: Parameters<typeof toChangeEventValues>[0],
): ChangeEventRecord {
  const result = transaction.insert(changeEvents).values(toChangeEventValues(input)).run();
  const row = transaction
    .select()
    .from(changeEvents)
    .where(eq(changeEvents.id, Number(result.lastInsertRowid)))
    .get();
  if (row === undefined) {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Adapter lifecycle event was not stored.');
  }
  return mapChangeEventRow(row);
}

function trustedBindingInTransaction(
  transaction: AppDatabase,
  providerId: string,
  ref: CustomAdapterRef,
  now: Date,
): { readonly record: ProviderAdapterDefinitionRecord; readonly event: ChangeEventRecord } {
  const provider = transaction
    .select({ id: providers.id, type: providers.type })
    .from(providers)
    .where(eq(providers.id, providerId))
    .get();
  if (provider === undefined) {
    throw new ProviderAdapterDefinitionError('provider_not_found', 'Provider was not found.');
  }
  if (provider.type !== 'custom-js-v1' || ref.kind !== 'trusted-javascript') {
    throw new ProviderAdapterDefinitionError(
      'invalid_reference',
      'Adapter reference kind is not valid for this Provider.',
    );
  }

  const current = transaction
    .select()
    .from(providerAdapterDefinitions)
    .where(and(eq(providerAdapterDefinitions.providerId, providerId), eq(providerAdapterDefinitions.isCurrent, true)))
    .get();
  if (current !== undefined && current.adapterId === ref.adapterId && (
    current.kind !== ref.kind || current.version !== ref.version || current.digest !== ref.digest
  )) {
    throw new ProviderAdapterDefinitionError(
      'already_exists',
      'Trusted adapter ids are immutable across revisions.',
    );
  }

  const existing = transaction
    .select()
    .from(providerAdapterDefinitions)
    .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
    .get();
  if (existing !== undefined && existing.definitionJson !== null) {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Stored trusted adapter definition is invalid.');
  }
  if (existing?.disabled === true) {
    throw new ProviderAdapterDefinitionError(
      'disabled_revision',
      'Disabled trusted adapter revisions cannot be rebound.',
    );
  }

  transaction
    .update(providerAdapterDefinitions)
    .set({ isCurrent: false, updatedAt: now })
    .where(and(eq(providerAdapterDefinitions.providerId, providerId), eq(providerAdapterDefinitions.isCurrent, true)))
    .run();

  if (existing === undefined) {
    transaction
      .insert(providerAdapterDefinitions)
      .values({
        providerId,
        kind: ref.kind,
        adapterId: ref.adapterId,
        version: ref.version,
        digest: ref.digest,
        definitionJson: null,
        isCurrent: true,
        disabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    transaction
      .update(providerAdapterDefinitions)
      .set({ isCurrent: true, disabled: false, updatedAt: now })
      .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
      .run();
  }

  const event = appendEvent(transaction, {
    aggregateType: 'provider_adapter_definition',
    aggregateId: providerId,
    eventType: existing === undefined
      ? 'provider_adapter_definition.created'
      : 'provider_adapter_definition.replaced',
    payload: eventPayload(providerId, ref),
    createdAt: now,
  });
  const row = transaction
    .select()
    .from(providerAdapterDefinitions)
    .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
    .get();
  if (row === undefined) {
    throw new ProviderAdapterDefinitionError('persisted_invalid', 'Adapter definition was not stored.');
  }
  return { record: persistedRecord(row), event };
}

function normalizeTrustedInstallationInput(
  first: TrustedAdapterInstallationInput | CustomAdapterRef | string | undefined,
  second?: string | CustomAdapterRef,
  third?: Date,
): TrustedAdapterInstallationInput {
  if (typeof first === 'string' || first === undefined) {
    const ref = CustomAdapterRefSchema.safeParse(second);
    if (!ref.success) {
      throw new ProviderAdapterDefinitionError('invalid_reference', 'Adapter reference is invalid.');
    }
    return {
      ref: ref.data,
      ...(first === undefined ? {} : { providerId: first }),
      ...(third === undefined ? {} : { now: third }),
    };
  }
  if (CustomAdapterRefSchema.safeParse(first).success) {
    const ref = CustomAdapterRefSchema.parse(first);
    return {
      ref,
      ...(typeof second === 'string' ? { providerId: second } : {}),
      ...(third === undefined ? {} : { now: third }),
    };
  }
  if (typeof first === 'object' && first !== null && Object.hasOwn(first, 'ref')) {
    const input = first as TrustedAdapterInstallationInput;
    const ref = CustomAdapterRefSchema.safeParse(input.ref);
    if (
      !ref.success ||
      (input.providerId !== undefined && typeof input.providerId !== 'string') ||
      (input.now !== undefined && !(input.now instanceof Date)) ||
      (input.createdAt !== undefined && !(input.createdAt instanceof Date)) ||
      (input.updatedAt !== undefined && !(input.updatedAt instanceof Date))
    ) {
      throw new ProviderAdapterDefinitionError('invalid_reference', 'Trusted adapter installation input is invalid.');
    }
    return {
      ref: ref.data,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    };
  }
  throw new ProviderAdapterDefinitionError('invalid_reference', 'Adapter reference is invalid.');
}

export class ProviderAdapterDefinitionRepository {
  public constructor(private readonly database: AppDatabase) {}

  /** Backwards-compatible alias for the current revision. */
  public get(providerId: string): ProviderAdapterDefinitionRecord | null {
    return this.getCurrent(providerId);
  }

  public getCurrent(providerId: string): ProviderAdapterDefinitionRecord | null {
    const row = this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(and(eq(providerAdapterDefinitions.providerId, providerId), eq(providerAdapterDefinitions.isCurrent, true)))
      .get();
    return row === undefined ? null : persistedRecord(row);
  }

  /** Returns current, or the most recently disabled exact binding when none is current. */
  public getCurrentOrLatestDisabled(providerId: string): ProviderAdapterDefinitionRecord | null {
    const current = this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(and(
        eq(providerAdapterDefinitions.providerId, providerId),
        eq(providerAdapterDefinitions.kind, 'trusted-javascript'),
        eq(providerAdapterDefinitions.isCurrent, true),
      ))
      .get();
    if (current !== undefined) return persistedRecord(current);
    const disabled = this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(and(
        eq(providerAdapterDefinitions.providerId, providerId),
        eq(providerAdapterDefinitions.kind, 'trusted-javascript'),
        eq(providerAdapterDefinitions.disabled, true),
      ))
      .orderBy(
        desc(providerAdapterDefinitions.updatedAt),
        desc(providerAdapterDefinitions.createdAt),
        asc(providerAdapterDefinitions.kind),
        asc(providerAdapterDefinitions.adapterId),
        asc(providerAdapterDefinitions.version),
        asc(providerAdapterDefinitions.digest),
      )
      .get();
    return disabled === undefined ? null : persistedRecord(disabled);
  }

  public getByRef(providerId: string, rawRef: CustomAdapterRef): ProviderAdapterDefinitionRecord | null {
    const ref = parseRef(rawRef);
    const row = this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
      .get();
    return row === undefined ? null : persistedRecord(row);
  }

  public getTombstone(adapterId: string): TrustedAdapterTombstoneRecord | null {
    const row = this.database
      .select()
      .from(trustedAdapterTombstones)
      .where(eq(trustedAdapterTombstones.adapterId, adapterId))
      .get();
    return row === undefined ? null : persistedTombstone(row);
  }

  public isTombstoned(adapterId: string): boolean {
    return this.getTombstone(adapterId) !== null;
  }

  public getTrustedAdapterInstallation(adapterId: string): TrustedAdapterInstallationRecord | null {
    const row = this.database
      .select()
      .from(trustedAdapterInstallations)
      .where(eq(trustedAdapterInstallations.adapterId, adapterId))
      .get();
    return row === undefined ? null : persistedInstallation(row);
  }

  public listTrustedAdapterInstallations(): readonly TrustedAdapterInstallationRecord[] {
    return this.database
      .select()
      .from(trustedAdapterInstallations)
      .orderBy(
        asc(trustedAdapterInstallations.createdAt),
        asc(trustedAdapterInstallations.updatedAt),
        asc(trustedAdapterInstallations.adapterId),
      )
      .all()
      .map(persistedInstallation);
  }

  /**
   * Commits trusted installation metadata, an optional Provider binding, and
   * their source-free lifecycle events as one SQLite transaction. The
   * filesystem install is intentionally performed by TrustedAdapterService
   * before entering this method and rolled back by that service on failure.
   */
  public installTrustedAdapter(input: TrustedAdapterInstallationInput): TrustedAdapterInstallResult;
  public installTrustedAdapter(rawRef: CustomAdapterRef, providerId?: string, now?: Date): TrustedAdapterInstallResult;
  public installTrustedAdapter(providerId: string | undefined, rawRef: CustomAdapterRef, now?: Date): TrustedAdapterInstallResult;
  public installTrustedAdapter(
    first: TrustedAdapterInstallationInput | CustomAdapterRef | string | undefined,
    second?: string | CustomAdapterRef,
    third?: Date,
  ): TrustedAdapterInstallResult {
    const input = normalizeTrustedInstallationInput(first, second, third);
    const ref = parseRef(input.ref);
    if (ref.kind !== 'trusted-javascript') {
      throw new ProviderAdapterDefinitionError(
        'invalid_reference',
        'Only trusted JavaScript adapter revisions may be installed.',
      );
    }
    const createdAt = transactionDate(input.createdAt ?? input.now);
    const requestedUpdatedAt = transactionDate(input.updatedAt ?? input.now ?? createdAt);
    const now = requestedUpdatedAt.getTime() >= createdAt.getTime() ? requestedUpdatedAt : createdAt;
    return this.database.transaction((transaction) => {
      const tombstone = transaction
        .select({ adapterId: trustedAdapterTombstones.adapterId })
        .from(trustedAdapterTombstones)
        .where(eq(trustedAdapterTombstones.adapterId, ref.adapterId))
        .get();
      if (tombstone !== undefined) {
        throw new ProviderAdapterDefinitionError('tombstoned', 'Trusted adapter id is tombstoned.');
      }

      const definitions = transaction
        .select({
          kind: providerAdapterDefinitions.kind,
          adapterId: providerAdapterDefinitions.adapterId,
          version: providerAdapterDefinitions.version,
          digest: providerAdapterDefinitions.digest,
        })
        .from(providerAdapterDefinitions)
        .where(eq(providerAdapterDefinitions.adapterId, ref.adapterId))
        .all();
      if (definitions.some((candidate) => candidate.kind !== ref.kind || candidate.version !== ref.version || candidate.digest !== ref.digest)) {
        throw new ProviderAdapterDefinitionError(
          'already_exists',
          'Trusted adapter ids are immutable across revisions.',
        );
      }

      const existing = transaction
        .select()
        .from(trustedAdapterInstallations)
        .where(eq(trustedAdapterInstallations.adapterId, ref.adapterId))
        .get();
      if (existing !== undefined && (existing.version !== ref.version || existing.digest !== ref.digest)) {
        throw new ProviderAdapterDefinitionError(
          'already_exists',
          'Trusted adapter ids are immutable across revisions.',
        );
      }

      const events: ChangeEventRecord[] = [];
      if (existing === undefined) {
        transaction
          .insert(trustedAdapterInstallations)
          .values({
            adapterId: ref.adapterId,
            version: ref.version,
            digest: ref.digest,
            createdAt,
            updatedAt: now,
          })
          .run();
        events.push(appendEvent(transaction, {
          aggregateType: 'trusted_adapter',
          aggregateId: ref.adapterId,
          eventType: 'trusted_adapter.installed',
          payload: {
            adapterId: ref.adapterId,
            digest: ref.digest,
            kind: ref.kind,
            version: ref.version,
          },
          createdAt: now,
        }));
      }

      let definition: ProviderAdapterDefinitionRecord | null = null;
      if (input.providerId !== undefined) {
        const binding = trustedBindingInTransaction(transaction, input.providerId, ref, now);
        definition = binding.record;
        events.push(binding.event);
        const updatedAt = existing === undefined || now.getTime() >= existing.updatedAt.getTime()
          ? now
          : existing.updatedAt;
        transaction
          .update(trustedAdapterInstallations)
          .set({ updatedAt })
          .where(eq(trustedAdapterInstallations.adapterId, ref.adapterId))
          .run();
      }

      const installation = transaction
        .select()
        .from(trustedAdapterInstallations)
        .where(eq(trustedAdapterInstallations.adapterId, ref.adapterId))
        .get();
      if (installation === undefined) {
        throw new ProviderAdapterDefinitionError('persisted_invalid', 'Trusted adapter installation was not stored.');
      }
      return {
        definition,
        events,
        installation: persistedInstallation(installation),
      };
    });
  }

  /** Compatibility alias for callers that use the revision-oriented name. */
  public installTrustedAdapterRevision(input: TrustedAdapterInstallationInput): TrustedAdapterInstallResult {
    return this.installTrustedAdapter(input);
  }

  /**
   * Atomically reserves a removed trusted adapter id. The transaction checks
   * every persisted definition and retained Job ref before inserting the
   * permanent tombstone, so a concurrent writer cannot recreate the id.
   */
  public tombstone(rawRef: CustomAdapterRef, removedAtInput?: Date): TrustedAdapterTombstoneRecord {
    const ref = parseRef(rawRef);
    if (ref.kind !== 'trusted-javascript') {
      throw new ProviderAdapterDefinitionError(
        'invalid_reference',
        'Only trusted JavaScript adapter revisions may be tombstoned.',
      );
    }
    return this.database.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(trustedAdapterTombstones)
        .where(eq(trustedAdapterTombstones.adapterId, ref.adapterId))
        .get();
      if (existing !== undefined) {
        transaction
          .delete(trustedAdapterInstallations)
          .where(eq(trustedAdapterInstallations.adapterId, ref.adapterId))
          .run();
        return persistedTombstone(existing);
      }

      const definition = transaction
        .select({ providerId: providerAdapterDefinitions.providerId })
        .from(providerAdapterDefinitions)
        .where(eq(providerAdapterDefinitions.adapterId, ref.adapterId))
        .get();
      if (definition !== undefined) {
        throw new ProviderAdapterDefinitionError(
          'referenced_definitions',
          'Adapter definition still references this adapter id.',
        );
      }
      const retainedJob = transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.adapterId, ref.adapterId), isNull(jobs.deletedAt)))
        .get();
      if (retainedJob !== undefined) {
        throw new ProviderAdapterDefinitionError(
          'referenced_jobs',
          'A retained Job still references this adapter id.',
        );
      }

      const removedAt = transactionDate(removedAtInput);
      transaction
        .insert(trustedAdapterTombstones)
        .values({
          adapterId: ref.adapterId,
          version: ref.version,
          digest: ref.digest,
          removedAt,
        })
        .run();
      transaction
        .delete(trustedAdapterInstallations)
        .where(eq(trustedAdapterInstallations.adapterId, ref.adapterId))
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'trusted_adapter',
            aggregateId: ref.adapterId,
            eventType: 'trusted_adapter.tombstoned',
            payload: {
              adapterId: ref.adapterId,
              digest: ref.digest,
              kind: ref.kind,
              version: ref.version,
            },
            createdAt: removedAt,
          }),
        )
        .run();
      const row = transaction
        .select()
        .from(trustedAdapterTombstones)
        .where(eq(trustedAdapterTombstones.adapterId, ref.adapterId))
        .get();
      if (row === undefined) throw new ProviderAdapterDefinitionError('persisted_invalid', 'Adapter tombstone was not stored.');
      return persistedTombstone(row);
    });
  }

  /**
   * Read-only lookup for every persisted revision using an adapter id.
   * AdapterStore keeps one immutable revision per id, so callers must account
   * for historical references as well as the current revision.
   */
  public listByAdapterId(
    adapterId: string,
  ): readonly ProviderAdapterDefinitionRecord[] {
    return this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(eq(providerAdapterDefinitions.adapterId, adapterId))
      .all()
      .map(persistedRecord);
  }

  /** Returns every retained revision in a deterministic, creation-ordered list. */
  public list(providerId: string): readonly ProviderAdapterDefinitionRecord[] {
    return this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(eq(providerAdapterDefinitions.providerId, providerId))
      .orderBy(
        asc(providerAdapterDefinitions.createdAt),
        asc(providerAdapterDefinitions.updatedAt),
        asc(providerAdapterDefinitions.kind),
        asc(providerAdapterDefinitions.adapterId),
        asc(providerAdapterDefinitions.version),
        asc(providerAdapterDefinitions.digest),
      )
      .all()
      .map(persistedRecord);
  }

  public create(providerId: string, input: PutProviderAdapterDefinitionInput): ProviderAdapterDefinitionRecord {
    return this.write(providerId, input, 'create');
  }

  /** Compatibility entry point; revision content is never updated in place. */
  public update(providerId: string, input: PutProviderAdapterDefinitionInput): ProviderAdapterDefinitionRecord {
    return this.replace(providerId, input);
  }

  public replace(providerId: string, input: PutProviderAdapterDefinitionInput): ProviderAdapterDefinitionRecord {
    return this.write(providerId, input, 'replace');
  }

  private write(
    providerId: string,
    input: PutProviderAdapterDefinitionInput,
    mode: 'create' | 'replace',
  ): ProviderAdapterDefinitionRecord {
    const ref = parseRef(input.ref);
    const normalized = normalizeDefinition(ref, input.definition);
    return this.database.transaction((transaction) => {
      const provider = transaction
        .select({ id: providers.id, type: providers.type })
        .from(providers)
        .where(eq(providers.id, providerId))
        .get();
      if (provider === undefined) {
        throw new ProviderAdapterDefinitionError('provider_not_found', 'Provider was not found.');
      }
      if (expectedKind(provider.type) !== ref.kind) {
        throw new ProviderAdapterDefinitionError(
          'invalid_reference',
          'Adapter reference kind is not valid for this provider.',
        );
      }
      if (ref.kind === 'trusted-javascript') {
        const tombstone = transaction
          .select({ adapterId: trustedAdapterTombstones.adapterId })
          .from(trustedAdapterTombstones)
          .where(eq(trustedAdapterTombstones.adapterId, ref.adapterId))
          .get();
        if (tombstone !== undefined) {
          throw new ProviderAdapterDefinitionError(
            'tombstoned',
            'Trusted adapter id is tombstoned.',
          );
        }
      }
      const existing = transaction
        .select()
        .from(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .get();
      if (mode === 'create' && existing !== undefined) {
        throw new ProviderAdapterDefinitionError('already_exists', 'Adapter definition already exists.');
      }
      if (existing !== undefined) {
        if (existing.definitionJson !== normalized.canonical) {
          throw new ProviderAdapterDefinitionError('persisted_invalid', 'Stored adapter definition is invalid.');
        }
        if (ref.kind === 'trusted-javascript' && existing.disabled) {
          throw new ProviderAdapterDefinitionError(
            'disabled_revision',
            'Disabled trusted adapter revisions cannot be rebound.',
          );
        }
      }
      const now = new Date();
      transaction
        .update(providerAdapterDefinitions)
        .set({ isCurrent: false, updatedAt: now })
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), eq(providerAdapterDefinitions.isCurrent, true)))
        .run();
      if (existing === undefined) {
        transaction
          .insert(providerAdapterDefinitions)
          .values({
            providerId,
            kind: ref.kind,
            adapterId: ref.adapterId,
            version: ref.version,
            digest: ref.digest,
            definitionJson: normalized.canonical,
            isCurrent: true,
            disabled: false,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else {
        // Content columns are immutable; only the current/disabled markers move.
        transaction
          .update(providerAdapterDefinitions)
          .set({ isCurrent: true, disabled: false, updatedAt: now })
          .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
          .run();
      }
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider_adapter_definition',
            aggregateId: providerId,
            eventType: mode === 'create'
              ? 'provider_adapter_definition.created'
              : 'provider_adapter_definition.replaced',
            payload: eventPayload(providerId, ref),
            createdAt: now,
          }),
        )
        .run();
      const row = transaction
        .select()
        .from(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .get();
      if (row === undefined) {
        throw new ProviderAdapterDefinitionError('persisted_invalid', 'Adapter definition was not stored.');
      }
      return persistedRecord(row);
    });
  }

  public disable(providerId: string, rawRef?: CustomAdapterRef): ProviderAdapterDefinitionRecord | null {
    return this.database.transaction((transaction) => {
      const ref = rawRef === undefined ? currentRef(transaction, providerId) : parseRef(rawRef);
      if (ref === null) return null;
      const row = transaction
        .select()
        .from(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .get();
      if (row === undefined) return null;
      const now = new Date();
      transaction
        .update(providerAdapterDefinitions)
        .set({ isCurrent: false, disabled: true, updatedAt: now })
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider_adapter_definition',
            aggregateId: providerId,
            eventType: 'provider_adapter_definition.disabled',
            payload: eventPayload(providerId, ref),
            createdAt: now,
          }),
        )
        .run();
      const updated = transaction
        .select()
        .from(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .get();
      return updated === undefined ? null : persistedRecord(updated);
    });
  }

  public delete(providerId: string, rawRef?: CustomAdapterRef): boolean {
    return this.database.transaction((transaction) => {
      const ref = rawRef === undefined ? currentRef(transaction, providerId) : parseRef(rawRef);
      if (ref === null) return false;
      const row = transaction
        .select({ providerId: providerAdapterDefinitions.providerId })
        .from(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .get();
      if (row === undefined) return false;
      if (hasReferencedJobs(transaction, providerId, ref)) {
        throw new ProviderAdapterDefinitionError(
          'referenced_jobs',
          'Adapter definition is referenced by a retained job.',
        );
      }
      transaction
        .delete(providerAdapterDefinitions)
        .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
        .run();
      transaction
        .insert(changeEvents)
        .values(
          toChangeEventValues({
            aggregateType: 'provider_adapter_definition',
            aggregateId: providerId,
            eventType: 'provider_adapter_definition.deleted',
            payload: eventPayload(providerId, ref),
          }),
        )
        .run();
      return true;
    });
  }

  /** Deletes only when the supplied immutable ref is still the current row. */
  public deleteCurrent(providerId: string, rawRef: CustomAdapterRef): boolean {
    const expected = parseRef(rawRef);
    return this.database.transaction((transaction) => {
      // Keep the expected ref and current marker in the same SQL predicate as
      // the delete. This is the CAS boundary; no preceding read can select a
      // newer revision for deletion after a concurrent replace commits.
      const deleted = transaction
        .delete(providerAdapterDefinitions)
        .where(and(
          eq(providerAdapterDefinitions.providerId, providerId),
          eq(providerAdapterDefinitions.isCurrent, true),
          exactRefCondition(expected),
          notExists(
            transaction
              .select({ id: jobs.id })
              .from(jobs)
              .where(retainedJobReferenceCondition(providerId, expected)),
          ),
        ))
        .run();
      if (deleted.changes === 1) {
        transaction
          .insert(changeEvents)
          .values(
            toChangeEventValues({
              aggregateType: 'provider_adapter_definition',
              aggregateId: providerId,
              eventType: 'provider_adapter_definition.deleted',
              payload: eventPayload(providerId, expected),
            }),
          )
          .run();
        return true;
      }

      // The failed CAS is classified while the transaction still owns its
      // snapshot. A changed current ref is a stable conflict, while no
      // current row preserves the existing not-found behavior.
      const current = currentRef(transaction, providerId);
      if (current === null) return false;
      if (
        current.kind !== expected.kind ||
        current.adapterId !== expected.adapterId ||
        current.version !== expected.version ||
        current.digest !== expected.digest
      ) {
        throw new ProviderAdapterDefinitionError(
          'current_conflict',
          'The current adapter revision changed; reload before deleting.',
        );
      }
      if (hasReferencedJobs(transaction, providerId, expected)) {
        throw new ProviderAdapterDefinitionError(
          'referenced_jobs',
          'Adapter definition is referenced by a retained Job.',
        );
      }
      // A current row that survived the CAS without a retained reference is
      // only possible if a database trigger changed it during the statement.
      // Treat it as a failed CAS rather than claiming a deletion occurred.
      throw new ProviderAdapterDefinitionError(
        'current_conflict',
        'The current adapter revision changed; reload before deleting.',
      );
    });
  }
}

export function hasRetainedAdapterJobs(database: AppDatabase, providerId: string): boolean {
  return database
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.providerId, providerId),
      isNull(jobs.deletedAt),
      or(
        isNotNull(jobs.adapterKind),
        isNotNull(jobs.adapterId),
        isNotNull(jobs.adapterVersion),
        isNotNull(jobs.adapterDigest),
      ),
    ))
    .get() !== undefined;
}
