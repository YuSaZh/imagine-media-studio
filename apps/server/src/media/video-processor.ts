import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  commitStagedFile,
  discardStagedFile,
  stageReadable,
  type StagedFile,
} from '../storage/atomic-file.js';
import type { VideoMediaMetadata } from './types.js';

export interface CommandResult {
  stderr: string;
  stdout: string;
}

export interface CommandRunOptions {
  maxOutputBytes: number;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
}

export class MediaCommandError extends Error {
  public override readonly name = 'MediaCommandError';
}

class PosterUnavailableError extends MediaCommandError {}

const MAX_VIDEO_DIMENSION = 16_384;
const MAX_VIDEO_PIXELS = 100_000_000;
const MAX_VIDEO_DURATION_MS = 24 * 60 * 60 * 1_000;
const POSTER_MAX_BYTES = 32 * 1024 * 1024;
const POSTER_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

export type SpawnPort = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ReturnType<typeof spawn>;

export class SpawnCommandRunner implements CommandRunner {
  public constructor(private readonly spawnPort: SpawnPort = spawn) {}

  public async run(
    command: string,
    args: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandResult> {
    options.signal?.throwIfAborted();
    return new Promise<CommandResult>((resolve, reject) => {
      const child = this.spawnPort(command, args, {
        env: { LANG: 'C', PATH: process.env.PATH ?? '/usr/bin:/bin' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      let closeObserved = false;
      let terminationError: Error | undefined;
      const forceTimer: { current?: ReturnType<typeof setTimeout> } = {};

      const cleanup = () => {
        clearTimeout(timer);
        if (forceTimer.current !== undefined) clearTimeout(forceTimer.current);
        options.signal?.removeEventListener('abort', onAbort);
        child.stdout?.removeListener('data', onStdout);
        child.stderr?.removeListener('data', onStderr);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
      };
      const finish = (error: Error | undefined, result: CommandResult | undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result!);
      };
      const abortedError = () => new MediaCommandError(`${command} was aborted.`);
      const terminate = (error: Error) => {
        if (settled) return;
        const preferredError = options.signal?.aborted ? abortedError() : error;
        if (terminationError !== undefined) {
          if (options.signal?.aborted) terminationError = preferredError;
          return;
        }
        terminationError = preferredError;
        forceTimer.current = setTimeout(() => {
          if (settled || closeObserved) return;
          try {
            child.kill('SIGKILL');
          } catch {
            // A process that already exited will still deliver close.
          }
        }, 1_000);
        forceTimer.current.unref();
        try {
          child.kill('SIGTERM');
        } catch {
          // The close event remains the only completion signal, even if kill races exit.
        }
      };
      const append = (target: Buffer[], value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        outputBytes += chunk.byteLength;
        if (outputBytes > options.maxOutputBytes) {
          terminate(new MediaCommandError(`${command} output exceeded its safety limit.`));
          return;
        }
        target.push(chunk);
      };
      function onAbort() {
        terminate(abortedError());
      }
      function onStdout(chunk: Buffer | string) {
        append(stdout, chunk);
      }
      function onStderr(chunk: Buffer | string) {
        append(stderr, chunk);
      }
      function onError(error: Error) {
        terminate(error);
      }
      function onClose(code: number | null, signal: NodeJS.Signals | null) {
        closeObserved = true;
        if (terminationError !== undefined) {
          finish(terminationError, undefined);
          return;
        }
        if (options.signal?.aborted) {
          finish(abortedError(), undefined);
          return;
        }
        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0) {
          finish(
            new MediaCommandError(
              `${command} failed (${code ?? signal ?? 'unknown'}): ${stderrText.slice(0, 1_024)}`,
            ),
            undefined,
          );
          return;
        }
        finish(undefined, { stderr: stderrText, stdout: stdoutText });
      }
      const timer = setTimeout(
        () => terminate(new MediaCommandError(`${command} exceeded ${options.timeoutMs}ms.`)),
        options.timeoutMs,
      );
      timer.unref();

      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('error', onError);
      child.once('close', onClose);
      if (options.signal?.aborted) onAbort();
    });
  }
}

interface ProbeDocument {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    duration?: string;
    height?: number;
    width?: number;
  }>;
}

function positiveSafeInteger(value: unknown, maximum: number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

function positiveDurationMs(value: unknown): number | null {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_VIDEO_DURATION_MS / 1_000) {
    return null;
  }
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

export function parseFfprobeOutput(stdout: string): VideoMediaMetadata {
  let document: ProbeDocument;
  try {
    document = JSON.parse(stdout) as ProbeDocument;
  } catch {
    throw new MediaCommandError('ffprobe returned invalid JSON.');
  }
  if (document === null || typeof document !== 'object') {
    throw new MediaCommandError('ffprobe returned an invalid document.');
  }
  const stream = Array.isArray(document.streams)
    ? document.streams.find((candidate) => candidate !== null && candidate.codec_type === 'video')
    : undefined;
  const width = positiveSafeInteger(stream?.width, MAX_VIDEO_DIMENSION);
  const height = positiveSafeInteger(stream?.height, MAX_VIDEO_DIMENSION);
  const durationMs = positiveDurationMs(stream?.duration) ?? positiveDurationMs(document.format?.duration);
  if (
    !stream ||
    !width ||
    !height ||
    width * height > MAX_VIDEO_PIXELS ||
    !durationMs ||
    typeof stream.codec_name !== 'string' ||
    stream.codec_name.length === 0
  ) {
    throw new MediaCommandError('ffprobe did not return a usable video stream.');
  }
  return {
    codec: stream.codec_name,
    durationMs,
    format:
      typeof document.format?.format_name === 'string'
        ? document.format.format_name.split(',')[0] ?? 'unknown'
        : 'unknown',
    height,
    width,
  };
}

export interface VideoProcessorOptions {
  ffmpegCommand?: string;
  ffprobeCommand?: string;
  posterTimeoutMs?: number;
  probeTimeoutMs?: number;
  runner?: CommandRunner;
}

export class VideoProcessor {
  private readonly ffmpegCommand: string;
  private readonly ffprobeCommand: string;
  private readonly posterTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly runner: CommandRunner;

  public constructor(options: VideoProcessorOptions = {}) {
    this.ffmpegCommand = options.ffmpegCommand ?? 'ffmpeg';
    this.ffprobeCommand = options.ffprobeCommand ?? 'ffprobe';
    this.posterTimeoutMs = options.posterTimeoutMs ?? 30_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 15_000;
    this.runner = options.runner ?? new SpawnCommandRunner();
  }

  public async probe(filePath: string, signal?: AbortSignal): Promise<VideoMediaMetadata> {
    const result = await this.runner.run(
      this.ffprobeCommand,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,format_name:stream=codec_type,codec_name,width,height,duration',
        '-of',
        'json',
        '-protocol_whitelist',
        'file,pipe',
        filePath,
      ],
      {
        maxOutputBytes: 1024 * 1024,
        ...(signal ? { signal } : {}),
        timeoutMs: this.probeTimeoutMs,
      },
    );
    return parseFfprobeOutput(result.stdout);
  }

  public async createPoster(options: {
    dataRoot: string;
    destinationPath: string;
    inputPath: string;
    metadata: VideoMediaMetadata;
    signal?: AbortSignal;
    temporaryDirectory: string;
  }): Promise<StagedFile> {
    const rawPoster = join(options.temporaryDirectory, `ims-${randomUUID()}.poster.jpg`);
    const preferredSeek = Math.min(1, options.metadata.durationMs / 10_000);
    let staged: StagedFile;
    let usedFallback = false;
    try {
      try {
        await this.runPosterCommand(options.inputPath, rawPoster, preferredSeek, options.signal);
      } catch {
        options.signal?.throwIfAborted();
        usedFallback = true;
        await removeRawPoster(rawPoster);
        await this.runPosterCommand(options.inputPath, rawPoster, 0, options.signal);
      }
      try {
        staged = await this.stagePoster(rawPoster, options);
      } catch (error) {
        if (!(error instanceof PosterUnavailableError) || usedFallback) throw error;
        options.signal?.throwIfAborted();
        await removeRawPoster(rawPoster);
        await this.runPosterCommand(options.inputPath, rawPoster, 0, options.signal);
        staged = await this.stagePoster(rawPoster, options);
      }
      try {
        options.signal?.throwIfAborted();
        await commitStagedFile(options.dataRoot, staged, options.destinationPath, options.signal);
        return staged;
      } catch (error) {
        await discardStagedFile(staged);
        throw error;
      }
    } finally {
      await removeRawPoster(rawPoster);
    }
  }

  private async stagePoster(
    path: string,
    options: {
      dataRoot: string;
      signal?: AbortSignal;
      temporaryDirectory: string;
    },
  ): Promise<StagedFile> {
    let handle;
    try {
      handle = await open(path, POSTER_OPEN_FLAGS);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ELOOP')) {
        throw new PosterUnavailableError('ffmpeg did not produce a safe poster file.');
      }
      throw error;
    }
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size === 0) {
        throw new PosterUnavailableError('ffmpeg did not produce a non-empty poster.');
      }
      const source = handle.createReadStream({ autoClose: false });
      try {
        const staged = await stageReadable({
          dataRoot: options.dataRoot,
          maxBytes: POSTER_MAX_BYTES,
          source,
          temporaryDirectory: options.temporaryDirectory,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (staged.bytes === 0) {
          await discardStagedFile(staged);
          throw new PosterUnavailableError('ffmpeg did not produce a non-empty poster.');
        }
        return staged;
      } finally {
        source.destroy();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async runPosterCommand(
    inputPath: string,
    outputPath: string,
    seekSeconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.runner.run(
      this.ffmpegCommand,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        seekSeconds.toFixed(3),
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=1280:-2:force_original_aspect_ratio=decrease',
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      {
        maxOutputBytes: 1024 * 1024,
        ...(signal ? { signal } : {}),
        timeoutMs: this.posterTimeoutMs,
      },
    );
  }
}

async function removeRawPoster(path: string): Promise<void> {
  // This path is generated above with randomUUID; recursive cleanup is limited to it.
  await rm(path, { force: true, recursive: true }).catch(() => undefined);
}
