import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseClient {
  orm: AppDatabase;
  sqlite: Database.Database;
}

function resolveMigrationsDirectory(explicitDirectory?: string): string {
  if (explicitDirectory) {
    return resolve(explicitDirectory);
  }

  const candidates = [
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'apps/server/migrations'),
    resolve(process.cwd(), 'dist/migrations'),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));

  if (!directory) {
    throw new Error('Unable to locate the database migrations directory.');
  }

  return directory;
}

function applyMigrations(sqlite: Database.Database, migrationsDirectory?: string): void {
  const directory = resolveMigrationsDirectory(migrationsDirectory);
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const isApplied = sqlite.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigration = sqlite.prepare(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (isApplied.get(file)) {
      continue;
    }

    const sql = readFileSync(resolve(directory, file), 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sql);
      recordMigration.run(file, Date.now());
    })();
  }
}

export function createDatabase(
  databasePath: string,
  migrationsDirectory?: string,
): DatabaseClient {
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('busy_timeout = 5000');
    applyMigrations(sqlite, migrationsDirectory);
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the initialization failure when cleanup itself fails.
    }
    throw error;
  }

  return {
    orm: drizzle(sqlite, { schema }),
    sqlite,
  };
}
