import { describe, expect, it, vi } from 'vitest';

import { fileFingerprint } from './acquisition.js';
import { UploadController } from './upload-controller.js';
import type { AcquiredImage } from './types.js';

function input(index: number): AcquiredImage {
  const file = new File([`image-${index}`], `${index}.png`, { type: 'image/png' });
  return { clientId: `client-${index}`, file, fingerprint: fileFingerprint(file) };
}

describe('UploadController', () => {
  it('limits active uploads to two and drains the queue', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const transitions: string[] = [];
    const upload = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { assetId: `asset-${releases.length}` };
    });
    const controller = new UploadController({
      concurrency: 2,
      onTransition: (action) => transitions.push(action.type),
      upload,
    });
    controller.enqueue([input(1), input(2), input(3)]);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(transitions.filter((item) => item === 'ready')).toHaveLength(3));
    expect(maximum).toBe(2);
  });

  it('aborts removal and supports retry after an error', async () => {
    const transitions: string[] = [];
    let fail = true;
    const upload = vi.fn(async (_file: File, signal: AbortSignal) => {
      if (fail) throw new Error('upload failed');
      await Promise.resolve();
      signal.throwIfAborted();
      return { assetId: 'asset-ready' };
    });
    const controller = new UploadController({
      onTransition: (action) => transitions.push(action.type),
      upload,
    });
    controller.enqueue([input(1)]);
    await vi.waitFor(() => expect(transitions).toContain('error'));
    fail = false;
    controller.retry('client-1');
    await vi.waitFor(() => expect(transitions).toContain('ready'));

    const blocking = new UploadController({
      onTransition: (action) => transitions.push(action.type),
      upload: async (_file, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    });
    blocking.enqueue([input(2)]);
    blocking.remove('client-2');
    await vi.waitFor(() => expect(transitions).toContain('remove'));
    expect(transitions.at(-1)).toBe('remove');
  });

  it('aborts every active upload when disposed', async () => {
    const aborted: string[] = [];
    const controller = new UploadController({
      onTransition: () => undefined,
      upload: async (file, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(file.name);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    });
    controller.enqueue([input(1), input(2), input(3)]);
    await vi.waitFor(() => expect(aborted).toHaveLength(0));
    controller.dispose();
    await vi.waitFor(() => expect(aborted).toEqual(['1.png', '2.png']));
  });

  it('surfaces preprocessing failures and preprocesses again on retry', async () => {
    const transitions: string[] = [];
    let shouldFail = true;
    const prepare = vi.fn(async (file: File) => {
      if (shouldFail) throw new Error('Image preprocessing failed.');
      return file;
    });
    const upload = vi.fn(async () => ({ assetId: 'asset-after-retry' }));
    const controller = new UploadController({
      onTransition: (action) => transitions.push(action.type),
      prepare,
      upload,
    });

    controller.enqueue([input(1)]);
    await vi.waitFor(() => expect(transitions).toContain('error'));
    expect(upload).not.toHaveBeenCalled();
    shouldFail = false;
    controller.retry('client-1');
    await vi.waitFor(() => expect(transitions).toContain('ready'));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('releases a removed preprocessing slot immediately and ignores its late result', async () => {
    const preprocessing: string[] = [];
    const releases = new Map<string, (file: File) => void>();
    const transitions: string[] = [];
    const upload = vi.fn(async () => ({ assetId: 'asset-ready' }));
    const controller = new UploadController({
      concurrency: 2,
      onTransition: (action) => transitions.push(`${action.type}:${'clientId' in action ? action.clientId : ''}`),
      prepare: async (file) => {
        preprocessing.push(file.name);
        return new Promise<File>((resolve) => releases.set(file.name, resolve));
      },
      upload,
    });

    controller.enqueue([input(1), input(2), input(3)]);
    await vi.waitFor(() => expect(preprocessing).toEqual(['1.png', '2.png']));
    controller.remove('client-1');
    await vi.waitFor(() => expect(preprocessing).toEqual(['1.png', '2.png', '3.png']));
    releases.get('1.png')?.(input(1).file);
    releases.get('2.png')?.(input(2).file);
    releases.get('3.png')?.(input(3).file);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(transitions).not.toContain('ready:client-1');
  });

  it('ignores an upload result that arrives after removal', async () => {
    const transitions: string[] = [];
    let finishUpload: ((value: { assetId: string }) => void) | undefined;
    const controller = new UploadController({
      onTransition: (action) => transitions.push(action.type),
      upload: async () => new Promise((resolve) => {
        finishUpload = resolve;
      }),
    });

    controller.enqueue([input(1)]);
    await vi.waitFor(() => expect(transitions).toContain('uploading'));
    controller.remove('client-1');
    finishUpload?.({ assetId: 'late-asset' });
    await Promise.resolve();
    await Promise.resolve();
    expect(transitions).not.toContain('ready');
    expect(transitions.at(-1)).toBe('remove');
  });
});
