import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { assertNoSymlinkTraversal, toStoredPath } from './path-safety.js';

const DEFAULT_PREFIX_BYTES = 8_192;

export class AtomicFileTooLargeError extends Error {
  public override readonly name = 'AtomicFileTooLargeError';
}

export interface StagedFile {
  bytes: number;
  prefix: Buffer;
  sha256: string;
  temporaryPath: string;
}

export interface StageReadableOptions {
  dataRoot: string;
  maxBytes: number;
  prefixBytes?: number;
  signal?: AbortSignal;
  source: Readable;
  temporaryDirectory: string;
}

function abortError(): Error {
  const error = new Error('Media write was aborted.');
  error.name = 'AbortError';
  return error;
}

export async function stageReadable(options: StageReadableOptions): Promise<StagedFile> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer.');
  }

  const prefixLimit = options.prefixBytes ?? DEFAULT_PREFIX_BYTES;
  if (!Number.isSafeInteger(prefixLimit) || prefixLimit < 0) {
    throw new RangeError('prefixBytes must be a non-negative safe integer.');
  }
  toStoredPath(options.dataRoot, options.temporaryDirectory);
  await mkdir(options.temporaryDirectory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(options.dataRoot, options.temporaryDirectory, false);
  const temporaryPath = join(options.temporaryDirectory, `ims-${randomUUID()}.part`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  const hash = createHash('sha256');
  const prefixChunks: Buffer[] = [];
  let prefixLength = 0;
  let bytes = 0;

  const onAbort = () => options.source.destroy(abortError());
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    options.signal?.throwIfAborted();
    for await (const value of options.source) {
      options.signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        throw new AtomicFileTooLargeError(`Media exceeds the ${options.maxBytes} byte limit.`);
      }
      hash.update(chunk);
      if (prefixLength < prefixLimit) {
        const part = chunk.subarray(0, prefixLimit - prefixLength);
        prefixChunks.push(part);
        prefixLength += part.byteLength;
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          null,
        );
        if (bytesWritten === 0) throw new Error('Media write made no progress.');
        offset += bytesWritten;
      }
    }
    options.signal?.throwIfAborted();
    await handle.sync();
    await handle.close();

    return {
      bytes,
      prefix: Buffer.concat(prefixChunks, prefixLength),
      sha256: hash.digest('hex'),
      temporaryPath,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function commitStagedFile(
  dataRoot: string,
  staged: StagedFile,
  destinationPath: string,
): Promise<void> {
  toStoredPath(dataRoot, destinationPath);
  await assertNoSymlinkTraversal(dataRoot, dirname(destinationPath), true);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await assertNoSymlinkTraversal(dataRoot, dirname(destinationPath), false);
  await assertNoSymlinkTraversal(dataRoot, destinationPath, true);
  await link(staged.temporaryPath, destinationPath);
  await rm(staged.temporaryPath, { force: true }).catch(() => undefined);
}

export async function discardStagedFile(staged: StagedFile): Promise<void> {
  await rm(staged.temporaryPath, { force: true });
}

export async function stageBuffer(
  options: Omit<StageReadableOptions, 'source'> & { bytes: Uint8Array },
): Promise<StagedFile> {
  return stageReadable({ ...options, source: Readable.from(options.bytes) });
}
