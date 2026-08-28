import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { AssetRepository } from './assets.js';
import { createDatabase, type DatabaseClient } from './client.js';
import { JobRepository } from './jobs.js';
import {
  MEDIA_REPAIR_MAX_BACKOFF_MS,
  MEDIA_REPAIR_MAX_SCAN_ISSUES,
  MediaRepairQueueError,
  MediaRepairQueueRepository,
  type MediaRepairIssueInput,
  mediaRepairIssueKey,
} from './media-repair.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const PRE_QUEUE_MIGRATIONS = [
  '0000_pr0.sql',
  '0001_pr2_core.sql',
  '0002_pr4_runtime_safety.sql',
  '0003_pr5_video_runtime.sql',
  '0004_pr6_custom_adapters.sql',
  '0005_pr6_trusted_adapter_tombstones.sql',
  '0006_pr8_migration_checksums.sql',
] as const;
const ALL_MIGRATIONS = [...PRE_QUEUE_MIGRATIONS, '0007_pr8_media_repair_queue.sql'] as const;

function issue(name: string, overrides: Partial<MediaRepairIssueInput> = {}): MediaRepairIssueInput {
  return {
    assetId: null,
    jobId: null,
    kind: 'missing' as const,
    storedPath: `media/uploads/${name}.png`,
    ...overrides,
  };
}

async function copyMigrationSet(destination: string, names: readonly string[]): Promise<void> {
  await mkdir(destination, { recursive: true });
  const manifest = JSON.parse(
    await readFile(resolve(migrationsDirectory, 'manifest.json'), 'utf8'),
  ) as { migrations: Record<string, string>; version: number };
  for (const name of names) {
    await copyFile(resolve(migrationsDirectory, name), resolve(destination, name));
  }
  await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify({
    migrations: Object.fromEntries(names.map((name) => [name, manifest.migrations[name]])),
    version: manifest.version,
  }, null, 2)}\n`);
}

async function databaseFixture(prefix: string): Promise<{ database: DatabaseClient; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  return { database, directory };
}

function at(milliseconds: number): Date {
  return new Date(milliseconds);
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => {
    try {
      database.sqlite.close();
    } catch {
      // A restart test may have already closed the connection.
    }
  }));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('media repair queue migration', () => {
  it('creates the bounded queue table, indexes, and the current migration entry', async () => {
    const { database } = await databaseFixture('imagine-media-repair-schema-');
    expect(database.sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: '0007_pr8_media_repair_queue.sql',
    });
    const columns = database.sqlite
      .prepare("PRAGMA table_info('media_repair_queue')")
      .all() as Array<{ readonly name: string; readonly notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'issue_key',
      'asset_id',
      'job_id',
      'kind',
      'stored_path',
      'state',
      'attempts',
      'next_attempt_at',
      'lease_until',
      'last_error_code',
      'first_seen_at',
      'last_seen_at',
      'resolved_at',
    ]);
    expect(columns.filter((column) => column.notnull === 1).map((column) => column.name)).toEqual([
      'issue_key',
      'kind',
      'stored_path',
      'state',
      'attempts',
      'next_attempt_at',
      'first_seen_at',
      'last_seen_at',
    ]);
    const indexes = database.sqlite
      .prepare("PRAGMA index_list('media_repair_queue')")
      .all() as Array<{ readonly name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'media_repair_queue_issue_key_idx',
      'media_repair_queue_due_idx',
      'media_repair_queue_lease_idx',
      'media_repair_queue_asset_idx',
      'media_repair_queue_job_idx',
      'media_repair_queue_seen_idx',
    ]));
    const insert = database.sqlite.prepare(
      `INSERT INTO media_repair_queue (
        issue_key, kind, stored_path, state, attempts, next_attempt_at,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run('b'.repeat(64), 'missing', '/data/app.db', 'open', 0, 1, 1, 1)).toThrow();
    expect(() => insert.run('c'.repeat(64), 'missing', 'media/uploads/a.png', 'invalid', 0, 1, 1, 1)).toThrow();
    expect(() => insert.run('d'.repeat(64), 'missing', 'media/uploads/a.png', 'running', 0, 1, 1, 1)).toThrow();
    const insertWithTiming = database.sqlite.prepare(
      `INSERT INTO media_repair_queue (
        issue_key, kind, stored_path, state, attempts, next_attempt_at,
        lease_until, first_seen_at, last_seen_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insertWithTiming.run('e'.repeat(64), 'missing', 'media/uploads/a.png', 'running', 0, 1, -1, 1, 1, null)).toThrow();
    expect(() => insertWithTiming.run('f'.repeat(64), 'missing', 'media/uploads/a.png', 'resolved', 0, 1, null, 1, 1, -1)).toThrow();
  });

  it('upgrades a pre-queue database and rejects a tampered queue migration manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagine-media-repair-upgrade-'));
    temporaryDirectories.push(root);
    const databasePath = resolve(root, 'app.db');
    const oldMigrations = join(root, 'old-migrations');
    const newMigrations = join(root, 'new-migrations');
    await copyMigrationSet(oldMigrations, PRE_QUEUE_MIGRATIONS);
    const old = createDatabase(databasePath, oldMigrations);
    old.sqlite.close();
    await copyMigrationSet(newMigrations, ALL_MIGRATIONS);
    const upgraded = createDatabase(databasePath, newMigrations);
    databases.push(upgraded);
    expect(upgraded.sqlite.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: 8 });
    expect(upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_repair_queue'").get())
      .toEqual({ name: 'media_repair_queue' });
    upgraded.sqlite.close();
    databases.splice(databases.indexOf(upgraded), 1);

    const tampered = join(root, 'tampered-migrations');
    await copyMigrationSet(tampered, ALL_MIGRATIONS);
    await writeFile(
      resolve(tampered, '0007_pr8_media_repair_queue.sql'),
      `${await readFile(resolve(tampered, '0007_pr8_media_repair_queue.sql'), 'utf8')}\n-- drift\n`,
    );
    expect(() => createDatabase(resolve(root, 'tampered.db'), tampered)).toThrow('checksum mismatch');
  });

  it('rejects a corrupted queue row without exposing its stored contents', async () => {
    const { database } = await databaseFixture('imagine-media-repair-corruption-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('corrupt');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });
    database.sqlite.pragma('ignore_check_constraints = ON');
    database.sqlite.prepare('UPDATE media_repair_queue SET state = ? WHERE issue_key = ?').run('corrupt-state', key);

    expect(() => queue.get(key)).toThrow(MediaRepairQueueError);
    expect(() => queue.get(key)).toThrow('queue row is invalid');
  });
});

describe('MediaRepairQueueRepository', () => {
  it('reports only due open rows for bounded worker truncation checks', async () => {
    const { database } = await databaseFixture('imagine-media-repair-due-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('due');

    queue.upsertScan([current], { now: at(1_000) });
    expect(queue.hasDue(at(999))).toBe(false);
    expect(queue.hasDue(at(1_000))).toBe(true);
    const claimed = queue.claimNext({ now: at(1_000), leaseMs: 1_000 });
    expect(claimed).not.toBeNull();
    expect(queue.hasDue(at(1_000))).toBe(false);
    expect(queue.retry(mediaRepairIssueKey(current), {
      errorCode: 'repair_failed',
      expectedAttempts: claimed!.attempts,
      expectedLeaseUntil: claimed!.leaseUntil!,
      now: at(1_100),
    })).not.toBeNull();
    expect(queue.hasDue(at(1_100))).toBe(false);
    expect(queue.hasDue(at(3_100))).toBe(true);
  });

  it('upserts duplicate issues deterministically and keeps a bounded issue key', async () => {
    const { database } = await databaseFixture('imagine-media-repair-upsert-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('same');

    const first = queue.upsertScan([current, current], { now: at(1_000) });
    const second = queue.upsertScan([current], { now: at(2_000) });
    const row = queue.get(mediaRepairIssueKey(current));

    expect(first).toMatchObject({ inserted: 1, reopened: 0, resolved: 0, seen: 1, truncated: false, updated: 0 });
    expect(second).toMatchObject({ inserted: 0, reopened: 0, resolved: 0, seen: 1, truncated: false, updated: 1 });
    expect(row).toMatchObject({
      firstSeenAt: at(1_000),
      issueKey: mediaRepairIssueKey(current),
      lastSeenAt: at(2_000),
      state: 'open',
    });
    expect(row?.issueKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(queue.list()).toHaveLength(1);
  });

  it('normalizes an unsafe path before deriving or storing its issue key', async () => {
    const { database } = await databaseFixture('imagine-media-repair-path-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('unsafe', { storedPath: '/data/app.db' });
    const key = mediaRepairIssueKey(current);

    queue.upsertScan([current], { now: at(1_000) });

    expect(queue.get(key)).toMatchObject({ issueKey: key, storedPath: '<unsafe-path>' });
    expect(JSON.stringify(queue.list())).not.toContain('/data/app.db');
  });

  it('does not resolve old issues when a scan is truncated, then resolves them on a complete scan', async () => {
    const { database } = await databaseFixture('imagine-media-repair-truncated-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('stale');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });

    const truncated = queue.upsertScan([], { now: at(2_000), truncated: true });
    expect(truncated).toMatchObject({ resolved: 0, truncated: true });
    expect(queue.get(key)?.state).toBe('open');

    const complete = queue.upsertScan([], { now: at(3_000) });
    expect(complete).toMatchObject({ resolved: 1, truncated: false });
    expect(queue.get(key)).toMatchObject({ resolvedAt: at(3_000), state: 'resolved' });
  });

  it('does not resolve a running issue while its lease is still valid', async () => {
    const { database } = await databaseFixture('imagine-media-repair-active-lease-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('active-lease');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });
    const claimed = queue.claimNext({ leaseMs: 1_000, now: at(1_000) });
    expect(claimed).toMatchObject({ issueKey: key, leaseUntil: at(2_000), state: 'running' });

    expect(queue.upsertScan([], { now: at(1_999) })).toMatchObject({ resolved: 0, truncated: false });
    expect(queue.get(key)).toMatchObject({ leaseUntil: at(2_000), state: 'running' });
    expect(queue.upsertScan([], { now: at(2_000) })).toMatchObject({ resolved: 1, truncated: false });
    expect(queue.get(key)).toMatchObject({ leaseUntil: null, state: 'resolved' });
  });

  it('sets both foreign keys to NULL when their source rows are removed', async () => {
    const { database } = await databaseFixture('imagine-media-repair-fk-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const jobs = new JobRepository(database.orm);
    const assets = new AssetRepository(database.orm);
    const job = jobs.create(createMockGenerationRequest());
    const asset = assets.create({
      filePath: 'media/uploads/fk.png',
      fileSize: 1,
      jobId: job.id,
      mimeType: 'image/png',
      role: 'upload',
      sha256: 'a'.repeat(64),
      type: 'image',
    });
    const current = issue('fk', { assetId: asset.id, jobId: job.id });
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });

    database.sqlite.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
    expect(queue.get(key)).toMatchObject({ assetId: null, jobId: job.id });
    database.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    expect(queue.get(key)).toMatchObject({ assetId: null, jobId: null });
    expect(database.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('claims one row with CAS, rejects stale leases, and supports retry/manual/resolve', async () => {
    const { database } = await databaseFixture('imagine-media-repair-transitions-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('transition');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });
    const claimed = queue.claimNext({ leaseMs: 1_000, now: at(1_000) });
    if (claimed === null || claimed.leaseUntil === null) throw new Error('Expected a leased repair row.');
    const other = issue('transition-other');
    queue.upsertScan([current, other], { now: at(1_000) });
    const contender = new MediaRepairQueueRepository(database.orm);
    const concurrentClaims = await Promise.all([
      Promise.resolve().then(() => contender.claimNext({ leaseMs: 1_000, now: at(1_000) })),
      Promise.resolve().then(() => queue.claimNext({ leaseMs: 1_000, now: at(1_000) })),
    ]);

    expect(claimed).toMatchObject({ attempts: 1, issueKey: key, leaseUntil: at(2_000), state: 'running' });
    expect(concurrentClaims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(concurrentClaims.find((claim) => claim !== null)?.issueKey).toBe(mediaRepairIssueKey(other));
    expect(queue.resolve(key, {
      expectedAttempts: claimed.attempts,
      expectedLeaseUntil: at(1_999),
      now: at(1_100),
    })).toBeNull();
    const retried = queue.retry(key, {
      errorCode: 'secret error\nstack trace',
      expectedAttempts: claimed.attempts,
      expectedLeaseUntil: claimed.leaseUntil,
      now: at(1_100),
    });
    if (retried === null) throw new Error('Expected the leased repair row to be retried.');
    expect(retried).toMatchObject({ lastErrorCode: 'unknown', state: 'open' });
    expect(retried.nextAttemptAt.getTime()).toBeGreaterThan(1_100);
    expect(retried.nextAttemptAt.getTime() - 1_100).toBeLessThanOrEqual(MEDIA_REPAIR_MAX_BACKOFF_MS);

    const manual = queue.markManual(key, { now: at(1_200) });
    expect(manual).toMatchObject({ state: 'manual', leaseUntil: null, resolvedAt: null });
    const reopened = queue.retry(key, { now: at(1_300) });
    expect(reopened).toMatchObject({ state: 'open', leaseUntil: null, resolvedAt: null });
    if (reopened === null) throw new Error('Expected the manual row to reopen.');
    const claimedAgain = queue.claimNext({ now: reopened.nextAttemptAt, leaseMs: 1_000 });
    if (claimedAgain === null || claimedAgain.leaseUntil === null) throw new Error('Expected a second claim.');
    const resolved = queue.resolve(key, {
      expectedAttempts: claimedAgain.attempts,
      expectedLeaseUntil: claimedAgain.leaseUntil,
      now: at(claimedAgain.leaseUntil.getTime() - 1),
    });
    expect(resolved).toMatchObject({ resolvedAt: at(claimedAgain.leaseUntil.getTime() - 1), state: 'resolved' });
    expect(queue.resolve(key)).toEqual(resolved);
  });

  it('reopens a resolved issue and clears its previous error code', async () => {
    const { database } = await databaseFixture('imagine-media-repair-reopen-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('reopen');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });
    const claimed = queue.claimNext({ leaseMs: 1_000, now: at(1_000) });
    if (claimed === null || claimed.leaseUntil === null) throw new Error('Expected a leased repair row.');
    const retried = queue.retry(key, {
      errorCode: 'repair_failed',
      expectedAttempts: claimed.attempts,
      expectedLeaseUntil: claimed.leaseUntil,
      now: at(1_100),
    });
    expect(retried?.lastErrorCode).toBe('repair_failed');
    queue.upsertScan([], { now: at(5_000) });
    expect(queue.get(key)).toMatchObject({ lastErrorCode: 'repair_failed', state: 'resolved' });
    const reopened = queue.upsertScan([current], { now: at(6_000) });
    expect(reopened).toMatchObject({ reopened: 1, seen: 1 });
    expect(queue.get(key)).toMatchObject({ lastErrorCode: null, state: 'open' });
  });

  it('reopens expired leases and claims deterministically after a database restart', async () => {
    const { database, directory } = await databaseFixture('imagine-media-repair-lease-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('lease');
    const key = mediaRepairIssueKey(current);
    queue.upsertScan([current], { now: at(1_000) });
    const first = queue.claimNext({ leaseMs: 1_000, now: at(1_000) });
    expect(first).toMatchObject({ attempts: 1, leaseUntil: at(2_000), state: 'running' });
    database.sqlite.close();
    databases.splice(databases.indexOf(database), 1);

    const reopened = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
    databases.push(reopened);
    const queueAfterRestart = new MediaRepairQueueRepository(reopened.orm);
    expect(queueAfterRestart.reclaimExpired(at(2_000))).toBe(1);
    const second = queueAfterRestart.claimNext({ leaseMs: 1_000, now: at(2_000) });
    expect(second).toMatchObject({ attempts: 2, issueKey: key, leaseUntil: at(3_000), state: 'running' });
  });

  it('bounds scan input and backoff without storing raw error text', async () => {
    const { database } = await databaseFixture('imagine-media-repair-bounds-');
    const queue = new MediaRepairQueueRepository(database.orm);
    expect(() => queue.upsertScan([], { maxIssues: MEDIA_REPAIR_MAX_SCAN_ISSUES + 1 })).toThrow(RangeError);
    expect(() => queue.list({ state: 'invalid' as never })).toThrow(MediaRepairQueueError);
    const current = issue('bounds');
    queue.upsertScan([current], { now: at(1_000) });
    const claimed = queue.claimNext({ now: at(1_000), leaseMs: 1_000 });
    if (claimed === null || claimed.leaseUntil === null) throw new Error('Expected a leased repair row.');
    const retried = queue.retry(mediaRepairIssueKey(current), {
      errorCode: 'Error: API secret value and stack trace',
      expectedAttempts: claimed.attempts,
      expectedLeaseUntil: claimed.leaseUntil,
      now: at(1_500),
    });
    expect(retried?.lastErrorCode).toBe('unknown');
    expect(retried!.nextAttemptAt.getTime() - 1_500).toBeLessThanOrEqual(MEDIA_REPAIR_MAX_BACKOFF_MS);
    expect(JSON.stringify(queue.list())).not.toContain('secret value');
  });

  it('rejects retry schedules that overflow the supported Date range', async () => {
    const { database } = await databaseFixture('imagine-media-repair-date-bound-');
    const queue = new MediaRepairQueueRepository(database.orm);
    const current = issue('date-bound');
    queue.upsertScan([current], { now: at(8_640_000_000_000_000 - 2_000) });
    const claimed = queue.claimNext({
      leaseMs: 1_000,
      now: at(8_640_000_000_000_000 - 2_000),
    });
    if (claimed === null || claimed.leaseUntil === null) throw new Error('Expected a leased repair row.');
    const leaseUntil = claimed.leaseUntil;

    expect(() => queue.retry(mediaRepairIssueKey(current), {
      expectedAttempts: claimed.attempts,
      expectedLeaseUntil: leaseUntil,
      now: at(8_640_000_000_000_000 - 1_500),
    })).toThrow(RangeError);
    expect(queue.get(mediaRepairIssueKey(current))).toMatchObject({ state: 'running' });
  });
});
