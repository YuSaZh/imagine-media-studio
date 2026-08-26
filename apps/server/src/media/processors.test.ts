import { EventEmitter } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { SharpImageProcessor } from './image-processor.js';
import { detectAllowedMedia, UnsupportedMediaTypeError } from './mime.js';
import {
  MediaCommandError,
  parseFfprobeOutput,
  SpawnCommandRunner,
  type SpawnPort,
  VideoProcessor,
  type CommandRunner,
} from './video-processor.js';

const temporaryDirectories: string[] = [];

interface FakeChild extends EventEmitter {
  readonly kill: ReturnType<typeof vi.fn>;
  readonly stderr: EventEmitter;
  readonly stdout: EventEmitter;
}

function fakeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stderr: new EventEmitter(),
    stdout: new EventEmitter(),
  }) as FakeChild;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ims-processors-'));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  const input = join(paths.uploads, 'input.png');
  const png = await sharp({
    create: { background: '#ff0000', channels: 4, height: 40, width: 80 },
  })
    .png()
    .toBuffer();
  await writeFile(input, png);
  return { input, paths, png };
}

describe('MIME and image processing', () => {
  it('detects signatures and rejects a mismatched claim or expected kind', async () => {
    const { png } = await fixture();
    await expect(detectAllowedMedia(png, { claimedMimeType: 'image/png' })).resolves.toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
    await expect(
      detectAllowedMedia(png, { claimedMimeType: 'image/jpeg' }),
    ).rejects.toThrow(UnsupportedMediaTypeError);
    await expect(detectAllowedMedia(png, { expectedKind: 'video' })).rejects.toThrow(
      'Expected video',
    );
  });

  it('validates an image decoder and creates a bounded WebP thumbnail', async () => {
    const { input, paths } = await fixture();
    const processor = new SharpImageProcessor({ thumbnailSize: 32 });
    await expect(processor.inspect(input)).resolves.toMatchObject({
      height: 40,
      mimeType: 'image/png',
      width: 80,
    });
    const destination = join(paths.thumbnails, 'thumb.webp');
    await processor.createThumbnail({
      dataRoot: paths.root,
      destinationPath: destination,
      inputPath: input,
      temporaryDirectory: paths.temporary,
    });
    const metadata = await sharp(await readFile(destination)).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(32);
    expect(metadata.height).toBe(16);
  });
});

describe('video processing', () => {
  it('parses a usable video stream and rejects malformed probe output', () => {
    expect(
      parseFfprobeOutput(
        JSON.stringify({
          format: { duration: '2.25', format_name: 'mov,mp4' },
          streams: [{ codec_name: 'h264', codec_type: 'video', height: 720, width: 1280 }],
        }),
      ),
    ).toEqual({
      codec: 'h264',
      durationMs: 2250,
      format: 'mov',
      height: 720,
      width: 1280,
    });
    expect(() => parseFfprobeOutput('{')).toThrow(MediaCommandError);
    expect(() => parseFfprobeOutput(JSON.stringify({ streams: [] }))).toThrow(MediaCommandError);
  });

  it.each([
    ['fractional width', { width: 2.5, height: 2, duration: '1' }],
    ['zero height', { width: 2, height: 0, duration: '1' }],
    ['oversized width', { width: 16_385, height: 2, duration: '1' }],
    ['oversized pixel area', { width: 16_000, height: 8_000, duration: '1' }],
    ['N/A duration', { width: 2, height: 2, duration: 'N/A' }],
    ['infinite duration', { width: 2, height: 2, duration: 'Infinity' }],
    ['excessive duration', { width: 2, height: 2, duration: '86401' }],
    ['sub-millisecond duration', { width: 2, height: 2, duration: '0.0001' }],
  ])('rejects unsafe ffprobe metadata: %s', (_label, values) => {
    expect(() => parseFfprobeOutput(JSON.stringify({
      format: { duration: values.duration, format_name: 'mp4' },
      streams: [{
        codec_name: 'h264',
        codec_type: 'video',
        height: values.height,
        width: values.width,
      }],
    }))).toThrow(MediaCommandError);
  });

  it('falls back from an invalid stream duration to a valid format duration', () => {
    expect(parseFfprobeOutput(JSON.stringify({
      format: { duration: '1.25', format_name: 'mp4' },
      streams: [{
        codec_name: 'h264',
        codec_type: 'video',
        duration: 'N/A',
        height: 90,
        width: 160,
      }],
    }))).toMatchObject({ durationMs: 1_250 });
  });

  it('waits for child close after output, timeout, and abort termination', async () => {
    vi.useFakeTimers();
    try {
      for (const trigger of ['output', 'timeout', 'abort'] as const) {
        const child = fakeChild();
        const spawnPort: SpawnPort = () => child as unknown as ReturnType<SpawnPort>;
        const runner = new SpawnCommandRunner(spawnPort);
        const controller = new AbortController();
        const promise = runner.run('fake', [], {
          maxOutputBytes: trigger === 'output' ? 1 : 1024,
          signal: controller.signal,
          timeoutMs: trigger === 'timeout' ? 100 : 60_000,
        });
        let rejection: unknown;
        const observed = promise.catch((error: unknown) => {
          rejection = error;
        });
        await flushMicrotasks();

        if (trigger === 'output') child.stdout.emit('data', Buffer.from('too large'));
        if (trigger === 'timeout') await vi.advanceTimersByTimeAsync(100);
        if (trigger === 'abort') controller.abort();
        await flushMicrotasks();
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        expect(rejection).toBeUndefined();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
        await observed;
        expect(rejection).toBeInstanceOf(MediaCommandError);
        if (trigger === 'abort') expect((rejection as Error).message).toContain('aborted');
        expect(child.listenerCount('error')).toBe(0);
        expect(child.listenerCount('close')).toBe(0);
        expect(child.stdout.listenerCount('data')).toBe(0);
        expect(child.stderr.listenerCount('data')).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start poster fallback until the terminated ffmpeg closes', async () => {
    const { input, paths } = await fixture();
    vi.useFakeTimers();
    try {
      const probeChild = fakeChild();
      const firstPosterChild = fakeChild();
      const secondPosterChild = fakeChild();
      const posterArguments: Array<readonly string[]> = [];
      const spawnPort: SpawnPort = (command, args) => {
        if (command === 'probe') {
          queueMicrotask(() => {
            probeChild.stdout.emit('data', JSON.stringify({
              format: { duration: '1', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }));
            probeChild.emit('close', 0, null);
          });
          return probeChild as unknown as ReturnType<SpawnPort>;
        }
        posterArguments.push(args);
        return (posterArguments.length === 1 ? firstPosterChild : secondPosterChild) as unknown as ReturnType<SpawnPort>;
      };
      const processor = new VideoProcessor({
        ffmpegCommand: 'poster',
        ffprobeCommand: 'probe',
        runner: new SpawnCommandRunner(spawnPort),
      });
      const metadata = await processor.probe(input);
      const destination = join(paths.posters, 'delayed-fallback.jpg');
      const promise = processor.createPoster({
        dataRoot: paths.root,
        destinationPath: destination,
        inputPath: input,
        metadata,
        temporaryDirectory: paths.temporary,
      });
      await flushMicrotasks();
      firstPosterChild.stderr.emit('data', Buffer.from('too large'));
      await flushMicrotasks();
      expect(posterArguments).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(posterArguments).toHaveLength(1);
      firstPosterChild.emit('close', null, 'SIGKILL');
      await vi.waitFor(() => expect(posterArguments).toHaveLength(2));
      const fallbackPath = posterArguments[1]?.at(-1);
      if (fallbackPath === undefined) throw new Error('Missing fallback output path.');
      await writeFile(fallbackPath, 'poster');
      secondPosterChild.emit('close', 0, null);
      await promise;
      expect(await readFile(destination, 'utf8')).toBe('poster');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses injectable commands, bounded options, and a zero-seek poster fallback', async () => {
    const { input, paths } = await fixture();
    const calls: Array<{ args: readonly string[]; command: string }> = [];
    let posterAttempts = 0;
    const runner: CommandRunner = {
      run: async (command, args, options) => {
        calls.push({ args, command });
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.maxOutputBytes).toBe(1024 * 1024);
        if (command === 'probe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '2', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }),
          };
        }
        posterAttempts += 1;
        if (posterAttempts === 1) throw new MediaCommandError('first frame unavailable');
        const outputPath = args.at(-1);
        if (outputPath === undefined) throw new Error('Missing poster output path.');
        await writeFile(outputPath, 'poster');
        return { stderr: '', stdout: '' };
      },
    };
    const processor = new VideoProcessor({
      ffmpegCommand: 'poster',
      ffprobeCommand: 'probe',
      runner,
    });
    const metadata = await processor.probe(input);
    const destination = join(paths.posters, 'poster.jpg');
    await processor.createPoster({
      dataRoot: paths.root,
      destinationPath: destination,
      inputPath: input,
      metadata,
      temporaryDirectory: paths.temporary,
    });
    expect(await readFile(destination, 'utf8')).toBe('poster');
    expect(posterAttempts).toBe(2);
    expect(calls.at(-1)?.args).toContain('0.000');
  });

  it('falls back when ffmpeg exits successfully without producing a poster', async () => {
    const { input, paths } = await fixture();
    let posterAttempts = 0;
    const runner: CommandRunner = {
      run: async (command, args) => {
        if (command === 'probe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '1', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }),
          };
        }
        posterAttempts += 1;
        if (posterAttempts === 2) {
          const outputPath = args.at(-1);
          if (outputPath === undefined) throw new Error('Missing poster output path.');
          await writeFile(outputPath, 'poster');
        }
        return { stderr: '', stdout: '' };
      },
    };
    const processor = new VideoProcessor({
      ffmpegCommand: 'poster',
      ffprobeCommand: 'probe',
      runner,
    });

    const metadata = await processor.probe(input);
    const destination = join(paths.posters, 'poster-with-empty-first-attempt.jpg');
    await processor.createPoster({
      dataRoot: paths.root,
      destinationPath: destination,
      inputPath: input,
      metadata,
      temporaryDirectory: paths.temporary,
    });

    expect(await readFile(destination, 'utf8')).toBe('poster');
    expect(posterAttempts).toBe(2);
  });

  it('cleans a poster directory before retrying', async () => {
    const { input, paths } = await fixture();
    let posterAttempts = 0;
    let outputPath: string | undefined;
    const runner: CommandRunner = {
      run: async (command, args) => {
        if (command === 'probe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '1', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }),
          };
        }
        posterAttempts += 1;
        outputPath = args.at(-1);
        if (posterAttempts === 1) {
          if (outputPath === undefined) throw new Error('Missing poster output path.');
          await mkdir(outputPath);
          await writeFile(join(outputPath, 'leftover'), 'stale');
          return { stderr: '', stdout: '' };
        }
        if (outputPath === undefined) throw new Error('Missing poster output path.');
        await writeFile(outputPath, 'poster');
        return { stderr: '', stdout: '' };
      },
    };
    const processor = new VideoProcessor({ ffmpegCommand: 'poster', ffprobeCommand: 'probe', runner });
    const metadata = await processor.probe(input);
    const destination = join(paths.posters, 'directory-fallback.jpg');
    await processor.createPoster({
      dataRoot: paths.root,
      destinationPath: destination,
      inputPath: input,
      metadata,
      temporaryDirectory: paths.temporary,
    });
    expect(await readFile(destination, 'utf8')).toBe('poster');
    expect(posterAttempts).toBe(2);
    expect(outputPath).toBeDefined();
  });

  it('preserves a fallback error when poster cleanup sees a directory', async () => {
    const { input, paths } = await fixture();
    let posterAttempts = 0;
    const runner: CommandRunner = {
      run: async (command, args) => {
        if (command === 'probe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '1', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }),
          };
        }
        posterAttempts += 1;
        const outputPath = args.at(-1);
        if (outputPath === undefined) throw new Error('Missing poster output path.');
        await mkdir(outputPath);
        throw new MediaCommandError('fallback poster command failed');
      },
    };
    const processor = new VideoProcessor({ ffmpegCommand: 'poster', ffprobeCommand: 'probe', runner });
    const metadata = await processor.probe(input);
    await expect(processor.createPoster({
      dataRoot: paths.root,
      destinationPath: join(paths.posters, 'directory-error.jpg'),
      inputPath: input,
      metadata,
      temporaryDirectory: paths.temporary,
    })).rejects.toThrow('fallback poster command failed');
    expect(posterAttempts).toBe(2);
  });

  it.skipIf(fsConstants.O_NOFOLLOW === undefined)('does not follow a poster symlink', async () => {
    const { input, paths } = await fixture();
    const outside = join(paths.root, 'outside.jpg');
    let posterAttempts = 0;
    const runner: CommandRunner = {
      run: async (command, args) => {
        if (command === 'probe') {
          return {
            stderr: '',
            stdout: JSON.stringify({
              format: { duration: '1', format_name: 'mp4' },
              streams: [{ codec_name: 'h264', codec_type: 'video', height: 2, width: 4 }],
            }),
          };
        }
        posterAttempts += 1;
        const outputPath = args.at(-1);
        if (outputPath === undefined) throw new Error('Missing poster output path.');
        await writeFile(outside, 'outside');
        await symlink(outside, outputPath);
        return { stderr: '', stdout: '' };
      },
    };
    const processor = new VideoProcessor({ ffmpegCommand: 'poster', ffprobeCommand: 'probe', runner });
    const metadata = await processor.probe(input);
    await expect(processor.createPoster({
      dataRoot: paths.root,
      destinationPath: join(paths.posters, 'symlink.jpg'),
      inputPath: input,
      metadata,
      temporaryDirectory: paths.temporary,
    })).rejects.toThrow(MediaCommandError);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    expect(posterAttempts).toBe(2);
  });
});
