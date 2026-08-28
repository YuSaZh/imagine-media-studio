import {
  EmptyQuerySchema,
  MaintenanceBackupResponseSchema,
  MaintenanceIntegrityResponseSchema,
} from '@imagine/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { checkSqliteIntegrity } from '../database/integrity.js';
import {
  BackupInProgressError,
  DatabaseBackupClosedError,
  DatabaseBackupCollisionError,
  type DatabaseBackupResult,
} from '../maintenance/database-backup.js';

export class MaintenanceUnauthenticatedError extends Error {
  public override readonly name = 'MaintenanceUnauthenticatedError';
}

export interface MaintenanceAuthorization {
  readonly adminEnabled: boolean;
  assertAdmin(request: FastifyRequest): void | Promise<void>;
}

export interface MaintenanceBackupPort {
  create(): Promise<DatabaseBackupResult>;
}

export interface MaintenanceRoutesOptions {
  readonly authorization: MaintenanceAuthorization;
  readonly backup: MaintenanceBackupPort;
  readonly sqlite: Database.Database;
}

function invalidRequest(reply: FastifyReply): void {
  void reply.code(400).send({
    error: 'invalid_request',
    message: 'The request must not include a body or query parameters.',
  });
}

function unauthorized(reply: FastifyReply): void {
  reply.header('www-authenticate', 'Basic realm="Imagine Media Studio", charset="UTF-8"');
  void reply.code(401).send({
    error: 'authentication_required',
    message: 'Administrator authentication is required.',
  });
}

function administratorRequired(reply: FastifyReply): void {
  void reply.code(403).send({
    error: 'administrator_required',
    message: 'Administrator authorization is required for maintenance.',
  });
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  authorization: MaintenanceAuthorization,
): Promise<boolean> {
  if (!authorization.adminEnabled) {
    administratorRequired(reply);
    return false;
  }
  try {
    await authorization.assertAdmin(request);
    return true;
  } catch (error) {
    if (error instanceof MaintenanceUnauthenticatedError) {
      unauthorized(reply);
      return false;
    }
    void reply.code(403).send({
      error: 'administrator_required',
      message: 'Administrator authorization is required for maintenance.',
    });
    return false;
  }
}

function hasBody(request: FastifyRequest): boolean {
  if (request.body !== undefined) return true;
  const contentLength = request.headers['content-length'];
  if (Array.isArray(contentLength)) return contentLength.some((value) => Number(value) > 0);
  if (typeof contentLength === 'string' && Number(contentLength) > 0) return true;
  return request.headers['transfer-encoding'] !== undefined;
}

function ensureEmptyRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  if (hasBody(request) || !EmptyQuerySchema.safeParse(request.query).success) {
    invalidRequest(reply);
    return false;
  }
  return true;
}

function safeFailure(reply: FastifyReply, status = 500): void {
  void reply.code(status).send({
    error: status === 503 ? 'maintenance_unavailable' : 'maintenance_failed',
    message: 'The maintenance operation could not be completed.',
  });
}

function integrityResponse(sqlite: Database.Database): unknown {
  const report = checkSqliteIntegrity(sqlite);
  return MaintenanceIntegrityResponseSchema.parse({
    integrity: {
      foreignKeyCheck: {
        ok: report.foreignKeyCheck.ok,
        truncated: report.foreignKeyCheck.truncated,
        violationCount: report.foreignKeyCheck.violations.length,
      },
      foreignKeysEnabled: report.foreignKeysEnabled,
      integrityCheck: report.integrityCheck,
      ok: report.ok,
    },
  });
}

function backupResponse(result: DatabaseBackupResult): unknown {
  return MaintenanceBackupResponseSchema.parse({
    backup: {
      createdAt: result.createdAt.toISOString(),
      id: result.id,
      sha256: result.sha256,
      size: result.size,
    },
  });
}

function backupFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof BackupInProgressError) {
    void reply.code(409).send({
      error: 'backup_in_progress',
      message: 'A database backup is already in progress.',
    });
    return;
  }
  if (error instanceof DatabaseBackupCollisionError) {
    void reply.code(409).send({
      error: 'backup_conflict',
      message: 'The database backup destination is unavailable.',
    });
    return;
  }
  if (error instanceof DatabaseBackupClosedError) {
    safeFailure(reply, 503);
    return;
  }
  safeFailure(reply);
}

export async function registerMaintenanceRoutes(
  app: FastifyInstance,
  options: MaintenanceRoutesOptions,
): Promise<void> {
  app.get('/internal/maintenance/integrity', async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorization)) return;
    if (!ensureEmptyRequest(request, reply)) return;
    try {
      return integrityResponse(options.sqlite);
    } catch {
      safeFailure(reply);
      return;
    }
  });

  app.post('/internal/maintenance/backups', async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorization)) return;
    if (!ensureEmptyRequest(request, reply)) return;
    try {
      const result = await options.backup.create();
      return reply.code(201).send(backupResponse(result));
    } catch (error) {
      backupFailure(reply, error);
      return;
    }
  });
}
