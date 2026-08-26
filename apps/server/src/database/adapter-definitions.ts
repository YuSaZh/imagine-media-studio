import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  CustomAdapterRefSchema,
  type CustomAdapterRef,
} from '@imagine/shared';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

import {
  canonicalDeclarativeSpec,
  isCredentialLikeQueryName,
  isSecretTemplate,
  parseDeclarativeJson,
} from '../providers/custom-http/index.js';
import { assertSafeCustomFields } from '../providers/custom-http/capabilities.js';
import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import { changeEvents, jobs, providers, providerAdapterDefinitions } from './schema.js';

export const MAX_ADAPTER_DEFINITION_BYTES = 128 * 1024;

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
      | 'not_found'
      | 'referenced_jobs'
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
            assertSafeCustomFields(item);
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

function isCredentialLikeFieldName(value: string): boolean {
  return CREDENTIAL_FIELD_NAME.test(value) || isCredentialLikeQueryName(value);
}

function assertNoStaticCredentialLiterals(value: unknown): void {
  const inspectPayload = (node: unknown): void => {
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
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'body') inspectPayload(child);
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

function eventPayload(providerId: string, ref: CustomAdapterRef): Record<string, string> {
  return {
    providerId,
    kind: ref.kind,
    adapterId: ref.adapterId,
    version: ref.version,
    digest: ref.digest,
  };
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

  public getByRef(providerId: string, rawRef: CustomAdapterRef): ProviderAdapterDefinitionRecord | null {
    const ref = parseRef(rawRef);
    const row = this.database
      .select()
      .from(providerAdapterDefinitions)
      .where(and(eq(providerAdapterDefinitions.providerId, providerId), exactRefCondition(ref)))
      .get();
    return row === undefined ? null : persistedRecord(row);
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
