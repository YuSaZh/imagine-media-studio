import { DEFAULT_IMAGE_INPUT_POLICY, type ImageInputPolicy, type JsonValue, type JsonObject, type ModelDto } from "@imagine/shared";
import { parseAspectRatio } from "../gallery/model/aspect-ratio";
import type { FixtureMediaOperation, FixtureAspectRatio, FixtureDurationRange, FixtureModel } from "../gallery/model/types";
interface GalleryModel extends FixtureModel { providerId: string; }

const knownOperations = new Set<FixtureMediaOperation>([
  'image.generate',
  'image.edit',
  'video.generate',
  'video.image_to_video',
  'video.reference_to_video',
]);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object';
}

function stringArray(value: JsonValue | undefined, maximumLength = 64): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'string') return [];
    const normalized = item.trim();
    return normalized.length > 0 && normalized.length <= maximumLength &&
      ![...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
      ? [normalized]
      : [];
  });
}

function aspectRatioArray(value: JsonValue | undefined): readonly FixtureAspectRatio[] {
  return [...new Set(stringArray(value, 32).flatMap((item) => {
    const ratio = parseAspectRatio(item);
    return ratio ? [ratio] : [];
  }))];
}

function numberArray(value: JsonValue | undefined): readonly number[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item > 0,
    );
  }
  return [];
}

function durationRange(value: JsonValue | undefined): FixtureDurationRange | undefined {
  if (!isObject(value)) return undefined;
  const min = value.min;
  const max = value.max;
  const step = value.step ?? 1;
  if (
    typeof min !== 'number' || !Number.isSafeInteger(min) || min <= 0 ||
    typeof max !== 'number' || !Number.isSafeInteger(max) || max < min ||
    typeof step !== 'number' || !Number.isSafeInteger(step) || step <= 0
  ) return undefined;
  return { min, max, step };
}

function positiveInteger(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedImageLimit(value: JsonValue | undefined, fallback: number): number {
  return Math.min(positiveInteger(value, fallback), fallback);
}

function mapImageInputPolicy(capabilities: JsonObject, maxReferenceImages: number): ImageInputPolicy {
  const constraints = isObject(capabilities.inputImageConstraints)
    ? capabilities.inputImageConstraints
    : {};
  const declaredMimeTypes = stringArray(constraints.mimeTypes).map((mime) => mime.trim().toLowerCase());
  const allowedMimeTypes = declaredMimeTypes.length === 0
    ? DEFAULT_IMAGE_INPUT_POLICY.allowedMimeTypes
    : DEFAULT_IMAGE_INPUT_POLICY.allowedMimeTypes.filter((mime) => declaredMimeTypes.includes(mime));
  return {
    allowedMimeTypes,
    maxCount: Math.min(DEFAULT_IMAGE_INPUT_POLICY.maxCount, maxReferenceImages),
    maxFileBytes: boundedImageLimit(constraints.maxBytes, DEFAULT_IMAGE_INPUT_POLICY.maxFileBytes),
    maxTotalBytes: DEFAULT_IMAGE_INPUT_POLICY.maxTotalBytes,
    maxPixels: boundedImageLimit(constraints.maxPixels, DEFAULT_IMAGE_INPUT_POLICY.maxPixels),
    maxWidth: boundedImageLimit(constraints.maxWidth, DEFAULT_IMAGE_INPUT_POLICY.maxWidth),
    maxHeight: boundedImageLimit(constraints.maxHeight, DEFAULT_IMAGE_INPUT_POLICY.maxHeight),
  };
}

export function mapInternalModel(model: ModelDto): GalleryModel {
  const capabilities = model.capabilities;
  const operations = stringArray(capabilities.operations).filter(
    (operation): operation is FixtureMediaOperation => knownOperations.has(operation as FixtureMediaOperation),
  );
  const mediaKind = operations.some((operation) => operation.startsWith('video.'))
    ? 'video'
    : 'image';
  const aspectRatios = aspectRatioArray(capabilities.aspectRatios);
  const durations = numberArray(capabilities.durations);
  const range = durationRange(capabilities.durations);
  const supportsBatchCount = capabilities.supportsBatchCount === true;
  const maxReferenceImages = positiveInteger(capabilities.maxReferenceImages, 0);
  return {
    id: model.modelId,
    providerId: model.providerId,
    displayName: model.displayName,
    mediaKind,
    capabilities: {
      operations,
      aspectRatios: aspectRatios.length > 0 ? aspectRatios : ['1:1'],
      resolutions: stringArray(capabilities.resolutions),
      durations,
      ...(range ? { durationRange: range } : {}),
      maxReferenceImages,
      supportsMask: capabilities.supportsMask === true,
      supportsProgress: capabilities.supportsProgress === true,
      supportsCancel: capabilities.supportsCancel === true,
      supportsBatchCount,
      maxBatchCount: supportsBatchCount ? positiveInteger(capabilities.maxBatchCount, 1) : 1,
      inputImagePolicy: mapImageInputPolicy(capabilities, maxReferenceImages),
    },
  };
}
