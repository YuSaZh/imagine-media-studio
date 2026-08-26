import type { ProviderAdapter } from '@imagine/provider-contract';

import type { ProviderRepository, ProviderStorageRecord } from '../database/providers.js';
import type { ProviderRegistration, ProviderRegistryPort } from '../jobs/ports.js';
import type { SecretVault } from '../security/secret-vault.js';
import { safeProviderConfig } from '../security/config-sanitizer.js';
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
} from './openai/index.js';
import { MockProviderAdapter } from './mock-provider.js';
import type { ProviderHttpClient as SafeProviderHttpClient } from './provider-http-client.js';
import { XaiImagineImageProvider, XaiImagineVideoProvider } from './xai/index.js';

export const MOCK_PROVIDER_ID = 'mock';

export type ProviderRegistryErrorCode =
  | 'provider_not_found'
  | 'provider_disabled'
  | 'provider_type_unsupported'
  | 'provider_secret_invalid'
  | 'provider_http_unavailable';

/**
 * The concrete HTTP client is intentionally opaque at this boundary. Each
 * provider profile narrows the injected object to its request/response shape,
 * while the application wires one policy-enforcing client for all profiles.
 */
export type ProviderHttpClient = SafeProviderHttpClient;

export interface ProviderHttpClientFactory {
  (provider: ProviderStorageRecord, secrets: Readonly<Record<string, string>>): ProviderHttpClient;
}

export interface ProviderRegistryOptions {
  mockAdapter?: ProviderAdapter;
  http?: ProviderHttpClient;
  httpFactory?: ProviderHttpClientFactory;
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
): Readonly<Record<string, string>> {
  try {
    const secrets: Record<string, string> = {};
    if (provider.apiKeyCiphertext !== null) {
      secrets.apiKey = vault.decryptString(provider.id, 'apiKey', provider.apiKeyCiphertext);
    }
    if (provider.headersCiphertext !== null) {
      const headers = vault.decryptJson(provider.id, 'headers', provider.headersCiphertext);
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') {
          throw new Error('Provider header values must be strings.');
        }
        secrets[`header:${name}`] = value;
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

function createAdapter(providerType: string, mockAdapter: ProviderAdapter): ProviderAdapter | null {
  switch (providerType) {
    case 'mock':
      return mockAdapter;
    case 'openai-images-v1':
      return createOpenAiImagesProvider();
    case 'openai-responses-image-v1':
      return createOpenAiResponsesImageProvider();
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
  private readonly http: ProviderHttpClient | undefined;
  private readonly httpFactory: ProviderHttpClientFactory | undefined;

  public constructor(
    private readonly providers: ProviderRepository,
    private readonly vault: SecretVault,
    optionsOrMock: ProviderRegistryOptions | ProviderAdapter = {},
  ) {
    if (isAdapter(optionsOrMock)) {
      this.mockAdapter = optionsOrMock;
      this.http = undefined;
      this.httpFactory = undefined;
    } else {
      this.mockAdapter = optionsOrMock.mockAdapter ?? new MockProviderAdapter();
      this.http = optionsOrMock.http;
      this.httpFactory = optionsOrMock.httpFactory;
    }
    if (this.mockAdapter.type !== 'mock') {
      throw new ProviderRegistryError(
        'provider_type_unsupported',
        'The mock Provider registration must use an adapter of type mock.',
      );
    }
  }

  public resolve(providerId: string): ProviderRegistration {
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

    const secrets = decryptSecrets(provider, this.vault);
    const adapter = createAdapter(provider.type, this.mockAdapter);
    if (!adapter) {
      throw new ProviderRegistryError(
        'provider_type_unsupported',
        `Provider type ${provider.type} is not supported.`,
      );
    }

    const config = freezeConfig(safeProviderConfig(provider.config)) as Readonly<Record<string, unknown>>;
    let http: ProviderHttpClient | undefined;
    try {
      http = this.httpFactory?.(provider, secrets) ?? this.http;
    } catch {
      throw new ProviderRegistryError(
        'provider_http_unavailable',
        `Provider ${provider.id} HTTP client is unavailable.`,
      );
    }
    return {
      adapter,
      secrets,
      ...(provider.baseUrl === null ? {} : { baseUrl: provider.baseUrl }),
      config,
      ...(http === undefined ? {} : { http }),
      // Current image profiles submit synchronously and expose no provider-side
      // idempotency guarantee that makes an unknown submit outcome replay-safe.
      submitReplaySafe: adapter.type === 'mock',
    };
  }
}
