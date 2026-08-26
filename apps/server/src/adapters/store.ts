import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { CustomAdapterRefSchema, type CustomAdapterRef } from '@imagine/shared';

import {
  ADAPTER_MANIFEST_VERSION,
  AdapterSourcePolicyError,
  MAX_ADAPTER_SOURCE_BYTES,
  MAX_MANIFEST_BYTES,
  parseAdapterManifest,
  parseBoundedManifestJson,
  validateAdapterSource,
  validateAdapterExports,
  type AdapterManifest,
} from './manifest.js';

const MANIFEST_FILENAME = 'manifest.json';
const SOURCE_FILENAME = 'adapter.mjs';
const STAGING_DIRECTORY = '.staging';
const EXPECTED_FILES = new Set([MANIFEST_FILENAME, SOURCE_FILENAME]);

export interface AdapterAdminAuthorization {
  readonly adminEnabled: boolean;
  assertAdmin(action: 'install' | 'remove' | 'read'): void | Promise<void>;
}

export interface AdapterInstallRequest {
  readonly manifest: unknown;
  readonly source: string | Uint8Array;
}

export interface AdapterRecord {
  readonly manifest: AdapterManifest;
}

export type AdapterRuntimeReference = Omit<CustomAdapterRef, 'kind'> & { readonly kind: 'trusted-javascript' };

export interface AdapterRuntimeRecord extends AdapterRecord {
  /** Source is only returned over this internal runtime port. */
  readonly source: Uint8Array;
}

export interface AdapterRuntimeReader {
  readByRef(reference: AdapterRuntimeReference): Promise<AdapterRuntimeRecord>;
}

export class AdapterStoreError extends Error {
  public override readonly name: string = 'AdapterStoreError';
}

export class AdapterAuthorizationError extends AdapterStoreError {
  public override readonly name: string = 'AdapterAuthorizationError';
}

export class AdapterAlreadyInstalledError extends AdapterStoreError {
  public override readonly name: string = 'AdapterAlreadyInstalledError';
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function sourceBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
}

function sha256(source: Uint8Array): string {
  return createHash('sha256').update(source).digest('hex');
}

function modeIsSecure(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

export async function writeAll(
  write: (bytes: Uint8Array, offset: number) => Promise<{ readonly bytesWritten: number }>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await write(bytes, offset);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw new AdapterStoreError('Adapter file write made no progress.');
    }
    offset += result.bytesWritten;
  }
}

export function validateReadFileBytes(
  bytes: Uint8Array,
  expectedSize: number,
  maxBytes: number,
): Uint8Array {
  if (bytes.byteLength > maxBytes || bytes.byteLength !== expectedSize) {
    throw new AdapterStoreError('Adapter file changed while it was being read.');
  }
  return bytes;
}

export class AdapterStore {
  private readonly root: string;
  private readonly authorization: AdapterAdminAuthorization;

  public constructor(root = '/data/adapters', authorization?: AdapterAdminAuthorization) {
    if (authorization === undefined) throw new AdapterAuthorizationError('Adapter store requires an administrator authorization port.');
    this.root = resolve(root);
    this.authorization = authorization;
  }

  public async install(request: AdapterInstallRequest): Promise<AdapterRecord> {
    await this.requireAdmin('install');
    await this.ensureRoot();

    const manifest = parseAdapterManifest(request.manifest);
    const source = sourceBytes(request.source);
    let sourceText: string;
    try {
      sourceText = validateAdapterSource(source);
    } catch (error) {
      if (error instanceof AdapterSourcePolicyError) throw error;
      throw new AdapterStoreError('Adapter source validation failed.');
    }
    if (sha256(source) !== manifest.sha256) {
      throw new AdapterStoreError('adapter.mjs sha256 does not match manifest.json.');
    }
    validateAdapterExports(sourceText, manifest);
    if (sourceText.length === 0) throw new AdapterSourcePolicyError('adapter.mjs is empty.');

    const target = join(this.root, manifest.id);
    const staging = join(this.root, STAGING_DIRECTORY, randomUUID());
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await this.ensureDirectory(staging, 'Adapter staging directory');
    let committed = false;
    try {
      await this.assertNotPresent(target);
      await this.writeSecureFile(join(staging, MANIFEST_FILENAME), JSON.stringify(manifest), MAX_MANIFEST_BYTES);
      await this.writeSecureFile(join(staging, SOURCE_FILENAME), source, MAX_ADAPTER_SOURCE_BYTES);
      await this.syncDirectory(staging);
      try {
        await rename(staging, target);
      } catch (error) {
        if (isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY')) {
          throw new AdapterAlreadyInstalledError(`Adapter ${manifest.id} is already installed.`);
        }
        throw error;
      }
      committed = true;
      await this.syncDirectory(this.root);
      return { manifest };
    } finally {
      if (!committed) await this.removeStagingDirectory(staging);
    }
  }

  public async list(): Promise<readonly AdapterRecord[]> {
    await this.requireAdmin('read');
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const records: AdapterRecord[] = [];
    for (const entry of entries) {
      if (entry.name === STAGING_DIRECTORY) continue;
      if (!entry.isDirectory()) throw new AdapterStoreError('Adapter root contains an unexpected entry.');
      records.push({ manifest: (await this.readInstalled(entry.name)).manifest });
    }
    return records.sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  public async get(id: string): Promise<AdapterRecord> {
    await this.requireAdmin('read');
    return { manifest: (await this.readInstalled(id)).manifest };
  }

  public async remove(id: string): Promise<void> {
    await this.requireAdmin('remove');
    this.assertId(id);
    await this.ensureRoot();
    const directory = join(this.root, id);
    await this.assertAdapterDirectory(directory, id);
    try {
      await rm(directory, { recursive: true, force: false });
      await this.syncDirectory(this.root);
    } catch (error) {
      throw new AdapterStoreError(`Could not remove adapter ${id}; the installed files were left intact.` +
        (error instanceof Error ? ` ${error.message}` : ''));
    }
  }

  /** Internal runtime port; management authorization is deliberately not used here. */
  public runtimeReader(): AdapterRuntimeReader {
    return { readByRef: (reference) => this.readByRef(reference) };
  }

  public async close(): Promise<void> {
    // The store has no long-lived handles; this method makes lifecycle ownership explicit.
  }

  private async requireAdmin(action: 'install' | 'remove' | 'read'): Promise<void> {
    if (!this.authorization.adminEnabled) {
      throw new AdapterAuthorizationError('Administrator authorization is required for adapter management.');
    }
    await this.authorization.assertAdmin(action);
  }

  private async readByRef(reference: AdapterRuntimeReference): Promise<AdapterRuntimeRecord> {
    const parsedReference = CustomAdapterRefSchema.safeParse(reference);
    if (!parsedReference.success || parsedReference.data.kind !== 'trusted-javascript') {
      throw new AdapterStoreError('Adapter runtime reference is invalid.');
    }
    const loaded = await this.readInstalled(parsedReference.data.adapterId);
    if (
      loaded.manifest.version !== parsedReference.data.version ||
      loaded.manifest.sha256 !== parsedReference.data.digest
    ) {
      throw new AdapterStoreError('Adapter runtime reference does not match the installed manifest.');
    }
    return loaded;
  }

  private async readInstalled(id: string): Promise<AdapterRuntimeRecord> {
    this.assertId(id);
    await this.ensureRoot();
    const directory = join(this.root, id);
    await this.assertAdapterDirectory(directory, id);
    const manifest = parseBoundedManifestJson(
      await this.readRegularFile(join(directory, MANIFEST_FILENAME), MAX_MANIFEST_BYTES),
    );
    if (manifest.schemaVersion !== ADAPTER_MANIFEST_VERSION || manifest.id !== id) {
      throw new AdapterStoreError('Adapter manifest identity does not match its directory.');
    }
    const source = await this.readRegularFile(join(directory, SOURCE_FILENAME), MAX_ADAPTER_SOURCE_BYTES);
    const sourceText = validateAdapterSource(source);
    validateAdapterExports(sourceText, manifest);
    if (sha256(source) !== manifest.sha256) {
      throw new AdapterStoreError('Installed adapter source digest is invalid.');
    }
    return { manifest, source };
  }

  private assertId(id: string): void {
    try {
      parseAdapterManifest({
        schemaVersion: ADAPTER_MANIFEST_VERSION,
        id,
        version: '1',
        displayName: 'validation',
        sha256: '0'.repeat(64),
        operations: ['image.generate'],
        capabilities: {
          providerType: 'validation',
          models: [{ id: 'validation', displayName: 'validation', capabilities: { operations: ['image.generate'] } }],
        },
        allowedHosts: ['example.com'],
        requiredSecrets: [],
        resourceLimits: {
          timeoutMs: 1,
          maxMessageBytes: 1,
          maxOutputBytes: 1,
          maxLogBytes: 1,
          maxOldGenerationSizeMb: 1,
          maxYoungGenerationSizeMb: 1,
          stackSizeMb: 1,
        },
      });
    } catch {
      throw new AdapterStoreError('Adapter id is invalid.');
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      await this.ensureDirectory(this.root, 'Adapter root');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      try {
        await mkdir(this.root, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError;
      }
      await this.ensureDirectory(this.root, 'Adapter root');
    }
    const staging = join(this.root, STAGING_DIRECTORY);
    try {
      await this.ensureDirectory(staging, 'Adapter staging directory');
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
      try {
        await mkdir(staging, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, 'EEXIST')) throw mkdirError;
      }
      await this.ensureDirectory(staging, 'Adapter staging directory');
    }
  }

  private async assertNotPresent(target: string): Promise<void> {
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) throw new AdapterStoreError('Adapter target may not be a symlink.');
      throw new AdapterAlreadyInstalledError(`Adapter ${basename(target)} is already installed.`);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return;
      throw error;
    }
  }

  private async assertAdapterDirectory(directory: string, id: string): Promise<void> {
    const stats = await lstat(directory).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) throw new AdapterStoreError(`Adapter ${id} is not installed.`);
      throw error;
    });
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new AdapterStoreError('Adapter directory is unsafe.');
    if (await realpath(directory) !== directory) throw new AdapterStoreError('Adapter directory realpath is unsafe.');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length !== EXPECTED_FILES.size || entries.some((entry) => !EXPECTED_FILES.has(entry.name) || !entry.isFile())) {
      throw new AdapterStoreError('Adapter directory contains unexpected files.');
    }
  }

  private async writeSecureFile(path: string, value: string | Uint8Array, maxBytes: number): Promise<void> {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (bytes.byteLength > maxBytes) throw new AdapterStoreError('Adapter file exceeds its size limit.');
    const handle = await open(path, 'wx', 0o600);
    try {
      await writeAll((input, offset) => handle.write(input, offset), bytes);
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }

  private async readRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || !modeIsSecure(stats.mode, 0o600)) throw new AdapterStoreError('Adapter file mode or type is unsafe.');
      if (stats.size > maxBytes) throw new AdapterStoreError('Adapter file exceeds its size limit.');
      const bytes = Uint8Array.from(await handle.readFile());
      return validateReadFileBytes(bytes, stats.size, maxBytes);
    } finally {
      await handle.close();
    }
  }

  private async removeStagingDirectory(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      // A failed cleanup never replaces the install error; staging is outside the active adapter path.
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async ensureDirectory(path: string, label: string): Promise<void> {
    const initial = await lstat(path);
    if (initial.isSymbolicLink() || !initial.isDirectory()) throw new AdapterStoreError(`${label} must be a real directory.`);
    if (await realpath(path) !== path) throw new AdapterStoreError(`${label} realpath is unsafe.`);
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const verified = await handle.stat();
      if (!verified.isDirectory()) throw new AdapterStoreError(`${label} is not a directory.`);
      await handle.chmod(0o700);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function digestAdapterSource(source: string | Uint8Array): string {
  return sha256(sourceBytes(source));
}
