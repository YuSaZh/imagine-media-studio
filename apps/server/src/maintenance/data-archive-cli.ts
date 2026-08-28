import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import {
  DataArchiveError,
  DataArchive,
  verifyDataArchive,
  type DataArchiveResult,
} from './data-archive.js';
import { DataRestoreError, restoreDataArchive, type DataRestoreResult } from './data-restore.js';
import {
  acquireOfflineMaintenanceLease,
  OfflineMaintenanceLeaseError,
} from './runtime-lock.js';
import { getStoragePaths } from '../storage/paths.js';

export type DataArchiveCliCommand =
  | { readonly command: 'create'; readonly dataDir: string }
  | { readonly command: 'restore'; readonly bundlePath: string; readonly targetPath: string }
  | { readonly command: 'verify'; readonly bundlePath: string };

export class DataArchiveCliUsageError extends Error {
  public override readonly name = 'DataArchiveCliUsageError';
}

export interface DataArchiveCliDependencies {
  readonly create?: (dataDir: string) => Promise<DataArchiveResult>;
  readonly verify?: (bundlePath: string) => Promise<{
    readonly bytes: number;
    readonly createdAt: Date;
    readonly entries: number;
  }>;
  readonly restore?: (bundlePath: string, targetPath: string) => Promise<DataRestoreResult>;
  readonly write?: (chunk: string) => void;
}

async function createOfflineDataArchive(dataDir: string): Promise<DataArchiveResult> {
  const paths = getStoragePaths(dataDir);
  // The atomic gate is the authoritative server/CLI exclusion mechanism. The
  // legacy callback remains true because a successful O_EXCL acquisition is
  // the stopped-server proof; a concurrent server loses the same race.
  const lease = await acquireOfflineMaintenanceLease({
    assertServerStopped: () => true,
    dataRoot: paths.root,
  });
  let sqlite: Database.Database | undefined;
  let archive: DataArchive | undefined;
  let operationError: unknown;
  let result: DataArchiveResult | undefined;
  try {
    sqlite = new Database(paths.database, { fileMustExist: true, readonly: true });
    archive = new DataArchive({ lease, paths, sqlite });
    result = await archive.create();
  } catch (error) {
    operationError = error;
  }

  const cleanupFailures: unknown[] = [];
  if (archive !== undefined) {
    try { await archive.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (sqlite !== undefined) {
    try { sqlite.close(); } catch (error) { cleanupFailures.push(error); }
  }
  try { await lease.release(); } catch (error) { cleanupFailures.push(error); }

  if (operationError !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new DataArchiveError('Data archive cleanup failed.');
    }
    throw operationError;
  }
  if (cleanupFailures.length > 0) throw new DataArchiveError('Data archive cleanup failed.');
  if (result === undefined) throw new DataArchiveError('Data archive did not produce a result.');
  return result;
}

function usage(): string {
  return 'Usage: data-archive verify --bundle PATH | data-archive create --data-dir PATH | data-archive restore --bundle PATH --target PATH';
}

function safePath(value: string, label: string): string {
  if (value.length === 0 || value.includes('\0') || value.startsWith('-')) {
    throw new DataArchiveCliUsageError(`${label} must be a non-empty path.`);
  }
  return value;
}

function optionValue(argv: readonly string[], index: number, option: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined) throw new DataArchiveCliUsageError(`${option} requires a value.`);
  return [value, index + 2];
}

export function parseDataArchiveCliArgs(argv: readonly string[]): DataArchiveCliCommand {
  if (argv.length < 1) throw new DataArchiveCliUsageError(usage());
  const command = argv[0];
  if (command !== 'create' && command !== 'verify' && command !== 'restore') throw new DataArchiveCliUsageError(usage());
  let dataDir: string | undefined;
  let bundlePath: string | undefined;
  let targetPath: string | undefined;
  for (let index = 1; index < argv.length;) {
    const option = argv[index];
    if (option === undefined) break;
    if (option === '--data-dir' && command === 'create') {
      if (dataDir !== undefined) throw new DataArchiveCliUsageError('The data directory may be specified only once.');
      [dataDir, index] = optionValue(argv, index, option);
      continue;
    }
    if (option === '--bundle' && (command === 'verify' || command === 'restore')) {
      if (bundlePath !== undefined) throw new DataArchiveCliUsageError('The bundle path may be specified only once.');
      [bundlePath, index] = optionValue(argv, index, option);
      continue;
    }
    if (option === '--target' && command === 'restore') {
      if (targetPath !== undefined) throw new DataArchiveCliUsageError('The target path may be specified only once.');
      [targetPath, index] = optionValue(argv, index, option);
      continue;
    }
    throw new DataArchiveCliUsageError(usage());
  }
  if (command === 'create') {
    if (dataDir === undefined) throw new DataArchiveCliUsageError(usage());
    return { command, dataDir: safePath(dataDir, '--data-dir') };
  }
  if (bundlePath === undefined) throw new DataArchiveCliUsageError(usage());
  if (command === 'restore') {
    if (targetPath === undefined) throw new DataArchiveCliUsageError(usage());
    return {
      bundlePath: safePath(bundlePath, '--bundle'),
      command,
      targetPath: safePath(targetPath, '--target'),
    };
  }
  return { bundlePath: safePath(bundlePath, '--bundle'), command };
}

export async function runDataArchiveCli(
  argv: readonly string[],
  dependencies: DataArchiveCliDependencies = {},
): Promise<number> {
  const command = parseDataArchiveCliArgs(argv);
  if (command.command === 'verify') {
    const result = await (dependencies.verify ?? (async (bundlePath) => verifyDataArchive(bundlePath)))(command.bundlePath);
    (dependencies.write ?? ((chunk) => process.stdout.write(chunk)))(
      `verified entries=${String(result.entries)} bytes=${String(result.bytes)} createdAt=${result.createdAt.toISOString()}\n`,
    );
    return 0;
  }
  if (command.command === 'restore') {
    const result = await (dependencies.restore ?? ((bundlePath, targetPath) => restoreDataArchive({ bundlePath, targetPath })))(
      command.bundlePath,
      command.targetPath,
    );
    (dependencies.write ?? ((chunk) => process.stdout.write(chunk)))(
      `restored entries=${String(result.entries)} bytes=${String(result.bytes)} createdAt=${result.createdAt.toISOString()}\n`,
    );
    return 0;
  }
  const result = await (dependencies.create ?? createOfflineDataArchive)(command.dataDir);
  (dependencies.write ?? ((chunk) => process.stdout.write(chunk)))(
    `created id=${result.id} entries=${String(result.entries)} bytes=${String(result.bytes)} createdAt=${result.createdAt.toISOString()}\n`,
  );
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await runDataArchiveCli(argv);
  } catch (error) {
    if (error instanceof DataArchiveCliUsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof OfflineMaintenanceLeaseError || error instanceof DataArchiveError || error instanceof DataRestoreError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write('Data archive operation failed.\n');
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().then((code) => { process.exitCode = code; });
}
