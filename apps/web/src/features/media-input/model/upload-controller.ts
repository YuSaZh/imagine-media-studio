import type { AcquiredImage, ImageAssetInputDescriptor } from './types.js';
import type { MediaInputAction } from './upload-reducer.js';

export interface UploadControllerDependencies {
  concurrency?: number;
  onTransition: (action: MediaInputAction) => void;
  prepare?: (
    file: File,
    signal: AbortSignal,
  ) => File | PreparedUploadFile | Promise<File | PreparedUploadFile>;
  upload: (
    file: File,
    signal: AbortSignal,
    inputDescriptor: ImageAssetInputDescriptor | null,
    clientId: string,
  ) => Promise<{ assetId: string; inputDescriptor?: ImageAssetInputDescriptor | null }>;
}

export interface PreparedUploadFile {
  readonly file: File;
  readonly inputDescriptor: ImageAssetInputDescriptor;
}

interface UploadTask {
  controller: AbortController;
  input: AcquiredImage;
  running: boolean;
  status: 'error' | 'queued' | 'ready';
}

function uploadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Reference image could not be uploaded.';
}

export class UploadController {
  private active = 0;
  private readonly concurrency: number;
  private disposed = false;
  private readonly tasks = new Map<string, UploadTask>();

  public constructor(private readonly dependencies: UploadControllerDependencies) {
    this.concurrency = dependencies.concurrency ?? 2;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new RangeError('Upload concurrency must be a positive safe integer.');
    }
  }

  public enqueue(inputs: readonly AcquiredImage[]): void {
    if (this.disposed) return;
    for (const input of inputs) {
      if (this.tasks.has(input.clientId)) continue;
      this.tasks.set(input.clientId, {
        controller: new AbortController(),
        input,
        running: false,
        status: 'queued',
      });
    }
    this.pump();
  }

  public remove(clientId: string): void {
    const task = this.tasks.get(clientId);
    if (!task) return;
    task.controller.abort();
    this.tasks.delete(clientId);
    if (task.running) {
      task.running = false;
      this.active = Math.max(0, this.active - 1);
    }
    this.dependencies.onTransition({ clientId, type: 'remove' });
    this.pump();
  }

  public retry(clientId: string): void {
    const task = this.tasks.get(clientId);
    if (!task || task.running || task.status !== 'error' || this.disposed) return;
    task.controller = new AbortController();
    task.status = 'queued';
    this.dependencies.onTransition({ clientId, type: 'retry' });
    this.pump();
  }

  public dispose(): void {
    this.disposed = true;
    for (const task of this.tasks.values()) {
      task.running = false;
      task.controller.abort();
    }
    this.active = 0;
    this.tasks.clear();
  }

  private pump(): void {
    if (this.disposed) return;
    for (const task of this.tasks.values()) {
      if (this.active >= this.concurrency) return;
      if (task.running || task.status !== 'queued') continue;
      task.running = true;
      this.active += 1;
      void this.run(task);
    }
  }

  private async run(task: UploadTask): Promise<void> {
    const { clientId, file } = task.input;
    const signal = task.controller.signal;
    const runController = task.controller;
    try {
      this.dependencies.onTransition({ clientId, type: 'preprocessing' });
      const preparedResult = this.dependencies.prepare
        ? await this.dependencies.prepare(file, signal)
        : file;
      const prepared = preparedResult instanceof File
        ? { file: preparedResult, inputDescriptor: null }
        : preparedResult;
      signal.throwIfAborted();
      this.dependencies.onTransition({ clientId, type: 'uploading' });
      const result = await this.dependencies.upload(
        prepared.file,
        signal,
        prepared.inputDescriptor,
        clientId,
      );
      signal.throwIfAborted();
      task.status = 'ready';
      this.dependencies.onTransition({
        assetId: result.assetId,
        clientId,
        inputDescriptor: result.inputDescriptor ?? prepared.inputDescriptor,
        type: 'ready',
      });
    } catch (error) {
      if (!signal.aborted && this.tasks.has(clientId)) {
        task.status = 'error';
        this.dependencies.onTransition({ clientId, error: uploadErrorMessage(error), type: 'error' });
      }
    } finally {
      if (task.running && task.controller === runController) {
        task.running = false;
        this.active = Math.max(0, this.active - 1);
        this.pump();
      }
    }
  }
}
