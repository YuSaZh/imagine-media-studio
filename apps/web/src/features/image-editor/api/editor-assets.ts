import { DEFAULT_IMAGE_INPUT_POLICY } from '@imagine/shared';
import type { AssetDto, MaskDocument } from '@imagine/shared';

import { internalClient } from '../../../api/internal-client.js';
import {
  createBrowserCanvasPngEncoder,
  exportMaskPng,
} from '../browser/png-exporter.js';
import type { PngEncoderPort } from '../browser/png-exporter.js';
import {
  createBrowserImageBitmapDecoder,
  loadSourceContent,
} from '../browser/source-content.js';
import type {
  ImageBitmapDecoderPort,
  LoadedSourceContent,
} from '../browser/source-content.js';
import { MAX_IMAGE_EDITOR_NATURAL_PIXELS } from '../model/limits.js';

export interface EditorAssetClientPort {
  getAsset(assetId: string): Promise<{ readonly asset: AssetDto }>;
  uploadAsset(
    file: File,
    fields: { readonly parentAssetId?: string; readonly role?: string },
    options: { readonly signal?: AbortSignal },
  ): Promise<{ readonly asset: AssetDto }>;
}

export interface EditorFetchPort {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface LoadEditorAssetDependencies {
  readonly client?: Pick<EditorAssetClientPort, 'getAsset'>;
  readonly decoder?: ImageBitmapDecoderPort;
  readonly fetch?: EditorFetchPort;
}

export interface UploadEditorMaskDependencies {
  readonly client?: Pick<EditorAssetClientPort, 'uploadAsset'>;
  readonly document?: Pick<Document, 'createElement'>;
  readonly encoder?: PngEncoderPort;
}

export interface LoadedEditorAsset {
  readonly asset: AssetDto;
  readonly source: LoadedSourceContent;
}

export type ImageEditorAssetApiErrorCode =
  | 'asset_content_url_forbidden'
  | 'asset_dimensions_missing'
  | 'asset_identity_mismatch'
  | 'asset_mime_invalid'
  | 'asset_not_image'
  | 'asset_not_persisted'
  | 'asset_pixels_exceeded'
  | 'asset_request_failed'
  | 'content_bytes_exceeded'
  | 'content_decode_failed'
  | 'content_dimensions_mismatch'
  | 'content_empty'
  | 'content_fetch_failed'
  | 'content_length_invalid'
  | 'content_mime_mismatch'
  | 'content_response_not_ok'
  | 'mask_empty'
  | 'mask_export_failed'
  | 'mask_upload_contract_mismatch'
  | 'mask_upload_failed'
  | 'unsupported_browser_encoder';

export class ImageEditorAssetApiError extends Error {
  public override readonly name = 'ImageEditorAssetApiError';

  public constructor(
    public readonly code: ImageEditorAssetApiErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function normalizedMimeType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function expectedContentUrl(assetId: string): string {
  return `/internal/assets/${encodeURIComponent(assetId)}/content`;
}

function validatePersistedImageAsset(asset: AssetDto, requestedId?: string): {
  readonly height: number;
  readonly mimeType: string;
  readonly width: number;
} {
  if (requestedId !== undefined && asset.id !== requestedId) {
    throw new ImageEditorAssetApiError(
      'asset_identity_mismatch',
      'The asset response does not match the requested asset.',
    );
  }
  if (asset.type !== 'image') {
    throw new ImageEditorAssetApiError('asset_not_image', 'Only image assets can be edited.');
  }
  if (asset.fileSize <= 0) {
    throw new ImageEditorAssetApiError(
      'asset_not_persisted',
      'The image asset does not reference persisted content.',
    );
  }
  if (asset.width === null || asset.height === null) {
    throw new ImageEditorAssetApiError(
      'asset_dimensions_missing',
      'The image asset is missing persisted dimensions.',
    );
  }
  if (asset.width > Math.floor(MAX_IMAGE_EDITOR_NATURAL_PIXELS / asset.height)) {
    throw new ImageEditorAssetApiError(
      'asset_pixels_exceeded',
      `Image assets cannot exceed ${MAX_IMAGE_EDITOR_NATURAL_PIXELS} pixels in the editor.`,
    );
  }
  const mimeType = normalizedMimeType(asset.mimeType);
  if (!DEFAULT_IMAGE_INPUT_POLICY.allowedMimeTypes.includes(mimeType)) {
    throw new ImageEditorAssetApiError(
      'asset_mime_invalid',
      `Image MIME type ${mimeType || '(empty)'} is not supported by the editor.`,
    );
  }
  if (asset.contentUrl !== expectedContentUrl(asset.id)) {
    throw new ImageEditorAssetApiError(
      'asset_content_url_forbidden',
      'Asset content must use its same-origin internal content path.',
    );
  }
  return { height: asset.height, mimeType, width: asset.width };
}

function waitForAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

function parseContentLength(response: Response): number | null {
  const value = response.headers.get('content-length');
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ImageEditorAssetApiError(
      'content_length_invalid',
      'Asset content length is malformed.',
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new ImageEditorAssetApiError(
      'content_length_invalid',
      'Asset content length is outside the supported range.',
    );
  }
  return length;
}

function assertContentBytes(bytes: number, declaredBytes: number): void {
  if (bytes === 0) {
    throw new ImageEditorAssetApiError('content_empty', 'Asset content is empty.');
  }
  if (bytes > declaredBytes || bytes > DEFAULT_IMAGE_INPUT_POLICY.maxFileBytes) {
    throw new ImageEditorAssetApiError(
      'content_bytes_exceeded',
      'Asset content exceeds its declared or editor byte limit.',
    );
  }
}

function defaultFetch(input: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export async function loadEditorAsset(
  assetId: string,
  signal: AbortSignal,
  dependencies: LoadEditorAssetDependencies = {},
): Promise<LoadedEditorAsset> {
  signal.throwIfAborted();
  const client = dependencies.client ?? internalClient;
  let response: { readonly asset: AssetDto };
  try {
    response = await waitForAbortable(client.getAsset(assetId), signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new ImageEditorAssetApiError(
      'asset_request_failed',
      'The editor asset metadata could not be loaded.',
      { cause: error },
    );
  }
  const dimensions = validatePersistedImageAsset(response.asset, assetId);
  const fetchPort = dependencies.fetch ?? defaultFetch;
  let contentResponse: Response;
  try {
    contentResponse = await fetchPort(response.asset.contentUrl, {
      credentials: 'same-origin',
      headers: { Accept: dimensions.mimeType },
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new ImageEditorAssetApiError(
      'content_fetch_failed',
      'The persisted image content could not be fetched.',
      { cause: error },
    );
  }
  if (!contentResponse.ok) {
    throw new ImageEditorAssetApiError(
      'content_response_not_ok',
      `The persisted image request failed with status ${contentResponse.status}.`,
    );
  }
  const responseMimeType = normalizedMimeType(contentResponse.headers.get('content-type') ?? '');
  if (responseMimeType !== dimensions.mimeType) {
    throw new ImageEditorAssetApiError(
      'content_mime_mismatch',
      'Persisted image MIME type does not match its asset metadata.',
    );
  }
  const contentLength = parseContentLength(contentResponse);
  if (contentLength !== null) assertContentBytes(contentLength, response.asset.fileSize);

  let content: Blob;
  try {
    content = await contentResponse.blob();
  } catch (error) {
    signal.throwIfAborted();
    throw new ImageEditorAssetApiError(
      'content_fetch_failed',
      'The persisted image response body could not be read.',
      { cause: error },
    );
  }
  signal.throwIfAborted();
  assertContentBytes(content.size, response.asset.fileSize);
  if (normalizedMimeType(content.type) !== dimensions.mimeType) {
    throw new ImageEditorAssetApiError(
      'content_mime_mismatch',
      'Persisted image Blob MIME type does not match its asset metadata.',
    );
  }
  const normalizedContent = content.type === dimensions.mimeType
    ? content
    : content.slice(0, content.size, dimensions.mimeType);

  let source: LoadedSourceContent;
  try {
    source = await loadSourceContent(normalizedContent, {
      decoder: dependencies.decoder ?? createBrowserImageBitmapDecoder(),
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new ImageEditorAssetApiError(
      'content_decode_failed',
      'The persisted image content could not be decoded.',
      { cause: error },
    );
  }
  if (
    source.naturalSize.width !== dimensions.width ||
    source.naturalSize.height !== dimensions.height
  ) {
    source.dispose();
    throw new ImageEditorAssetApiError(
      'content_dimensions_mismatch',
      'Decoded image dimensions do not match its asset metadata.',
    );
  }
  return Object.freeze({ asset: response.asset, source });
}

function defaultPngEncoder(documentPort: Pick<Document, 'createElement'> | undefined): PngEncoderPort {
  const resolvedDocument = documentPort ?? globalThis.document;
  if (!resolvedDocument) {
    throw new ImageEditorAssetApiError(
      'unsupported_browser_encoder',
      'The browser canvas PNG encoder is unavailable.',
    );
  }
  return createBrowserCanvasPngEncoder(resolvedDocument);
}

function assertUploadedMask(asset: AssetDto, sourceAsset: AssetDto): void {
  try {
    validatePersistedImageAsset(asset);
  } catch (error) {
    throw new ImageEditorAssetApiError(
      'mask_upload_contract_mismatch',
      'The uploaded Mask asset does not match the source image contract.',
      { cause: error },
    );
  }
  if (
    asset.type !== 'image' ||
    asset.role !== 'mask' ||
    asset.parentAssetId !== sourceAsset.id ||
    normalizedMimeType(asset.mimeType) !== 'image/png' ||
    asset.width !== sourceAsset.width ||
    asset.height !== sourceAsset.height
  ) {
    throw new ImageEditorAssetApiError(
      'mask_upload_contract_mismatch',
      'The uploaded Mask asset does not match the source image contract.',
    );
  }
}

export async function uploadEditorMask(
  input: {
    readonly document: MaskDocument;
    readonly signal: AbortSignal;
    readonly sourceAsset: AssetDto;
  },
  dependencies: UploadEditorMaskDependencies = {},
): Promise<AssetDto> {
  input.signal.throwIfAborted();
  const dimensions = validatePersistedImageAsset(input.sourceAsset);
  let png: Blob;
  try {
    png = await exportMaskPng({
      encoder: dependencies.encoder ?? defaultPngEncoder(dependencies.document),
      mask: input.document,
      signal: input.signal,
      sourceSize: { height: dimensions.height, width: dimensions.width },
    });
  } catch (error) {
    input.signal.throwIfAborted();
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'empty_mask') {
      throw new ImageEditorAssetApiError('mask_empty', 'The Mask has no edited area.', {
        cause: error,
      });
    }
    if (error instanceof ImageEditorAssetApiError) throw error;
    throw new ImageEditorAssetApiError('mask_export_failed', 'The Mask PNG could not be exported.', {
      cause: error,
    });
  }
  const file = new File([png], 'mask.png', { lastModified: 0, type: 'image/png' });
  const client = dependencies.client ?? internalClient;
  let response: { readonly asset: AssetDto };
  try {
    response = await client.uploadAsset(
      file,
      { parentAssetId: input.sourceAsset.id, role: 'mask' },
      { signal: input.signal },
    );
  } catch (error) {
    input.signal.throwIfAborted();
    throw new ImageEditorAssetApiError('mask_upload_failed', 'The Mask asset could not be uploaded.', {
      cause: error,
    });
  }
  assertUploadedMask(response.asset, input.sourceAsset);
  return response.asset;
}
