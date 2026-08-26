import type { GenerationRequest } from '@imagine/shared';
import { MediaOperationSchema } from '@imagine/shared';
import { z } from 'zod';

import type { AssetRecord, AssetRepository } from '../database/assets.js';
import type { ModelRecord, ModelRepository } from '../database/models.js';

const ImageInputConstraintsSchema = z.object({
  mimeTypes: z.array(z.string().trim().min(1)).min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxPixels: z.number().int().positive().optional(),
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
}).strict();

const RelevantCapabilitiesSchema = z.object({
  operations: z.array(MediaOperationSchema).min(1),
  maxReferenceImages: z.number().int().nonnegative().optional(),
  supportsMask: z.boolean().optional(),
  inputImageConstraints: ImageInputConstraintsSchema.optional(),
}).passthrough();

type AssetLookup = Pick<AssetRepository, 'get'>;
type ModelLookup = Pick<ModelRepository, 'listForProvider'>;

export type GenerationInputErrorCode =
  | 'asset_input_duplicate'
  | 'asset_input_not_found'
  | 'asset_input_not_image'
  | 'image_dimensions_missing'
  | 'image_input_too_large'
  | 'image_mime_unsupported'
  | 'input_role_not_allowed'
  | 'mask_not_supported'
  | 'mask_parent_mismatch'
  | 'mask_source_required'
  | 'mask_type_invalid'
  | 'model_capabilities_invalid'
  | 'model_disabled'
  | 'model_not_found'
  | 'operation_not_supported'
  | 'reference_limit_exceeded'
  | 'source_input_required';

export class GenerationInputError extends Error {
  public override readonly name = 'GenerationInputError';

  public constructor(
    public readonly code: GenerationInputErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedGenerationInput {
  input: GenerationRequest['inputs'][number];
  asset: AssetRecord;
}

export interface ResolvedGenerationRequest {
  request: GenerationRequest;
  model: ModelRecord;
  inputs: readonly ResolvedGenerationInput[];
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export class GenerationInputResolver {
  public constructor(
    private readonly assets: AssetLookup,
    private readonly models: ModelLookup,
  ) {}

  public resolve(request: GenerationRequest): ResolvedGenerationRequest {
    const model = this.models
      .listForProvider(request.providerId)
      .find((candidate) => candidate.modelId === request.modelId);
    if (!model) {
      throw new GenerationInputError(
        'model_not_found',
        `Model ${request.modelId} was not found for Provider ${request.providerId}.`,
      );
    }
    if (!model.enabled) {
      throw new GenerationInputError('model_disabled', `Model ${request.modelId} is disabled.`);
    }
    const parsedCapabilities = RelevantCapabilitiesSchema.safeParse(model.capabilities);
    if (!parsedCapabilities.success) {
      throw new GenerationInputError(
        'model_capabilities_invalid',
        `Model ${request.modelId} has invalid input capabilities.`,
      );
    }
    const capabilities = parsedCapabilities.data;
    if (!capabilities.operations.includes(request.operation)) {
      throw new GenerationInputError(
        'operation_not_supported',
        `Model ${request.modelId} does not support ${request.operation}.`,
      );
    }

    this.validateCardinality(request, capabilities);
    const seenAssetIds = new Set<string>();
    const inputs = request.inputs.map((input) => {
      if (seenAssetIds.has(input.assetId)) {
        throw new GenerationInputError(
          'asset_input_duplicate',
          `Asset ${input.assetId} is included more than once.`,
        );
      }
      seenAssetIds.add(input.assetId);
      const asset = this.assets.get(input.assetId);
      if (!asset || asset.deletedAt !== null) {
        throw new GenerationInputError(
          'asset_input_not_found',
          `Input Asset ${input.assetId} was not found.`,
        );
      }
      this.validateImage(asset, capabilities.inputImageConstraints);
      return { input, asset };
    });

    this.validateMaskRelationship(request, inputs);
    return { request, model, inputs };
  }

  private validateCardinality(
    request: GenerationRequest,
    capabilities: z.infer<typeof RelevantCapabilitiesSchema>,
  ): void {
    const count = (role: GenerationRequest['inputs'][number]['role']) =>
      request.inputs.filter((input) => input.role === role).length;
    const references = count('reference');
    const maxReferences = capabilities.maxReferenceImages ?? 0;
    if (references > maxReferences) {
      throw new GenerationInputError(
        'reference_limit_exceeded',
        `Model ${request.modelId} accepts at most ${maxReferences} reference image(s).`,
      );
    }

    if (request.operation === 'image.generate') {
      if (request.inputs.some((input) => input.role !== 'reference')) {
        throw new GenerationInputError(
          'input_role_not_allowed',
          'image.generate only accepts reference image inputs.',
        );
      }
      return;
    }
    if (request.operation === 'video.generate') {
      if (request.inputs.length > 0) {
        throw new GenerationInputError(
          'input_role_not_allowed',
          'video.generate does not accept input assets.',
        );
      }
      return;
    }
    if (request.operation === 'video.image_to_video') {
      if (count('first_frame') !== 1 || request.inputs.some((input) => input.role !== 'first_frame')) {
        throw new GenerationInputError(
          'source_input_required',
          'video.image_to_video requires exactly one first_frame image.',
        );
      }
      return;
    }
    if (request.operation === 'video.reference_to_video') {
      if (references < 1 || request.inputs.some((input) => input.role !== 'reference')) {
        throw new GenerationInputError(
          'input_role_not_allowed',
          'video.reference_to_video requires reference image inputs only.',
        );
      }
      return;
    }
    if (request.operation === 'video.edit' || request.operation === 'video.extend') {
      throw new GenerationInputError(
        'input_role_not_allowed',
        `${request.operation} is not supported by the current video input runtime.`,
      );
    }
    if (request.operation !== 'image.edit') return;

    if (count('source') !== 1) {
      throw new GenerationInputError(
        'source_input_required',
        'image.edit requires exactly one source image.',
      );
    }
    if (
      count('mask') > 1 ||
      count('first_frame') > 0 ||
      count('last_frame') > 0
    ) {
      throw new GenerationInputError(
        'input_role_not_allowed',
        'image.edit accepts one source, references, and at most one mask.',
      );
    }
    if (count('mask') > 0 && capabilities.supportsMask !== true) {
      throw new GenerationInputError('mask_not_supported', `Model ${request.modelId} does not support masks.`);
    }
  }

  private validateImage(
    asset: AssetRecord,
    constraints: z.infer<typeof ImageInputConstraintsSchema> | undefined,
  ): void {
    if (asset.type !== 'image') {
      throw new GenerationInputError(
        'asset_input_not_image',
        `Input Asset ${asset.id} is not an image.`,
      );
    }
    if (asset.width === null || asset.height === null || asset.width < 1 || asset.height < 1) {
      throw new GenerationInputError(
        'image_dimensions_missing',
        `Input Asset ${asset.id} has no validated image dimensions.`,
      );
    }
    if (!constraints) return;
    const acceptedMimeTypes = constraints.mimeTypes?.map(normalizeMimeType);
    if (
      acceptedMimeTypes &&
      !acceptedMimeTypes.includes(normalizeMimeType(asset.mimeType))
    ) {
      throw new GenerationInputError(
        'image_mime_unsupported',
        `Input Asset ${asset.id} has an unsupported image MIME type.`,
      );
    }
    if (
      (constraints.maxBytes !== undefined && asset.fileSize > constraints.maxBytes) ||
      (constraints.maxWidth !== undefined && asset.width > constraints.maxWidth) ||
      (constraints.maxHeight !== undefined && asset.height > constraints.maxHeight) ||
      (constraints.maxPixels !== undefined && asset.width * asset.height > constraints.maxPixels)
    ) {
      throw new GenerationInputError(
        'image_input_too_large',
        `Input Asset ${asset.id} exceeds the model input limits.`,
      );
    }
  }

  private validateMaskRelationship(
    request: GenerationRequest,
    inputs: readonly ResolvedGenerationInput[],
  ): void {
    if (request.operation !== 'image.edit') return;
    const source = inputs.find((input) => input.input.role === 'source')?.asset;
    const mask = inputs.find((input) => input.input.role === 'mask')?.asset;
    if (!mask) return;
    if (!source) {
      throw new GenerationInputError('mask_source_required', 'A mask requires a source image.');
    }
    if (mask.role !== 'mask' || normalizeMimeType(mask.mimeType) !== 'image/png') {
      throw new GenerationInputError(
        'mask_type_invalid',
        'Mask inputs must reference a persisted PNG mask Asset.',
      );
    }
    if (
      mask.parentAssetId !== source.id ||
      mask.width !== source.width ||
      mask.height !== source.height
    ) {
      throw new GenerationInputError(
        'mask_parent_mismatch',
        'Mask parent and dimensions must match the source image.',
      );
    }
  }
}
