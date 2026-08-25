import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { SharpImageProcessor } from './image-processor.js';
import { detectAllowedMedia, UnsupportedMediaTypeError } from './mime.js';
import {
  MediaCommandError,
  parseFfprobeOutput,
  VideoProcessor,
  type CommandRunner,
} from './video-processor.js';

const temporaryDirectories: string[] = [];

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
});
