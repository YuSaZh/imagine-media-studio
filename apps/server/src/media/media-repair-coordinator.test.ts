import { describe, expect, it, vi } from 'vitest';

import type { MediaRepairRecord, MediaRepairScanResult } from '../database/media-repair.js';
import {
  MAX_MEDIA_REPAIR_REPORT_ITEMS,
  MediaRepairCoordinator,
  type MediaRepairListResult,
} from './media-repair-coordinator.js';
import type { MediaConsistencyReport } from './maintenance.js';

const QUEUE_RESULT: MediaRepairScanResult = {
  inserted: 1,
  reopened: 0,
  resolved: 0,
  seen: 1,
  truncated: false,
  updated: 0,
};

function report(overrides: Partial<MediaConsistencyReport> = {}): MediaConsistencyReport {
  return {
    assetCount: 1,
    fileCount: 2,
    hashedBytes: 64,
    issueCount: 1,
    issues: [{ assetId: 'asset-1', kind: 'missing', storedPath: 'media/uploads/missing.png' }],
    ok: false,
    truncated: false,
    ...overrides,
  };
}

function repair(index: number): MediaRepairRecord {
  return {
    assetId: null,
    attempts: 0,
    firstSeenAt: new Date(index),
    issueKey: index.toString(16).padStart(64, '0'),
    jobId: null,
    kind: 'orphan',
    lastErrorCode: null,
    lastSeenAt: new Date(index),
    leaseUntil: null,
    nextAttemptAt: new Date(index),
    resolvedAt: null,
    state: 'open',
    storedPath: `media/uploads/orphan-${index}.bin`,
  };
}

describe('MediaRepairCoordinator', () => {
  it('maps only safe audit fields and forwards the truncated flag', async () => {
    const audit = { audit: vi.fn().mockResolvedValue(report({
      issueCount: 2,
      issues: [
        { assetId: 'asset-1', kind: 'missing', storedPath: 'media/uploads/missing.png' },
        { assetId: '<asset-id-too-long>', kind: 'unsafe', storedPath: '<unsafe-path>' },
      ],
      truncated: true,
    })) };
    const upsertScan = vi.fn().mockResolvedValue({ ...QUEUE_RESULT, seen: 2, truncated: true });
    const coordinator = new MediaRepairCoordinator({
      audit,
      queue: {
        count: vi.fn().mockReturnValue(0),
        list: vi.fn().mockReturnValue([]),
        upsertScan,
      },
    });

    const result = await coordinator.reconcile();

    expect(upsertScan).toHaveBeenCalledWith([
      { assetId: 'asset-1', jobId: null, kind: 'missing', storedPath: 'media/uploads/missing.png' },
      { assetId: null, jobId: null, kind: 'unsafe', storedPath: '<unsafe-path>' },
    ], { truncated: true });
    expect(result.scan.truncated).toBe(true);
    expect(result.queue.truncated).toBe(true);
  });

  it('passes complete scans through so the queue can resolve absent open issues', async () => {
    const audit = { audit: vi.fn().mockResolvedValue(report({ issues: [], issueCount: 0, ok: true })) };
    const upsertScan = vi.fn().mockReturnValue({ ...QUEUE_RESULT, inserted: 0, resolved: 1, seen: 0 });
    const coordinator = new MediaRepairCoordinator({
      audit,
      queue: {
        count: vi.fn().mockReturnValue(0),
        list: vi.fn().mockReturnValue([]),
        upsertScan,
      },
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({
      queue: { resolved: 1, truncated: false },
      scan: { issueCount: 0, ok: true, truncated: false },
    });
    expect(upsertScan).toHaveBeenCalledWith([], { truncated: false });
  });

  it('fails closed when an audit omits issues without marking the report truncated', async () => {
    const audit = { audit: vi.fn().mockResolvedValue(report({
      issueCount: 2,
      issues: [report().issues[0]!],
      ok: true,
      truncated: false,
    })) };
    const upsertScan = vi.fn().mockResolvedValue({ ...QUEUE_RESULT, resolved: 0, truncated: true });
    const coordinator = new MediaRepairCoordinator({
      audit,
      queue: {
        count: vi.fn().mockReturnValue(0),
        list: vi.fn().mockReturnValue([]),
        upsertScan,
      },
    });

    const result = await coordinator.reconcile();

    expect(upsertScan).toHaveBeenCalledWith([
      { assetId: 'asset-1', jobId: null, kind: 'missing', storedPath: 'media/uploads/missing.png' },
    ], { truncated: true });
    expect(result.scan).toMatchObject({ ok: false, truncated: true });
    expect(result.queue).toMatchObject({ resolved: 0, truncated: true });
  });

  it('returns a fixed bounded repair page and total count', async () => {
    const records = Array.from({ length: MAX_MEDIA_REPAIR_REPORT_ITEMS + 1 }, (_, index) => repair(index));
    const list = vi.fn().mockResolvedValue(records);
    const count = vi.fn().mockResolvedValue(records.length);
    const coordinator = new MediaRepairCoordinator({
      audit: { audit: vi.fn() },
      queue: { count, list, upsertScan: vi.fn() },
    });

    const result: MediaRepairListResult = await coordinator.listRepairs();

    expect(list).toHaveBeenCalledWith({ limit: MAX_MEDIA_REPAIR_REPORT_ITEMS + 1 });
    expect(count).toHaveBeenCalledOnce();
    expect(result.count).toBe(MAX_MEDIA_REPAIR_REPORT_ITEMS + 1);
    expect(result.items).toHaveLength(MAX_MEDIA_REPAIR_REPORT_ITEMS);
    expect(result.truncated).toBe(true);
  });
});
