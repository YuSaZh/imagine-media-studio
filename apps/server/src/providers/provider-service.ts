import { randomUUID } from 'node:crypto';

import {
  ModelCapabilitiesSchema,
  ProviderBaseUrlSchema,
  ProviderDtoSchema,
  ProviderTypeSchema,
  SafeConfigSchema,
  resolveModelProfile,
  NativeProviderProfileSchema,
  providerFamily,
  type CustomAdapterRef,
  type JsonObject,
  type ModelCapabilities,
  type ProviderDto,
} from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderModel,
} from '@imagine/provider-contract';

import {
  type ManualModelInput,
  type ManualModelUpdate,
  type ModelPageRequest,
  type ModelRecord,
  ModelRepositoryError,
  type ModelRepository,
} from '../database/models.js';
import type { CursorPage } from '../database/pagination.js';
import type { ProviderRegistration } from '../jobs/ports.js';
import {
  type ProviderPageRequest,
  type ProviderRepository,
  type ProviderStorageRecord,
} from '../database/providers.js';
import type { SecretVault } from '../security/secret-vault.js';
import { MOCK_PROVIDER_ID } from './provider-registry.js';
import type { ProviderRegistry } from './provider-registry.js';

export interface CreateProviderServiceInput {
  readonly name: string;
  readonly type: string;
  readonly baseUrl?: string | null;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly config?: JsonObject;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
}

export interface UpdateProviderServiceInput {
  readonly name?: string;
  readonly type?: string;
  readonly baseUrl?: string | null;
  readonly apiKey?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly config?: JsonObject;
  readonly enabled?: boolean;
  readonly isDefault?: boolean;
}

export interface ProviderConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly message: string;
}

export interface ProviderServiceClock {
  now(): number;
}

export class ManualModelServiceError extends Error {
  public override readonly name = 'ManualModelServiceError';

  public constructor(
    public readonly code:
      | 'model_not_found'
      | 'model_not_manual'
      | 'provider_not_found'
      | 'invalid_model',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ModelCatalogServiceError extends Error {
  public override readonly name = 'ModelCatalogServiceError';

  public constructor(
    public readonly code: 'model_catalog_unavailable' | 'model_capabilities_invalid',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

class InvalidProviderCapabilitiesError extends Error {
  public override readonly name = 'InvalidProviderCapabilitiesError';
}

const systemClock: ProviderServiceClock = { now: () => Date.now() };

const CUSTOM_HTTP_PROVIDER_TYPE = 'custom-http-v1' as const;
const CUSTOM_JS_PROVIDER_TYPE = 'custom-js-v1' as const;
const MAX_CAPABILITY_MODELS = 200;
const MAX_CAPABILITY_ARRAY_ITEMS = 128;
const MAX_CAPABILITY_KEYS = 512;
const MAX_CAPABILITY_NODES = 10_000;
const MAX_CAPABILITY_DEPTH = 12;
const MAX_CAPABILITY_STRING_LENGTH = 4_096;
const MAX_CAPABILITY_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITY_OPERATIONS = 16;
const CAPABILITY_KEYS = new Set(['providerType', 'models']);
const MODEL_KEYS = new Set(['id', 'displayName', 'capabilities']);
const FORBIDDEN_CAPABILITY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type ProviderCatalogSource = 'mock' | 'profile' | 'provider';

export interface ProviderCatalogStatus {
  readonly providerId: string;
  readonly source: ProviderCatalogSource;
  /** True when a live custom catalog failed and the static profile was used. */
  readonly stale: boolean;
  readonly adapterRef: CustomAdapterRef | null;
}

interface CatalogCacheEntry {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
}

interface CustomAdapterInternals {
  readonly spec?: {
    readonly catalog?: unknown;
  };
}

function hasCustomAdapterInternals(
  adapter: ProviderAdapter,
): adapter is ProviderAdapter & CustomAdapterInternals {
  return typeof adapter === 'object' && adapter !== null && 'spec' in adapter;
}

function parseProviderBaseUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return ProviderBaseUrlSchema.parse(value);
}

function toProviderDto(record: ProviderStorageRecord): ProviderDto {
  return ProviderDtoSchema.parse({
    id: record.id,
    name: record.name,
    type: record.type,
    baseUrl: record.baseUrl,
    config: record.config,
    enabled: record.enabled,
    isDefault: record.isDefault,
    hasApiKey: record.apiKeyCiphertext !== null,
    hasCustomHeaders: record.headersCiphertext !== null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

interface LiveCatalogProviderAdapter extends ProviderAdapter {
  getLiveCapabilities(context: ProviderContext): Promise<ProviderCapabilities>;
}

function hasLiveCapabilities(adapter: ProviderAdapter): adapter is LiveCatalogProviderAdapter {
  const candidate: unknown = adapter;
  return typeof candidate === 'object' && candidate !== null &&
    'getLiveCapabilities' in candidate &&
    typeof candidate.getLiveCapabilities === 'function';
}

function catalogSource(providerType: string, live: boolean): ProviderCatalogSource {
  if (providerType === 'mock') return 'mock';
  return live ? 'provider' : 'profile';
}

function customKindForProviderType(providerType: string): CustomAdapterRef['kind'] | null {
  if (providerType === CUSTOM_HTTP_PROVIDER_TYPE) return 'declarative-http';
  if (providerType === CUSTOM_JS_PROVIDER_TYPE) return 'trusted-javascript';
  return null;
}

function adapterRefKey(ref: CustomAdapterRef | null | undefined): string {
  if (ref === null || ref === undefined) return 'builtin';
  return [ref.kind, ref.adapterId, ref.version, ref.digest].join('\u0000');
}

function copyAdapterRef(ref: CustomAdapterRef | null | undefined): CustomAdapterRef | null {
  return ref === null || ref === undefined ? null : { ...ref };
}

function isCustomHttpCatalogConfigured(adapter: ProviderAdapter): boolean {
  if (adapter.type !== CUSTOM_HTTP_PROVIDER_TYPE) return false;
  // DeclarativeHttpAdapter keeps the immutable parsed spec private. This
  // narrow read is intentionally fail-closed for test doubles and future
  // adapters that do not expose the endpoint metadata.
  return hasCustomAdapterInternals(adapter) &&
    adapter.spec !== undefined &&
    adapter.spec.catalog !== undefined;
}

function assertBoundedCapabilityValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > MAX_CAPABILITY_DEPTH) throw new Error('Provider capabilities are too deeply nested.');
  state.nodes += 1;
  if (state.nodes > MAX_CAPABILITY_NODES) throw new Error('Provider capabilities contain too much data.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Provider capabilities contain a non-finite number.');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_CAPABILITY_STRING_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
      throw new Error('Provider capabilities contain an invalid string.');
    }
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error('Provider capabilities are not bounded JSON.');
  }
  if (value instanceof Uint8Array || value instanceof Date) {
    throw new Error('Provider capabilities contain a non-JSON value.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error('Provider capabilities must contain plain objects.');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_CAPABILITY_ARRAY_ITEMS) throw new Error('Provider capability arrays are too large.');
    for (const child of value) assertBoundedCapabilityValue(child, state, depth + 1, seen);
  } else {
    const entries = Object.entries(value);
    if (entries.length > MAX_CAPABILITY_KEYS) throw new Error('Provider capability objects are too large.');
    for (const [key, child] of entries) {
      if (
        key.length > 255 ||
        CONTROL_CHARACTER_PATTERN.test(key) ||
        FORBIDDEN_CAPABILITY_KEYS.has(key)
      ) {
        throw new Error('Provider capability keys are invalid.');
      }
      assertBoundedCapabilityValue(child, state, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function freezeCapabilityValue<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) freezeCapabilityValue(child, seen);
  } else {
    for (const child of Object.values(value)) freezeCapabilityValue(child, seen);
  }
  Object.freeze(value);
  return value;
}

/** Convert schema-owned capabilities into the repository's JSON-record contract. */
function toJsonCapabilitiesRecord(
  value: ProviderModel['capabilities'],
): Readonly<Record<string, unknown>> {
  const parsed = ModelCapabilitiesSchema.safeParse(value);
  if (!parsed.success || parsed.data.operations.length > MAX_CAPABILITY_OPERATIONS) {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      'Custom Provider model capabilities could not be synchronized.',
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed.data);
  } catch {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      'Custom Provider model capabilities could not be synchronized.',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPABILITY_BYTES) {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      'Custom Provider model capabilities could not be synchronized.',
    );
  }
  const cloned: unknown = JSON.parse(serialized);
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      'Custom Provider model capabilities could not be synchronized.',
    );
  }
  try {
    assertBoundedCapabilityValue(cloned, { nodes: 0 });
  } catch {
    throw new ModelRepositoryError(
      'invalid_capabilities',
      'Custom Provider model capabilities could not be synchronized.',
    );
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const [key, child] of Object.entries(cloned)) record[key] = child;
  return freezeCapabilityValue(record);
}

function toProviderModelCapabilities(value: ModelCapabilities): ProviderModel['capabilities'] {
  const inputImageConstraints = value.inputImageConstraints;
  return {
    ...(value.profile === undefined ? {} : { profile: value.profile }),
    ...(value.parameters === undefined ? {} : { parameters: value.parameters }),
    operations: value.operations,
    ...(value.aspectRatios === undefined ? {} : { aspectRatios: value.aspectRatios }),
    ...(value.resolutions === undefined ? {} : { resolutions: value.resolutions }),
    ...(value.durations === undefined ? {} : { durations: value.durations }),
    ...(value.maxReferenceImages === undefined ? {} : { maxReferenceImages: value.maxReferenceImages }),
    ...(inputImageConstraints === undefined
      ? {}
      : {
          inputImageConstraints: {
            ...(inputImageConstraints.mimeTypes === undefined ? {} : { mimeTypes: inputImageConstraints.mimeTypes }),
            ...(inputImageConstraints.maxBytes === undefined ? {} : { maxBytes: inputImageConstraints.maxBytes }),
            ...(inputImageConstraints.maxPixels === undefined ? {} : { maxPixels: inputImageConstraints.maxPixels }),
            ...(inputImageConstraints.maxWidth === undefined ? {} : { maxWidth: inputImageConstraints.maxWidth }),
            ...(inputImageConstraints.maxHeight === undefined ? {} : { maxHeight: inputImageConstraints.maxHeight }),
          },
        }),
    ...(value.supportsMask === undefined ? {} : { supportsMask: value.supportsMask }),
    ...(value.supportsNegativePrompt === undefined ? {} : { supportsNegativePrompt: value.supportsNegativePrompt }),
    ...(value.supportsSeed === undefined ? {} : { supportsSeed: value.supportsSeed }),
    ...(value.supportsAudio === undefined ? {} : { supportsAudio: value.supportsAudio }),
    ...(value.supportsProgress === undefined ? {} : { supportsProgress: value.supportsProgress }),
    ...(value.supportsCancel === undefined ? {} : { supportsCancel: value.supportsCancel }),
    ...(value.supportsBatchCount === undefined ? {} : { supportsBatchCount: value.supportsBatchCount }),
    ...(value.maxBatchCount === undefined ? {} : { maxBatchCount: value.maxBatchCount }),
    ...(value.customFields === undefined ? {} : { customFields: value.customFields }),
  };
}

export class ProviderService {
  private readonly staticCapabilityCache = new Map<string, CatalogCacheEntry>();
  private readonly activeStaticCacheKeyByProvider = new Map<string, string>();
  private readonly providerTypeByAdapter = new Map<string, string>();
  private readonly catalogStatuses = new Map<string, ProviderCatalogStatus>();

  public constructor(
    private readonly providers: ProviderRepository,
    private readonly models: ModelRepository,
    private readonly vault: SecretVault,
    private readonly registry: ProviderRegistry,
    private readonly clock: ProviderServiceClock = systemClock,
  ) {}

  public get(id: string): ProviderDto | null {
    const provider = this.providers.get(id);
    return provider ? toProviderDto(provider) : null;
  }

  public page(request: ProviderPageRequest = {}): CursorPage<ProviderDto> {
    const page = this.providers.page(request);
    return { items: page.items.map(toProviderDto), nextCursor: page.nextCursor };
  }

  public create(input: CreateProviderServiceInput): ProviderDto {
    return this.createWithId(randomUUID(), input);
  }

  public update(id: string, input: UpdateProviderServiceInput): ProviderDto | null {
    const type = input.type === undefined ? undefined : ProviderTypeSchema.parse(input.type);
    const baseUrl = !('baseUrl' in input) ? undefined : parseProviderBaseUrl(input.baseUrl);
    const config = input.config === undefined ? undefined : SafeConfigSchema.parse(input.config);
    const existing = this.providers.get(id);
    const legacy = NativeProviderProfileSchema.safeParse(existing?.type);
    if (type && legacy.success && providerFamily(legacy.data) === type) this.models.preserveLegacyProtocol(id, legacy.data);
    const updated = this.providers.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(type === undefined ? {} : { type }),
      ...(!('baseUrl' in input) ? {} : { baseUrl: baseUrl ?? null }),
      ...(!('apiKey' in input)
        ? {}
        : {
            apiKeyCiphertext:
              input.apiKey === null ? null : this.vault.encryptString(id, 'apiKey', input.apiKey),
          }),
      ...(!('headers' in input)
        ? {}
        : {
            headersCiphertext:
              input.headers === null || Object.keys(input.headers).length === 0
                ? null
                : this.vault.encryptJson(id, 'headers', input.headers),
          }),
      ...(config === undefined ? {} : { config }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    });
    if (updated !== null) this.invalidateProviderState(id);
    return updated ? toProviderDto(updated) : null;
  }

  public setDefault(id: string): ProviderDto | null {
    const provider = this.providers.setDefault(id);
    if (provider !== null) this.invalidateProviderState(id);
    return provider ? toProviderDto(provider) : null;
  }

  public delete(id: string): boolean {
    const deleted = this.providers.delete(id);
    if (deleted) this.invalidateProviderState(id);
    return deleted;
  }

  public ensureMockProvider(): ProviderDto {
    const current = this.providers.get(MOCK_PROVIDER_ID);
    if (current) {
      if (current.type !== 'mock') {
        throw new Error('The reserved mock Provider ID is assigned to another Provider type.');
      }
      return toProviderDto(current);
    }

    const isFirstProvider = this.providers.page({ limit: 1 }).items.length === 0;
    return this.createWithId(MOCK_PROVIDER_ID, {
      name: 'Mock Provider',
      type: 'mock',
      enabled: true,
      isDefault: isFirstProvider,
    });
  }

  public listModels(request: ModelPageRequest = {}): CursorPage<ModelRecord> {
    return this.models.page(request);
  }

  public saveManualModel(input: ManualModelInput): ModelRecord {
    const provider = this.providers.get(input.providerId);
    if (!provider) {
      throw new ManualModelServiceError(
        'provider_not_found',
        `Provider ${input.providerId} was not found.`,
      );
    }
    if (customKindForProviderType(provider.type) !== null) {
      throw new ManualModelServiceError(
        'invalid_model',
        'Custom Provider models are managed by the adapter definition.',
      );
    }
    try {
      const capabilities = ModelCapabilitiesSchema.parse(input.capabilities);
      try { for (const operation of capabilities.operations) resolveModelProfile(provider.type, operation, input.modelId, capabilities.profile); }
      catch { throw new ManualModelServiceError('invalid_model', '模型调用协议与连接或支持的操作不匹配。'); }
      const family = providerFamily(provider.type);
      if (capabilities.profile && family && provider.type !== family) this.update(provider.id, { type: family });
      return this.models.saveManual(input);
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ManualModelServiceError('invalid_model', 'Manual model input is invalid.');
      }
      throw error;
    }
  }

  public updateManualModel(id: string, input: ManualModelUpdate): ModelRecord {
    const current = this.models.get(id);
    if (!current) {
      throw new ManualModelServiceError('model_not_found', `Model ${id} was not found.`);
    }
    if (current.capabilitySource !== 'manual') {
      throw new ManualModelServiceError(
        'model_not_manual',
        `Model ${id} is managed by its Provider and cannot be edited manually.`,
      );
    }
    const provider = this.providers.get(current.providerId);
    if (provider !== null && customKindForProviderType(provider.type) !== null) {
      throw new ManualModelServiceError(
        'model_not_manual',
        'Custom Provider models are managed by the adapter definition.',
      );
    }
    let updated: ModelRecord | null;
    try {
      const capabilities = ModelCapabilitiesSchema.parse(input.capabilities ?? current.capabilities);
      try { if (provider) for (const operation of capabilities.operations) resolveModelProfile(provider.type, operation, input.modelId ?? current.modelId, capabilities.profile); }
      catch { throw new ManualModelServiceError('invalid_model', '模型调用协议与连接或支持的操作不匹配。'); }
      const family = provider && providerFamily(provider.type);
      if (capabilities.profile && provider && family && provider.type !== family) this.update(provider.id, { type: family });
      updated = this.models.updateManual(id, input);
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ManualModelServiceError('invalid_model', 'Manual model input is invalid.');
      }
      throw error;
    }
    if (!updated) throw new ManualModelServiceError('model_not_found', `Model ${id} was not found.`);
    return updated;
  }

  public deleteManualModel(id: string): void {
    const current = this.models.get(id);
    if (!current) {
      throw new ManualModelServiceError('model_not_found', `Model ${id} was not found.`);
    }
    if (current.capabilitySource !== 'manual') {
      throw new ManualModelServiceError(
        'model_not_manual',
        `Model ${id} is managed by its Provider and cannot be deleted manually.`,
      );
    }
    if (!this.models.deleteManual(id)) {
      throw new ManualModelServiceError('model_not_found', `Model ${id} was not found.`);
    }
  }

  public async refreshModels(providerId: string): Promise<readonly ModelRecord[]> {
    const registration = await Promise.resolve(this.registry.resolve(providerId));
    const provider = this.providers.get(providerId);
    if (provider === null) {
      throw new ModelCatalogServiceError(
        'model_catalog_unavailable',
        'Provider model catalog could not be refreshed.',
      );
    }
    const adapter = registration.adapter;
    const customKind = customKindForProviderType(registration.adapter.type);
    const liveAdapter = hasLiveCapabilities(adapter) ? adapter : null;
    const customCatalog = isCustomHttpCatalogConfigured(registration.adapter);
    const hasLiveCatalog = registration.http !== undefined && liveAdapter !== null && (
      customKind === null || customCatalog
    );
    const cacheKey = this.catalogCacheKey(provider, registration);
    const context = { ...this.catalogContext(providerId, registration) };
    let capabilities: ProviderCapabilities;
    let source: ProviderCatalogSource;
    let stale = false;
    try {
      this.assertCustomRegistration(registration.adapter.type, registration.adapterRef);
      if (customKind === 'declarative-http') {
        // The static definition is authoritative and doubles as a bounded
        // fallback when an optional live catalog is unavailable or malformed.
        const staticCapabilities = await this.getStaticCapabilities(cacheKey, registration, context);
        if (hasLiveCatalog && liveAdapter !== null) {
          try {
            capabilities = this.assertMatchingCapabilities(
              registration,
              await liveAdapter.getLiveCapabilities(context),
            );
            source = 'provider';
          } catch {
            capabilities = staticCapabilities;
            source = 'profile';
            stale = true;
          }
        } else {
          capabilities = staticCapabilities;
          source = 'profile';
        }
      } else if (hasLiveCatalog && liveAdapter !== null) {
        capabilities = this.assertMatchingCapabilities(
          registration,
          await liveAdapter.getLiveCapabilities(context),
        );
        source = catalogSource(registration.adapter.type, true);
      } else {
        capabilities = await this.getStaticCapabilities(cacheKey, registration, context);
        source = catalogSource(registration.adapter.type, false);
      }
    } catch (error) {
      const invalid = error instanceof InvalidProviderCapabilitiesError;
      throw new ModelCatalogServiceError(
        invalid ? 'model_capabilities_invalid' : 'model_catalog_unavailable',
        invalid
          ? 'Provider returned an invalid model catalog.'
          : 'Provider model catalog could not be refreshed.',
      );
    }
    try {
      if (customKind !== null) {
        this.synchronizeCustomManualCapabilities(providerId, capabilities);
      }
      const refreshed = this.models.replaceForProvider(
        providerId,
        capabilities.models.map((model) => ({
          modelId: model.id,
          displayName: model.displayName,
          capabilities: { ...model.capabilities },
          capabilitySource: source,
        })),
      );
      this.catalogStatuses.set(providerId, {
        providerId,
        source,
        stale,
        adapterRef: copyAdapterRef(registration.adapterRef),
      });
      return refreshed;
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ModelCatalogServiceError(
          'model_capabilities_invalid',
          'Provider returned an invalid model catalog.',
          undefined,
        );
      }
      throw new ModelCatalogServiceError(
        'model_catalog_unavailable',
        'Provider model catalog could not be refreshed.',
        undefined,
      );
    }
  }

  public async testConnection(providerId: string): Promise<ProviderConnectionTestResult> {
    const registration = await Promise.resolve(this.registry.resolve(providerId));
    const startedAt = this.clock.now();
    try {
      if (registration.adapter.testConnection === undefined) {
        if (registration.adapter.type === CUSTOM_JS_PROVIDER_TYPE) {
          return {
            ok: false,
            latencyMs: Math.max(0, this.clock.now() - startedAt),
            message: 'Provider connection test is not supported for this adapter.',
          };
        }
        throw new Error('Provider connection test is not configured.');
      }
      await registration.adapter.testConnection({
        ...this.catalogContext(providerId, registration),
      });
      return {
        ok: true,
        latencyMs: Math.max(0, this.clock.now() - startedAt),
        message: 'Provider connection succeeded.',
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.max(0, this.clock.now() - startedAt),
        message: await this.connectionFailureMessage(error, registration),
      };
    }
  }

  private async connectionFailureMessage(error: unknown, registration: ProviderRegistration): Promise<string> {
    const normalized = await Promise.resolve().then(() => registration.adapter.normalizeError(error)).catch(() => null);
    const status = normalized?.statusCode;
    const descriptions: Readonly<Record<number, string>> = {
      400: '连接请求不符合上游接口规范', 401: 'API Key 无效或已失效', 403: 'API Key 没有访问权限',
      404: '模型目录接口不存在，请检查 Base URL 和协议', 405: '模型目录接口不支持 GET 请求',
      429: '上游请求限流或额度不足', 500: '上游服务内部错误', 502: '上游网关错误', 503: '上游服务暂不可用',
    };
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
      return `HTTP ${status}：${descriptions[status] ?? '上游拒绝了连接检测请求'}`;
    }
    return 'Provider connection test failed.';
  }

  /** Returns the last in-process catalog state without exposing adapter data. */
  public getCatalogStatus(providerId: string): ProviderCatalogStatus | null {
    const status = this.catalogStatuses.get(providerId);
    return status === undefined
      ? null
      : { ...status, adapterRef: copyAdapterRef(status.adapterRef) };
  }

  private invalidateProviderState(providerId: string): void {
    this.activeStaticCacheKeyByProvider.delete(providerId);
    for (const [key, entry] of this.staticCapabilityCache.entries()) {
      if (entry.providerId === providerId) this.staticCapabilityCache.delete(key);
    }
    this.catalogStatuses.delete(providerId);
  }

  private catalogCacheKey(
    provider: ProviderStorageRecord,
    registration: ProviderRegistration,
  ): string {
    let config: string;
    try {
      config = JSON.stringify(registration.config ?? {});
    } catch {
      config = '<invalid>';
    }
    const ref = registration.adapterRef;
    return JSON.stringify([
      provider.id,
      provider.updatedAt.toISOString(),
      registration.adapter.type,
      ref?.kind ?? null,
      ref?.adapterId ?? null,
      ref?.version ?? null,
      ref?.digest ?? null,
      registration.baseUrl ?? null,
      config,
    ]);
  }

  private async getStaticCapabilities(
    cacheKey: string,
    registration: ProviderRegistration,
    context: ProviderContext,
  ): Promise<ProviderCapabilities> {
    const previousKey = this.activeStaticCacheKeyByProvider.get(context.providerId);
    if (previousKey !== undefined && previousKey !== cacheKey) {
      this.staticCapabilityCache.delete(previousKey);
    }
    this.activeStaticCacheKeyByProvider.set(context.providerId, cacheKey);
    const cached = this.staticCapabilityCache.get(cacheKey);
    if (cached !== undefined) return cached.capabilities;
    const capabilities = this.assertMatchingCapabilities(
      registration,
      await registration.adapter.getCapabilities(context),
    );
    if (this.staticCapabilityCache.size >= 128) {
      const oldest = this.staticCapabilityCache.keys().next().value;
      if (typeof oldest === 'string') this.staticCapabilityCache.delete(oldest);
    }
    this.staticCapabilityCache.set(cacheKey, {
      providerId: context.providerId,
      capabilities,
    });
    return capabilities;
  }

  private assertCustomRegistration(
    adapterType: string,
    adapterRef: CustomAdapterRef | null | undefined,
  ): void {
    const expectedKind = customKindForProviderType(adapterType);
    if (expectedKind === null) return;
    if (adapterRef?.kind !== expectedKind) {
      throw new InvalidProviderCapabilitiesError('Provider adapter reference is invalid.');
    }
  }

  private synchronizeCustomManualCapabilities(
    providerId: string,
    capabilities: ProviderCapabilities,
  ): void {
    const authoritative = new Map(
      capabilities.models.map((model) => [model.id, model.capabilities]),
    );
    for (const model of this.models.listForProvider(providerId)) {
      if (model.capabilitySource !== 'manual') continue;
      const declared = authoritative.get(model.modelId);
      if (declared === undefined) continue;
      if (JSON.stringify(model.capabilities) === JSON.stringify(declared)) continue;
      const updated = this.models.updateManual(model.id, {
        capabilities: toJsonCapabilitiesRecord(declared),
      });
      if (updated === null) {
        throw new ModelRepositoryError(
          'invalid_capabilities',
          'Custom Provider model capabilities could not be synchronized.',
        );
      }
    }
  }

  private createWithId(id: string, input: CreateProviderServiceInput): ProviderDto {
    const type = ProviderTypeSchema.parse(input.type);
    const baseUrl = parseProviderBaseUrl(input.baseUrl);
    const config = SafeConfigSchema.parse(input.config ?? {});
    const created = this.providers.create({
      id,
      name: input.name,
      type,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(input.apiKey === undefined
        ? {}
        : { apiKeyCiphertext: this.vault.encryptString(id, 'apiKey', input.apiKey) }),
      ...(input.headers === undefined
        ? {}
        : {
            headersCiphertext: Object.keys(input.headers).length === 0
              ? null
              : this.vault.encryptJson(id, 'headers', input.headers),
          }),
      config,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    });
    return toProviderDto(created);
  }

  private catalogContext(
    providerId: string,
    registration: ProviderRegistration,
  ): ProviderContext & { readonly http?: object } {
    return {
      providerId,
      ...(registration.baseUrl === undefined ? {} : { baseUrl: registration.baseUrl }),
      config: registration.config ?? {},
      ...(registration.http === undefined ? {} : { http: registration.http }),
      secrets: registration.secrets,
    };
  }

  private assertMatchingCapabilities(
    registration: ProviderRegistration,
    capabilities: ProviderCapabilities,
  ): ProviderCapabilities {
    try {
      const boundedState = { nodes: 0 };
      assertBoundedCapabilityValue(capabilities, boundedState);
      const serialized = JSON.stringify(capabilities);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPABILITY_BYTES) {
        throw new Error('Provider capabilities exceed the size limit.');
      }
      if (
        capabilities === null ||
        typeof capabilities !== 'object' ||
        Array.isArray(capabilities) ||
        typeof capabilities.providerType !== 'string' ||
        capabilities.providerType.length === 0 ||
        capabilities.providerType.length > 255 ||
        !Array.isArray(capabilities.models) ||
        capabilities.models.length === 0 ||
        capabilities.models.length > MAX_CAPABILITY_MODELS
      ) {
        throw new Error('Provider capability response is invalid.');
      }
      if (Object.keys(capabilities).some((key) => !CAPABILITY_KEYS.has(key))) {
        throw new Error('Provider capability response contains unknown fields.');
      }
      const customKind = customKindForProviderType(registration.adapter.type);
      if (customKind === 'declarative-http' && capabilities.providerType !== registration.adapter.type) {
        throw new Error('Provider capability response did not match the registered adapter type.');
      }
      if (customKind === null && capabilities.providerType !== registration.adapter.type) {
        throw new Error('Provider capability response did not match the registered adapter type.');
      }
      if (customKind === 'trusted-javascript') {
        const ref = registration.adapterRef;
        if (ref === null || ref === undefined || ref.kind !== customKind) {
          throw new Error('Provider adapter reference is invalid.');
        }
        const key = adapterRefKey(ref);
        const previousType = this.providerTypeByAdapter.get(key);
        if (previousType !== undefined && previousType !== capabilities.providerType) {
          throw new Error('Provider capability response changed for the adapter revision.');
        }
      }
      const modelIds = new Set<string>();
      const models: ProviderModel[] = capabilities.models.map((model): ProviderModel => {
        if (
          model === null ||
          typeof model !== 'object' ||
          Object.keys(model).some((key) => !MODEL_KEYS.has(key)) ||
          typeof model.id !== 'string' ||
          model.id.trim().length === 0 ||
          model.id.length > 255 ||
          CONTROL_CHARACTER_PATTERN.test(model.id) ||
          typeof model.displayName !== 'string' ||
          model.displayName.trim().length === 0 ||
          model.displayName.length > 255 ||
          CONTROL_CHARACTER_PATTERN.test(model.displayName) ||
          modelIds.has(model.id)
        ) {
          throw new Error('Provider capability response contained an invalid model.');
        }
        const parsed = ModelCapabilitiesSchema.safeParse(model.capabilities);
        if (!parsed.success || parsed.data.operations.length > MAX_CAPABILITY_OPERATIONS) {
          throw new Error('Provider capability response contained invalid model capabilities.');
        }
        modelIds.add(model.id);
        return {
          id: model.id,
          displayName: model.displayName,
          capabilities: toProviderModelCapabilities(parsed.data),
        };
      });
      const normalized: ProviderCapabilities = {
        providerType: capabilities.providerType,
        models,
      };
      freezeCapabilityValue(normalized);
      if (customKind === 'trusted-javascript') {
        const ref = registration.adapterRef;
        if (ref !== null && ref !== undefined) {
          this.providerTypeByAdapter.set(adapterRefKey(ref), normalized.providerType);
        }
      }
      return normalized;
    } catch {
      throw new InvalidProviderCapabilitiesError('Provider capability response is invalid.');
    }
  }
}
