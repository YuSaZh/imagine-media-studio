import sharp from 'sharp';
import { MASK_OVERLAY_COLOR, type GenerationRequest } from '@imagine/shared';
import type { ProviderInput } from '@imagine/provider-contract';
import { createHash } from 'node:crypto';

const MAX_PIXELS = 16_777_216;
export async function prepareMaskedInputs(request: GenerationRequest, inputs: readonly ProviderInput[], maxBytes: number, maxTotalBytes: number, signal?: AbortSignal): Promise<readonly ProviderInput[]> {
  const policy = request.maskProcessing;
  if (!policy) return inputs; // Previously queued tasks keep their original behavior.
  const source = inputs.find(input => input.assetId === policy.sourceAssetId && input.role !== 'mask');
  const masks = inputs.filter(input => input.role === 'mask');
  const mask = masks[0];
  if (!source || masks.length !== 1 || !mask || mask.parentAssetId !== source.assetId || mask.mimeType !== 'image/png' || mask.width !== source.width || mask.height !== source.height) throw new Error('蒙版与原图关联或尺寸不匹配');
  if (policy.mode === 'native') return inputs;
  signal?.throwIfAborted();
  const options = { limitInputPixels: MAX_PIXELS, failOn: 'error' as const };
  const { data, info } = await sharp(mask.bytes, options).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4 || info.width !== source.width || info.height !== source.height) throw new Error('蒙版像素尺寸无效');
  const color = MASK_OVERLAY_COLOR;
  let edited = false;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (offset % 262144 === 0) signal?.throwIfAborted();
    const alpha = Math.round((255 - data[offset + 3]!) * color.alpha / 255);
    edited ||= alpha > 0;
    data[offset] = color.red; data[offset + 1] = color.green; data[offset + 2] = color.blue; data[offset + 3] = alpha;
  }
  if (!edited) throw new Error('蒙版没有可编辑区域');
  const pipeline = sharp(source.bytes, options).autoOrient().composite([{ input: data, raw: { width: info.width, height: info.height, channels: 4 } }]);
  const result = await (policy.outputMimeType === 'image/jpeg' ? pipeline.jpeg({ quality: 95 }) : policy.outputMimeType === 'image/webp' ? pipeline.webp({ lossless: true }) : pipeline.png()).toBuffer({ resolveWithObject: true });
  signal?.throwIfAborted();
  if (result.info.width !== source.width || result.info.height !== source.height) throw new Error('合成图片尺寸与原图不一致');
  if (result.data.length > Math.min(maxBytes, policy.maxOutputBytes ?? Infinity) || result.data.length + inputs.filter(input => input !== source && input !== mask).reduce((sum, input) => sum + input.bytes.length, 0) > maxTotalBytes) throw new Error('合成图片超过模型或应用的输入大小限制');
  // A public URL for the unmodified original must never shadow composite bytes.
  const { publicUrl: _publicUrl, ...original } = source;
  const prepared: ProviderInput = { ...original, bytes: result.data, mimeType: policy.outputMimeType, filename: `masked-source.${policy.outputMimeType.split('/')[1]}`, fileSize: result.data.length, sha256: createHash('sha256').update(result.data).digest('hex') };
  return inputs.filter(input => input !== mask).map(input => input === source ? prepared : input);
}
