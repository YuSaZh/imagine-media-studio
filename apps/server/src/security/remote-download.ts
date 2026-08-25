import type { IncomingHttpHeaders } from 'node:http';

import {
  discardStagedFile,
  stageReadable,
  type StagedFile,
} from '../storage/atomic-file.js';
import { detectAllowedMedia, type AllowedMediaType } from '../media/mime.js';
import type { MediaKind } from '../media/types.js';
import { RemoteHttpError, type SafeHttpTransport } from './safe-http-transport.js';

export interface RemoteDownloadOptions {
  claimedMimeType?: string;
  dataRoot: string;
  expectedKind?: MediaKind;
  headers?: Readonly<Record<string, string>>;
  maxBytes: number;
  signal?: AbortSignal;
  temporaryDirectory: string;
  url: string;
}

export interface RemoteDownloadResult {
  finalUrl: URL;
  mediaType: AllowedMediaType;
  staged: StagedFile;
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseContentLength(headers: IncomingHttpHeaders): number | null {
  const value = singleHeader(headers, 'content-length');
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new RemoteHttpError('Remote Content-Length is invalid.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RemoteHttpError('Remote Content-Length is invalid.');
  return parsed;
}

export class RemoteMediaDownloader {
  public constructor(private readonly transport: SafeHttpTransport) {}

  public async download(options: RemoteDownloadOptions): Promise<RemoteDownloadResult> {
    const response = await this.transport.fetch(options.url, {
      headers: { Accept: 'image/*, video/*', ...(options.headers ?? {}) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let staged: StagedFile | null = null;
    try {
      if (response.statusCode !== 200) {
        throw new RemoteHttpError(`Remote media request returned HTTP ${response.statusCode}.`);
      }
      const encoding = singleHeader(response.headers, 'content-encoding');
      if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
        throw new RemoteHttpError('Compressed remote media responses are not accepted.');
      }
      const contentLength = parseContentLength(response.headers);
      if (contentLength !== null && contentLength > options.maxBytes) {
        throw new RemoteHttpError(`Remote media exceeds the ${options.maxBytes} byte limit.`);
      }

      staged = await stageReadable({
        dataRoot: options.dataRoot,
        maxBytes: options.maxBytes,
        source: response.body,
        temporaryDirectory: options.temporaryDirectory,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const claimedMimeType =
        options.claimedMimeType ?? singleHeader(response.headers, 'content-type');
      const mediaType = await detectAllowedMedia(staged.prefix, {
        ...(claimedMimeType === undefined ? {} : { claimedMimeType }),
        ...(options.expectedKind === undefined ? {} : { expectedKind: options.expectedKind }),
      });
      return { finalUrl: response.url, mediaType, staged };
    } catch (error) {
      if (staged !== null) await discardStagedFile(staged);
      throw error;
    } finally {
      await response.dispose().catch(() => undefined);
    }
  }
}
