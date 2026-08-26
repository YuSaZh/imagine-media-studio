import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdapterAuthorizationError,
  AdapterAlreadyInstalledError,
  AdapterManifestError,
  AdapterSourcePolicyError,
  AdapterStore,
  AdapterStoreError,
  digestAdapterSource,
  parseAdapterManifest,
  parseBoundedManifestJson,
  validateReadFileBytes,
  validateAdapterSource,
  writeAll,
} from './index.js';

const roots: string[] = [];
const limits = {
  timeoutMs: 1000,
  maxMessageBytes: 1_048_576,
  maxOutputBytes: 1_048_576,
  maxLogBytes: 65_536,
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
};

function source(): string {
  return "export const capabilities = { providerType: 'fixture', models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }] }; export async function submit() { return { state: 'completed', assets: [{ type: 'image', mimeType: 'image/png', source: 'base64', base64: 'aGVsbG8=' }] }; } export function normalizeError() { return { code: 'error', kind: 'unknown', message: 'error', retryable: false }; }\n";
}

function manifest(sourceText = source(), overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'fixture-adapter',
    version: '1.0.0',
    displayName: 'Fixture adapter',
    sha256: digestAdapterSource(sourceText),
    operations: ['image.generate'],
    capabilities: {
      providerType: 'fixture',
      models: [{ id: 'model', displayName: 'Model', capabilities: { operations: ['image.generate'] } }],
    },
    allowedHosts: ['API.EXAMPLE.COM.'],
    requiredSecrets: ['apiKey'],
    resourceLimits: limits,
    ...overrides,
  };
}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imagine-adapters-'));
  roots.push(root);
  return root;
}

function adminAuthorization(): { readonly adminEnabled: true; assertAdmin(): void } {
  return { adminEnabled: true, assertAdmin() {} };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe('adapter manifest and source policy', () => {
  it('normalizes exact hosts and rejects URL, port, IP and wildcard syntax', () => {
    expect(parseAdapterManifest(manifest()).allowedHosts).toEqual(['api.example.com']);
    for (const allowedHosts of [['https://api.example.com'], ['api.example.com:443'], ['*.example.com'], ['127.0.0.1'], ['api.example.com/path']]) {
      expect(() => parseAdapterManifest(manifest(source(), { allowedHosts }))).toThrow(AdapterManifestError);
    }
    expect(() => parseAdapterManifest({ ...manifest(), unknown: true })).toThrow(AdapterManifestError);
    expect(() => parseAdapterManifest(manifest(source(), { id: '../escape' }))).toThrow(AdapterManifestError);
    expect(() => parseAdapterManifest(manifest(source(), { operations: ['video.edit'] }))).toThrow(AdapterManifestError);
    expect(() => parseAdapterManifest(manifest(source(), { operations: ['video.extend'] }))).toThrow(AdapterManifestError);
    expect(() => parseBoundedManifestJson(new TextEncoder().encode('{"schemaVersion":1,"schemaVersion":1}'))).toThrow(AdapterManifestError);
    expect(() => parseBoundedManifestJson(new TextEncoder().encode('{"__proto__":{}}'))).toThrow(AdapterManifestError);
    const dangerousCustomFields = Object.create(null) as Record<string, unknown>;
    dangerousCustomFields.__proto__ = { leaked: true };
    expect(() => parseAdapterManifest(manifest(source(), {
      capabilities: {
        providerType: 'fixture',
        models: [{
          id: 'model',
          displayName: 'Model',
          capabilities: { operations: ['image.generate'], customFields: dangerousCustomFields },
        }],
      },
    }))).toThrow(AdapterManifestError);
    const oversizedCustomFields = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field-${index}`, 'x'.repeat(16_000)]));
    expect(() => parseAdapterManifest(manifest(source(), {
      capabilities: {
        providerType: 'fixture',
        models: [{
          id: 'model',
          displayName: 'Model',
          capabilities: { operations: ['image.generate'], customFields: oversizedCustomFields },
        }],
      },
    }))).toThrow(AdapterManifestError);
  });

  it('rejects source imports and runtime escape tokens as best-effort policy', () => {
    for (const value of [
      "import fs from 'fs';",
      "export async function submit() { return import('x'); }",
      'export function submit() { return eval("x"); }',
      'export const value = process.env.SECRET;',
      'export const value = WebAssembly;',
      'export async function submit() { return fetch("https://example.com"); }',
      'export async function submit() { return new WebSocket("wss://example.com"); }',
      'export async function submit() { return new EventSource("https://example.com"); }',
      'export async function submit() { return new XMLHttpRequest(); }',
      'export async function submit() { return navigator.sendBeacon("https://example.com", "x"); }',
    ]) {
      expect(() => validateAdapterSource(new TextEncoder().encode(value))).toThrow(AdapterSourcePolicyError);
    }
    expect(validateAdapterSource(new TextEncoder().encode(source()))).toContain('capabilities');
  });

  it('writes short chunks until complete and rejects growth after a stat snapshot', async () => {
    const target = new Uint8Array(7);
    const chunks: number[] = [];
    await writeAll(async (bytes, offset) => {
      const written = Math.min(2, bytes.byteLength - offset);
      target.set(bytes.subarray(offset, offset + written), offset);
      chunks.push(written);
      return { bytesWritten: written };
    }, new TextEncoder().encode('payload'));
    expect(new TextDecoder().decode(target)).toBe('payload');
    expect(chunks).toEqual([2, 2, 2, 1]);
    expect(() => validateReadFileBytes(new Uint8Array(8), 7, 10)).toThrow(AdapterStoreError);
    expect(() => validateReadFileBytes(new Uint8Array(7), 7, 6)).toThrow(AdapterStoreError);
  });
});

describe('AdapterStore', () => {
  it('installs atomically with private modes and returns no source in DTO', async () => {
    const root = await newRoot();
    const store = new AdapterStore(root, adminAuthorization());
    const installed = await store.install({ manifest: manifest(), source: source() });
    expect(installed.manifest.allowedHosts).toEqual(['api.example.com']);
    expect('source' in installed).toBe(false);
    const directory = await lstat(join(root, 'fixture-adapter'));
    const adapterFile = await lstat(join(root, 'fixture-adapter', 'adapter.mjs'));
    const manifestFile = await lstat(join(root, 'fixture-adapter', 'manifest.json'));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(adapterFile.mode & 0o777).toBe(0o600);
    expect(manifestFile.mode & 0o777).toBe(0o600);
    const runtimeReader = store.runtimeReader();
    const runtime = await runtimeReader.readByRef({ kind: 'trusted-javascript', adapterId: 'fixture-adapter', version: '1.0.0', digest: digestAdapterSource(source()) });
    expect(runtime.source).toEqual(new TextEncoder().encode(source()));
    await expect(runtimeReader.readByRef({ kind: 'declarative-http', adapterId: 'fixture-adapter', version: '1.0.0', digest: digestAdapterSource(source()) } as never)).rejects.toThrow(AdapterStoreError);
    await expect(runtimeReader.readByRef({ kind: 'trusted-javascript', adapterId: 'fixture-adapter', version: '9.0.0', digest: digestAdapterSource(source()) })).rejects.toThrow(AdapterStoreError);
    await expect(runtimeReader.readByRef({ kind: 'trusted-javascript', adapterId: 'fixture-adapter', version: '1.0.0', digest: '0'.repeat(64) })).rejects.toThrow(AdapterStoreError);
    await expect(runtimeReader.readByRef({ kind: 'trusted-javascript', adapterId: 'other-adapter', version: '1.0.0', digest: digestAdapterSource(source()) })).rejects.toThrow(AdapterStoreError);
    expect((await store.list()).map((item) => item.manifest.id)).toEqual(['fixture-adapter']);
    expect(await readFile(join(root, 'fixture-adapter', 'manifest.json'), 'utf8')).toContain('fixture-adapter');
  });

  it('rejects administrators being disabled, bad hashes and duplicate installs without final partial state', async () => {
    const root = await newRoot();
    const denied = new AdapterStore(root, { adminEnabled: false, assertAdmin() {} });
    await expect(denied.install({ manifest: manifest(), source: source() })).rejects.toThrow(AdapterAuthorizationError);
    await expect(denied.install({ manifest: manifest(), source: source(), adminEnabled: true } as never)).rejects.toThrow(AdapterAuthorizationError);
    await expect(denied.list()).rejects.toThrow(AdapterAuthorizationError);
    await expect(denied.get('fixture-adapter')).rejects.toThrow(AdapterAuthorizationError);
    await expect(denied.remove('fixture-adapter')).rejects.toThrow(AdapterAuthorizationError);
    const store = new AdapterStore(root, adminAuthorization());
    await expect(store.install({ manifest: manifest(source(), { sha256: '0'.repeat(64) }), source: source() })).rejects.toThrow(AdapterStoreError);
    await expect(readdir(join(root, '.staging'))).resolves.toEqual([]);
    await store.install({ manifest: manifest(), source: source() });
    await expect(store.install({ manifest: manifest(), source: source() })).rejects.toThrow(AdapterAlreadyInstalledError);
  });

  it('allows only trusted regular files and detects symlink replacement', async () => {
    const root = await newRoot();
    const store = new AdapterStore(root, adminAuthorization());
    await store.install({ manifest: manifest(), source: source() });
    const outside = join(root, '..', 'outside-adapter-test');
    await mkdir(outside, { recursive: true });
    await symlink(join(outside, 'adapter.mjs'), join(root, 'fixture-adapter', 'adapter-link')).catch(() => undefined);
    await expect(store.get('fixture-adapter')).rejects.toThrow(AdapterStoreError);
    await rm(outside, { recursive: true, force: true });
  });

  it('does not follow a symlink at the adapter target', async () => {
    const root = await newRoot();
    const store = new AdapterStore(root, adminAuthorization());
    await store.install({ manifest: manifest(), source: source() });
    await rm(join(root, 'fixture-adapter'), { recursive: true, force: true });
    await symlink(root, join(root, 'fixture-adapter'));
    await expect(store.get('fixture-adapter')).rejects.toThrow(AdapterStoreError);
    await expect(store.remove('fixture-adapter')).rejects.toThrow(AdapterStoreError);
  });

  it('uses the owner authorization port for all management operations', async () => {
    const root = await newRoot();
    const calls: string[] = [];
    const store = new AdapterStore(root, {
      adminEnabled: true,
      assertAdmin(action) { calls.push(action); },
    });
    await store.install({ manifest: manifest(), source: source() });
    await store.get('fixture-adapter');
    await store.remove('fixture-adapter');
    expect(calls).toEqual(['install', 'read', 'remove']);
  });

  it('rejects insecure file modes after tampering', async () => {
    const root = await newRoot();
    const store = new AdapterStore(root, adminAuthorization());
    await store.install({ manifest: manifest(), source: source() });
    await chmod(join(root, 'fixture-adapter', 'adapter.mjs'), 0o644);
    await expect(store.get('fixture-adapter')).rejects.toThrow(AdapterStoreError);
  });

  it('fails closed when no owner authorization port is supplied', () => {
    expect(() => new AdapterStore('/tmp/adapter-store-without-auth')).toThrow(AdapterAuthorizationError);
  });
});
