import { constants, type Stats } from 'node:fs';
import {
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
const DIRECTORY_MODE = 0o700;
const LOCK_MODE = 0o600;
const issuedLeases = new WeakSet<object>();

export interface OfflineMaintenanceLease {
  readonly kind: typeof LEASE_KIND;
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

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function lockPath(dataRoot: string): string {
  return resolve(dataRoot, LOCK_FILENAME);
}

function assertSecureDirectoryStats(stats: Stats): void {
  if (!stats.isDirectory() || (stats.mode & 0o777) !== DIRECTORY_MODE) {
    throw new OfflineMaintenanceLeaseError('Offline maintenance requires a canonical 0700 data directory.');
  }
}

async function assertSecureRoot(dataRoot: string): Promise<string> {
  const root = resolve(dataRoot);
  const stats = await lstat(root);
  if (stats.isSymbolicLink()) throw new OfflineMaintenanceLeaseError('Offline maintenance root may not be a symlink.');
  assertSecureDirectoryStats(stats);
  if (await realpath(root) !== root) throw new OfflineMaintenanceLeaseError('Offline maintenance root must be canonical.');
  return root;
}

async function syncParent(path: string): Promise<void> {
  const handle = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class FileOfflineMaintenanceLease implements OfflineMaintenanceLease {
  public readonly kind = LEASE_KIND;
  public readonly dataRoot: string;
  private readonly lock: FileHandle;
  private readonly lockStats: Stats;
  private readonly payload: Buffer;
  private readonly assertServerStopped: () => boolean | Promise<boolean>;
  private handleClosed = false;
  private lockUnlinked = false;
  private parentSynced = false;
  private released = false;

  public constructor(
    dataRoot: string,
    lock: FileHandle,
    lockStats: Stats,
    payload: Buffer,
    assertServerStopped: () => boolean | Promise<boolean>,
  ) {
    this.dataRoot = dataRoot;
    this.lock = lock;
    this.lockStats = lockStats;
    this.payload = payload;
    this.assertServerStopped = assertServerStopped;
  }

  public async verify(): Promise<void> {
    if (this.released) throw new OfflineMaintenanceLeaseError('Offline maintenance lease is released.');
    if (!await this.assertServerStopped()) {
      throw new OfflineMaintenanceLeaseError('Offline maintenance requires the application to remain stopped.');
    }
    await assertSecureRoot(this.dataRoot);
    const current = await this.lock.stat();
    if (
      !current.isFile()
      || (current.mode & 0o777) !== LOCK_MODE
      || current.nlink !== 1
      || current.dev !== this.lockStats.dev
      || current.ino !== this.lockStats.ino
      || current.size !== this.payload.byteLength
    ) {
      throw new OfflineMaintenanceLeaseError('Offline maintenance lease proof is no longer valid.');
    }
    const contents = Buffer.allocUnsafe(this.payload.byteLength);
    const read = await this.lock.read(contents, 0, contents.byteLength, 0);
    if (read.bytesRead !== this.payload.byteLength || !contents.equals(this.payload)) {
      throw new OfflineMaintenanceLeaseError('Offline maintenance lease proof is no longer valid.');
    }
    const pathStats = await lstat(lockPath(this.dataRoot));
    if (
      pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || (pathStats.mode & 0o777) !== LOCK_MODE
      || pathStats.nlink !== 1
      || pathStats.dev !== this.lockStats.dev
      || pathStats.ino !== this.lockStats.ino
    ) {
      throw new OfflineMaintenanceLeaseError('Offline maintenance lease lock was replaced.');
    }
  }

  public async release(): Promise<void> {
    if (this.released) return;
    let closeFailed = false;
    if (!this.handleClosed) {
      try {
        await this.lock.close();
        this.handleClosed = true;
      } catch {
        closeFailed = true;
      }
    }
    if (!this.lockUnlinked) {
      try {
        const current = await lstat(lockPath(this.dataRoot));
        if (
          current.dev !== this.lockStats.dev
          || current.ino !== this.lockStats.ino
          || current.nlink !== 1
        ) throw new OfflineMaintenanceLeaseError('Offline maintenance lease cleanup failed.');
        await unlink(lockPath(this.dataRoot));
        this.lockUnlinked = true;
      } catch (error) {
        if (isCode(error, 'ENOENT')) {
          this.lockUnlinked = true;
        } else {
          throw new OfflineMaintenanceLeaseError('Offline maintenance lease cleanup failed.');
        }
      }
    }
    if (closeFailed) throw new OfflineMaintenanceLeaseError('Offline maintenance lease cleanup failed.');
    if (!this.parentSynced) {
      try {
        await syncParent(lockPath(this.dataRoot));
        this.parentSynced = true;
      } catch {
        throw new OfflineMaintenanceLeaseError('Offline maintenance lease cleanup failed.');
      }
    }
    this.released = true;
    issuedLeases.delete(this);
  }
}

export async function acquireOfflineMaintenanceLease(
  options: OfflineMaintenanceLeaseOptions,
): Promise<OfflineMaintenanceLease> {
  await assertSecureRoot(options.dataRoot);
  if (!await options.assertServerStopped()) {
    throw new OfflineMaintenanceLeaseError('Offline maintenance requires the application to be stopped.');
  }
  // Recheck after the caller's liveness probe so a root replacement between
  // the probe and lock creation cannot move the lease outside the validated
  // 0700 canonical directory.
  const verifiedRoot = await assertSecureRoot(options.dataRoot);
  const path = lockPath(verifiedRoot);
  await mkdir(verifiedRoot, { recursive: false, mode: DIRECTORY_MODE }).catch((error: unknown) => {
    if (!isCode(error, 'EEXIST')) throw new OfflineMaintenanceLeaseError('Offline maintenance root is unavailable.');
  });
  let handle: FileHandle;
  const payload = Buffer.from(JSON.stringify({ kind: LEASE_KIND, root: verifiedRoot, version: 1 }) + '\n', 'utf8');
  let created = false;
  try {
    handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      LOCK_MODE,
    );
    created = true;
    await handle.chmod(LOCK_MODE);
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    if (created) {
      try { await handle!.close(); } catch { /* Preserve the lease acquisition failure. */ }
      try { await unlink(path); } catch { /* Preserve the lease acquisition failure. */ }
    }
    if (isCode(error, 'EEXIST')) throw new OfflineMaintenanceLeaseError('Another offline maintenance lease is active.');
    throw new OfflineMaintenanceLeaseError('Offline maintenance lease could not be acquired.');
  }
  const stats = await handle.stat();
  const lease = new FileOfflineMaintenanceLease(
    verifiedRoot,
    handle,
    stats,
    payload,
    options.assertServerStopped,
  );
  issuedLeases.add(lease);
  try {
    await lease.verify();
  } catch (error) {
    try { await lease.release(); } catch { /* Preserve the lease proof failure. */ }
    issuedLeases.delete(lease);
    if (error instanceof OfflineMaintenanceLeaseError) throw error;
    throw new OfflineMaintenanceLeaseError('Offline maintenance lease proof could not be verified.');
  }
  return lease;
}

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

export { LEASE_KIND as OFFLINE_MAINTENANCE_LEASE_KIND, LOCK_FILENAME as OFFLINE_MAINTENANCE_LOCK_FILENAME };
