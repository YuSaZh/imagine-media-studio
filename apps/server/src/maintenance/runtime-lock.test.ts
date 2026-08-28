import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureStorage, getStoragePaths } from '../storage/paths.js';
import {
  OFFLINE_MAINTENANCE_LOCK_FILENAME,
  OFFLINE_MAINTENANCE_LEASE_KIND,
  OfflineMaintenanceLeaseError,
  acquireOfflineMaintenanceLease,
  assertOfflineMaintenanceLease,
} from './runtime-lock.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
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

  it('rejects a symlinked data root', async () => {
    const target = await fixture('ims-archive-lock-target-');
    const linkRoot = join(await mkdtemp(join(tmpdir(), 'ims-archive-lock-link-')), 'data');
    temporaryDirectories.push(linkRoot.slice(0, linkRoot.lastIndexOf('/')));
    await symlink(target.root, linkRoot);
    await expect(acquireOfflineMaintenanceLease({ assertServerStopped: () => true, dataRoot: linkRoot })).rejects.toThrow(OfflineMaintenanceLeaseError);
  });
});
