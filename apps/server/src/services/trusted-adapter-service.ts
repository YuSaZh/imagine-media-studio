import { Buffer } from 'node:buffer';

import {
  AdapterAlreadyInstalledError,
  AdapterAuthorizationError,
  AdapterManifestError,
  AdapterSourcePolicyError,
  AdapterStoreError,
  digestAdapterSource,
  MAX_ADAPTER_SOURCE_BYTES,
  MAX_MANIFEST_BYTES,
  parseAdapterManifest,
  validateAdapterExports,
  validateAdapterSource,
  type AdapterInstallRequest,
  type AdapterManifest,
  type AdapterRecord,
} from '../adapters/index.js';
import {
  CustomAdapterRefSchema,
  type CustomAdapterRef,
} from '@imagine/shared';
import {
  ProviderAdapterDefinitionError,
  type TrustedAdapterInstallResult,
  type TrustedAdapterInstallationRecord,
  type ProviderAdapterDefinitionRecord,
  type PutProviderAdapterDefinitionInput,
  type TrustedAdapterTombstoneRecord,
} from '../database/adapter-definitions.js';
import type { ProviderStorageRecord } from '../database/providers.js';

const TRUSTED_JAVASCRIPT_KIND = 'trusted-javascript' as const;
const CUSTOM_JAVASCRIPT_PROVIDER_TYPE = 'custom-js-v1' as const;
const INSTALL_KEYS = new Set(['manifest', 'source', 'providerId']);
const BIND_KEYS = new Set(['providerId', 'ref']);

/**
 * Adapter directories contain one immutable revision. Updating the code must
 * use a new adapter id so old Job references can continue to resolve.
 */
export const TRUSTED_ADAPTER_DIRECTORY_POLICY =
  'one immutable revision per adapter id; upgrades require a new adapter id' as const;

export interface TrustedAdapterStorePort {
  install(request: AdapterInstallRequest): AdapterRecord | Promise<AdapterRecord>;
  list(): readonly AdapterRecord[] | Promise<readonly AdapterRecord[]>;
  get(id: string): AdapterRecord | null | Promise<AdapterRecord | null>;
  remove(id: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface TrustedAdapterDefinitionRepositoryPort {
  getCurrent(providerId: string): ProviderAdapterDefinitionRecord | null;
  getCurrentOrLatestDisabled(providerId: string): ProviderAdapterDefinitionRecord | null;
  getByRef(providerId: string, ref: CustomAdapterRef): ProviderAdapterDefinitionRecord | null;
  list(providerId: string): readonly ProviderAdapterDefinitionRecord[];
  disable(providerId: string, ref?: CustomAdapterRef): ProviderAdapterDefinitionRecord | null;
  delete(providerId: string, ref?: CustomAdapterRef): boolean;
  create?(
    providerId: string,
    input: PutProviderAdapterDefinitionInput,
  ): ProviderAdapterDefinitionRecord;
  replace(
    providerId: string,
    input: PutProviderAdapterDefinitionInput,
  ): ProviderAdapterDefinitionRecord;
  installTrustedAdapter?(
    input: {
      readonly ref: CustomAdapterRef;
      readonly providerId?: string;
      readonly now?: Date;
    },
  ): TrustedAdapterInstallResult | Promise<TrustedAdapterInstallResult>;
  /** Read-only lookup used to prevent dangling adapter-id references. */
  listByAdapterId(adapterId: string): readonly ProviderAdapterDefinitionRecord[];
  getTrustedAdapterInstallation?(adapterId: string): TrustedAdapterInstallationRecord | null;
  getTombstone?(adapterId: string): TrustedAdapterTombstoneRecord | null;
  isTombstoned?(adapterId: string): boolean;
  tombstone?(ref: CustomAdapterRef, removedAt?: Date): TrustedAdapterTombstoneRecord;
}

export interface TrustedAdapterProviderRepositoryPort {
  get(id: string): ProviderStorageRecord | null;
}

export interface TrustedAdapterJobRepositoryPort {
  /** Includes active and retained terminal jobs, but excludes soft-deleted jobs. */
  hasRetainedAdapterId(adapterId: string): boolean;
}

export interface TrustedAdapterOutboxPort {
  flush(): void | Promise<void>;
}

export interface TrustedAdapterServiceClock {
  now(): Date | number;
}

export interface TrustedAdapterInstallRequest {
  readonly manifest: unknown;
  readonly source: string | Uint8Array;
  readonly providerId?: string;
}

export interface TrustedAdapterBindRequest {
  readonly providerId: string;
  readonly ref: CustomAdapterRef;
}

export type TrustedJavaScriptAdapterInstallRequest = TrustedAdapterInstallRequest;
export type TrustedJavaScriptAdapterBindRequest = TrustedAdapterBindRequest;

export type TrustedAdapterRef = Omit<CustomAdapterRef, 'kind'> & { readonly kind: 'trusted-javascript' };

/** Source-free management projection. Runtime source is available only through AdapterStore.runtimeReader(). */
export interface TrustedAdapterManagementDto {
  readonly manifest: AdapterManifest;
  readonly ref: TrustedAdapterRef;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TrustedAdapterInstallationTimestamps {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Source-free view of one Provider binding. The top-level timestamps belong to
 * the provider definition; installation timestamps are kept separate because
 * an immutable adapter can remain installed after its last binding is removed.
 */
export interface TrustedAdapterBindingDto {
  readonly providerId: string;
  readonly ref: TrustedAdapterRef;
  readonly definition: null;
  readonly isCurrent: boolean;
  readonly disabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly manifest: AdapterManifest;
  readonly installation: TrustedAdapterInstallationTimestamps;
}

export type TrustedJavaScriptAdapterBindingDto = TrustedAdapterBindingDto;

export type TrustedAdapterDto = TrustedAdapterManagementDto;
export type TrustedJavaScriptAdapterDto = TrustedAdapterManagementDto;

export type TrustedAdapterServiceErrorCode =
  | 'administrator_required'
  | 'invalid_request'
  | 'invalid_manifest'
  | 'invalid_source'
  | 'source_too_large'
  | 'manifest_too_large'
  | 'digest_mismatch'
  | 'already_exists'
  | 'adapter_id_immutable'
  | 'disabled_revision'
  | 'not_found'
  | 'manifest_mismatch'
  | 'provider_not_found'
  | 'provider_type_mismatch'
  | 'adapter_references_in_use'
  | 'adapter_references_unavailable'
  | 'store_failure'
  | 'definition_failure'
  | 'outbox_failure'
  | 'rollback_failed';

const ERROR_MESSAGES: Readonly<Record<TrustedAdapterServiceErrorCode, string>> = {
  administrator_required: 'Administrator authorization is required for adapter management.',
  invalid_request: 'The trusted adapter management request is invalid.',
  invalid_manifest: 'The trusted adapter manifest is invalid.',
  invalid_source: 'The trusted adapter source is invalid.',
  source_too_large: 'The trusted adapter source exceeds the size limit.',
  manifest_too_large: 'The trusted adapter manifest exceeds the size limit.',
  digest_mismatch: 'The trusted adapter source digest does not match its manifest.',
  already_exists: 'The trusted adapter is already installed.',
  adapter_id_immutable: 'The trusted adapter id is immutable; install an upgraded revision under a new id.',
  disabled_revision: 'Disabled trusted adapter revisions cannot be rebound.',
  not_found: 'The trusted adapter was not found.',
  manifest_mismatch: 'The installed trusted adapter manifest does not match the requested revision.',
  provider_not_found: 'The Provider was not found.',
  provider_type_mismatch: 'The Provider type does not accept a trusted JavaScript adapter.',
  adapter_references_in_use: 'The trusted adapter is still referenced and cannot be removed.',
  adapter_references_unavailable: 'Trusted adapter references could not be verified.',
  store_failure: 'The trusted adapter store operation could not be completed.',
  definition_failure: 'The trusted adapter definition could not be persisted.',
  outbox_failure: 'The trusted adapter event could not be published.',
  rollback_failed: 'The trusted adapter installation could not be rolled back.',
};

function statusFor(code: TrustedAdapterServiceErrorCode): number {
  switch (code) {
    case 'administrator_required':
      return 403;
    case 'invalid_request':
    case 'invalid_manifest':
    case 'invalid_source':
    case 'digest_mismatch':
      return 400;
    case 'source_too_large':
    case 'manifest_too_large':
      return 413;
    case 'not_found':
      return 404;
    case 'already_exists':
    case 'adapter_id_immutable':
    case 'disabled_revision':
    case 'manifest_mismatch':
    case 'provider_type_mismatch':
    case 'adapter_references_in_use':
      return 409;
    case 'provider_not_found':
      return 404;
    case 'adapter_references_unavailable':
      return 500;
    default:
      return 500;
  }
}

export class TrustedAdapterServiceError extends Error {
  public override readonly name = 'TrustedAdapterServiceError';
  public readonly statusCode: number;

  public constructor(public readonly code: TrustedAdapterServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.statusCode = statusFor(code);
  }
}

interface ServiceRepositories {
  readonly adapterDefinitions: TrustedAdapterDefinitionRepositoryPort;
  readonly providers: TrustedAdapterProviderRepositoryPort;
  readonly jobs: TrustedAdapterJobRepositoryPort;
}

interface BindingReadResult {
  readonly dto: TrustedAdapterBindingDto;
  readonly manifest: AdapterManifest;
  readonly installation: TrustedAdapterInstallationRecord;
  readonly events: readonly unknown[];
}

export interface TrustedAdapterServiceOptions {
  /** This value is captured at construction from PasswordAuth.required. */
  readonly adminEnabled: boolean;
  readonly store: TrustedAdapterStorePort;
  readonly adapterDefinitions?: TrustedAdapterDefinitionRepositoryPort;
  readonly definitions?: TrustedAdapterDefinitionRepositoryPort;
  readonly providers?: TrustedAdapterProviderRepositoryPort;
  readonly providerRepository?: TrustedAdapterProviderRepositoryPort;
  readonly jobs?: TrustedAdapterJobRepositoryPort;
  readonly jobRepository?: TrustedAdapterJobRepositoryPort;
  readonly repositories?: Partial<ServiceRepositories>;
  /** Required after-commit publisher for every management mutation. */
  readonly outbox: TrustedAdapterOutboxPort;
  readonly clock?: TrustedAdapterServiceClock;
}

const systemClock: TrustedAdapterServiceClock = { now: () => new Date() };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameRef(left: CustomAdapterRef, right: CustomAdapterRef): boolean {
  return left.kind === right.kind &&
    left.adapterId === right.adapterId &&
    left.version === right.version &&
    left.digest === right.digest;
}

function normalizedDate(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TrustedAdapterServiceError('definition_failure');
  return date;
}

function ownKeysAreAllowed(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sourceBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
}

function boundedByteLength(value: unknown): number | undefined {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof Uint8Array) return value.byteLength;
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return undefined;
  }
}

function cloneJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TrustedAdapterServiceError('definition_failure');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item, seen));
    if (value instanceof Date) return new Date(value.getTime());
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) output[key] = cloneJsonValue(child, seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

function parseTrustedRef(value: unknown): TrustedAdapterRef {
  const parsed = CustomAdapterRefSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== TRUSTED_JAVASCRIPT_KIND) {
    throw new TrustedAdapterServiceError('invalid_request');
  }
  return {
    kind: TRUSTED_JAVASCRIPT_KIND,
    adapterId: parsed.data.adapterId,
    version: parsed.data.version,
    digest: parsed.data.digest,
  };
}

function adapterIdIsValid(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u.test(id) && CustomAdapterRefSchema.safeParse({
    kind: TRUSTED_JAVASCRIPT_KIND,
    adapterId: id,
    version: '1',
    digest: '0'.repeat(64),
  }).success;
}

function parseAdapterId(value: unknown): string {
  if (typeof value !== 'string' || !adapterIdIsValid(value)) {
    throw new TrustedAdapterServiceError('invalid_request');
  }
  return value;
}

function isMissingStoreError(error: unknown): boolean {
  if (error instanceof AdapterStoreError && /^Adapter [a-z0-9][a-z0-9._-]{0,61}[a-z0-9] is not installed\.$/u.test(error.message)) {
    return true;
  }
  if (isRecord(error) && (error.code === 'not_found' || error.code === 'adapter_not_found')) return true;
  return false;
}

export class TrustedAdapterService {
  private readonly adminEnabled: boolean;
  private readonly store: TrustedAdapterStorePort;
  private readonly adapterDefinitions: TrustedAdapterDefinitionRepositoryPort;
  private readonly providers: TrustedAdapterProviderRepositoryPort;
  private readonly jobs: TrustedAdapterJobRepositoryPort;
  private readonly clock: TrustedAdapterServiceClock;
  private readonly outbox: TrustedAdapterOutboxPort;
  private readonly adapterLocks = new Map<string, Promise<void>>();

  public constructor(options: TrustedAdapterServiceOptions);
  public constructor(
    adminEnabled: boolean,
    store: TrustedAdapterStorePort,
    adapterDefinitions: TrustedAdapterDefinitionRepositoryPort,
    providers: TrustedAdapterProviderRepositoryPort,
    jobs: TrustedAdapterJobRepositoryPort,
    outbox: TrustedAdapterOutboxPort,
    clock?: TrustedAdapterServiceClock,
  );
  public constructor(
    optionsOrAdminEnabled: TrustedAdapterServiceOptions | boolean,
    positionalStore?: TrustedAdapterStorePort,
    positionalDefinitions?: TrustedAdapterDefinitionRepositoryPort,
    positionalProviders?: TrustedAdapterProviderRepositoryPort,
    positionalJobs?: TrustedAdapterJobRepositoryPort,
    positionalOutbox?: TrustedAdapterOutboxPort,
    positionalClock?: TrustedAdapterServiceClock,
  ) {
    let options: TrustedAdapterServiceOptions;
    if (typeof optionsOrAdminEnabled === 'boolean') {
      if (positionalStore === undefined || positionalDefinitions === undefined || positionalProviders === undefined || positionalJobs === undefined) {
        throw new TypeError('TrustedAdapterService requires adapter, Provider, and Job repositories.');
      }
      options = {
        adminEnabled: optionsOrAdminEnabled,
        store: positionalStore,
        adapterDefinitions: positionalDefinitions,
        providers: positionalProviders,
        jobs: positionalJobs,
        outbox: positionalOutbox as TrustedAdapterOutboxPort,
        ...(positionalClock === undefined ? {} : { clock: positionalClock }),
      };
    } else {
      options = optionsOrAdminEnabled;
    }
    const repositories = options.repositories;
    const adapterDefinitions = options.adapterDefinitions ?? options.definitions ?? repositories?.adapterDefinitions;
    const providers = options.providers ?? options.providerRepository ?? repositories?.providers;
    const jobs = options.jobs ?? options.jobRepository ?? repositories?.jobs;
    if (adapterDefinitions === undefined || providers === undefined || jobs === undefined) {
      throw new TypeError('TrustedAdapterService requires adapter, Provider, and Job repositories.');
    }
    if (options.outbox === undefined || typeof options.outbox.flush !== 'function') {
      throw new TypeError('TrustedAdapterService requires an outbox publisher.');
    }
    this.adminEnabled = options.adminEnabled;
    this.store = options.store;
    this.adapterDefinitions = adapterDefinitions;
    this.providers = providers;
    this.jobs = jobs;
    this.clock = options.clock ?? systemClock;
    this.outbox = options.outbox;
  }

  /** Installs one immutable revision and optionally binds it to a custom-js Provider. */
  public async install(input: TrustedAdapterInstallRequest): Promise<TrustedAdapterManagementDto> {
    this.assertAdmin();
    const request = this.preflightInstallRequest(input);
    return this.withAdapterLock(request.manifest.id, () => this.installPrepared(request));
  }

  private async installPrepared(request: {
    readonly manifest: AdapterManifest;
    readonly source: Uint8Array;
    readonly providerId?: string;
  }): Promise<TrustedAdapterManagementDto> {
    this.assertNotTombstoned(request.manifest.id);
    const provider = request.providerId === undefined
      ? null
      : this.requireCustomJavaScriptProvider(request.providerId);
    const requestedRef = this.refFromManifest(request.manifest);
    const existingDefinitions = this.readDefinitionsByAdapterId(request.manifest.id);
    if (existingDefinitions.some((definition) => sameRef(definition.ref, requestedRef))) {
      throw new TrustedAdapterServiceError('already_exists');
    }
    this.assertAdapterIdAvailable(request.manifest.id, provider?.id);
    await this.assertStoreIdAvailable(requestedRef);

    const installed = await this.installInStore(request);
    let manifest: AdapterManifest;
    try {
      manifest = this.manifestFromRecord(installed, request.manifest.id);
    } catch (error) {
      await this.rollbackInstall(request.manifest.id);
      throw error;
    }
    const ref = this.refFromManifest(manifest);
    const installedAt = normalizedDate(this.clock.now());
    let installation: TrustedAdapterInstallationRecord;
    try {
      this.assertNotTombstoned(ref.adapterId);
      const result = await this.persistInstallation(ref, provider?.id, installedAt);
      installation = result.installation;
    } catch (error) {
      await this.rollbackInstall(manifest.id);
      throw error;
    }
    await this.flushOutbox();
    return this.toDto(manifest, installation);
  }

  /** Binds an already installed revision to a custom-js Provider. */
  public async bind(input: TrustedAdapterBindRequest): Promise<TrustedAdapterManagementDto>;
  public async bind(providerId: string, ref: CustomAdapterRef): Promise<TrustedAdapterManagementDto>;
  public async bind(
    inputOrProviderId: TrustedAdapterBindRequest | string,
    positionalRef?: CustomAdapterRef,
  ): Promise<TrustedAdapterManagementDto> {
    this.assertAdmin();
    const input = typeof inputOrProviderId === 'string'
      ? { providerId: inputOrProviderId, ref: positionalRef }
      : inputOrProviderId;
    if (!isRecord(input) || !ownKeysAreAllowed(input, BIND_KEYS) || typeof input.providerId !== 'string') {
      throw new TrustedAdapterServiceError('invalid_request');
    }
    const ref = parseTrustedRef(input.ref);
    return this.withAdapterLock(ref.adapterId, async () => {
      const provider = this.requireCustomJavaScriptProvider(input.providerId);
      this.assertNotTombstoned(ref.adapterId);
      const installed = await this.loadInstalled(ref.adapterId);
      const manifest = this.manifestFromRecord(installed);
      if (!sameRef(this.refFromManifest(manifest), ref)) {
        throw new TrustedAdapterServiceError('manifest_mismatch');
      }
      this.assertNotTombstoned(ref.adapterId);
      const now = normalizedDate(this.clock.now());
      const result = await this.persistInstallation(ref, provider.id, now);
      await this.flushOutbox();
      return this.toDto(manifest, result.installation);
    });
  }

  /**
   * Reads one provider binding. An omitted ref means the provider's current
   * revision; an explicit ref is always looked up exactly and never falls back
   * to current.
   */
  public async getBinding(providerId: string, ref?: CustomAdapterRef): Promise<TrustedAdapterBindingDto | null> {
    this.assertAdmin();
    this.requireCustomJavaScriptProvider(providerId);
    const requestedRef = ref === undefined ? undefined : parseTrustedRef(ref);
    const initial = requestedRef === undefined
      ? this.readCurrentBindingDefinition(providerId)
      : this.readBindingDefinition(providerId, requestedRef);
    if (initial === null) return null;
    return this.withAdapterLock(initial.ref.adapterId, async () => {
      const definition = requestedRef === undefined
        ? this.readCurrentBindingDefinition(providerId)
        : this.readBindingDefinition(providerId, requestedRef);
      if (definition === null) return null;
      const result = await this.readBinding(providerId, definition);
      if (result.events.length > 0) await this.flushOutbox();
      return result.dto;
    });
  }

  /** Returns current, or the latest disabled binding when current was disabled. */
  public async getCurrentOrDisabledBinding(providerId: string): Promise<TrustedAdapterBindingDto | null> {
    this.assertAdmin();
    this.requireCustomJavaScriptProvider(providerId);
    const initial = this.readCurrentOrDisabledBindingDefinition(providerId);
    if (initial === null) return null;
    return this.withAdapterLock(initial.ref.adapterId, async () => {
      const definition = this.readCurrentOrDisabledBindingDefinition(providerId);
      if (definition === null) return null;
      const result = await this.readBinding(providerId, definition);
      if (result.events.length > 0) await this.flushOutbox();
      return result.dto;
    });
  }

  /** Returns all current and historical trusted revisions bound to a Provider. */
  public async listBindings(providerId: string): Promise<readonly TrustedAdapterBindingDto[]> {
    this.assertAdmin();
    this.requireCustomJavaScriptProvider(providerId);
    let definitions: readonly ProviderAdapterDefinitionRecord[];
    try {
      definitions = this.adapterDefinitions.list(providerId);
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
    const output: TrustedAdapterBindingDto[] = [];
    let reconciled = false;
    for (const definition of definitions) {
      this.assertTrustedBindingDefinition(providerId, definition);
      const result = await this.readBinding(providerId, definition);
      if (result.events.length > 0) reconciled = true;
      output.push(result.dto);
    }
    if (reconciled) await this.flushOutbox();
    return output;
  }

  /** Disables one exact binding, or the current binding when ref is omitted. */
  public async disableBinding(providerId: string, ref?: CustomAdapterRef): Promise<TrustedAdapterBindingDto | null> {
    this.assertAdmin();
    this.requireCustomJavaScriptProvider(providerId);
    const requestedRef = ref === undefined ? undefined : parseTrustedRef(ref);
    const initial = requestedRef === undefined
      ? this.readCurrentBindingDefinition(providerId)
      : this.readBindingDefinition(providerId, requestedRef);
    if (initial === null) return null;
    return this.withAdapterLock(initial.ref.adapterId, async () => {
      const definition = requestedRef === undefined
        ? this.readCurrentBindingDefinition(providerId)
        : this.readBindingDefinition(providerId, requestedRef);
      if (definition === null) return null;
      const loaded = await this.readBinding(providerId, definition);
      let disabled: ProviderAdapterDefinitionRecord | null;
      try {
        disabled = this.adapterDefinitions.disable(providerId, definition.ref);
      } catch (error) {
        throw this.mapDefinitionError(error);
      }
      if (disabled === null) {
        if (loaded.events.length > 0) await this.flushOutbox();
        return null;
      }
      this.assertTrustedBindingDefinition(providerId, disabled);
      await this.flushOutbox();
      return this.bindingDto(disabled, loaded.manifest, loaded.installation);
    });
  }

  /** Removes one exact binding without removing the global installation. */
  public async deleteBinding(providerId: string, ref?: CustomAdapterRef): Promise<boolean> {
    this.assertAdmin();
    this.requireCustomJavaScriptProvider(providerId);
    const requestedRef = ref === undefined ? undefined : parseTrustedRef(ref);
    const initial = requestedRef === undefined
      ? this.readCurrentBindingDefinition(providerId)
      : this.readBindingDefinition(providerId, requestedRef);
    if (initial === null) return false;
    return this.withAdapterLock(initial.ref.adapterId, async () => {
      const definition = requestedRef === undefined
        ? this.readCurrentBindingDefinition(providerId)
        : this.readBindingDefinition(providerId, requestedRef);
      if (definition === null) return false;
      const loaded = await this.readBinding(providerId, definition);
      let removed: boolean;
      try {
        removed = this.adapterDefinitions.delete(providerId, definition.ref);
      } catch (error) {
        throw this.mapDefinitionError(error);
      }
      if (removed || loaded.events.length > 0) await this.flushOutbox();
      return removed;
    });
  }

  /** Alias used by callers that call provider-scoped deletion an unbind. */
  public async unbind(providerId: string, ref?: CustomAdapterRef): Promise<boolean> {
    this.assertAdmin();
    return this.deleteBinding(providerId, ref);
  }

  public async list(): Promise<readonly TrustedAdapterManagementDto[]> {
    this.assertAdmin();
    let records: readonly AdapterRecord[];
    try {
      records = await this.store.list();
    } catch (error) {
      throw this.mapStoreError(error);
    }
    const seen = new Set<string>();
    const output: TrustedAdapterManagementDto[] = [];
    let reconciled = false;
    for (const record of records) {
      const manifest = this.manifestFromRecord(record);
      if (seen.has(manifest.id)) throw new TrustedAdapterServiceError('store_failure');
      seen.add(manifest.id);
      if (this.readTombstone(manifest.id) !== null) continue;
      const ref = this.refFromManifest(manifest);
      const installation = await this.ensureInstallation(ref);
      if (installation.events.length > 0) reconciled = true;
      output.push(this.toDto(manifest, installation.installation));
    }
    if (reconciled) await this.flushOutbox();
    return output.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  public async get(id: string): Promise<TrustedAdapterManagementDto | null> {
    this.assertAdmin();
    const adapterId = parseAdapterId(id);
    if (this.readTombstone(adapterId) !== null) return null;
    let record: AdapterRecord | null;
    try {
      record = await this.store.get(adapterId);
    } catch (error) {
      if (isMissingStoreError(error)) return null;
      throw this.mapStoreError(error);
    }
    if (record === null) return null;
    const manifest = this.manifestFromRecord(record, adapterId);
    const ref = this.refFromManifest(manifest);
    const installation = await this.ensureInstallation(ref);
    if (installation.events.length > 0) await this.flushOutbox();
    return this.toDto(manifest, installation.installation);
  }

  /** Removes an adapter only after every persisted reference has been checked. */
  public async remove(id: string): Promise<void> {
    this.assertAdmin();
    const adapterId = parseAdapterId(id);
    return this.withAdapterLock(adapterId, () => this.removePrepared(adapterId));
  }

  private async removePrepared(adapterId: string): Promise<void> {
    const existingTombstone = this.readTombstone(adapterId);
    if (existingTombstone !== null) {
      try {
        await this.store.remove(adapterId);
      } catch (error) {
        if (!isMissingStoreError(error)) throw this.mapStoreError(error);
      }
      await this.flushOutbox();
      return;
    }
    this.assertNoReferences(adapterId);
    let record: AdapterRecord | null;
    try {
      record = await this.store.get(adapterId);
    } catch (error) {
      if (isMissingStoreError(error)) throw new TrustedAdapterServiceError('not_found');
      throw this.mapStoreError(error);
    }
    if (record === null) throw new TrustedAdapterServiceError('not_found');
    const manifest = this.manifestFromRecord(record, adapterId);
    this.assertNoReferences(adapterId);
    const ref = this.refFromManifest(manifest);
    this.createTombstone(ref, normalizedDate(this.clock.now()));
    try {
      await this.store.remove(adapterId);
    } catch (error) {
      if (!isMissingStoreError(error)) throw this.mapStoreError(error);
    }
    await this.flushOutbox();
  }

  /** Lifecycle close is intentionally independent of administrator authorization. */
  public async close(): Promise<void> {
    if (this.store.close !== undefined) await this.store.close();
  }

  private assertAdmin(): void {
    if (!this.adminEnabled) throw new TrustedAdapterServiceError('administrator_required');
  }

  private async withAdapterLock<T>(adapterId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.adapterLocks.get(adapterId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.adapterLocks.set(adapterId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.adapterLocks.get(adapterId) === current) this.adapterLocks.delete(adapterId);
    }
  }

  private readCurrentBindingDefinition(providerId: string): ProviderAdapterDefinitionRecord | null {
    let definition: ProviderAdapterDefinitionRecord | null;
    try {
      definition = this.adapterDefinitions.getCurrent(providerId);
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
    if (definition === null) return null;
    this.assertTrustedBindingDefinition(providerId, definition);
    return definition;
  }

  private readCurrentOrDisabledBindingDefinition(providerId: string): ProviderAdapterDefinitionRecord | null {
    let definition: ProviderAdapterDefinitionRecord | null;
    try {
      definition = this.adapterDefinitions.getCurrentOrLatestDisabled(providerId);
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
    if (definition === null) return null;
    this.assertTrustedBindingDefinition(providerId, definition);
    return definition;
  }

  private readBindingDefinition(
    providerId: string,
    ref: TrustedAdapterRef,
  ): ProviderAdapterDefinitionRecord | null {
    if (this.readTombstone(ref.adapterId) !== null) {
      throw new TrustedAdapterServiceError('not_found');
    }
    let definition: ProviderAdapterDefinitionRecord | null;
    try {
      definition = this.adapterDefinitions.getByRef(providerId, ref);
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
    if (definition === null) return null;
    this.assertTrustedBindingDefinition(providerId, definition);
    if (!sameRef(definition.ref, ref)) {
      throw new TrustedAdapterServiceError('definition_failure');
    }
    return definition;
  }

  private assertTrustedBindingDefinition(
    providerId: string,
    definition: ProviderAdapterDefinitionRecord,
  ): void {
    if (definition.providerId !== providerId) {
      throw new TrustedAdapterServiceError('definition_failure');
    }
    if (definition.ref.kind !== TRUSTED_JAVASCRIPT_KIND) {
      throw new TrustedAdapterServiceError('provider_type_mismatch');
    }
    if (definition.definition !== null) {
      throw new TrustedAdapterServiceError('definition_failure');
    }
  }

  /**
   * Resolve the filesystem manifest using the complete immutable ref before
   * exposing a binding. Missing/tombstoned rows and digest/version drift are
   * intentionally surfaced as stable service errors.
   */
  private async readBinding(
    providerId: string,
    definition: ProviderAdapterDefinitionRecord,
  ): Promise<BindingReadResult> {
    this.assertTrustedBindingDefinition(providerId, definition);
    const ref = parseTrustedRef(definition.ref);
    if (this.readTombstone(ref.adapterId) !== null) {
      throw new TrustedAdapterServiceError('not_found');
    }
    const installed = await this.loadInstalled(ref.adapterId);
    const manifest = this.manifestFromRecord(installed, ref.adapterId);
    if (!sameRef(this.refFromManifest(manifest), ref)) {
      throw new TrustedAdapterServiceError('manifest_mismatch');
    }
    const installation = await this.ensureInstallation(ref);
    if (
      installation.installation.adapterId !== ref.adapterId ||
      installation.installation.version !== ref.version ||
      installation.installation.digest !== ref.digest
    ) {
      throw new TrustedAdapterServiceError('manifest_mismatch');
    }
    return {
      dto: this.bindingDto(definition, manifest, installation.installation),
      manifest,
      installation: installation.installation,
      events: installation.events,
    };
  }

  private readTombstone(adapterId: string): TrustedAdapterTombstoneRecord | null {
    try {
      if (this.adapterDefinitions.getTombstone !== undefined) {
        return this.adapterDefinitions.getTombstone(adapterId);
      }
      if (this.adapterDefinitions.isTombstoned !== undefined) {
        return this.adapterDefinitions.isTombstoned(adapterId) ? {
          adapterId,
          version: 'unknown',
          digest: '0'.repeat(64),
          removedAt: new Date(0),
        } : null;
      }
      return null;
    } catch {
      throw new TrustedAdapterServiceError('adapter_references_unavailable');
    }
  }

  private assertNotTombstoned(adapterId: string): void {
    if (this.readTombstone(adapterId) !== null) {
      throw new TrustedAdapterServiceError('adapter_id_immutable');
    }
  }

  private createTombstone(ref: TrustedAdapterRef, removedAt: Date): TrustedAdapterTombstoneRecord {
    if (this.adapterDefinitions.tombstone === undefined) {
      throw new TrustedAdapterServiceError('adapter_references_unavailable');
    }
    try {
      return this.adapterDefinitions.tombstone(ref, removedAt);
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
  }

  private async flushOutbox(): Promise<void> {
    try {
      await this.outbox.flush();
    } catch {
      throw new TrustedAdapterServiceError('outbox_failure');
    }
  }

  private async persistInstallation(
    ref: TrustedAdapterRef,
    providerId: string | undefined,
    now: Date,
  ): Promise<TrustedAdapterInstallResult> {
    const install = this.adapterDefinitions.installTrustedAdapter;
    if (install === undefined) {
      throw new TrustedAdapterServiceError('definition_failure');
    }
    try {
      return await install.call(this.adapterDefinitions, {
        ref,
        ...(providerId === undefined ? {} : { providerId }),
        now,
      });
    } catch (error) {
      throw this.mapDefinitionError(error);
    }
  }

  /**
   * Reconciles a pre-existing filesystem adapter exactly once. The repository
   * transaction is idempotent, so a restart cannot refresh timestamps or emit
   * duplicate lifecycle events after the installation row exists.
   */
  private async ensureInstallation(ref: TrustedAdapterRef): Promise<TrustedAdapterInstallResult> {
    this.assertNotTombstoned(ref.adapterId);
    return this.persistInstallation(ref, undefined, normalizedDate(this.clock.now()));
  }

  private preflightInstallRequest(input: TrustedAdapterInstallRequest): {
    readonly manifest: AdapterManifest;
    readonly source: Uint8Array;
    readonly providerId?: string;
  } {
    if (!isRecord(input) || !ownKeysAreAllowed(input, INSTALL_KEYS)) {
      throw new TrustedAdapterServiceError('invalid_request');
    }
    const manifestBytes = boundedByteLength(input.manifest);
    if (manifestBytes !== undefined && manifestBytes > MAX_MANIFEST_BYTES) {
      throw new TrustedAdapterServiceError('manifest_too_large');
    }
    let manifest: AdapterManifest;
    try {
      manifest = parseAdapterManifest(input.manifest);
    } catch (error) {
      if (error instanceof AdapterManifestError) throw new TrustedAdapterServiceError('invalid_manifest');
      throw new TrustedAdapterServiceError('invalid_manifest');
    }
    if (input.providerId !== undefined && typeof input.providerId !== 'string') {
      throw new TrustedAdapterServiceError('invalid_request');
    }
    if (typeof input.source !== 'string' && !(input.source instanceof Uint8Array)) {
      throw new TrustedAdapterServiceError('invalid_source');
    }
    const sourceLength = typeof input.source === 'string'
      ? Buffer.byteLength(input.source, 'utf8')
      : input.source.byteLength;
    if (sourceLength > MAX_ADAPTER_SOURCE_BYTES) {
      throw new TrustedAdapterServiceError('source_too_large');
    }
    const source = sourceBytes(input.source);
    if (digestAdapterSource(source) !== manifest.sha256) {
      throw new TrustedAdapterServiceError('digest_mismatch');
    }
    try {
      const sourceText = validateAdapterSource(source);
      validateAdapterExports(sourceText, manifest);
    } catch (error) {
      if (error instanceof AdapterSourcePolicyError) throw new TrustedAdapterServiceError('invalid_source');
      throw new TrustedAdapterServiceError('invalid_source');
    }
    return {
      manifest,
      source,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    };
  }

  private async installInStore(request: {
    readonly manifest: AdapterManifest;
    readonly source: Uint8Array;
    readonly providerId?: string;
  }): Promise<AdapterRecord> {
    try {
      return await this.store.install({ manifest: request.manifest, source: request.source });
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  private async loadInstalled(adapterId: string): Promise<AdapterRecord> {
    let record: AdapterRecord | null;
    try {
      record = await this.store.get(adapterId);
    } catch (error) {
      if (isMissingStoreError(error)) throw new TrustedAdapterServiceError('not_found');
      throw this.mapStoreError(error);
    }
    if (record === null) throw new TrustedAdapterServiceError('not_found');
    return record;
  }

  private async assertStoreIdAvailable(ref: TrustedAdapterRef): Promise<void> {
    let record: AdapterRecord | null;
    try {
      record = await this.store.get(ref.adapterId);
    } catch (error) {
      if (isMissingStoreError(error)) return;
      throw this.mapStoreError(error);
    }
    if (record === null) return;
    const manifest = this.manifestFromRecord(record, ref.adapterId);
    if (sameRef(this.refFromManifest(manifest), ref)) {
      throw new TrustedAdapterServiceError('already_exists');
    }
    throw new TrustedAdapterServiceError('adapter_id_immutable');
  }

  private manifestFromRecord(record: AdapterRecord, expectedId?: string): AdapterManifest {
    let manifest: AdapterManifest;
    try {
      manifest = parseAdapterManifest(record.manifest);
    } catch {
      throw new TrustedAdapterServiceError('store_failure');
    }
    if (expectedId !== undefined && manifest.id !== expectedId) {
      throw new TrustedAdapterServiceError('store_failure');
    }
    return manifest;
  }

  private refFromManifest(manifest: AdapterManifest): TrustedAdapterRef {
    return {
      kind: TRUSTED_JAVASCRIPT_KIND,
      adapterId: manifest.id,
      version: manifest.version,
      digest: manifest.sha256,
    };
  }

  private requireCustomJavaScriptProvider(providerId: string): ProviderStorageRecord {
    // eslint-disable-next-line no-control-regex
    if (providerId.length === 0 || providerId.length > 255 || /[\u0000-\u001f\u007f]/u.test(providerId)) {
      throw new TrustedAdapterServiceError('invalid_request');
    }
    const provider = this.providers.get(providerId);
    if (provider === null) throw new TrustedAdapterServiceError('provider_not_found');
    if (provider.type !== CUSTOM_JAVASCRIPT_PROVIDER_TYPE) {
      throw new TrustedAdapterServiceError('provider_type_mismatch');
    }
    return provider;
  }

  private assertAdapterIdAvailable(
    adapterId: string,
    providerId?: string,
    allowedRef?: CustomAdapterRef,
  ): void {
    const definitions = this.readDefinitionsByAdapterId(adapterId);
    if (definitions.some((definition) => allowedRef === undefined || !sameRef(definition.ref, allowedRef))) {
      if (providerId !== undefined) {
        const current = this.adapterDefinitions.getCurrent(providerId);
        if (current !== null && current.ref.adapterId === adapterId && allowedRef !== undefined && sameRef(current.ref, allowedRef)) {
          // Rebinding the same immutable revision is idempotent.
          return;
        }
      }
      throw new TrustedAdapterServiceError('adapter_id_immutable');
    }
    const hasSameReference = allowedRef !== undefined && definitions.some((definition) => sameRef(definition.ref, allowedRef));
    const hasRetained = (() => {
      try {
        return this.jobs.hasRetainedAdapterId(adapterId);
      } catch {
        throw new TrustedAdapterServiceError('adapter_references_unavailable');
      }
    })();
    if (!hasSameReference && hasRetained) {
      throw new TrustedAdapterServiceError('adapter_id_immutable');
    }
  }

  private readDefinitionsByAdapterId(adapterId: string): readonly ProviderAdapterDefinitionRecord[] {
    try {
      return this.adapterDefinitions.listByAdapterId(adapterId);
    } catch {
      throw new TrustedAdapterServiceError('definition_failure');
    }
  }

  private assertNoReferences(adapterId: string): void {
    const definitions = this.readDefinitionsByAdapterId(adapterId);
    const hasRetained = (() => {
      try {
        return this.jobs.hasRetainedAdapterId(adapterId);
      } catch {
        throw new TrustedAdapterServiceError('adapter_references_unavailable');
      }
    })();
    if (definitions.length > 0 || hasRetained) {
      for (const definition of definitions) {
        const provider = this.providers.get(definition.providerId);
        if (provider === null || provider.type !== CUSTOM_JAVASCRIPT_PROVIDER_TYPE) {
          throw new TrustedAdapterServiceError('adapter_references_in_use');
        }
      }
      throw new TrustedAdapterServiceError('adapter_references_in_use');
    }
  }

  private toDto(
    manifest: AdapterManifest,
    installation: TrustedAdapterInstallationRecord,
  ): TrustedAdapterManagementDto {
    const ref = this.refFromManifest(manifest);
    return {
      manifest,
      ref,
      createdAt: new Date(installation.createdAt.getTime()),
      updatedAt: new Date(installation.updatedAt.getTime()),
    };
  }

  private bindingDto(
    definition: ProviderAdapterDefinitionRecord,
    manifest: AdapterManifest,
    installation: TrustedAdapterInstallationRecord,
  ): TrustedAdapterBindingDto {
    this.assertTrustedBindingDefinition(definition.providerId, definition);
    const ref = this.refFromManifest(manifest);
    if (!sameRef(definition.ref, ref)) {
      throw new TrustedAdapterServiceError('manifest_mismatch');
    }
    return {
      providerId: definition.providerId,
      ref: { ...definition.ref } as TrustedAdapterRef,
      definition: null,
      isCurrent: definition.isCurrent,
      disabled: definition.disabled,
      createdAt: new Date(definition.createdAt.getTime()),
      updatedAt: new Date(definition.updatedAt.getTime()),
      manifest: cloneJsonValue(manifest) as AdapterManifest,
      installation: {
        createdAt: new Date(installation.createdAt.getTime()),
        updatedAt: new Date(installation.updatedAt.getTime()),
      },
    };
  }

  private async rollbackInstall(adapterId: string): Promise<void> {
    try {
      await this.store.remove(adapterId);
    } catch {
      throw new TrustedAdapterServiceError('rollback_failed');
    }
  }

  private mapStoreError(error: unknown): TrustedAdapterServiceError {
    if (error instanceof TrustedAdapterServiceError) return error;
    if (error instanceof AdapterAuthorizationError) return new TrustedAdapterServiceError('administrator_required');
    if (error instanceof AdapterAlreadyInstalledError) return new TrustedAdapterServiceError('already_exists');
    if (error instanceof AdapterManifestError) return new TrustedAdapterServiceError('invalid_manifest');
    if (error instanceof AdapterSourcePolicyError) return new TrustedAdapterServiceError('invalid_source');
    if (error instanceof AdapterStoreError) return new TrustedAdapterServiceError('store_failure');
    return new TrustedAdapterServiceError('store_failure');
  }

  private mapDefinitionError(error: unknown): TrustedAdapterServiceError {
    if (error instanceof TrustedAdapterServiceError) return error;
    if (error instanceof ProviderAdapterDefinitionError) {
      switch (error.code) {
        case 'provider_not_found':
          return new TrustedAdapterServiceError('provider_not_found');
        case 'already_exists':
          return new TrustedAdapterServiceError('already_exists');
        case 'disabled_revision':
          return new TrustedAdapterServiceError('disabled_revision');
        case 'invalid_reference':
          return new TrustedAdapterServiceError('provider_type_mismatch');
        case 'referenced_jobs':
        case 'referenced_definitions':
          return new TrustedAdapterServiceError('adapter_references_in_use');
        case 'tombstoned':
          return new TrustedAdapterServiceError('adapter_id_immutable');
        default:
          return new TrustedAdapterServiceError('definition_failure');
      }
    }
    return new TrustedAdapterServiceError('definition_failure');
  }
}

export { TrustedAdapterService as TrustedJavaScriptAdapterService };
export { TrustedAdapterService as TrustedJavaScriptManagementService };
export { TrustedAdapterService as JavaScriptAdapterService };
