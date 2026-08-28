import { describe, expect, it } from 'vitest';

import { OfflineMaintenanceLeaseError } from './runtime-lock.js';
import {
  DataArchiveCliUsageError,
  parseDataArchiveCliArgs,
  runDataArchiveCli,
} from './data-archive-cli.js';

describe('data archive CLI', () => {
  it('parses only the strict create and verify forms', () => {
    expect(parseDataArchiveCliArgs(['create', '--data-dir', '/var/lib/imagine'])).toEqual({
      command: 'create',
      dataDir: '/var/lib/imagine',
    });
    expect(parseDataArchiveCliArgs(['verify', '--bundle', '/var/lib/imagine/backups/data.bundle'])).toEqual({
      bundlePath: '/var/lib/imagine/backups/data.bundle',
      command: 'verify',
    });
    expect(() => parseDataArchiveCliArgs([])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['create', '--bundle', 'archive.bundle'])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['verify', '--bundle', 'archive.bundle', '--extra'])).toThrow(DataArchiveCliUsageError);
    expect(() => parseDataArchiveCliArgs(['create', '--data-dir', '--bad'])).toThrow(DataArchiveCliUsageError);
  });

  it('fails closed for create until the server supplies a verified lease', async () => {
    await expect(runDataArchiveCli(['create', '--data-dir', '/var/lib/imagine'])).rejects.toThrow(OfflineMaintenanceLeaseError);
  });

  it('runs verify through an injected verifier without printing paths or contents', async () => {
    const output: string[] = [];
    const code = await runDataArchiveCli(['verify', '--bundle', '/tmp/archive.bundle'], {
      verify: async () => ({ bytes: 12, createdAt: new Date('2026-08-29T00:00:00.000Z'), entries: 2 }),
      write: (chunk) => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(output).toEqual(['verified entries=2 bytes=12 createdAt=2026-08-29T00:00:00.000Z\n']);
    expect(output.join('')).not.toContain('/tmp/archive.bundle');
  });
});
