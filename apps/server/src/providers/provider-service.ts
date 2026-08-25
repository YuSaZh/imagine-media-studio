import { randomUUID } from 'node:crypto';

import {
  ProviderDtoSchema,
  type JsonObject,
  type ProviderDto,
} from '@imagine/shared';
import type { ProviderCapabilities } from '@imagine/provider-contract';

import {
  type ModelPageRequest,
  type ModelRecord,
  type ModelRepository,
} from '../database/models.js';
import type { CursorPage } from '../database/pagination.js';
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

const systemClock: ProviderServiceClock = { now: () => Date.now() };

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

function catalogSource(providerType: string): 'mock' | 'provider' {
  return providerType === 'mock' ? 'mock' : 'provider';
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
    const updated = this.providers.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(!('baseUrl' in input) ? {} : { baseUrl: input.baseUrl ?? null }),
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
              input.headers === null ? null : this.vault.encryptJson(id, 'headers', input.headers),
          }),
      ...(input.config === undefined ? {} : { config: input.config }),
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

  public async refreshModels(providerId: string): Promise<readonly ModelRecord[]> {
    const registration = this.registry.resolve(providerId);
    const capabilities = await registration.adapter.getCapabilities({
      providerId,
      secrets: registration.secrets,
    });
    this.assertMatchingCapabilities(registration.adapter.type, capabilities);
    return this.models.replaceForProvider(
      providerId,
      capabilities.models.map((model) => ({
        modelId: model.id,
        displayName: model.displayName,
        capabilities: { ...model.capabilities },
        capabilitySource: catalogSource(registration.adapter.type),
      })),
    );
  }

  public async testConnection(providerId: string): Promise<ProviderConnectionTestResult> {
    const registration = this.registry.resolve(providerId);
    const startedAt = this.clock.now();
    try {
      const capabilities = await registration.adapter.getCapabilities({
        providerId,
        secrets: registration.secrets,
      });
      this.assertMatchingCapabilities(registration.adapter.type, capabilities);
      return {
        ok: true,
        latencyMs: Math.max(0, this.clock.now() - startedAt),
        message: `Provider connection succeeded with ${capabilities.models.length} model(s).`,
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
    const created = this.providers.create({
      id,
      name: input.name,
      type: input.type,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.apiKey === undefined
        ? {}
        : { apiKeyCiphertext: this.vault.encryptString(id, 'apiKey', input.apiKey) }),
      ...(input.headers === undefined
        ? {}
        : { headersCiphertext: this.vault.encryptJson(id, 'headers', input.headers) }),
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    });
    return toProviderDto(created);
  }

  private assertMatchingCapabilities(
    adapterType: string,
    capabilities: ProviderCapabilities,
  ): void {
    if (capabilities.providerType !== adapterType) {
      throw new Error('Provider capability response did not match the registered adapter type.');
    }
  }
}
