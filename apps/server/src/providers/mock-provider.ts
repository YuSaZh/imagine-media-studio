import type { GenerationRequest } from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  SubmitResult,
} from '@imagine/provider-contract';

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export class MockProviderValidationError extends Error {
  public override readonly name = 'MockProviderValidationError';
}

export class MockProviderAdapter implements ProviderAdapter {
  public readonly type = 'mock';

  public async testConnection(_context: ProviderContext): Promise<void> {
    // The mock has no upstream endpoint; this keeps its connection check explicit
    // while preserving the same ProviderService contract as real adapters.
  }

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return {
      providerType: this.type,
      models: [
        {
          id: 'mock-image-v1',
          displayName: 'Mock Image',
          capabilities: {
            operations: ['image.generate', 'image.edit'],
            aspectRatios: ['1:1'],
            maxReferenceImages: 4,
            supportsMask: true,
            supportsBatchCount: false,
            inputImageConstraints: {
              mimeTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
              maxBytes: 32 * 1024 * 1024,
              maxPixels: 100_000_000,
              maxWidth: 16_384,
              maxHeight: 16_384,
            },
          },
        },
      ],
    };
  }

  public async validate(request: GenerationRequest, _context: ProviderContext): Promise<void> {
    if (
      request.providerId !== 'mock' ||
      request.modelId !== 'mock-image-v1' ||
      !['image.generate', 'image.edit'].includes(request.operation)
    ) {
      throw new MockProviderValidationError(
        'The Mock Provider only supports mock-image-v1 image.generate and image.edit requests.',
      );
    }

    const count = (role: GenerationRequest['inputs'][number]['role']) =>
      request.inputs.filter((input) => input.role === role).length;
    if (count('reference') > 4) {
      throw new MockProviderValidationError('The Mock Provider accepts at most four references.');
    }
    if (request.operation === 'image.generate') {
      if (request.inputs.some((input) => input.role !== 'reference')) {
        throw new MockProviderValidationError(
          'Mock image.generate only accepts reference inputs.',
        );
      }
    } else if (
      count('source') !== 1 ||
      count('mask') > 1 ||
      count('first_frame') > 0 ||
      count('last_frame') > 0
    ) {
      throw new MockProviderValidationError(
        'Mock image.edit requires one source and accepts references plus one optional mask.',
      );
    }

    if (request.aspectRatio && request.aspectRatio !== '1:1') {
      throw new MockProviderValidationError(
        'The PR 0 Mock Provider only supports the 1:1 aspect ratio.',
      );
    }

    if (request.count && request.count !== 1) {
      throw new MockProviderValidationError('The PR 0 Mock Provider only supports one output.');
    }

    const unsupportedOptions: Array<[string, unknown]> = [
      ['negativePrompt', request.negativePrompt],
      ['width', request.width],
      ['height', request.height],
      ['resolution', request.resolution],
      ['durationSeconds', request.durationSeconds],
      ['fps', request.fps],
      ['quality', request.quality],
      ['format', request.format],
      ['seed', request.seed],
      ['audio', request.audio],
      ['extra', request.extra],
    ];
    const unsupported = unsupportedOptions.find(([, value]) => value !== undefined);
    if (unsupported) {
      throw new MockProviderValidationError(
        `The PR 0 Mock Provider does not support ${unsupported[0]}.`,
      );
    }
  }

  public async submit(
    _request: GenerationRequest,
    _context: ProviderContext,
  ): Promise<SubmitResult> {
    return {
      state: 'completed',
      assets: [
        {
          type: 'image',
          mimeType: 'image/png',
          source: 'base64',
          base64: TRANSPARENT_PNG_BASE64,
        },
      ],
    };
  }

  public normalizeError(error: unknown): ProviderError {
    return {
      code:
        error instanceof MockProviderValidationError
          ? 'mock_validation_error'
          : 'mock_provider_error',
      kind: error instanceof MockProviderValidationError ? 'rejected' : 'unknown',
      message: error instanceof Error ? error.message : 'Unknown Mock Provider error',
      retryable: false,
    };
  }
}
