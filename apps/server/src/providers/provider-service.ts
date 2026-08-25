import { randomUUID } from 'node:crypto';

import {
  ModelCapabilitiesSchema,
  ProviderBaseUrlSchema,
  ProviderDtoSchema,
  ProviderTypeSchema,
  SafeConfigSchema,
  type JsonObject,
  type ProviderDto,
} from '@imagine/shared';
import type { ProviderAdapter, ProviderCapabilities, ProviderContext } from '@imagine/provider-contract';

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

const systemClock: ProviderServiceClock = { now: () => Date.now() };

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
  getLiveCapabilities?(context: ProviderContext): Promise<ProviderCapabilities>;
}

function catalogSource(providerType: string, live: boolean): 'mock' | 'profile' | 'provider' {
  if (providerType === 'mock') return 'mock';
  return live ? 'provider' : 'profile';
}

export class ProviderService {
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
    return updated ? toProviderDto(updated) : null;
  }

  public setDefault(id: string): ProviderDto | null {
    const provider = this.providers.setDefault(id);
    return provider ? toProviderDto(provider) : null;
  }

  public delete(id: string): boolean {
    return this.providers.delete(id);
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
    if (!this.providers.get(input.providerId)) {
      throw new ManualModelServiceError(
        'provider_not_found',
        `Provider ${input.providerId} was not found.`,
      );
    }
    try {
      return this.models.saveManual(input);
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ManualModelServiceError('invalid_model', 'Manual model input is invalid.', { cause: error });
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
    let updated: ModelRecord | null;
    try {
      updated = this.models.updateManual(id, input);
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ManualModelServiceError('invalid_model', 'Manual model input is invalid.', { cause: error });
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
    const registration = this.registry.resolve(providerId);
    const adapter = registration.adapter as LiveCatalogProviderAdapter;
    const hasLiveCatalog = registration.http !== undefined && typeof adapter.getLiveCapabilities === 'function';
    let capabilities: ProviderCapabilities;
    try {
      const context = { ...this.catalogContext(providerId, registration) };
      capabilities = hasLiveCatalog
        ? await adapter.getLiveCapabilities!(context)
        : await adapter.getCapabilities(context);
    } catch (error) {
      throw new ModelCatalogServiceError(
        'model_catalog_unavailable',
        'Provider model catalog could not be refreshed.',
        { cause: error },
      );
    }
    try {
      this.assertMatchingCapabilities(registration.adapter.type, capabilities);
    } catch (error) {
      throw new ModelCatalogServiceError(
        'model_capabilities_invalid',
        'Provider returned an invalid model catalog.',
        { cause: error },
      );
    }
    try {
      return this.models.replaceForProvider(
        providerId,
        capabilities.models.map((model) => ({
          modelId: model.id,
          displayName: model.displayName,
          capabilities: { ...model.capabilities },
          capabilitySource: catalogSource(registration.adapter.type, hasLiveCatalog),
        })),
      );
    } catch (error) {
      if (error instanceof ModelRepositoryError) {
        throw new ModelCatalogServiceError(
          'model_capabilities_invalid',
          'Provider returned an invalid model catalog.',
          { cause: error },
        );
      }
      throw new ModelCatalogServiceError(
        'model_catalog_unavailable',
        'Provider model catalog could not be refreshed.',
        { cause: error },
      );
    }
  }

  public async testConnection(providerId: string): Promise<ProviderConnectionTestResult> {
    const registration = this.registry.resolve(providerId);
    const startedAt = this.clock.now();
    try {
      if (registration.adapter.testConnection === undefined) {
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
    } catch {
      return {
        ok: false,
        latencyMs: Math.max(0, this.clock.now() - startedAt),
        message: 'Provider connection test failed.',
      };
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
    adapterType: string,
    capabilities: ProviderCapabilities,
  ): void {
    if (capabilities.providerType !== adapterType) {
      throw new Error('Provider capability response did not match the registered adapter type.');
    }
    if (!Array.isArray(capabilities.models)) {
      throw new Error('Provider capability response did not contain a model list.');
    }
    const modelIds = new Set<string>();
    for (const model of capabilities.models) {
      if (
        typeof model.id !== 'string' ||
        model.id.trim().length === 0 ||
        typeof model.displayName !== 'string' ||
        model.displayName.trim().length === 0 ||
        modelIds.has(model.id)
      ) {
        throw new Error('Provider capability response contained an invalid model.');
      }
      if (!ModelCapabilitiesSchema.safeParse(model.capabilities).success) {
        throw new Error('Provider capability response contained invalid model capabilities.');
      }
      modelIds.add(model.id);
    }
  }
}
