import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const LOCK_FILENAME = '.offline-maintenance.lock';
const LEASE_KIND = 'imagine-media-studio/offline-maintenance-lease-v1' as const;
const SERVER_RUNTIME_LEASE_KIND = 'imagine-media-studio/server-runtime-lease-v1' as const;
const DIRECTORY_MODE = 0o700;
const LOCK_MODE = 0o600;
const issuedLeases = new WeakSet<object>();

type RuntimeLeaseKind = typeof LEASE_KIND | typeof SERVER_RUNTIME_LEASE_KIND;

interface RuntimeLockFsOps {
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<Stats>;
  mkdir(path: string, options?: { readonly mode?: number; readonly recursive?: boolean }): Promise<string | undefined>;
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

const defaultFsOps: RuntimeLockFsOps = {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
};

interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly path: string;
  readonly uid: number;
}

export interface OfflineMaintenanceLease {
  readonly kind: typeof LEASE_KIND;
  readonly dataRoot: string;
  verify(): Promise<void>;
  release(): Promise<void>;
}

export interface ServerRuntimeLease {
  readonly kind: typeof SERVER_RUNTIME_LEASE_KIND;
  readonly dataRoot: string;
  verify(): Promise<void>;
  release(): Promise<void>;
}

export interface OfflineMaintenanceLeaseOptions {
  readonly dataRoot: string;
  /** The caller must prove that the application process is stopped. */
  readonly assertServerStopped: () => boolean | Promise<boolean>;
}

export class OfflineMaintenanceLeaseError extends Error {
  public override readonly name = 'OfflineMaintenanceLeaseError';
}

export class ServerRuntimeLeaseError extends Error {
  public override readonly name = 'ServerRuntimeLeaseError';
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function lockPath(dataRoot: string): string {
  return resolve(dataRoot, LOCK_FILENAME);
}

function leaseError<K extends RuntimeLeaseKind>(kind: K, message: string): Error {
  return kind === SERVER_RUNTIME_LEASE_KIND
    ? new ServerRuntimeLeaseError(message)
    : new OfflineMaintenanceLeaseError(message);
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function inspectDirectoryStats<K extends RuntimeLeaseKind>(stats: Stats, kind: K): RootIdentity {
  const expectedUid = currentUid();
  if (
    !stats.isDirectory()
    || (stats.mode & 0o777) !== DIRECTORY_MODE
    || !Number.isSafeInteger(stats.dev)
    || !Number.isSafeInteger(stats.ino)
    || !Number.isSafeInteger(stats.uid)
    || (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw leaseError(kind, 'Runtime maintenance requires a canonical 0700 data directory owned by the current user.');
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode & 0o777,
    path: '',
    uid: stats.uid,
  };
}

function assertSameRootIdentity(current: RootIdentity, expected: RootIdentity, kind: RuntimeLeaseKind): void {
  if (
    current.path !== expected.path
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.uid !== expected.uid
    || current.mode !== expected.mode
  ) {
    throw leaseError(kind, 'Runtime maintenance data root identity changed.');
  }
}

async function inspectSecureRoot<K extends RuntimeLeaseKind>(
  fsops: RuntimeLockFsOps,
  dataRoot: string,
  kind: K,
  expected?: RootIdentity,
): Promise<RootIdentity> {
  const root = resolve(dataRoot);
  let stats: Stats;
  try {
    stats = await fsops.lstat(root);
  } catch (error) {
    if (isCode(error, 'ENOENT')) throw leaseError(kind, 'Runtime maintenance data root is unavailable.');
    throw leaseError(kind, 'Runtime maintenance data root could not be inspected.');
  }
  if (stats.isSymbolicLink()) throw leaseError(kind, 'Runtime maintenance root may not be a symlink.');
  const identity = inspectDirectoryStats(stats, kind);
  const current = { ...identity, path: root };
  try {
    if (await fsops.realpath(root) !== root) throw leaseError(kind, 'Runtime maintenance root must be canonical.');
  } catch (error) {
    if (error instanceof OfflineMaintenanceLeaseError || error instanceof ServerRuntimeLeaseError) throw error;
    throw leaseError(kind, 'Runtime maintenance root could not be canonicalized.');
  }
  if (expected !== undefined) assertSameRootIdentity(current, expected, kind);
  return current;
}

async function inspectCanonicalParent<K extends RuntimeLeaseKind>(
  fsops: RuntimeLockFsOps,
  dataRoot: string,
  kind: K,
): Promise<void> {
  const parent = resolve(dirname(dataRoot));
  let stats: Stats;
  try {
    stats = await fsops.lstat(parent);
  } catch {
    throw leaseError(kind, 'Runtime maintenance data root parent is unavailable.');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw leaseError(kind, 'Runtime maintenance data root parent must be a real directory.');
  }
  try {
    if (await fsops.realpath(parent) !== parent) {
      throw leaseError(kind, 'Runtime maintenance data root parent must be canonical.');
    }
  } catch (error) {
    if (error instanceof OfflineMaintenanceLeaseError || error instanceof ServerRuntimeLeaseError) throw error;
    throw leaseError(kind, 'Runtime maintenance data root parent could not be canonicalized.');
  }
}

async function bootstrapServerRoot(fsops: RuntimeLockFsOps, dataRoot: string): Promise<RootIdentity> {
  const root = resolve(dataRoot);
  try {
    await fsops.lstat(root);
  } catch (error) {
    if (!isCode(error, 'ENOENT')) {
      throw new ServerRuntimeLeaseError('Runtime maintenance data root could not be inspected.');
    }
    await inspectCanonicalParent(fsops, root, SERVER_RUNTIME_LEASE_KIND);
    try {
      await fsops.mkdir(root, { mode: DIRECTORY_MODE, recursive: false });
      await fsops.chmod(root, DIRECTORY_MODE);
    } catch (createError) {
      if (!isCode(createError, 'EEXIST')) {
        throw new ServerRuntimeLeaseError('Runtime maintenance data root could not be created.');
      }
    }
  }
  return inspectSecureRoot(fsops, root, SERVER_RUNTIME_LEASE_KIND);
}

async function syncParent(fsops: RuntimeLockFsOps, path: string): Promise<void> {
  const handle = await fsops.open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function lockStatsMatch(current: Stats, expected: Stats, payload: Buffer): boolean {
  return lockIdentityMatch(current, expected)
    && current.size === payload.byteLength;
}

function lockIdentityMatch(current: Stats, expected: Stats): boolean {
  return current.isFile()
    && !current.isSymbolicLink()
    && (current.mode & 0o777) === LOCK_MODE
    && current.nlink === 1
    && Number.isSafeInteger(current.uid)
    && current.uid === expected.uid
    && current.dev === expected.dev
    && current.ino === expected.ino;
}

function lockIdentitiesMatch(...stats: readonly Stats[]): boolean {
  const [first, ...rest] = stats;
  return first !== undefined
    && lockIdentityMatch(first, first)
    && rest.every((candidate) => lockIdentityMatch(candidate, first));
}

function initialLockStatsAreOwned(stats: Stats, root: RootIdentity): boolean {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && (stats.mode & 0o777) === LOCK_MODE
    && stats.nlink === 1
    && Number.isSafeInteger(stats.uid)
    && stats.uid === root.uid
    && Number.isSafeInteger(stats.dev)
    && Number.isSafeInteger(stats.ino)
    && stats.dev === root.dev
    && stats.size === 0;
}

async function readLockPayload(handle: FileHandle, payload: Buffer): Promise<boolean> {
  const contents = Buffer.allocUnsafe(payload.byteLength);
  const read = await handle.read(contents, 0, contents.byteLength, 0);
  return read.bytesRead === payload.byteLength && contents.equals(payload);
}

async function readLockIsEmpty(handle: FileHandle): Promise<boolean> {
  const probe = Buffer.alloc(1);
  const read = await handle.read(probe, 0, probe.byteLength, 0);
  return read.bytesRead === 0;
}

async function closeHandle(handle: FileHandle | undefined): Promise<unknown | undefined> {
  if (handle === undefined) return undefined;
  try {
    await handle.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function cleanupAcquisition<K extends RuntimeLeaseKind>(options: {
  readonly dataRoot: string;
  readonly expectedRoot: RootIdentity;
  readonly handle: FileHandle | undefined;
  readonly initialLockStats: Stats | undefined;
  readonly handleStats: Stats | undefined;
  readonly handleStatFailed: boolean;
  readonly path: string;
  readonly payload: Buffer;
  readonly kind: K;
  readonly fsops: RuntimeLockFsOps;
}): Promise<readonly unknown[]> {
  const failures: unknown[] = [];
  if (options.handle !== undefined && !options.handleStatFailed && options.initialLockStats !== undefined) {
    try {
      let handleStats = options.handleStats;
      if (handleStats === undefined) {
        try { handleStats = await options.handle.stat(); } catch { /* Preserve the gate when ownership cannot be proven. */ }
      }
      if (handleStats !== undefined) {
        await inspectSecureRoot(options.fsops, options.dataRoot, options.kind, options.expectedRoot);
        const current = await options.fsops.lstat(options.path);
        const sameIdentity = lockIdentitiesMatch(current, options.initialLockStats, handleStats);
        const complete = sameIdentity
          && current.size === options.payload.byteLength
          && await readLockPayload(options.handle, options.payload);
        // A failure before the payload write leaves an empty inode that is
        // still ours when all ownership stats agree. Remove that inode, but
        // never infer ownership when an ownership stat is unavailable.
        const empty = sameIdentity
          && current.size === 0
          && await readLockIsEmpty(options.handle);
        const canUnlink = complete || empty;
        if (canUnlink) {
          try {
            await options.fsops.unlink(options.path);
          } catch (error) {
            if (!isCode(error, 'ENOENT')) failures.push(error);
          }
        }
      }
    } catch (error) {
      if (!isCode(error, 'ENOENT')) failures.push(error);
    }
  }
  const closeFailure = await closeHandle(options.handle);
  if (closeFailure !== undefined) failures.push(closeFailure);
  return failures;
}

class FileRuntimeLease<K extends RuntimeLeaseKind> {
  public readonly kind: K;
  public readonly dataRoot: string;
  private readonly lock: FileHandle;
  private readonly lockStats: Stats;
  private readonly payload: Buffer;
  private readonly rootIdentity: RootIdentity;
  private readonly fsops: RuntimeLockFsOps;
  private readonly assertServerStopped: (() => boolean | Promise<boolean>) | undefined;
  private handleClosed = false;
  private lockUnlinked = false;
  private parentSynced = false;
  private released = false;

  public constructor(
    kind: K,
    dataRoot: string,
    lock: FileHandle,
    lockStats: Stats,
    payload: Buffer,
    rootIdentity: RootIdentity,
    fsops: RuntimeLockFsOps,
    assertServerStopped: (() => boolean | Promise<boolean>) | undefined,
  ) {
    this.kind = kind;
    this.dataRoot = dataRoot;
    this.lock = lock;
    this.lockStats = lockStats;
    this.payload = payload;
    this.rootIdentity = rootIdentity;
    this.fsops = fsops;
    this.assertServerStopped = assertServerStopped;
  }

  public async verify(): Promise<void> {
    if (this.released) throw leaseError(this.kind, 'Runtime maintenance lease is released.');
    if (this.assertServerStopped !== undefined && !await this.assertServerStopped()) {
      throw leaseError(this.kind, 'Offline maintenance requires the application to remain stopped.');
    }
    await inspectSecureRoot(this.fsops, this.dataRoot, this.kind, this.rootIdentity);
    let current: Stats;
    try {
      current = await this.lock.stat();
    } catch {
      throw leaseError(this.kind, 'Runtime maintenance lease proof is no longer valid.');
    }
    if (!lockStatsMatch(current, this.lockStats, this.payload)) {
      throw leaseError(this.kind, 'Runtime maintenance lease proof is no longer valid.');
    }
    if (!await readLockPayload(this.lock, this.payload)) {
      throw leaseError(this.kind, 'Runtime maintenance lease proof is no longer valid.');
    }
    let pathStats: Stats;
    try {
      pathStats = await this.fsops.lstat(lockPath(this.dataRoot));
    } catch {
      throw leaseError(this.kind, 'Runtime maintenance lease lock was replaced.');
    }
    if (!lockStatsMatch(pathStats, this.lockStats, this.payload)) {
      throw leaseError(this.kind, 'Runtime maintenance lease lock was replaced.');
    }
  }

  public async release(): Promise<void> {
    if (this.released) return;
    let failure: unknown;
    let rootOwned = false;
    try {
      await inspectSecureRoot(this.fsops, this.dataRoot, this.kind, this.rootIdentity);
      rootOwned = true;
    } catch (error) {
      failure = error;
    }

    if (rootOwned && !this.lockUnlinked) {
      try {
        const path = lockPath(this.dataRoot);
        const pathStats = await this.fsops.lstat(path);
        const handleStats = await this.lock.stat();
        if (!lockIdentityMatch(pathStats, this.lockStats) || !lockIdentityMatch(handleStats, this.lockStats)) {
          throw leaseError(this.kind, 'Runtime maintenance lease lock was replaced.');
        }
        await this.fsops.unlink(path);
        this.lockUnlinked = true;
      } catch (error) {
        if (isCode(error, 'ENOENT')) {
          this.lockUnlinked = true;
        } else if (failure === undefined) {
          failure = error;
        }
      }
    }

    if (!this.handleClosed) {
      const closeFailure = await closeHandle(this.lock);
      if (closeFailure === undefined) this.handleClosed = true;
      else if (failure === undefined) failure = closeFailure;
    }

    if (rootOwned && this.lockUnlinked && !this.parentSynced) {
      try {
        await inspectSecureRoot(this.fsops, this.dataRoot, this.kind, this.rootIdentity);
        await syncParent(this.fsops, lockPath(this.dataRoot));
        this.parentSynced = true;
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    if (failure !== undefined) throw leaseError(this.kind, 'Runtime maintenance lease cleanup failed.');
    this.released = true;
    issuedLeases.delete(this);
  }
}

async function acquireRuntimeLease<K extends RuntimeLeaseKind>(options: {
  readonly assertServerStopped?: () => boolean | Promise<boolean>;
  readonly bootstrapRoot?: boolean;
  readonly dataRoot: string;
  readonly fsops?: Partial<RuntimeLockFsOps>;
  readonly kind: K;
}): Promise<FileRuntimeLease<K>> {
  const fsops = { ...defaultFsOps, ...(options.fsops ?? {}) };
  const initialRoot = options.bootstrapRoot
    ? await bootstrapServerRoot(fsops, options.dataRoot)
    : await inspectSecureRoot(fsops, options.dataRoot, options.kind);
  if (options.assertServerStopped !== undefined && !await options.assertServerStopped()) {
    throw new OfflineMaintenanceLeaseError('Offline maintenance requires the application to be stopped.');
  }
  const rootIdentity = await inspectSecureRoot(fsops, initialRoot.path, options.kind, initialRoot);
  const path = lockPath(rootIdentity.path);
  const payload = Buffer.from(JSON.stringify({
    kind: options.kind,
    root: rootIdentity.path,
    token: randomUUID(),
    version: 1,
  }) + '\n', 'utf8');
  let handle: FileHandle | undefined;
  let initialLockStats: Stats | undefined;
  let handleStats: Stats | undefined;
  let handleStatFailed = false;
  let lease: FileRuntimeLease<K> | undefined;
  try {
    handle = await fsops.open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      LOCK_MODE,
    );
    initialLockStats = await fsops.lstat(path);
    if (!initialLockStatsAreOwned(initialLockStats, rootIdentity)) {
      throw leaseError(options.kind, 'Runtime maintenance lease lock is unsafe.');
    }
    await handle.chmod(LOCK_MODE);
    await handle.writeFile(payload);
    await handle.sync();
    try {
      handleStats = await handle.stat();
    } catch (error) {
      handleStatFailed = true;
      throw error;
    }
    if (!lockStatsMatch(handleStats, { ...initialLockStats, size: payload.byteLength }, payload)) {
      throw leaseError(options.kind, 'Runtime maintenance lease lock could not be verified.');
    }
    const pathStats = await fsops.lstat(path);
    if (!lockStatsMatch(pathStats, handleStats, payload) || !await readLockPayload(handle, payload)) {
      throw leaseError(options.kind, 'Runtime maintenance lease lock was replaced.');
    }
    lease = new FileRuntimeLease(
      options.kind,
      rootIdentity.path,
      handle,
      handleStats,
      payload,
      rootIdentity,
      fsops,
      options.assertServerStopped,
    );
    issuedLeases.add(lease);
    await lease.verify();
    return lease;
  } catch (error) {
    const cleanupFailures = lease === undefined
      ? await cleanupAcquisition({
        dataRoot: rootIdentity.path,
        expectedRoot: rootIdentity,
        handle,
        initialLockStats,
        handleStats,
        handleStatFailed,
        path,
        payload,
        kind: options.kind,
        fsops,
      })
      : await (async () => {
        try {
          await lease!.release();
          return [] as readonly unknown[];
        } catch (releaseError) {
          return [releaseError];
        }
      })();
    if (cleanupFailures.length > 0) {
      throw leaseError(options.kind, 'Runtime maintenance lease cleanup failed.');
    }
    if (isCode(error, 'EEXIST')) {
      throw leaseError(options.kind, options.kind === SERVER_RUNTIME_LEASE_KIND
        ? 'Another runtime maintenance lease is active.'
        : 'Another runtime lease is active.');
    }
    if (error instanceof OfflineMaintenanceLeaseError || error instanceof ServerRuntimeLeaseError) throw error;
    throw leaseError(options.kind, 'Runtime maintenance lease could not be acquired.');
  }
}

export async function acquireOfflineMaintenanceLease(
  options: OfflineMaintenanceLeaseOptions,
): Promise<OfflineMaintenanceLease> {
  return acquireRuntimeLease({
    assertServerStopped: options.assertServerStopped,
    dataRoot: options.dataRoot,
    kind: LEASE_KIND,
  });
}

export async function acquireServerRuntimeLease(dataRoot: string): Promise<ServerRuntimeLease> {
  return acquireRuntimeLease({
    bootstrapRoot: true,
    dataRoot,
    kind: SERVER_RUNTIME_LEASE_KIND,
  });
}

export const __testing = {
  acquireOfflineMaintenanceLease: (
    options: OfflineMaintenanceLeaseOptions & { readonly fsops: Partial<RuntimeLockFsOps> },
  ): Promise<OfflineMaintenanceLease> => acquireRuntimeLease({
    assertServerStopped: options.assertServerStopped,
    dataRoot: options.dataRoot,
    kind: LEASE_KIND,
    fsops: options.fsops,
  }),
} as const;

export async function assertOfflineMaintenanceLease(
  lease: OfflineMaintenanceLease | undefined,
  dataRoot: string,
): Promise<void> {
  if (
    lease === undefined
    || lease.kind !== LEASE_KIND
    || typeof lease !== 'object'
    || !issuedLeases.has(lease)
  ) {
    throw new OfflineMaintenanceLeaseError('A verifiable offline maintenance lease is required.');
  }
  const root = resolve(dataRoot);
  if (resolve(lease.dataRoot) !== root) {
    throw new OfflineMaintenanceLeaseError('Offline maintenance lease does not match the data root.');
  }
  await lease.verify();
}

export {
  LEASE_KIND as OFFLINE_MAINTENANCE_LEASE_KIND,
  LOCK_FILENAME as OFFLINE_MAINTENANCE_LOCK_FILENAME,
  SERVER_RUNTIME_LEASE_KIND,
};
