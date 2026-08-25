import type { ProviderAdapter } from '@imagine/provider-contract';

import type { ProviderRepository, ProviderStorageRecord } from '../database/providers.js';
import type { ProviderRegistration, ProviderRegistryPort } from '../jobs/ports.js';
import type { SecretVault } from '../security/secret-vault.js';
import { MockProviderAdapter } from './mock-provider.js';

export const MOCK_PROVIDER_ID = 'mock';

export type ProviderRegistryErrorCode =
  | 'provider_not_found'
  | 'provider_disabled'
  | 'provider_type_unsupported'
  | 'provider_secret_invalid';

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
        secrets[`header:${name}`] = value;
      }
    }
    return secrets;
  } catch (error) {
    throw new ProviderRegistryError(
      'provider_secret_invalid',
      `Provider ${provider.id} has invalid encrypted credentials.`,
      { cause: error },
    );
  }
}

export class ProviderRegistry implements ProviderRegistryPort {
  public constructor(
    private readonly providers: ProviderRepository,
    private readonly vault: SecretVault,
    private readonly mockAdapter: ProviderAdapter = new MockProviderAdapter(),
  ) {
    if (mockAdapter.type !== 'mock') {
      throw new ProviderRegistryError(
        'provider_type_unsupported',
        'The PR 2 Provider Registry requires a mock adapter.',
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
    if (provider.type !== this.mockAdapter.type) {
      throw new ProviderRegistryError(
        'provider_type_unsupported',
        `Provider type ${provider.type} is not supported in PR 2.`,
      );
    }

    return {
      adapter: this.mockAdapter,
      secrets: decryptSecrets(provider, this.vault),
      submitReplaySafe: true,
    };
  }
}
