import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../database/client.js';
import type { MediaConsistencyReport } from '../media/maintenance.js';
import type { DatabaseBackupResult } from '../maintenance/database-backup.js';
import {
  BackupInProgressError,
  DatabaseBackupClosedError,
  DatabaseBackupCollisionError,
} from '../maintenance/database-backup.js';
import { registerMaintenanceRoutes, MaintenanceUnauthenticatedError } from './maintenance.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

const RESULT: DatabaseBackupResult = {
  createdAt: new Date('2026-08-29T00:00:00.000Z'),
  id: 'backup-route-test',
  sha256: 'a'.repeat(64),
  size: 8192,
};

const MEDIA_RESULT: MediaConsistencyReport = {
  assetCount: 0,
  fileCount: 0,
  hashedBytes: 0,
  issueCount: 0,
  issues: [],
  ok: true,
  truncated: false,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
  vi.restoreAllMocks();
});

async function createRouteApp(options: {
  readonly adminEnabled?: boolean;
  readonly backup?: { create(): Promise<DatabaseBackupResult> };
  readonly media?: { audit(): Promise<MediaConsistencyReport> };
  readonly assertAdmin?: (request: FastifyRequest) => void;
} = {}): Promise<FastifyInstance> {
  const dataDir = await mkdtemp(join(tmpdir(), 'imagine-maintenance-route-'));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(resolve(dataDir, 'app.db'), migrationsDirectory);
  const backup = options.backup ?? { create: vi.fn().mockResolvedValue(RESULT) };
  const media = options.media ?? { audit: vi.fn().mockResolvedValue(MEDIA_RESULT) };
  const app = Fastify({ logger: false });
  apps.push(app);
  app.addHook('onClose', async () => {
    database.sqlite.close();
  });
  await registerMaintenanceRoutes(app, {
    authorization: {
      adminEnabled: options.adminEnabled ?? true,
      assertAdmin: (request) => {
        if (options.assertAdmin !== undefined) {
          options.assertAdmin(request);
          return;
        }
        if (request.headers.authorization !== 'Basic admin') {
          throw new MaintenanceUnauthenticatedError();
        }
      },
    },
    backup,
    media,
    sqlite: database.sqlite,
  });
  return app;
}

describe('maintenance routes', () => {
  it('requires an explicitly enabled administrator even when no password is configured', async () => {
    const app = await createRouteApp({ adminEnabled: false });
    const integrity = await app.inject({ method: 'GET', url: '/internal/maintenance/integrity' });
    const backup = await app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: { authorization: 'Basic admin' },
    });

    expect(integrity.statusCode).toBe(403);
    expect(integrity.json()).toEqual({
      error: 'administrator_required',
      message: 'Administrator authorization is required for maintenance.',
    });
    expect(backup.statusCode).toBe(403);
  });

  it('fails closed for unauthenticated administrators and accepts only empty requests', async () => {
    const create = vi.fn().mockResolvedValue(RESULT);
    const app = await createRouteApp({ backup: { create } });
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
    });
    const query = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity?path=%2Fdata%2Fapp.db',
      headers: { authorization: 'Basic admin' },
    });
    const getBody = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
      headers: { authorization: 'Basic admin' },
      payload: {},
    });
    const body = await app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: { authorization: 'Basic admin' },
      payload: {},
    });
    const extraQuery = await app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups?filename=app.db',
      headers: { authorization: 'Basic admin' },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain('Basic');
    expect(query.statusCode).toBe(400);
    expect(getBody.statusCode).toBe(400);
    expect(body.statusCode).toBe(400);
    expect(extraQuery.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('projects integrity and backup results without path or SQLite details', async () => {
    const app = await createRouteApp();
    const headers = { authorization: 'Basic admin' };
    const integrity = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/integrity',
      headers,
    });
    const backup = await app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers,
    });

    expect(integrity.statusCode).toBe(200);
    expect(integrity.json()).toMatchObject({
      integrity: {
        foreignKeyCheck: { ok: true, truncated: false, violationCount: 0 },
        foreignKeysEnabled: true,
        integrityCheck: { errorCount: 0, ok: true, truncated: false },
        ok: true,
      },
    });
    expect(integrity.body).not.toContain('schema_migrations');
    expect(backup.statusCode).toBe(201);
    expect(backup.json()).toEqual({
      backup: {
        createdAt: '2026-08-29T00:00:00.000Z',
        id: 'backup-route-test',
        sha256: 'a'.repeat(64),
        size: 8192,
      },
    });
    expect(backup.body).not.toContain('path');
    expect(backup.body).not.toContain('filename');
    expect(backup.body).not.toContain('sqlite');
  });

  it('projects a bounded media report and rejects request options', async () => {
    const audit = vi.fn().mockResolvedValue({
      assetCount: 2,
      fileCount: 4,
      hashedBytes: 128,
      issueCount: 1,
      issues: [{ assetId: 'asset-1', kind: 'missing', storedPath: 'media/uploads/a.png' }],
      ok: false,
      truncated: false,
    } satisfies MediaConsistencyReport);
    const app = await createRouteApp({ media: { audit } });
    const headers = { authorization: 'Basic admin' };
    const response = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/media',
      headers,
    });
    const query = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/media?path=media/uploads/a.png',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      media: {
        assetCount: 2,
        fileCount: 4,
        hashedBytes: 128,
        issueCount: 1,
        issues: [{ assetId: 'asset-1', kind: 'missing', storedPath: 'media/uploads/a.png' }],
        ok: false,
        truncated: false,
      },
    });
    expect(query.statusCode).toBe(400);
    expect(audit).toHaveBeenCalledOnce();
  });

  it('fails closed when a media implementation returns an unsafe stored path', async () => {
    const app = await createRouteApp({
      media: {
        audit: vi.fn().mockResolvedValue({
          ...MEDIA_RESULT,
          issueCount: 1,
          issues: [{ assetId: null, kind: 'unsafe', storedPath: '/data/app.db' }],
          ok: false,
        } satisfies MediaConsistencyReport),
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/internal/maintenance/media',
      headers: { authorization: 'Basic admin' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('/data/app.db');
    expect(response.body).not.toContain('unsafe stored path');
  });

  it.each([
    [new BackupInProgressError('private detail'), 409, 'backup_in_progress'],
    [new DatabaseBackupCollisionError('private detail'), 409, 'backup_conflict'],
    [new DatabaseBackupClosedError('private detail'), 503, 'maintenance_unavailable'],
    [new Error('SQLITE secret/path detail'), 500, 'maintenance_failed'],
  ] as const)('maps backup failures to stable safe responses', async (error, status, code) => {
    const app = await createRouteApp({ backup: { create: vi.fn().mockRejectedValue(error) } });
    const response = await app.inject({
      method: 'POST',
      url: '/internal/maintenance/backups',
      headers: { authorization: 'Basic admin' },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: code });
    expect(response.body).not.toContain('private detail');
    expect(response.body).not.toContain('SQLITE');
    expect(response.body).not.toContain('/path');
  });
});
