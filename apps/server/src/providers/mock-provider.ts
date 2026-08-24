import type { GenerationRequest } from '@imagine/shared';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderError,
  SubmitResult,
} from '@imagine/provider-contract';

const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZX1GQAAAABJRU5ErkJggg==';

export class MockProviderValidationError extends Error {
  public override readonly name = 'MockProviderValidationError';
}

export class MockProviderAdapter implements ProviderAdapter {
  public readonly type = 'mock';

  public async getCapabilities(_context: ProviderContext): Promise<ProviderCapabilities> {
    return {
      providerType: this.type,
      models: [
        {
          id: 'mock-image-v1',
          displayName: 'Mock Image',
          capabilities: {
            operations: ['image.generate'],
            aspectRatios: ['1:1'],
            supportsBatchCount: false,
          },
        },
      ],
    };
  }

  public async validate(request: GenerationRequest, _context: ProviderContext): Promise<void> {
    if (
      request.providerId !== 'mock' ||
      request.modelId !== 'mock-image-v1' ||
      request.operation !== 'image.generate'
    ) {
      throw new MockProviderValidationError(
        'The PR 0 Mock Provider only supports mock-image-v1 image.generate requests.',
      );
    }

    if (request.inputs.length > 0) {
      throw new MockProviderValidationError('The PR 0 Mock Provider does not accept asset inputs.');
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
      message: error instanceof Error ? error.message : 'Unknown Mock Provider error',
      retryable: false,
    };
  }
}
