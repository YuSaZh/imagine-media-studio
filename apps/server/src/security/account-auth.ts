import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { PasswordAuth } from './password-auth.js';
import type { AccountIdentity } from './account-context.js';

interface AccountRow extends AccountIdentity { password_hash: string; enabled: number; session_version: number; }
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function matches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export class AccountAuth extends PasswordAuth {
  public constructor(private readonly sqlite: Database.Database, private readonly secret: string, username: string, password: string) {
    super({ appSecret: secret, password });
    if (!sqlite.prepare('SELECT id FROM accounts LIMIT 1').get()) {
      sqlite.transaction(() => {
        sqlite.prepare('INSERT INTO accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run('admin', username, hashPassword(password), 'admin', Date.now());
        sqlite.prepare('INSERT INTO account_settings(owner_id, key, value_json, updated_at) SELECT ?, key, value_json, updated_at FROM settings').run('admin');
      })();
    }
  }
  public identity(row: AccountIdentity): AccountIdentity { return { id: row.id, username: row.username, role: row.role }; }
  public list(): (AccountIdentity & { enabled: boolean })[] {
    return (this.sqlite.prepare('SELECT id, username, role, enabled FROM accounts ORDER BY created_at').all() as AccountRow[]).map(row => ({ ...this.identity(row), enabled: !!row.enabled }));
  }
  public login(username: string, password: string): AccountRow | null {
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined;
    // Equal-cost password work also applies to nonexistent usernames.
    const valid = matches(password, row?.password_hash ?? '00000000000000000000000000000000:' + '00'.repeat(64));
    return row?.enabled && valid ? row : null;
  }
  public create(username: string, password: string): AccountIdentity {
    const id = randomUUID();
    this.sqlite.prepare('INSERT INTO accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, hashPassword(password), 'user', Date.now());
    return { id, username, role: 'user' };
  }
  public update(id: string, input: { username?: string | undefined; password?: string | undefined; enabled?: boolean | undefined }): void {
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    if (!row) throw new Error('Account not found');
    if (row.role === 'admin' && input.enabled === false) throw new Error('Administrator cannot be disabled');
    this.sqlite.prepare('UPDATE accounts SET username=?, password_hash=?, enabled=?, session_version=session_version+1 WHERE id=?').run(input.username ?? row.username, input.password ? hashPassword(input.password) : row.password_hash, input.enabled === undefined ? row.enabled : Number(input.enabled), id);
  }
  public sessionCookie(id: string, secure: boolean): string {
    const row = this.sqlite.prepare('SELECT session_version FROM accounts WHERE id=?').get(id) as AccountRow;
    const payload = `${id}.${row.session_version}.${Math.floor(Date.now() / 1000) + 43200}`;
    return `imagine_session=${payload}.${this.signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`;
  }
  private signature(payload: string): string { return createHmac('sha256', this.secret).update(`accounts/v1/${payload}`).digest('hex'); }
  public user(request: FastifyRequest): AccountIdentity | null {
    const header = request.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      const separator = decoded.indexOf(':');
      const row = separator < 0 ? null : this.login(decoded.slice(0, separator), decoded.slice(separator + 1));
      if (row) return this.identity(row);
    }
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('imagine_session='))?.slice(16);
    if (!token) return null;
    const [id, version, expiry, signature, ...rest] = token.split('.');
    if (!id || !version || !expiry || !signature || rest.length || !/^\d+$/.test(expiry) || Number(expiry) <= Date.now() / 1000) return null;
    const expected = Buffer.from(this.signature(`${id}.${version}.${expiry}`));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND session_version=?').get(id, version) as AccountRow | undefined;
    return row ? this.identity(row) : null;
  }
  public override authenticated(request: FastifyRequest): boolean { return this.user(request) !== null; }
}
