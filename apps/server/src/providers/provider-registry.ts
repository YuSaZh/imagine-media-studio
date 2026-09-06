import type { ProviderAdapter, ProviderHttpClientPort } from '@imagine/provider-contract';
import { CustomAdapterRefSchema, type CustomAdapterRef } from '@imagine/shared';

import {
  ProviderAdapterDefinitionError,
  type ProviderAdapterDefinitionRecord,
  type ProviderAdapterDefinitionRepository,
} from '../database/adapter-definitions.js';
import type { ProviderRepository, ProviderStorageRecord } from '../database/providers.js';
import type { ProviderRegistration, ProviderRegistryPort } from '../jobs/ports.js';
import type { SecretVault } from '../security/secret-vault.js';
import { safeProviderConfig } from '../security/config-sanitizer.js';
import type { AdapterWorkerHost } from '../adapters/worker-host.js';
import {
  GeminiInteractionsImageProvider,
  GeminiNativeImageProvider,
  GeminiOmniVideoProvider,
  GeminiVeoProvider,
} from './gemini/index.js';
import {
  createOpenAiImagesProvider,
  createOpenAiResponsesImageProvider,
  createOpenAiVideosProvider,
  OpenAiProviderAdapter,
} from './openai/index.js';
import {
  DeclarativeHttpAdapter,
  type DeclarativeHttpSpec,
} from './custom-http/index.js';
import {
  TrustedJavaScriptProviderAdapter,
  type TrustedJavaScriptWorkerHost,
} from './custom-js/index.js';
import { MockProviderAdapter } from './mock-provider.js';
import type { ProviderHttpClient as SafeProviderHttpClient } from './provider-http-client.js';
import { XaiImagineImageProvider, XaiImagineVideoProvider } from './xai/index.js';
import { FamilyProvider } from './family-provider.js';
import { MODEL_PROTOCOLS } from '@imagine/shared';

export const MOCK_PROVIDER_ID = 'mock';

export type ProviderRegistryErrorCode =
  | 'provider_not_found'
  | 'provider_disabled'
  | 'provider_type_unsupported'
  | 'provider_secret_invalid'
  | 'provider_http_unavailable'
  | 'provider_adapter_ref_invalid'
  | 'provider_adapter_ref_not_allowed'
  | 'provider_adapter_not_found'
  | 'provider_adapter_disabled'
  | 'provider_adapter_kind_mismatch'
  | 'provider_adapter_invalid'
  | 'provider_adapter_unavailable';

/**
 * The concrete HTTP client is intentionally opaque at this boundary. Each
 * provider profile narrows the injected object to its request/response shape,
 * while the application wires one policy-enforcing client for all profiles.
 */
export type ProviderHttpClient = SafeProviderHttpClient;

export interface ProviderHttpClientFactory {
  (provider: ProviderStorageRecord, secrets: Readonly<Record<string, string>>): ProviderHttpClientPort;
}

export interface ProviderRegistryOptions {
  mockAdapter?: ProviderAdapter;
  http?: ProviderHttpClientPort;
  httpFactory?: ProviderHttpClientFactory;
  /** Durable custom adapter definition records, including historical revisions. */
  adapterDefinitions?: ProviderAdapterDefinitionRepository;
  /** Runtime host that verifies and executes trusted JavaScript revisions. */
  adapterWorkerHost?: AdapterWorkerHost | TrustedJavaScriptWorkerHost;
}

export class ProviderRegistryError extends Error {
  public override readonly name = 'ProviderRegistryError';

  public constructor(
    public readonly code: ProviderRegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function decryptSecrets(
  provider: ProviderStorageRecord,
  vault: SecretVault,
  requiredNames?: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  try {
    const includeAll = requiredNames === undefined;
    const wants = (name: string): boolean => includeAll || requiredNames.has(name);
    const secrets: Record<string, string> = {};
    if (provider.apiKeyCiphertext !== null && wants('apiKey')) {
      secrets.apiKey = vault.decryptString(provider.id, 'apiKey', provider.apiKeyCiphertext);
    }
    const wantsHeader = includeAll || [...requiredNames].some((name) => name.startsWith('header:'));
    if (provider.headersCiphertext !== null && wantsHeader) {
      const headers = vault.decryptJson(provider.id, 'headers', provider.headersCiphertext);
      for (const [name, value] of Object.entries(headers)) {
        const secretName = `header:${name}`;
        if (!wants(secretName)) continue;
        if (typeof value !== 'string') {
          throw new Error('Provider header values must be strings.');
        }
        secrets[secretName] = value;
      }
    }
    return Object.freeze(secrets);
  } catch {
    throw new ProviderRegistryError(
      'provider_secret_invalid',
      `Provider ${provider.id} has invalid encrypted credentials.`,
    );
  }
}

function isAdapter(value: ProviderAdapter | ProviderRegistryOptions): value is ProviderAdapter {
  return 'type' in value && typeof value.type === 'string';
}

function freezeConfig(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeConfig(child);
    Object.freeze(value);
  }
  return value;
}

function adapterKindForProviderType(
  providerType: string,
): CustomAdapterRef['kind'] | null {
  if (providerType === 'custom-http-v1') return 'declarative-http';
  if (providerType === 'custom-js-v1') return 'trusted-javascript';
  return null;
}

function parseRequestedRef(value: CustomAdapterRef | null | undefined): CustomAdapterRef | null {
  if (value === undefined || value === null) return null;
  const parsed = CustomAdapterRefSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProviderRegistryError(
      'provider_adapter_ref_invalid',
      'Provider adapter reference is invalid.',
    );
  }
  return parsed.data;
}

function sameAdapterRef(left: CustomAdapterRef, right: CustomAdapterRef): boolean {
  return left.kind === right.kind &&
    left.adapterId === right.adapterId &&
    left.version === right.version &&
    left.digest === right.digest;
}

const SECRET_TEMPLATE_PATTERN = /\{\{\s*secret\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/gu;

/** Extracts only secret names referenced by a declarative definition. */
function declarativeSecretNames(value: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<object>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      SECRET_TEMPLATE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SECRET_TEMPLATE_PATTERN.exec(current)) !== null) names.add(match[1]!);
      return;
    }
    if (current === null || typeof current !== 'object' || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
    } else {
      for (const [key, child] of Object.entries(current)) {
        if (key === 'secretRef' && typeof child === 'string') names.add(child);
        visit(child);
      }
    }
    seen.delete(current);
  };
  visit(value);
  return names;
}

function registryAdapterError(
  code: Extract<ProviderRegistryErrorCode, `provider_adapter_${string}`>,
  message: string,
): ProviderRegistryError {
  return new ProviderRegistryError(code, message);
}

function createAdapter(providerType: string, mockAdapter: ProviderAdapter): ProviderAdapter | null {
  switch (providerType) {
    case 'openai':
    case 'gemini':
    case 'xai':
      return new FamilyProvider(providerType, new Map(MODEL_PROTOCOLS.map(profile => [profile.value, createAdapter(profile.value, mockAdapter)!])));
    case 'mock':
      return mockAdapter;
    case 'openai-images-v1':
      return createOpenAiImagesProvider();
    case 'openai-responses-image-v1':
      return createOpenAiResponsesImageProvider();
    case 'openai-chat-image-v1':
      return new OpenAiProviderAdapter('openai-chat-image-v1');
    case 'openai-videos-v1-compatible':
      return createOpenAiVideosProvider();
    case 'gemini-generate-content-image-v1':
      return new GeminiNativeImageProvider();
    case 'gemini-interactions-image-v1':
      return new GeminiInteractionsImageProvider();
    case 'gemini-veo-operation-v1':
      return new GeminiVeoProvider();
    case 'gemini-omni-interactions-video-v1':
      return new GeminiOmniVideoProvider();
    case 'xai-imagine-image-v1':
      return new XaiImagineImageProvider();
    case 'xai-imagine-video-v1':
      return new XaiImagineVideoProvider();
    default:
      return null;
  }
}

/**
 * Resolves persisted provider records into runtime-only registrations. The
 * adapter instances contain no credentials; decrypted values live only in the
 * short-lived registration/context handed to a job operation.
 */
export class ProviderRegistry implements ProviderRegistryPort {
  private readonly mockAdapter: ProviderAdapter;
  private readonly http: ProviderHttpClientPort | undefined;
  private readonly httpFactory: ProviderHttpClientFactory | undefined;
  private readonly adapterDefinitions: ProviderAdapterDefinitionRepository | undefined;
  private readonly adapterWorkerHost: AdapterWorkerHost | TrustedJavaScriptWorkerHost | undefined;

  public constructor(
    private readonly providers: ProviderRepository,
    private readonly vault: SecretVault,
    optionsOrMock: ProviderRegistryOptions | ProviderAdapter = {},
  ) {
    if (isAdapter(optionsOrMock)) {
      this.mockAdapter = optionsOrMock;
      this.http = undefined;
      this.httpFactory = undefined;
      this.adapterDefinitions = undefined;
      this.adapterWorkerHost = undefined;
    } else {
      this.mockAdapter = optionsOrMock.mockAdapter ?? new MockProviderAdapter();
      this.http = optionsOrMock.http;
      this.httpFactory = optionsOrMock.httpFactory;
      this.adapterDefinitions = optionsOrMock.adapterDefinitions;
      this.adapterWorkerHost = optionsOrMock.adapterWorkerHost;
    }
    if (this.mockAdapter.type !== 'mock') {
      throw new ProviderRegistryError(
        'provider_type_unsupported',
        'The mock Provider registration must use an adapter of type mock.',
      );
    }
  }

  public resolve(
    providerId: string,
    rawAdapterRef?: CustomAdapterRef | null,
  ): ProviderRegistration {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ProviderRegistryError(
        'provider_not_found',
        `Provider ${providerId} was not found.`,
      );
    }
    if (!provider.enabled) {
      throw new ProviderRegistryError(
        'provider_disabled',
        `Provider ${providerId} is disabled.`,
      );
    }

    const requestedRef = parseRequestedRef(rawAdapterRef);
    const adapterKind = adapterKindForProviderType(provider.type);
    if (adapterKind === null) {
      const adapter = createAdapter(provider.type, this.mockAdapter);
      if (!adapter) {
        throw new ProviderRegistryError(
          'provider_type_unsupported',
          `Provider type ${provider.type} is not supported.`,
        );
      }
      if (requestedRef !== null) {
        throw registryAdapterError(
          'provider_adapter_ref_not_allowed',
          'Built-in Provider profiles do not accept an adapter reference.',
        );
      }
      const secrets = decryptSecrets(provider, this.vault);
      return this.registration(provider, adapter, secrets, null, this.createHttp(provider, secrets));
    }

    if (requestedRef !== null && requestedRef.kind !== adapterKind) {
      throw registryAdapterError(
        'provider_adapter_kind_mismatch',
        'Provider adapter reference kind does not match the Provider type.',
      );
    }
    const definition = this.resolveDefinition(provider, requestedRef, adapterKind);
    const requiredSecrets = adapterKind === 'declarative-http'
      ? declarativeSecretNames(definition.definition)
      : undefined;
    const secrets = decryptSecrets(provider, this.vault, requiredSecrets);
    const http = this.createHttp(provider, secrets);

    if (adapterKind === 'declarative-http') {
      if (definition.definition === null) {
        throw registryAdapterError(
          'provider_adapter_invalid',
          'Provider declarative adapter definition is invalid.',
        );
      }
      if (http === undefined) {
        throw new ProviderRegistryError(
          'provider_http_unavailable',
          'Provider HTTP client is unavailable.',
        );
      }
      const adapter = new DeclarativeHttpAdapter(
        definition.definition as unknown as DeclarativeHttpSpec,
        { http },
      );
      return this.registration(provider, adapter, secrets, definition.ref, http);
    }

    if (definition.definition !== null) {
      throw registryAdapterError(
        'provider_adapter_invalid',
        'Provider trusted JavaScript adapter definition is invalid.',
      );
    }
    if (this.adapterWorkerHost === undefined) {
      throw registryAdapterError(
        'provider_adapter_unavailable',
        'Provider trusted JavaScript runtime is unavailable.',
      );
    }
    const adapter = new TrustedJavaScriptProviderAdapter(
      definition.ref as Extract<CustomAdapterRef, { kind: 'trusted-javascript' }>,
      this.adapterWorkerHost,
    );
    return this.registration(provider, adapter, secrets, definition.ref, http);
  }

  private resolveDefinition(
    provider: ProviderStorageRecord,
    requestedRef: CustomAdapterRef | null,
    expectedKind: CustomAdapterRef['kind'],
  ): ProviderAdapterDefinitionRecord {
    if (this.adapterDefinitions === undefined) {
      throw registryAdapterError(
        'provider_adapter_unavailable',
        'Provider adapter definition repository is unavailable.',
      );
    }

    let definition: ProviderAdapterDefinitionRecord | null;
    try {
      definition = requestedRef === null
        ? this.adapterDefinitions.getCurrent(provider.id)
        : this.adapterDefinitions.getByRef(provider.id, requestedRef);
    } catch (error) {
      if (error instanceof ProviderAdapterDefinitionError && error.code === 'not_found') {
        throw registryAdapterError(
          'provider_adapter_not_found',
          'Provider adapter revision was not found.',
        );
      }
      throw registryAdapterError(
        'provider_adapter_invalid',
        'Provider adapter revision is invalid.',
      );
    }

    if (definition === null) {
      throw registryAdapterError(
        'provider_adapter_not_found',
        requestedRef === null
          ? 'Provider has no current adapter revision.'
          : 'Provider adapter revision was not found.',
      );
    }
    if (definition.providerId !== provider.id || definition.ref.kind !== expectedKind) {
      throw registryAdapterError(
        'provider_adapter_kind_mismatch',
        'Provider adapter revision does not match the Provider type.',
      );
    }
    if (requestedRef !== null && !sameAdapterRef(definition.ref, requestedRef)) {
      throw registryAdapterError(
        'provider_adapter_not_found',
        'Provider adapter revision was not found.',
      );
    }
    if (requestedRef === null && (!definition.isCurrent || definition.disabled)) {
      throw new ProviderRegistryError(
        'provider_adapter_disabled',
        'Provider current adapter revision is disabled.',
      );
    }
    return definition;
  }

  private createHttp(
    provider: ProviderStorageRecord,
    secrets: Readonly<Record<string, string>>,
  ): ProviderHttpClientPort | undefined {
    try {
      return this.httpFactory?.(provider, secrets) ?? this.http;
    } catch {
      throw new ProviderRegistryError(
        'provider_http_unavailable',
        'Provider HTTP client is unavailable.',
      );
    }
  }

  private registration(
    provider: ProviderStorageRecord,
    adapter: ProviderAdapter,
    secrets: Readonly<Record<string, string>>,
    adapterRef: CustomAdapterRef | null,
    http?: ProviderHttpClientPort,
  ): ProviderRegistration {
    const config = freezeConfig(safeProviderConfig(provider.config)) as Readonly<Record<string, unknown>>;
    return {
      adapter,
      secrets,
      adapterRef,
      ...(provider.baseUrl === null ? {} : { baseUrl: provider.baseUrl }),
      config,
      ...(http === undefined ? {} : { http }),
      // Current image profiles submit synchronously and expose no provider-side
      // idempotency guarantee that makes an unknown submit outcome replay-safe.
      submitReplaySafe: adapter.type === 'mock',
    };
  }
}
