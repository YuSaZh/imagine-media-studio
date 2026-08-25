export interface ImageInputDescriptor {
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface ImageInputPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly maxCount: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPixels: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export const DEFAULT_IMAGE_INPUT_POLICY: ImageInputPolicy = {
  allowedMimeTypes: ['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'],
  maxCount: 4,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxWidth: 16_384,
  maxHeight: 16_384,
};

export type ImageInputPolicyErrorCode =
  | 'image_count_exceeded'
  | 'image_dimensions_exceeded'
  | 'image_file_too_large'
  | 'image_pixels_exceeded'
  | 'image_total_bytes_exceeded'
  | 'image_upscale_forbidden'
  | 'invalid_image_metadata'
  | 'invalid_image_policy'
  | 'unsupported_image_mime';

export class ImageInputPolicyError extends Error {
  public override readonly name = 'ImageInputPolicyError';

  public constructor(
    public readonly code: ImageInputPolicyErrorCode,
    message: string,
    public readonly inputIndex: number | null = null,
  ) {
    super(message);
  }
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface FittedImageSize extends ImageSize {
  readonly scale: number;
  readonly wasResized: boolean;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertImageSize(size: ImageSize): void {
  if (!positiveSafeInteger(size.width) || !positiveSafeInteger(size.height)) {
    throw new ImageInputPolicyError(
      'invalid_image_metadata',
      'Image dimensions must be positive safe integers.',
    );
  }
}

function assertPolicy(policy: ImageInputPolicy): void {
  const limits = [
    policy.maxCount,
    policy.maxFileBytes,
    policy.maxTotalBytes,
    policy.maxPixels,
    policy.maxWidth,
    policy.maxHeight,
  ];
  if (
    policy.allowedMimeTypes.length === 0 ||
    policy.allowedMimeTypes.some((mime) => !/^image\/[a-z0-9!#$&^_.+-]+$/i.test(mime)) ||
    limits.some((limit) => !positiveSafeInteger(limit)) ||
    policy.maxFileBytes > policy.maxTotalBytes
  ) {
    throw new ImageInputPolicyError('invalid_image_policy', 'Image input policy is invalid.');
  }
}

function normalizedMimeType(value: string): string {
  return value.trim().toLowerCase();
}

export function validateImageInputs(
  inputs: readonly ImageInputDescriptor[],
  policy: ImageInputPolicy = DEFAULT_IMAGE_INPUT_POLICY,
): void {
  assertPolicy(policy);
  if (inputs.length > policy.maxCount) {
    throw new ImageInputPolicyError(
      'image_count_exceeded',
      `At most ${policy.maxCount} image inputs are allowed.`,
    );
  }
  let totalBytes = 0;
  for (const [index, input] of inputs.entries()) {
    if (!positiveSafeInteger(input.bytes)) {
      throw new ImageInputPolicyError(
        'invalid_image_metadata',
        'Image byte size must be a positive safe integer.',
        index,
      );
    }
    if (!positiveSafeInteger(input.width) || !positiveSafeInteger(input.height)) {
      throw new ImageInputPolicyError(
        'invalid_image_metadata',
        'Image dimensions must be positive safe integers.',
        index,
      );
    }
    const mimeType = normalizedMimeType(input.mimeType);
    if (!policy.allowedMimeTypes.some((allowed) => normalizedMimeType(allowed) === mimeType)) {
      throw new ImageInputPolicyError(
        'unsupported_image_mime',
        `Image MIME type ${mimeType || '(empty)'} is not allowed.`,
        index,
      );
    }
    if (input.bytes > policy.maxFileBytes) {
      throw new ImageInputPolicyError(
        'image_file_too_large',
        `Image input exceeds ${policy.maxFileBytes} bytes.`,
        index,
      );
    }
    if (input.width > policy.maxWidth || input.height > policy.maxHeight) {
      throw new ImageInputPolicyError(
        'image_dimensions_exceeded',
        'Image dimensions exceed the configured limit.',
        index,
      );
    }
    if (input.width > Math.floor(policy.maxPixels / input.height)) {
      throw new ImageInputPolicyError(
        'image_pixels_exceeded',
        `Image input exceeds ${policy.maxPixels} pixels.`,
        index,
      );
    }
    if (totalBytes > policy.maxTotalBytes - input.bytes) {
      throw new ImageInputPolicyError(
        'image_total_bytes_exceeded',
        `Image inputs exceed ${policy.maxTotalBytes} total bytes.`,
        index,
      );
    }
    totalBytes += input.bytes;
  }
}

export function assertNoImageUpscale(source: ImageSize, target: ImageSize): void {
  assertImageSize(source);
  assertImageSize(target);
  if (target.width > source.width || target.height > source.height) {
    throw new ImageInputPolicyError(
      'image_upscale_forbidden',
      'Image preprocessing cannot enlarge the source image.',
    );
  }
}

export function fitImageWithin(
  source: ImageSize,
  bounds: ImageSize,
  dimensionMultiple = 1,
): FittedImageSize {
  assertImageSize(source);
  assertImageSize(bounds);
  if (!positiveSafeInteger(dimensionMultiple)) {
    throw new ImageInputPolicyError(
      'invalid_image_policy',
      'Dimension multiple must be a positive safe integer.',
    );
  }
  const requestedScale = Math.min(
    1,
    bounds.width / source.width,
    bounds.height / source.height,
  );
  if (requestedScale === 1) return { ...source, scale: 1, wasResized: false };
  const width = Math.max(
    1,
    Math.floor((source.width * requestedScale) / dimensionMultiple) * dimensionMultiple,
  );
  const height = Math.max(
    1,
    Math.floor((source.height * requestedScale) / dimensionMultiple) * dimensionMultiple,
  );
  const fitted = {
    width: Math.min(source.width, width),
    height: Math.min(source.height, height),
  };
  assertNoImageUpscale(source, fitted);
  return {
    ...fitted,
    scale: Math.min(fitted.width / source.width, fitted.height / source.height),
    wasResized: fitted.width !== source.width || fitted.height !== source.height,
  };
}
