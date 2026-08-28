import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  open as fsOpen,
  readFile,
  realpath as fsRealpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import {
  OFFLINE_MAINTENANCE_LOCK_FILENAME,
  OFFLINE_MAINTENANCE_LEASE_KIND,
  OfflineMaintenanceLeaseError,
  ServerRuntimeLeaseError,
  acquireOfflineMaintenanceLease,
  acquireServerRuntimeLease,
  assertOfflineMaintenanceLease,
  SERVER_RUNTIME_LEASE_KIND,
  __testing,
} from './runtime-lock.js';

const temporaryDirectories: string[] = [];
type TestFsOps = NonNullable<Parameters<typeof __testing.acquireOfflineMaintenanceLease>[0]['fsops']>;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  return paths;
}

describe('offline maintenance lease', () => {
  it('requires a proof and binds it to the canonical data root', async () => {
    const paths = await fixture('ims-archive-lock-');
    await expect(assertOfflineMaintenanceLease(undefined, paths.root)).rejects.toThrow(OfflineMaintenanceLeaseError);
    const lease = {
      dataRoot: paths.root,
      kind: OFFLINE_MAINTENANCE_LEASE_KIND,
      release: vi.fn(async () => undefined),
      verify: vi.fn(async () => undefined),
    };
    await expect(assertOfflineMaintenanceLease(lease, paths.root)).rejects.toThrow(OfflineMaintenanceLeaseError);
    expect(lease.verify).not.toHaveBeenCalled();
    const probe = vi.fn(() => true);
    const issued = await acquireOfflineMaintenanceLease({ assertServerStopped: probe, dataRoot: paths.root });
    await assertOfflineMaintenanceLease(issued, paths.root);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2);
    await issued.release();
    await expect(assertOfflineMaintenanceLease(issued, paths.root)).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(assertOfflineMaintenanceLease(lease, join(paths.root, '..'))).rejects.toThrow(OfflineMaintenanceLeaseError);
  });

  it('only acquires when the caller proves the application is stopped', async () => {
    const paths = await fixture('ims-archive-lock-stopped-');
    await expect(acquireOfflineMaintenanceLease({
      assertServerStopped: () => false,
      dataRoot: paths.root,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });

    const lease = await acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
    });
    expect(lease.kind).toBe(OFFLINE_MAINTENANCE_LEASE_KIND);
    await lease.verify();
    expect(await readFile(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME), 'utf8')).toContain('offline-maintenance-lease-v1');
    await writeFile(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME), 'tampered\n', { mode: 0o600 });
    await expect(lease.verify()).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: paths.root })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await lease.release();
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses one atomic gate for server and offline maintenance contenders', async () => {
    const paths = await fixture('ims-archive-lock-shared-');
    const serverLease = await acquireServerRuntimeLease(paths.root);
    expect(serverLease.kind).toBe(SERVER_RUNTIME_LEASE_KIND);
    await expect(acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await serverLease.release();

    const offlineLease = await acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
    });
    await expect(acquireServerRuntimeLease(paths.root)).rejects.toThrow(ServerRuntimeLeaseError);
    await offlineLease.release();
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows exactly one server or offline contender to win the gate race', async () => {
    const paths = await fixture('ims-archive-lock-race-');
    const results = await Promise.allSettled([
      acquireServerRuntimeLease(paths.root),
      acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: paths.root }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireServerRuntimeLease>>> => result.status === 'fulfilled');
    expect(winner).toBeDefined();
    await winner!.value.release();
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not remove an unknown or stale gate automatically', async () => {
    const paths = await fixture('ims-archive-lock-stale-');
    const lockPath = join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME);
    await writeFile(lockPath, 'unknown-runtime-state\n', { mode: 0o600 });
    await expect(acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(acquireServerRuntimeLease(paths.root)).rejects.toThrow(ServerRuntimeLeaseError);
    expect(await readFile(lockPath, 'utf8')).toBe('unknown-runtime-state\n');
  });

  it('bootstraps only an absent server root and keeps it canonical', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ims-archive-lock-bootstrap-parent-'));
    temporaryDirectories.push(parent);
    const root = join(parent, 'data');
    const lease = await acquireServerRuntimeLease(root);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual([OFFLINE_MAINTENANCE_LOCK_FILENAME]);
    await lease.release();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not mkdir or modify an existing offline root while acquiring its lease', async () => {
    const paths = await fixture('ims-archive-lock-no-mkdir-');
    const mkdirSpy = vi.fn(async () => { throw new Error('offline root must not be bootstrapped'); });
    const lease = await __testing.acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
      fsops: { mkdir: mkdirSpy },
    });
    expect(mkdirSpy).not.toHaveBeenCalled();
    await lease.release();
  });

  it('rejects a data-root owner mismatch before creating the gate', async () => {
    const paths = await fixture('ims-archive-lock-uid-');
    const uid = process.getuid?.();
    if (uid === undefined) return;
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a replaced data root and replacement gate during verify and release', async () => {
    const paths = await fixture('ims-archive-lock-root-replacement-');
    const lease = await acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: paths.root });
    const originalRoot = `${paths.root}-original`;
    await rename(paths.root, originalRoot);
    await mkdir(paths.root, { mode: 0o700 });
    await expect(lease.verify()).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(lease.release()).rejects.toThrow(OfflineMaintenanceLeaseError);
    expect(await readFile(join(originalRoot, OFFLINE_MAINTENANCE_LOCK_FILENAME), 'utf8')).toContain('offline-maintenance-lease-v1');
    await rm(originalRoot, { force: true, recursive: true });
    await rm(paths.root, { force: true, recursive: true });
  });

  it('preserves a replacement gate inode during release', async () => {
    const paths = await fixture('ims-archive-lock-replacement-');
    const lease = await acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: paths.root });
    const lockPath = join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME);
    const replacementPath = join(paths.root, '.replacement-lock');
    await rename(lockPath, replacementPath);
    await writeFile(lockPath, 'replacement-runtime-state\n', { mode: 0o600 });
    await expect(lease.release()).rejects.toThrow(OfflineMaintenanceLeaseError);
    expect(await readFile(lockPath, 'utf8')).toBe('replacement-runtime-state\n');
    await rm(replacementPath, { force: true });
    await rm(lockPath, { force: true });
  });

  it('preserves the gate when fstat fails before the lease is returned', async () => {
    const paths = await fixture('ims-archive-lock-fstat-');
    const lockPath = join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME);
    const fsops: TestFsOps = {
      open: async (path, flags, mode) => {
        const handle = await fsOpen(path, flags, mode);
        if (path === lockPath) {
          handle.stat = async () => { throw new Error('injected fstat failure'); };
        }
        return handle;
      },
    };
    await expect(__testing.acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
      fsops,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    // A failed fstat leaves ownership ambiguous, so the gate is intentionally
    // retained for controlled stale-lock recovery rather than unlinked here.
    expect((await lstat(lockPath)).isFile()).toBe(true);
    await rm(lockPath, { force: true });

    const lease = await acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: paths.root });
    await lease.release();
  });

  it('cleans an owned empty gate after a pre-fstat write failure', async () => {
    const paths = await fixture('ims-archive-lock-write-failure-');
    const lockPath = join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME);
    const fsops: TestFsOps = {
      open: async (path, flags, mode) => {
        const handle = await fsOpen(path, flags, mode);
        if (path === lockPath) {
          handle.writeFile = async () => { throw new Error('injected write failure'); };
        }
        return handle;
      },
    };
    await expect(__testing.acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
      fsops,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves replacement path B when fstat fails after opening inode A', async () => {
    const paths = await fixture('ims-archive-lock-race-replacement-');
    const lockPath = join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME);
    const originalPath = join(paths.root, '.original-lock-inode');
    const fsops: TestFsOps = {
      open: async (path, flags, mode) => {
        const handle = await fsOpen(path, flags, mode);
        if (path === lockPath) {
          const writeFileToHandle = handle.writeFile.bind(handle);
          handle.writeFile = async (data, options) => {
            await writeFileToHandle(data, options);
            await rename(lockPath, originalPath);
            await writeFile(lockPath, 'replacement-runtime-state\n', { mode: 0o600 });
          };
          handle.stat = async () => { throw new Error('injected fstat failure after path replacement'); };
        }
        return handle;
      },
    };
    await expect(__testing.acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
      fsops,
    })).rejects.toThrow(OfflineMaintenanceLeaseError);
    expect(await readFile(lockPath, 'utf8')).toBe('replacement-runtime-state\n');
    expect((await lstat(originalPath)).isFile()).toBe(true);
    await rm(originalPath, { force: true });
    await rm(lockPath, { force: true });
  });

  it('cleans a lease after a verify failure without releasing a replacement root', async () => {
    const paths = await fixture('ims-archive-lock-verify-');
    let failVerify = false;
    const fsops: TestFsOps = {
      realpath: async (path) => {
        if (failVerify && path === paths.root) throw new Error('injected verify root failure');
        return fsRealpath(path);
      },
    };
    const lease = await __testing.acquireOfflineMaintenanceLease({
      assertServerStopped: () => true,
      dataRoot: paths.root,
      fsops,
    });
    failVerify = true;
    await expect(lease.verify()).rejects.toThrow(OfflineMaintenanceLeaseError);
    failVerify = false;
    await lease.release();
    await expect(lstat(join(paths.root, OFFLINE_MAINTENANCE_LOCK_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked data root', async () => {
    const target = await fixture('ims-archive-lock-target-');
    const linkRoot = join(await mkdtemp(join(tmpdir(), 'ims-archive-lock-link-')), 'data');
    temporaryDirectories.push(linkRoot.slice(0, linkRoot.lastIndexOf('/')));
    await symlink(target.root, linkRoot);
    await expect(acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: linkRoot })).rejects.toThrow(OfflineMaintenanceLeaseError);
  });
});
