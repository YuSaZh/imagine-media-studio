import type { IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import { NetworkPolicy, UnsafeRemoteUrlError } from './network-policy.js';
import { RemoteMediaDownloader } from './remote-download.js';
import {
  RemoteHttpError,
  SafeHttpTransport,
  type PinnedRequestExecutor,
  type RawPinnedResponse,
} from './safe-http-transport.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function rawResponse(
  statusCode: number,
  headers: IncomingHttpHeaders,
  payload: Buffer = Buffer.alloc(0),
): RawPinnedResponse & { disposed: () => boolean } {
  const body = Readable.from([payload]);
  let disposed = false;
  return {
    body,
    dispose: async () => {
      disposed = true;
      body.destroy();
    },
    disposed: () => disposed,
    headers,
    statusCode,
  };
}

function publicResolver(hostname: string) {
  return Promise.resolve([
    { address: hostname === 'second.example' ? '1.1.1.1' : '8.8.8.8', family: 4 as const },
  ]);
}

describe('NetworkPolicy', () => {
  it('rejects private, loopback, link-local metadata, credentials, and unsafe schemes', async () => {
    const addresses = ['10.0.0.1', '127.0.0.1', '169.254.169.254', '::1'];
    for (const address of addresses) {
      const policy = new NetworkPolicy({
        resolver: () =>
          Promise.resolve([{ address, family: (address.includes(':') ? 6 : 4) as 4 | 6 }]),
      });
      await expect(policy.validate('https://blocked.example/file')).rejects.toThrow(
        UnsafeRemoteUrlError,
      );
    }
    const policy = new NetworkPolicy({ resolver: publicResolver });
    await expect(policy.validate('http://public.example/file')).rejects.toThrow('must use HTTPS');
    await expect(policy.validate('https://user:pass@public.example/file')).rejects.toThrow(
      'cannot contain credentials',
    );
    await expect(policy.validate('https://metadata.google.internal/file')).rejects.toThrow(
      'not allowed',
    );
  });

  it('checks every resolved address and pins an allowed address', async () => {
    const policy = new NetworkPolicy({
      resolver: () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.7', family: 4 },
        ]),
    });
    await expect(policy.validate('https://mixed.example/file')).rejects.toThrow('not allowed');

    const allowed = await new NetworkPolicy({ resolver: publicResolver }).validate(
      'https://public.example/file',
    );
    expect(allowed.pinnedAddress).toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('allows explicit private access without allowing metadata address ranges', async () => {
    const privatePolicy = new NetworkPolicy({
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      resolver: () => Promise.resolve([{ address: '192.168.1.10', family: 4 }]),
    });
    await expect(privatePolicy.validate('http://nas.example/media')).resolves.toBeDefined();

    const metadataPolicy = new NetworkPolicy({
      allowInsecureHttp: true,
      allowPrivateNetwork: true,
      resolver: () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]),
    });
    await expect(metadataPolicy.validate('http://metadata-target.example/media')).rejects.toThrow(
      'not allowed',
    );
  });
});

describe('SafeHttpTransport', () => {
  it('revalidates redirects, pins each hop, and strips secrets across origins', async () => {
    const first = rawResponse(302, { location: 'https://second.example/final' });
    const second = rawResponse(200, { 'content-type': 'image/png' }, PNG);
    const calls: Array<{ address: string; headers: Readonly<Record<string, string>> }> = [];
    const executor: PinnedRequestExecutor = async (target, request) => {
      calls.push({ address: target.pinnedAddress.address, headers: request.headers ?? {} });
      return calls.length === 1 ? first : second;
    };
    const transport = new SafeHttpTransport({
      executor,
      policy: new NetworkPolicy({ resolver: publicResolver }),
    });
    const response = await transport.fetch('https://first.example/start', {
      headers: { Authorization: 'Bearer secret', 'X-Request': 'kept' },
    });
    expect(response.url.href).toBe('https://second.example/final');
    expect(calls).toEqual([
      {
        address: '8.8.8.8',
        headers: { Authorization: 'Bearer secret', 'X-Request': 'kept' },
      },
      { address: '1.1.1.1', headers: {} },
    ]);
    expect(first.disposed()).toBe(true);
    await response.dispose();
  });

  it('blocks a redirect to a private target before the second request', async () => {
    const executor = vi.fn<PinnedRequestExecutor>().mockResolvedValue(
      rawResponse(302, { location: 'https://private.example/file' }),
    );
    const transport = new SafeHttpTransport({
      executor,
      policy: new NetworkPolicy({
        resolver: (hostname) =>
          Promise.resolve([
            { address: hostname === 'private.example' ? '10.0.0.1' : '8.8.4.4', family: 4 },
          ]),
      }),
    });
    await expect(transport.fetch('https://public.example/start')).rejects.toThrow('not allowed');
    expect(executor).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteMediaDownloader', () => {
  it('streams a permitted response to a bounded staged file and detects MIME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ims-remote-download-'));
    temporaryDirectories.push(root);
    const paths = getStoragePaths(root);
    await ensureStorage(paths);
    const response = rawResponse(200, {
      'content-length': String(PNG.byteLength),
      'content-type': 'image/png',
    }, PNG);
    const downloader = new RemoteMediaDownloader(
      new SafeHttpTransport({
        executor: async () => response,
        policy: new NetworkPolicy({ resolver: publicResolver }),
      }),
    );
    const result = await downloader.download({
      dataRoot: paths.root,
      expectedKind: 'image',
      maxBytes: 1024,
      temporaryDirectory: paths.temporary,
      url: 'https://public.example/image',
    });
    expect(result.mediaType).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(result.staged.bytes).toBe(PNG.byteLength);
    expect(response.disposed()).toBe(true);
  });

  it('rejects oversized or compressed responses without leaving a temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ims-remote-limit-'));
    temporaryDirectories.push(root);
    const paths = getStoragePaths(root);
    await ensureStorage(paths);
    for (const headers of [
      { 'content-length': '9999', 'content-type': 'image/png' },
      { 'content-encoding': 'gzip', 'content-type': 'image/png' },
    ]) {
      const response = rawResponse(200, headers, PNG);
      const downloader = new RemoteMediaDownloader(
        new SafeHttpTransport({
          executor: async () => response,
          policy: new NetworkPolicy({ resolver: publicResolver }),
        }),
      );
      await expect(
        downloader.download({
          dataRoot: paths.root,
          maxBytes: 1024,
          temporaryDirectory: paths.temporary,
          url: 'https://public.example/image',
        }),
      ).rejects.toThrow(RemoteHttpError);
      expect(response.disposed()).toBe(true);
    }
    expect(await readdir(paths.temporary)).toEqual([]);
  });
});
