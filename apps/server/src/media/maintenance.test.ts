import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { JobMaintenanceRecord } from '../database/jobs.js';
import { ensureStorage, getStoragePaths, type StoragePaths } from '../storage/paths.js';
import type {
  AssetMediaRecord,
  AssetMediaRepositoryPort,
  NewAssetMediaRecord,
} from './types.js';
import {
  cleanupTerminalProviderOutputs,
  inspectMediaConsistency,
} from './maintenance.js';

const temporaryDirectories: string[] = [];

class MemoryAssetRepository implements AssetMediaRepositoryPort {
  public readonly records: AssetMediaRecord[] = [];

  public create(input: NewAssetMediaRecord): AssetMediaRecord {
    const record: AssetMediaRecord = {
      ...input,
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      deletedAt: null,
      id: `asset-${this.records.length + 1}`,
    };
    this.records.push(record);
    return record;
  }

  public get(id: string, includeDeleted = false): AssetMediaRecord | null {
    return this.records.find((record) => record.id === id && (includeDeleted || record.deletedAt === null)) ?? null;
  }

  public listForMaintenance(options: { readonly limit?: number } = {}): readonly AssetMediaRecord[] {
    return options.limit === undefined ? this.records : this.records.slice(0, options.limit);
  }

  public softDelete(id: string): boolean {
    const index = this.records.findIndex((candidate) => candidate.id === id && candidate.deletedAt === null);
    if (index < 0) return false;
    const record = this.records[index]!;
    this.records[index] = {
      ...record,
      deletedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    return true;
  }
}

function asset(
  id: string,
  filePath: string,
  bytes: Uint8Array,
  overrides: Partial<AssetMediaRecord> = {},
): AssetMediaRecord {
  return {
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    deletedAt: null,
    durationMs: null,
    filePath,
    fileSize: bytes.byteLength,
    height: null,
    id,
    jobId: null,
    metadata: {},
    mimeType: 'image/png',
    originalFilename: null,
    parentAssetId: null,
    posterPath: null,
    role: 'upload',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    thumbnailPath: null,
    type: 'image',
    width: null,
    ...overrides,
  };
}

async function fixture(prefix: string): Promise<{ paths: StoragePaths; repository: MemoryAssetRepository }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const paths = getStoragePaths(root);
  await ensureStorage(paths);
  return { paths, repository: new MemoryAssetRepository() };
}

function providerKey(jobId: string): string {
  return createHash('sha256').update(`imagine-provider-output-v1\0${jobId}`).digest('hex');
}

function providerBase(jobId: string, slot = 0): string {
  return `job-${providerKey(jobId)}-slot-${String(slot).padStart(4, '0')}`;
}

async function providerManifest(paths: StoragePaths, jobId: string, slot = 0): Promise<string> {
  const directory = join(paths.temporary, 'provider-results', providerKey(jobId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `slot-${String(slot).padStart(4, '0')}.json`);
  await writeFile(path, JSON.stringify({ version: 1, jobId, slot }));
  return path;
}

function jobs(records: readonly JobMaintenanceRecord[]): {
  listForMaintenance(): readonly JobMaintenanceRecord[];
} {
  return { listForMaintenance: () => records };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('media consistency audit', () => {
  it('bounds the asset set and refuses to claim a complete scan', async () => {
    const { paths, repository } = await fixture('imagine-media-audit-assets-');
    const bytes = Buffer.from('asset');
    await writeFile(join(paths.uploads, 'one.png'), bytes);
    repository.records.push(asset('one', 'media/uploads/one.png', bytes));
    repository.records.push(asset('two', 'media/uploads/two.png', bytes));

    const report = await inspectMediaConsistency({
      limits: { maxAssets: 1, maxFiles: 100, maxHashedBytes: 1_000, maxIssues: 10 },
      paths,
      repository,
    });

    expect(report.assetCount).toBe(1);
    expect(report.fileCount).toBe(0);
    expect(report.truncated).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('reports missing, modified, unsafe, and orphaned managed media', async () => {
    const { paths, repository } = await fixture('imagine-media-audit-issues-');
    const original = Buffer.from('original');
    await writeFile(join(paths.uploads, 'modified.png'), Buffer.from('changed'));
    await writeFile(join(paths.uploads, 'orphan.bin'), 'orphan');
    const outside = join(paths.root, 'outside.png');
    await writeFile(outside, 'outside');
    await symlink(outside, join(paths.uploads, 'escape.png'));
    repository.records.push(asset('modified', 'media/uploads/modified.png', original));
    repository.records.push(asset('missing', 'media/uploads/missing.png', original));
    repository.records.push(asset('unsafe', 'media/uploads/escape.png', original));

    const report = await inspectMediaConsistency({ paths, repository });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      { assetId: 'modified', kind: 'size_mismatch', storedPath: 'media/uploads/modified.png' },
      { assetId: 'modified', kind: 'hash_mismatch', storedPath: 'media/uploads/modified.png' },
      { assetId: 'missing', kind: 'missing', storedPath: 'media/uploads/missing.png' },
      { assetId: 'unsafe', kind: 'unsafe', storedPath: 'media/uploads/escape.png' },
      { assetId: null, kind: 'orphan', storedPath: 'media/uploads/orphan.bin' },
      { assetId: null, kind: 'unsafe', storedPath: 'media/uploads/escape.png' },
    ]));
  });

  it('sanitizes unsafe and oversized database paths before reporting them', async () => {
    const { paths, repository } = await fixture('imagine-media-audit-paths-');
    const bytes = Buffer.from('asset');
    const absolutePath = '/data/app.db';
    const backslashPath = 'media\\uploads\\asset.png';
    const traversalPath = 'media/uploads/../asset.png';
    const longPath = `media/uploads/${'x'.repeat(4_100)}`;
    repository.records.push(
      asset('absolute', absolutePath, bytes),
      asset('backslash', backslashPath, bytes),
      asset('traversal', traversalPath, bytes),
      asset('long', longPath, bytes),
    );

    const report = await inspectMediaConsistency({ paths, repository });

    expect(report.issues).toEqual(expect.arrayContaining([
      { assetId: 'absolute', kind: 'unsafe', storedPath: '<unsafe-path>' },
      { assetId: 'backslash', kind: 'unsafe', storedPath: '<unsafe-path>' },
      { assetId: 'traversal', kind: 'unsafe', storedPath: '<unsafe-path>' },
      { assetId: 'long', kind: 'unreadable', storedPath: '<path-too-long>' },
    ]));
    expect(JSON.stringify(report)).not.toContain(absolutePath);
    expect(JSON.stringify(report)).not.toContain(backslashPath);
    expect(JSON.stringify(report)).not.toContain(traversalPath);
    expect(JSON.stringify(report)).not.toContain(longPath);
  });

  it('stops hashing at the byte budget and marks the report truncated', async () => {
    const { paths, repository } = await fixture('imagine-media-audit-hash-');
    const bytes = Buffer.from('larger-than-budget');
    await writeFile(join(paths.uploads, 'bounded.png'), bytes);
    repository.records.push(asset('bounded', 'media/uploads/bounded.png', bytes));

    const report = await inspectMediaConsistency({
      limits: { maxAssets: 10, maxFiles: 10, maxHashedBytes: 1, maxIssues: 10 },
      paths,
      repository,
    });

    expect(report.hashedBytes).toBe(0);
    expect(report.truncated).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('does not report deterministic output for an active job as an orphan', async () => {
    const { paths, repository } = await fixture('imagine-media-audit-active-provider-');
    const jobId = 'active-audit-job';
    const base = providerBase(jobId);
    await providerManifest(paths, jobId);
    await writeFile(join(paths.originals, `${base}.png`), 'active');

    const report = await inspectMediaConsistency({
      jobs: jobs([{ id: jobId, status: 'remote_running', deletedAt: null }]),
      paths,
      repository,
    });

    expect(report.ok).toBe(true);
    expect(report.issues).not.toContainEqual({
      assetId: null,
      kind: 'orphan',
      storedPath: `media/originals/${base}.png`,
    });
  });
});

describe('terminal provider-output cleanup', () => {
  it('removes only terminal unreferenced provisional files and keeps active output', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-');
    const terminalId = 'terminal-job';
    const activeId = 'active-job';
    const terminalBase = providerBase(terminalId);
    const activeBase = providerBase(activeId);
    await providerManifest(paths, terminalId);
    await providerManifest(paths, activeId);
    await writeFile(join(paths.originals, `${terminalBase}.png`), 'terminal');
    await writeFile(join(paths.originals, `${activeBase}.png`), 'active');

    const result = await cleanupTerminalProviderOutputs({
      jobs: jobs([
        { id: terminalId, status: 'failed', deletedAt: null },
        { id: activeId, status: 'processing', deletedAt: null },
      ]),
      paths,
      repository,
    });

    expect(result.removed).toBeGreaterThan(0);
    await expect(lstat(join(paths.originals, `${terminalBase}.png`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(paths.temporary, 'provider-results', providerKey(terminalId), 'slot-0000.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(paths.originals, `${activeBase}.png`), 'utf8')).resolves.toBe('active');
    await expect(readFile(join(paths.temporary, 'provider-results', providerKey(activeId), 'slot-0000.json'), 'utf8'))
      .resolves.toContain(activeId);
  });

  it('keeps a completed output referenced by an Asset but removes its stale manifest', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-completed-');
    const jobId = 'completed-job';
    const base = providerBase(jobId);
    const bytes = Buffer.from('durable');
    await providerManifest(paths, jobId);
    await writeFile(join(paths.originals, `${base}.png`), bytes);
    repository.records.push(asset('output', `media/originals/${base}.png`, bytes, { jobId, role: 'output' }));

    const result = await cleanupTerminalProviderOutputs({
      jobs: jobs([{ id: jobId, status: 'completed', deletedAt: null }]),
      paths,
      repository,
    });

    expect(result.removed).toBe(1);
    await expect(readFile(join(paths.originals, `${base}.png`), 'utf8')).resolves.toBe('durable');
    await expect(lstat(join(paths.temporary, 'provider-results', providerKey(jobId), 'slot-0000.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a soft-deleted Asset as a reference during audit and cleanup', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-soft-deleted-');
    const jobId = 'soft-deleted-job';
    const base = providerBase(jobId);
    const bytes = Buffer.from('durable');
    await providerManifest(paths, jobId);
    await writeFile(join(paths.originals, `${base}.png`), bytes);
    repository.records.push(asset('deleted-output', `media/originals/${base}.png`, bytes, {
      deletedAt: new Date('2026-08-29T00:00:00.000Z'),
      jobId,
      role: 'output',
    }));

    const report = await inspectMediaConsistency({
      jobs: jobs([{ id: jobId, status: 'failed', deletedAt: null }]),
      paths,
      repository,
    });
    const result = await cleanupTerminalProviderOutputs({
      jobs: jobs([{ id: jobId, status: 'failed', deletedAt: null }]),
      paths,
      repository,
    });

    expect(report.ok).toBe(true);
    expect(report.issues).not.toContainEqual({
      assetId: null,
      kind: 'orphan',
      storedPath: `media/originals/${base}.png`,
    });
    expect(result.removed).toBe(0);
    await expect(readFile(join(paths.originals, `${base}.png`), 'utf8')).resolves.toBe('durable');
    await expect(readFile(join(paths.temporary, 'provider-results', providerKey(jobId), 'slot-0000.json'), 'utf8'))
      .resolves.toContain(jobId);
  });

  it('keeps the manifest when an output is unsafe or cannot be removed', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-output-failure-');
    const jobId = 'output-failure-job';
    const base = providerBase(jobId);
    const outside = join(paths.root, 'outside-output.png');
    await writeFile(outside, 'outside');
    await providerManifest(paths, jobId);
    await symlink(outside, join(paths.originals, `${base}.png`));

    const result = await cleanupTerminalProviderOutputs({
      jobs: jobs([{ id: jobId, status: 'failed', deletedAt: null }]),
      paths,
      repository,
    });

    expect(result.preserved).toBeGreaterThan(0);
    await expect(readFile(join(paths.temporary, 'provider-results', providerKey(jobId), 'slot-0000.json'), 'utf8'))
      .resolves.toContain(jobId);
    const outputStats = await lstat(join(paths.originals, `${base}.png`));
    expect(outputStats.isSymbolicLink()).toBe(true);
  });

  it('preserves manifests whose slot is outside the generation bound', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-slot-bound-');
    const jobId = 'slot-bound-job';
    const manifest = await providerManifest(paths, jobId, 9_999);

    const result = await cleanupTerminalProviderOutputs({
      jobs: jobs([{ id: jobId, status: 'failed', deletedAt: null }]),
      paths,
      repository,
    });

    expect(result.preserved).toBeGreaterThan(0);
    await expect(readFile(manifest, 'utf8')).resolves.toContain(jobId);
  });

  it('does not delete unknown provider directories or operate without a complete Asset reference set', async () => {
    const { paths, repository } = await fixture('imagine-provider-cleanup-unknown-');
    const unknownId = 'unknown-job';
    const manifest = await providerManifest(paths, unknownId);
    const bytes = Buffer.from('unknown');
    await writeFile(join(paths.originals, `${providerBase(unknownId)}.png`), bytes);

    const unknown = await cleanupTerminalProviderOutputs({
      jobs: jobs([]),
      paths,
      repository,
    });
    expect(unknown.preserved).toBeGreaterThan(0);
    await expect(readFile(manifest, 'utf8')).resolves.toContain(unknownId);

    repository.records.push(asset('one', 'media/uploads/one.png', bytes));
    repository.records.push(asset('two', 'media/uploads/two.png', bytes));
    const limited = await cleanupTerminalProviderOutputs({
      jobs: jobs([{ id: 'terminal-job', status: 'failed', deletedAt: null }]),
      limits: { maxAssets: 1 },
      paths,
      repository,
    });
    expect(limited.truncated).toBe(true);
    await expect(readFile(manifest, 'utf8')).resolves.toContain(unknownId);
  });
});
