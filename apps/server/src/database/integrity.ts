import type Database from 'better-sqlite3';

export const DEFAULT_INTEGRITY_RESULT_LIMIT = 100;
export const MAX_INTEGRITY_RESULT_LIMIT = 1_000;

export interface SqliteIntegrityOptions {
  /** Maximum number of integrity messages or foreign-key violations retained. */
  readonly maxResults?: number;
}

export interface SqliteIntegrityCheck {
  readonly errorCount: number;
  readonly ok: boolean;
  readonly truncated: boolean;
}

export interface SqliteForeignKeyViolation {
  readonly foreignKey: number;
  readonly parent: string;
  readonly rowid: number | string | null;
  readonly table: string;
}

export interface SqliteForeignKeyCheck {
  readonly ok: boolean;
  readonly truncated: boolean;
  readonly violations: readonly SqliteForeignKeyViolation[];
}

export interface SqliteIntegrityReport {
  readonly foreignKeyCheck: SqliteForeignKeyCheck;
  readonly foreignKeysEnabled: boolean;
  readonly integrityCheck: SqliteIntegrityCheck;
  readonly ok: boolean;
}

export class SqliteIntegrityError extends Error {
  public override readonly name = 'SqliteIntegrityError';
}

function invalidResult(message: string): SqliteIntegrityError {
  return new SqliteIntegrityError(message);
}

function resultLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_INTEGRITY_RESULT_LIMIT;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_INTEGRITY_RESULT_LIMIT
  ) {
    throw new RangeError(
      `maxResults must be an integer between 1 and ${MAX_INTEGRITY_RESULT_LIMIT}.`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedIdentifier(value: unknown, label: string): string {
  // SQLite identifiers are metadata only; reject control characters before
  // returning them in a health report.
  // eslint-disable-next-line no-control-regex
  const hasControlCharacter = typeof value === 'string' && /[\u0000-\u001f\u007f]/u.test(value);
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    hasControlCharacter
  ) {
    throw invalidResult(`SQLite ${label} result has an invalid identifier.`);
  }
  return value;
}

function boundedRowId(value: unknown): number | string | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw invalidResult('SQLite foreign-key result has an invalid row identifier.');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    const serialized = String(value);
    if (!/^-?[0-9]{1,32}$/u.test(serialized)) {
      throw invalidResult('SQLite foreign-key result has an invalid row identifier.');
    }
    return serialized;
  }
  throw invalidResult('SQLite foreign-key result has an invalid row identifier.');
}

function boundedForeignKey(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResult('SQLite foreign-key result has an invalid constraint identifier.');
  }
  return value as number;
}

function runIntegrityCheck(
  sqlite: Database.Database,
  limit: number,
): SqliteIntegrityCheck {
  let rows: unknown[];
  try {
    rows = sqlite.prepare(`PRAGMA integrity_check(${String(limit)})`).all() as unknown[];
  } catch {
    throw invalidResult('SQLite integrity check could not be executed.');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw invalidResult('SQLite integrity check returned an invalid result.');
  }
  let errorCount = 0;
  for (const row of rows.slice(0, limit)) {
    if (!isRecord(row) || typeof row.integrity_check !== 'string') {
      throw invalidResult('SQLite integrity check returned an invalid result.');
    }
    if (row.integrity_check !== 'ok') errorCount += 1;
  }
  return {
    errorCount,
    ok: errorCount === 0,
    truncated: rows.length > limit || errorCount >= limit,
  };
}

function runForeignKeyCheck(
  sqlite: Database.Database,
  limit: number,
): SqliteForeignKeyCheck {
  let statement: { iterate: () => Iterable<unknown> };
  try {
    statement = sqlite.prepare('PRAGMA foreign_key_check') as unknown as {
      iterate: () => Iterable<unknown>;
    };
  } catch {
    throw invalidResult('SQLite foreign-key check could not be executed.');
  }
  const violations: SqliteForeignKeyViolation[] = [];
  let truncated = false;
  try {
    for (const row of statement.iterate()) {
      if (violations.length >= limit) {
        truncated = true;
        break;
      }
      if (!isRecord(row)) {
        throw invalidResult('SQLite foreign-key check returned an invalid result.');
      }
      violations.push({
        foreignKey: boundedForeignKey(row.fkid),
        parent: boundedIdentifier(row.parent, 'foreign-key'),
        rowid: boundedRowId(row.rowid),
        table: boundedIdentifier(row.table, 'foreign-key'),
      });
    }
  } catch (error) {
    if (error instanceof SqliteIntegrityError) throw error;
    throw invalidResult('SQLite foreign-key check returned an invalid result.');
  }
  return {
    ok: violations.length === 0,
    truncated,
    violations,
  };
}

export function checkSqliteIntegrity(
  sqlite: Database.Database,
  options: SqliteIntegrityOptions = {},
): SqliteIntegrityReport {
  const limit = resultLimit(options.maxResults);
  let foreignKeysValue: unknown;
  try {
    foreignKeysValue = sqlite.pragma('foreign_keys', { simple: true });
  } catch {
    throw invalidResult('SQLite foreign-key mode could not be inspected.');
  }
  if (foreignKeysValue !== 0 && foreignKeysValue !== 1) {
    throw invalidResult('SQLite foreign-key mode returned an invalid result.');
  }
  const integrityCheck = runIntegrityCheck(sqlite, limit);
  const foreignKeyCheck = runForeignKeyCheck(sqlite, limit);
  const foreignKeysEnabled = foreignKeysValue === 1;
  return {
    foreignKeyCheck,
    foreignKeysEnabled,
    integrityCheck,
    ok: foreignKeysEnabled && integrityCheck.ok && foreignKeyCheck.ok,
  };
}

export const inspectSqliteIntegrity = checkSqliteIntegrity;
