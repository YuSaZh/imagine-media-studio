import type { ModelCapabilities } from '@imagine/provider-contract';
import { COMPATIBLE_MODEL_IDENTITIES, compatibleModelIdentity, ModelCapabilitiesSchema, imageDimensionsAllowed } from '@imagine/shared';

const imageSizes = ['1024x1024', '1024x768', '768x1024', '1280x720', '720x1280', '2048x2048', '2048x1536', '1536x2048', '2560x1440', '1440x2560', '3072x3072', '3840x2160', '2160x3840', '3840x3840'];
const ratios = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

function imageCapabilities(id: string): ModelCapabilities {
  const mai = id.startsWith('MAI-');
  const textOnly = id === 'MAI-Image-2' || id === 'MAI-Image-2e';
  const pro = id === 'dola-seedream-5-0-pro-260628';
  const large = id === 'doubao-seedream-4-5-251128' || id === 'doubao-seedream-5-0-260128';
  const dimensions = mai ? { minWidth: 768, minHeight: 768, maxPixels: 1048576 }
    : { minPixels: large ? 3686400 : 921600, maxPixels: pro ? 4624220 : 16777216, maxAspectRatio: 16 };
  const maxImages = textOnly ? 0 : mai ? 1 : pro ? 10 : 14;
  const formats = mai ? ['png'] : id === 'doubao-seedream-4-0-250828' || id === 'doubao-seedream-4-5-251128' ? ['jpeg'] : ['png', 'jpeg'];
  return ModelCapabilitiesSchema.parse({ profile: 'openai-images-v1',
    operations: textOnly ? ['image.generate'] : ['image.generate', 'image.edit'],
    maxReferenceImages: maxImages, supportsMask: false,
    operationPolicies: { 'image.generate': { maxReferenceImages: 0, inputRoles: [] }, ...(textOnly ? {} : { 'image.edit': { maxReferenceImages: maxImages - 1, inputRoles: ['source', 'reference'] } }) },
    aspectRatios: mai ? ['auto', '1:1', '4:3', '3:4'] : ratios,
    imageResolution: { mode: 'pixels', values: ['auto', ...imageSizes.filter(size => imageDimensionsAllowed(size, dimensions))], allowCustomDimensions: true, dimensions },
    supportsBatchCount: false, maxBatchCount: 1,
    inputImageConstraints: { mimeTypes: mai ? ['image/jpeg', 'image/png'] : ['image/jpeg', 'image/png', 'image/webp'], ...(mai ? {} : { maxBytes: 30 * 1024 * 1024, maxPixels: 36000000 }) },
    customFields: { type: 'object', properties: { output_format: formats.length === 1 ? { const: formats[0] } : { type: 'string', enum: formats } }, additionalProperties: false },
  }) as ModelCapabilities;
}

function videoCapabilities(id: string): ModelCapabilities {
  const legacy = id.includes('-1-0-'), lite = id.includes('-lite-'), v15 = id.includes('-1-5-');
  const generate = !id.includes('-lite-i2v-'), firstFrame = !id.includes('-lite-t2v-');
  const operations = [...(generate ? ['video.generate'] : []), ...(firstFrame ? ['video.image_to_video'] : [])];
  const durations = { min: legacy ? 2 : 4, max: legacy || v15 ? 12 : id.includes('-2-5-') ? 30 : 15 };
  // 4K in the LAS enhanced operator is not a guarantee of native model output.
  const resolutions = !lite && !v15 && (legacy || id === 'dreamina-seedance-2-0-260128') ? ['480p', '720p', '1080p'] : ['480p', '720p'];
  const aspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
  return ModelCapabilitiesSchema.parse({ profile: 'openai-videos-v1-compatible', operations, durations, resolutions, aspectRatios,
    maxReferenceImages: firstFrame ? 1 : 0, supportsMask: false, supportsAudio: false, supportsSeed: false, supportsNegativePrompt: false,
    supportsProgress: true, supportsCancel: false, supportsBatchCount: false, maxBatchCount: 1,
    inputImageConstraints: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 30 * 1024 * 1024, maxWidth: 6000, maxHeight: 6000 },
    operationPolicies: Object.fromEntries(operations.map(operation => [operation, { durations, resolutions, aspectRatios, inputRoles: operation === 'video.image_to_video' ? ['first_frame'] : [], maxReferenceImages: operation === 'video.image_to_video' ? 1 : 0,
      unsupportedParameters: ['audio', 'seed', 'negativePrompt', 'fps', 'quality', 'format'] }])),
    customFields: { type: 'object', properties: {}, additionalProperties: false },
  }) as ModelCapabilities;
}

export function compatibleModelCapabilities(modelId: string, profile: string): ModelCapabilities | undefined {
  const model = compatibleModelIdentity(modelId);
  if (!model || profile !== (model.kind === 'image' ? 'openai-images-v1' : 'openai-videos-v1-compatible')) return undefined;
  return model.kind === 'image' ? imageCapabilities(model.id) : videoCapabilities(model.id);
}
export function compatibleCatalog(profile: string) {
  return COMPATIBLE_MODEL_IDENTITIES.flatMap(model => {
    const capabilities = compatibleModelCapabilities(model.id, profile);
    return capabilities ? [{ id: model.id, displayName: model.name, capabilities }] : [];
  });
}
