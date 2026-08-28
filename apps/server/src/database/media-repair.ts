import { createHash } from 'node:crypto';

import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  lte,
  lt,
  sql,
} from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { mediaRepairQueue } from './schema.js';

const MEDIA_REPAIR_KINDS = [
  'hash_mismatch',
  'missing',
  'orphan',
  'size_mismatch',
  'unsafe',
  'unreadable',
] as const;
const MEDIA_REPAIR_STATES = ['open', 'running', 'resolved', 'manual'] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const UNSAFE_PATH_SENTINEL = '<unsafe-path>';
const PATH_TOO_LONG_SENTINEL = '<path-too-long>';
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;

export const MEDIA_REPAIR_MAX_STORED_PATH_LENGTH = 4_096;
export const MEDIA_REPAIR_MAX_IDENTIFIER_LENGTH = 255;
export const MEDIA_REPAIR_MAX_ATTEMPTS = 1_000_000;
export const MEDIA_REPAIR_MAX_SCAN_ISSUES = 1_000;
export const MEDIA_REPAIR_DEFAULT_LIST_LIMIT = 100;
export const MEDIA_REPAIR_MAX_LIST_LIMIT = 1_000;
export const MEDIA_REPAIR_MIN_LEASE_MS = 1_000;
export const MEDIA_REPAIR_DEFAULT_LEASE_MS = 5 * 60 * 1_000;
export const MEDIA_REPAIR_MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
export const MEDIA_REPAIR_RETRY_BASE_MS = 1_000;
export const MEDIA_REPAIR_MAX_BACKOFF_MS = 15 * 60 * 1_000;

export type MediaRepairKind = (typeof MEDIA_REPAIR_KINDS)[number];
export type MediaRepairState = (typeof MEDIA_REPAIR_STATES)[number];

export interface MediaRepairIssueInput {
  readonly assetId?: string | null;
  readonly jobId?: string | null;
  readonly kind: MediaRepairKind;
  readonly storedPath: string;
}

export interface MediaRepairRecord {
  readonly issueKey: string;
  readonly assetId: string | null;
  readonly jobId: string | null;
  readonly kind: MediaRepairKind;
  readonly storedPath: string;
  readonly state: MediaRepairState;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly leaseUntil: Date | null;
  readonly lastErrorCode: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly resolvedAt: Date | null;
}

export interface MediaRepairScanOptions {
  readonly maxIssues?: number;
  readonly now?: Date;
  readonly truncated?: boolean;
}

export interface MediaRepairScanResult {
  readonly seen: number;
  readonly inserted: number;
  readonly updated: number;
  readonly reopened: number;
  readonly resolved: number;
  readonly truncated: boolean;
}

export interface MediaRepairListOptions {
  readonly limit?: number;
  readonly state?: MediaRepairState;
}

export interface MediaRepairClaimOptions {
  readonly leaseMs?: number;
  readonly now?: Date;
}

export interface MediaRepairLeaseGuard {
  readonly expectedAttempts: number;
  readonly expectedLeaseUntil: Date;
}

export interface MediaRepairTransitionOptions {
  readonly expectedAttempts?: number;
  readonly expectedLeaseUntil?: Date;
  readonly now?: Date;
}

export interface MediaRepairRetryOptions extends MediaRepairTransitionOptions {
  readonly errorCode?: string | null;
}

export class MediaRepairQueueError extends Error {
  public override readonly name = 'MediaRepairQueueError';

  public constructor(
    public readonly code: 'invalid_input' | 'invalid_row' | 'storage_failure',
    message: string,
  ) {
    super(message);
  }
}

interface NormalizedIssue {
  readonly assetId: string | null;
  readonly jobId: string | null;
  readonly kind: MediaRepairKind;
  readonly storedPath: string;
  readonly issueKey: string;
}

function isSafeDate(value: unknown): value is Date {
  return value instanceof Date &&
    Number.isSafeInteger(value.getTime()) &&
    value.getTime() >= 0 &&
    value.getTime() <= MAX_DATE_MILLISECONDS;
}

function requiredDate(value: Date | undefined, label: string): Date {
  const result = value ?? new Date();
  if (!isSafeDate(result)) throw new RangeError(`${label} must be a valid non-negative Date.`);
  return result;
}

function validateIdentifier(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (
    value.length === 0 ||
    value.length > MEDIA_REPAIR_MAX_IDENTIFIER_LENGTH ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    throw new MediaRepairQueueError('invalid_input', `${label} is outside the bounded queue contract.`);
  }
  return value;
}

function safeStoredPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MEDIA_REPAIR_MAX_STORED_PATH_LENGTH) {
    return value === UNSAFE_PATH_SENTINEL || value === PATH_TOO_LONG_SENTINEL;
  }
  if (value === UNSAFE_PATH_SENTINEL || value === PATH_TOO_LONG_SENTINEL) return true;
  const segments = value.split('/');
  return !value.includes('\0') &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !WINDOWS_DRIVE_PATH.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.startsWith('./') &&
    !value.startsWith('../') &&
    !value.endsWith('/') &&
    !value.includes('//') &&
    !value.includes('/./') &&
    !value.includes('/../') &&
    !value.endsWith('/.') &&
    !value.endsWith('/..') &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function normalizeStoredPath(value: string): string {
  if (value.length > MEDIA_REPAIR_MAX_STORED_PATH_LENGTH) return PATH_TOO_LONG_SENTINEL;
  return safeStoredPath(value) ? value : UNSAFE_PATH_SENTINEL;
}

function validateKind(value: unknown): MediaRepairKind {
  if (typeof value === 'string' && MEDIA_REPAIR_KINDS.includes(value as MediaRepairKind)) {
    return value as MediaRepairKind;
  }
  throw new MediaRepairQueueError('invalid_input', 'Media repair issue kind is invalid.');
}

function validateState(value: unknown): MediaRepairState {
  if (typeof value === 'string' && MEDIA_REPAIR_STATES.includes(value as MediaRepairState)) {
    return value as MediaRepairState;
  }
  throw new MediaRepairQueueError('invalid_input', 'Media repair queue state is invalid.');
}

function normalizeErrorCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === 'string' ? value.trim() : '';
  return ERROR_CODE.test(normalized) ? normalized : 'unknown';
}

function normalizedIssue(input: MediaRepairIssueInput): NormalizedIssue {
  if (input === null || typeof input !== 'object') {
    throw new MediaRepairQueueError('invalid_input', 'Media repair issue is invalid.');
  }
  const assetId = validateIdentifier(input.assetId ?? null, 'Asset id');
  const jobId = validateIdentifier(input.jobId ?? null, 'Job id');
  if (typeof input.storedPath !== 'string') {
    throw new MediaRepairQueueError('invalid_input', 'Media repair stored path is invalid.');
  }
  const kind = validateKind(input.kind);
  const storedPath = normalizeStoredPath(input.storedPath);
  const issueKey = mediaRepairIssueKey({ assetId, jobId, kind, storedPath });
  return { assetId, issueKey, jobId, kind, storedPath };
}

export function mediaRepairIssueKey(input: MediaRepairIssueInput): string {
  if (input === null || typeof input !== 'object') {
    throw new MediaRepairQueueError('invalid_input', 'Media repair issue is invalid.');
  }
  const kind = validateKind(input.kind);
  const assetId = validateIdentifier(input.assetId ?? null, 'Asset id');
  const jobId = validateIdentifier(input.jobId ?? null, 'Job id');
  const normalizedPath = typeof input.storedPath === 'string'
    ? normalizeStoredPath(input.storedPath)
    : UNSAFE_PATH_SENTINEL;
  const canonical = JSON.stringify([
    kind,
    assetId,
    jobId,
    normalizedPath,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function scanLimit(value: number | undefined): number {
  const result = value ?? MEDIA_REPAIR_MAX_SCAN_ISSUES;
  if (!Number.isSafeInteger(result) || result < 1 || result > MEDIA_REPAIR_MAX_SCAN_ISSUES) {
    throw new RangeError(`Media repair scan limit must be between 1 and ${MEDIA_REPAIR_MAX_SCAN_ISSUES}.`);
  }
  return result;
}

function listLimit(value: number | undefined): number {
  const result = value ?? MEDIA_REPAIR_DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(result) || result < 1 || result > MEDIA_REPAIR_MAX_LIST_LIMIT) {
    throw new RangeError(`Media repair list limit must be between 1 and ${MEDIA_REPAIR_MAX_LIST_LIMIT}.`);
  }
  return result;
}

function leaseDuration(value: number | undefined): number {
  const result = value ?? MEDIA_REPAIR_DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(result) || result < MEDIA_REPAIR_MIN_LEASE_MS || result > MEDIA_REPAIR_MAX_LEASE_MS) {
    throw new RangeError(
      `Media repair lease must be between ${MEDIA_REPAIR_MIN_LEASE_MS} and ${MEDIA_REPAIR_MAX_LEASE_MS} milliseconds.`,
    );
  }
  return result;
}

function dateAfter(value: Date, milliseconds: number, label: string): Date {
  const result = new Date(value.getTime() + milliseconds);
  if (!isSafeDate(result)) throw new RangeError(`${label} is outside the supported Date range.`);
  return result;
}

function issueKeyInput(value: string): string {
  if (!SHA256.test(value)) throw new MediaRepairQueueError('invalid_input', 'Media repair issue key is invalid.');
  return value;
}

function mapMediaRepairRow(row: typeof mediaRepairQueue.$inferSelect): MediaRepairRecord {
  const validIds = [row.assetId, row.jobId].every((value) =>
    value === null || (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MEDIA_REPAIR_MAX_IDENTIFIER_LENGTH &&
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r')
    ),
  );
  const validLastError = row.lastErrorCode === null || (
    typeof row.lastErrorCode === 'string' && ERROR_CODE.test(row.lastErrorCode)
  );
  const validDates = isSafeDate(row.nextAttemptAt) &&
    (row.leaseUntil === null || isSafeDate(row.leaseUntil)) &&
    isSafeDate(row.firstSeenAt) &&
    isSafeDate(row.lastSeenAt) &&
    (row.resolvedAt === null || isSafeDate(row.resolvedAt));
  const validState = MEDIA_REPAIR_STATES.includes(row.state as MediaRepairState);
  const validKind = MEDIA_REPAIR_KINDS.includes(row.kind as MediaRepairKind);
  const validAttempts = Number.isSafeInteger(row.attempts) &&
    row.attempts >= 0 &&
    row.attempts <= MEDIA_REPAIR_MAX_ATTEMPTS;
  const validRelations = validDates &&
    row.lastSeenAt.getTime() >= row.firstSeenAt.getTime() &&
    ((row.state === 'running' && row.leaseUntil !== null) ||
      (row.state !== 'running' && row.leaseUntil === null)) &&
    ((row.state === 'resolved' && row.resolvedAt !== null) ||
      (row.state !== 'resolved' && row.resolvedAt === null));
  if (
    !SHA256.test(row.issueKey) ||
    !validIds ||
    !validLastError ||
    !safeStoredPath(row.storedPath) ||
    !validDates ||
    !validState ||
    !validKind ||
    !validAttempts ||
    !validRelations
  ) {
    throw new MediaRepairQueueError('invalid_row', 'Media repair queue row is invalid.');
  }
  return {
    assetId: row.assetId,
    attempts: row.attempts,
    firstSeenAt: row.firstSeenAt,
    issueKey: row.issueKey,
    jobId: row.jobId,
    kind: row.kind as MediaRepairKind,
    lastErrorCode: row.lastErrorCode,
    lastSeenAt: row.lastSeenAt,
    leaseUntil: row.leaseUntil,
    nextAttemptAt: row.nextAttemptAt,
    resolvedAt: row.resolvedAt,
    state: row.state as MediaRepairState,
    storedPath: row.storedPath,
  };
}

function transitionGuardMatches(
  row: MediaRepairRecord,
  options: MediaRepairTransitionOptions,
): boolean {
  const hasGuard = options.expectedAttempts !== undefined || options.expectedLeaseUntil !== undefined;
  if (row.state !== 'running') return !hasGuard;
  if (!hasGuard || options.expectedAttempts === undefined || options.expectedLeaseUntil === undefined) {
    return false;
  }
  const leaseUntil = row.leaseUntil;
  return leaseUntil !== null &&
    row.attempts === options.expectedAttempts &&
    leaseUntil.getTime() === options.expectedLeaseUntil.getTime() &&
    leaseUntil.getTime() > (options.now?.getTime() ?? Date.now());
}

function retryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 20);
  return Math.min(MEDIA_REPAIR_MAX_BACKOFF_MS, MEDIA_REPAIR_RETRY_BASE_MS * 2 ** exponent);
}

export class MediaRepairQueueRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(issueKey: string): MediaRepairRecord | null {
    const row = this.database
      .select()
      .from(mediaRepairQueue)
      .where(eq(mediaRepairQueue.issueKey, issueKeyInput(issueKey)))
      .get();
    return row === undefined ? null : mapMediaRepairRow(row);
  }

  public list(options: MediaRepairListOptions = {}): readonly MediaRepairRecord[] {
    const limit = listLimit(options.limit);
    const state = options.state === undefined ? undefined : validateState(options.state);
    const rows = this.database
      .select()
      .from(mediaRepairQueue)
      .where(state === undefined ? undefined : eq(mediaRepairQueue.state, state))
      .orderBy(
        asc(mediaRepairQueue.nextAttemptAt),
        asc(mediaRepairQueue.firstSeenAt),
        asc(mediaRepairQueue.issueKey),
      )
      .limit(limit)
      .all();
    return rows.map(mapMediaRepairRow);
  }

  public count(): number {
    const row = this.database
      .select({ value: count() })
      .from(mediaRepairQueue)
      .get();
    return row?.value ?? 0;
  }

  public hasDue(now?: Date): boolean {
    const checkedAt = requiredDate(now, 'Due time');
    try {
      return this.database
        .select({ issueKey: mediaRepairQueue.issueKey })
        .from(mediaRepairQueue)
        .where(and(
          eq(mediaRepairQueue.state, 'open'),
          lte(mediaRepairQueue.nextAttemptAt, checkedAt),
          lt(mediaRepairQueue.attempts, MEDIA_REPAIR_MAX_ATTEMPTS),
        ))
        .limit(1)
        .get() !== undefined;
    } catch {
      throw new MediaRepairQueueError('storage_failure', 'Due media repair rows could not be inspected.');
    }
  }

  public upsertScan(
    issues: readonly MediaRepairIssueInput[],
    options: MediaRepairScanOptions = {},
  ): MediaRepairScanResult {
    const scanAt = requiredDate(options.now, 'Scan time');
    const maxIssues = scanLimit(options.maxIssues);
    const truncated = options.truncated === true || issues.length > maxIssues;
    const uniqueIssues = new Map<string, NormalizedIssue>();
    for (const issue of issues.slice(0, maxIssues)) {
      const normalized = normalizedIssue(issue);
      uniqueIssues.set(normalized.issueKey, normalized);
    }
    const orderedIssues = [...uniqueIssues.values()].sort((left, right) =>
      left.issueKey.localeCompare(right.issueKey));

    try {
      return this.database.transaction((transaction) => {
        transaction
          .update(mediaRepairQueue)
          .set({
            nextAttemptAt: scanAt,
            resolvedAt: null,
            state: 'open',
            leaseUntil: null,
          })
          .where(and(
            eq(mediaRepairQueue.state, 'running'),
            isNotNull(mediaRepairQueue.leaseUntil),
            lte(mediaRepairQueue.leaseUntil, scanAt),
          ))
          .run();

        let inserted = 0;
        let updated = 0;
        let reopened = 0;
        for (const issue of orderedIssues) {
          const existing = transaction
            .select()
            .from(mediaRepairQueue)
            .where(eq(mediaRepairQueue.issueKey, issue.issueKey))
            .get();
          if (existing === undefined) {
            transaction.insert(mediaRepairQueue).values({
              assetId: issue.assetId,
              firstSeenAt: scanAt,
              issueKey: issue.issueKey,
              jobId: issue.jobId,
              kind: issue.kind,
              lastErrorCode: null,
              lastSeenAt: scanAt,
              leaseUntil: null,
              nextAttemptAt: scanAt,
              resolvedAt: null,
              state: 'open',
              storedPath: issue.storedPath,
            }).run();
            inserted += 1;
            continue;
          }

          const existingRecord = mapMediaRepairRow(existing);
          const lastSeenAt = existingRecord.lastSeenAt.getTime() > scanAt.getTime()
            ? existingRecord.lastSeenAt
            : scanAt;
          const wasResolved = existingRecord.state === 'resolved';
          if (wasResolved) reopened += 1;
          transaction
            .update(mediaRepairQueue)
            .set(wasResolved
              ? {
                assetId: issue.assetId,
                jobId: issue.jobId,
                kind: issue.kind,
                lastSeenAt,
                lastErrorCode: null,
                leaseUntil: null,
                nextAttemptAt: scanAt,
                resolvedAt: null,
                state: 'open',
                storedPath: issue.storedPath,
              }
              : {
                assetId: issue.assetId,
                jobId: issue.jobId,
                kind: issue.kind,
                lastSeenAt,
                storedPath: issue.storedPath,
              })
            .where(eq(mediaRepairQueue.issueKey, issue.issueKey))
            .run();
          updated += 1;
        }

        let resolved = 0;
        if (!truncated) {
          const activeRows = transaction
            .select({ issueKey: mediaRepairQueue.issueKey })
            .from(mediaRepairQueue)
            .where(eq(mediaRepairQueue.state, 'open'))
            .all();
          const seen = new Set(orderedIssues.map((issue) => issue.issueKey));
          for (const row of activeRows) {
            if (seen.has(row.issueKey)) continue;
            resolved += transaction
              .update(mediaRepairQueue)
              .set({
                leaseUntil: null,
                resolvedAt: scanAt,
                state: 'resolved',
              })
              .where(and(
                eq(mediaRepairQueue.issueKey, row.issueKey),
                eq(mediaRepairQueue.state, 'open'),
              ))
              .run().changes;
          }
        }
        return {
          inserted,
          reopened,
          resolved,
          seen: orderedIssues.length,
          truncated,
          updated,
        };
      });
    } catch (error) {
      if (error instanceof MediaRepairQueueError) throw error;
      throw new MediaRepairQueueError('storage_failure', 'Media repair queue scan could not be stored.');
    }
  }

  public reclaimExpired(now?: Date): number {
    const reclaimAt = requiredDate(now, 'Reclaim time');
    try {
      return this.database
        .update(mediaRepairQueue)
        .set({
          leaseUntil: null,
          nextAttemptAt: reclaimAt,
          resolvedAt: null,
          state: 'open',
        })
        .where(and(
          eq(mediaRepairQueue.state, 'running'),
          isNotNull(mediaRepairQueue.leaseUntil),
          lte(mediaRepairQueue.leaseUntil, reclaimAt),
        ))
        .run().changes;
    } catch {
      throw new MediaRepairQueueError('storage_failure', 'Expired media repair leases could not be reclaimed.');
    }
  }

  public claimNext(options: MediaRepairClaimOptions = {}): MediaRepairRecord | null {
    const now = requiredDate(options.now, 'Claim time');
    const leaseMs = leaseDuration(options.leaseMs);
    const leaseUntil = dateAfter(now, leaseMs, 'Claim lease');
    try {
      return this.database.transaction((transaction) => {
        transaction
          .update(mediaRepairQueue)
          .set({
            leaseUntil: null,
            nextAttemptAt: now,
            resolvedAt: null,
            state: 'open',
          })
          .where(and(
            eq(mediaRepairQueue.state, 'running'),
            isNotNull(mediaRepairQueue.leaseUntil),
            lte(mediaRepairQueue.leaseUntil, now),
          ))
          .run();
        const candidate = transaction
          .select()
          .from(mediaRepairQueue)
          .where(and(
            eq(mediaRepairQueue.state, 'open'),
            lte(mediaRepairQueue.nextAttemptAt, now),
            lt(mediaRepairQueue.attempts, MEDIA_REPAIR_MAX_ATTEMPTS),
          ))
          .orderBy(
            asc(mediaRepairQueue.nextAttemptAt),
            asc(mediaRepairQueue.firstSeenAt),
            asc(mediaRepairQueue.issueKey),
          )
          .limit(1)
          .get();
        if (candidate === undefined) return null;
        const changed = transaction
          .update(mediaRepairQueue)
          .set({
            attempts: sql`${mediaRepairQueue.attempts} + 1`,
            leaseUntil,
            state: 'running',
          })
          .where(and(
            eq(mediaRepairQueue.issueKey, candidate.issueKey),
            eq(mediaRepairQueue.state, 'open'),
            lte(mediaRepairQueue.nextAttemptAt, now),
            lt(mediaRepairQueue.attempts, MEDIA_REPAIR_MAX_ATTEMPTS),
          ))
          .run();
        if (changed.changes !== 1) return null;
        const claimed = transaction
          .select()
          .from(mediaRepairQueue)
          .where(eq(mediaRepairQueue.issueKey, candidate.issueKey))
          .get();
        if (claimed === undefined) {
          throw new MediaRepairQueueError('invalid_row', 'Claimed media repair row disappeared.');
        }
        return mapMediaRepairRow(claimed);
      });
    } catch (error) {
      if (error instanceof MediaRepairQueueError) throw error;
      throw new MediaRepairQueueError('storage_failure', 'Media repair queue claim failed.');
    }
  }

  public resolve(issueKey: string, options: MediaRepairTransitionOptions = {}): MediaRepairRecord | null {
    return this.transition(issueKey, options, 'resolved');
  }

  public markManual(issueKey: string, options: MediaRepairTransitionOptions = {}): MediaRepairRecord | null {
    return this.transition(issueKey, options, 'manual');
  }

  public retry(issueKey: string, options: MediaRepairRetryOptions = {}): MediaRepairRecord | null {
    const now = requiredDate(options.now, 'Retry time');
    const key = issueKeyInput(issueKey);
    try {
      return this.database.transaction((transaction) => {
        const row = transaction
          .select()
          .from(mediaRepairQueue)
          .where(eq(mediaRepairQueue.issueKey, key))
          .get();
        if (row === undefined) return null;
        const current = mapMediaRepairRow(row);
        if (!transitionGuardMatches(current, options)) return null;
        const nextAttemptAt = dateAfter(now, retryDelay(current.attempts), 'Retry schedule');
        const changed = transaction
          .update(mediaRepairQueue)
          .set({
            lastErrorCode: normalizeErrorCode(options.errorCode),
            leaseUntil: null,
            nextAttemptAt,
            resolvedAt: null,
            state: 'open',
          })
          .where(and(
            eq(mediaRepairQueue.issueKey, key),
            eq(mediaRepairQueue.state, current.state),
            ...(current.state === 'running'
              ? [
                eq(mediaRepairQueue.attempts, current.attempts),
                eq(mediaRepairQueue.leaseUntil, current.leaseUntil!),
              ]
              : []),
          ))
          .run();
        if (changed.changes !== 1) return null;
        const updated = transaction
          .select()
          .from(mediaRepairQueue)
          .where(eq(mediaRepairQueue.issueKey, key))
          .get();
        return updated === undefined ? null : mapMediaRepairRow(updated);
      });
    } catch (error) {
      if (error instanceof MediaRepairQueueError) throw error;
      if (error instanceof RangeError) throw error;
      throw new MediaRepairQueueError('storage_failure', 'Media repair queue retry failed.');
    }
  }

  private transition(
    issueKey: string,
    options: MediaRepairTransitionOptions,
    state: 'manual' | 'resolved',
  ): MediaRepairRecord | null {
    const now = requiredDate(options.now, `${state} time`);
    const key = issueKeyInput(issueKey);
    try {
      return this.database.transaction((transaction) => {
        const row = transaction
          .select()
          .from(mediaRepairQueue)
          .where(eq(mediaRepairQueue.issueKey, key))
          .get();
        if (row === undefined) return null;
        const current = mapMediaRepairRow(row);
        if (state === 'resolved' && current.state === 'resolved') return current;
        if (state === 'manual' && current.state === 'manual') return current;
        if (!transitionGuardMatches(current, options)) return null;
        const changed = transaction
          .update(mediaRepairQueue)
          .set(state === 'resolved'
            ? { leaseUntil: null, resolvedAt: now, state: 'resolved' }
            : { leaseUntil: null, resolvedAt: null, state: 'manual' })
          .where(and(
            eq(mediaRepairQueue.issueKey, key),
            eq(mediaRepairQueue.state, current.state),
            ...(current.state === 'running'
              ? [
                eq(mediaRepairQueue.attempts, current.attempts),
                eq(mediaRepairQueue.leaseUntil, current.leaseUntil!),
              ]
              : []),
          ))
          .run();
        if (changed.changes !== 1) return null;
        const updated = transaction
          .select()
          .from(mediaRepairQueue)
          .where(eq(mediaRepairQueue.issueKey, key))
          .get();
        return updated === undefined ? null : mapMediaRepairRow(updated);
      });
    } catch (error) {
      if (error instanceof MediaRepairQueueError) throw error;
      throw new MediaRepairQueueError('storage_failure', `Media repair queue ${state} failed.`);
    }
  }
}
