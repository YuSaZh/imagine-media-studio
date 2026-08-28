import {
  DataArchiveError,
  verifyDataArchive,
  type DataArchiveResult,
} from './data-archive.js';
import { OfflineMaintenanceLeaseError } from './runtime-lock.js';
import { pathToFileURL } from 'node:url';

export type DataArchiveCliCommand =
  | { readonly command: 'create'; readonly dataDir: string }
  | { readonly command: 'verify'; readonly bundlePath: string };

export class DataArchiveCliUsageError extends Error {
  public override readonly name = 'DataArchiveCliUsageError';
}

export interface DataArchiveCliDependencies {
  /** Deliberately absent from the production entry point until server lease integration. */
  readonly create?: (dataDir: string) => Promise<DataArchiveResult>;
  readonly verify?: (bundlePath: string) => Promise<{
    readonly bytes: number;
    readonly createdAt: Date;
    readonly entries: number;
  }>;
  readonly write?: (chunk: string) => void;
}

function usage(): string {
  return 'Usage: data-archive verify --bundle PATH | data-archive create --data-dir PATH';
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
  if (command !== 'create' && command !== 'verify') throw new DataArchiveCliUsageError(usage());
  let value: string | undefined;
  for (let index = 1; index < argv.length;) {
    const option = argv[index];
    if (option === undefined) break;
    if (option === '--data-dir' && command === 'create') {
      if (value !== undefined) throw new DataArchiveCliUsageError('The data directory may be specified only once.');
      [value, index] = optionValue(argv, index, option);
      continue;
    }
    if (option === '--bundle' && command === 'verify') {
      if (value !== undefined) throw new DataArchiveCliUsageError('The bundle path may be specified only once.');
      [value, index] = optionValue(argv, index, option);
      continue;
    }
    throw new DataArchiveCliUsageError(usage());
  }
  if (value === undefined) throw new DataArchiveCliUsageError(usage());
  return command === 'create'
    ? { command, dataDir: safePath(value, '--data-dir') }
    : { bundlePath: safePath(value, '--bundle'), command };
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
  if (dependencies.create === undefined) {
    throw new OfflineMaintenanceLeaseError(
      'Offline archive creation is unavailable until the caller supplies a verified maintenance lease.',
    );
  }
  const result = await dependencies.create(command.dataDir);
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
    if (error instanceof OfflineMaintenanceLeaseError || error instanceof DataArchiveError) {
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
