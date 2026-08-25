import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
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

      const finish = (error?: Error, result?: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const terminate = (error: Error) => {
        if (settled) return;
        child.kill('SIGTERM');
        const forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
        forceTimer.unref();
        finish(error);
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
      const onAbort = () => terminate(new MediaCommandError(`${command} was aborted.`));
      const timer = setTimeout(
        () => terminate(new MediaCommandError(`${command} exceeded ${options.timeoutMs}ms.`)),
        options.timeoutMs,
      );
      timer.unref();

      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk));
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => {
        const stdoutText = Buffer.concat(stdout).toString('utf8');
        const stderrText = Buffer.concat(stderr).toString('utf8');
        if (code !== 0) {
          finish(
            new MediaCommandError(
              `${command} failed (${code ?? signal ?? 'unknown'}): ${stderrText.slice(0, 1_024)}`,
            ),
          );
          return;
        }
        finish(undefined, { stderr: stderrText, stdout: stdoutText });
      });
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

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseFfprobeOutput(stdout: string): VideoMediaMetadata {
  let document: ProbeDocument;
  try {
    document = JSON.parse(stdout) as ProbeDocument;
  } catch {
    throw new MediaCommandError('ffprobe returned invalid JSON.');
  }
  const stream = document.streams?.find((candidate) => candidate.codec_type === 'video');
  const width = positiveNumber(stream?.width);
  const height = positiveNumber(stream?.height);
  const durationSeconds = positiveNumber(stream?.duration) ?? positiveNumber(document.format?.duration);
  if (!stream || !width || !height || !durationSeconds || !stream.codec_name) {
    throw new MediaCommandError('ffprobe did not return a usable video stream.');
  }
  return {
    codec: stream.codec_name,
    durationMs: Math.round(durationSeconds * 1_000),
    format: document.format?.format_name?.split(',')[0] ?? 'unknown',
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
    try {
      try {
        await this.runPosterCommand(options.inputPath, rawPoster, preferredSeek, options.signal);
      } catch {
        options.signal?.throwIfAborted();
        await rm(rawPoster, { force: true });
        await this.runPosterCommand(options.inputPath, rawPoster, 0, options.signal);
      }
      const staged = await stageReadable({
        dataRoot: options.dataRoot,
        maxBytes: 32 * 1024 * 1024,
        source: createReadStream(rawPoster),
        temporaryDirectory: options.temporaryDirectory,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      try {
        await commitStagedFile(options.dataRoot, staged, options.destinationPath);
        return staged;
      } catch (error) {
        await discardStagedFile(staged);
        throw error;
      }
    } finally {
      await rm(rawPoster, { force: true });
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
