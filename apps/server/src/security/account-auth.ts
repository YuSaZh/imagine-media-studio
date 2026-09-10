import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { PasswordAuth } from './password-auth.js';
import type { AccountIdentity } from './account-context.js';

interface AccountRow extends AccountIdentity { password_hash: string; enabled: number; session_version: number; }
interface AttemptWindow { count: number; expires: number; }
interface BasicSession { id: string; version: number; }
export interface AccountAuthOptions {
  now?: () => number;
  deriveKey?: (password: string, salt: string) => Promise<Buffer>;
}
const deriveKey = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
});
const UNKNOWN_PASSWORD_HASH = '00000000000000000000000000000000:' + '00'.repeat(64);

export class AccountRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super('Too many authentication attempts.'); }
}

export class AccountAuth extends PasswordAuth {
  private readonly attempts = new Map<string, AttemptWindow>();
  private readonly requests = new WeakMap<FastifyRequest, Promise<void>>();
  private readonly basicSessions = new WeakMap<FastifyRequest, BasicSession>();
  private readonly now: () => number;
  private readonly deriveKey: (password: string, salt: string) => Promise<Buffer>;

  private constructor(private readonly sqlite: Database.Database, private readonly secret: string, options: AccountAuthOptions) {
    super({ appSecret: secret, password: '' });
    this.now = options.now ?? Date.now;
    this.deriveKey = options.deriveKey ?? deriveKey;
  }

  public static async initialize(sqlite: Database.Database, secret: string, username: string, password: string, options: AccountAuthOptions = {}): Promise<AccountAuth> {
    const auth = new AccountAuth(sqlite, secret, options);
    if (!sqlite.prepare('SELECT id FROM accounts LIMIT 1').get()) {
      const hash = await auth.hashPassword(password);
      sqlite.transaction(() => {
        if (sqlite.prepare('SELECT id FROM accounts LIMIT 1').get()) return;
        sqlite.prepare('INSERT INTO accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run('admin', username, hash, 'admin', auth.now());
        sqlite.prepare('INSERT INTO account_settings(owner_id, key, value_json, updated_at) SELECT ?, key, value_json, updated_at FROM settings').run('admin');
      })();
    }
    return auth;
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${(await this.deriveKey(password, salt)).toString('hex')}`;
  }

  private reserveAttempt(ip: string): AttemptWindow {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    const window = this.attempts.get(ip) ?? { count: 0, expires: now + 60_000 };
    if (window.count >= 10 || !this.attempts.has(ip) && this.attempts.size >= 10_000) {
      throw new AccountRateLimitError(Math.max(1, Math.ceil((window.expires - now) / 1000)));
    }
    window.count++;
    this.attempts.set(ip, window);
    return window;
  }

  public identity(row: AccountIdentity): AccountIdentity { return { id: row.id, username: row.username, role: row.role }; }
  public list(): (AccountIdentity & { enabled: boolean })[] {
    return (this.sqlite.prepare('SELECT id, username, role, enabled FROM accounts ORDER BY created_at').all() as AccountRow[]).map(row => ({ ...this.identity(row), enabled: !!row.enabled }));
  }

  public async login(username: string, password: string, ip: string): Promise<AccountRow | null> {
    const attempt = this.reserveAttempt(ip);
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE username = ?').get(username) as AccountRow | undefined;
    const parts = (row?.password_hash ?? UNKNOWN_PASSWORD_HASH).split(':');
    const wellFormed = !!parts[0] && /^[a-f0-9]{128}$/iu.test(parts[1] ?? '') && parts.length === 2;
    const [salt, hash] = wellFormed ? parts : UNKNOWN_PASSWORD_HASH.split(':');
    const derived = await this.deriveKey(password, salt!);
    const expected = Buffer.from(hash!, 'hex');
    const valid = wellFormed && derived.length === expected.length && timingSafeEqual(derived, expected);
    if (!row || !valid) return null;
    // A password or account state may have changed while asynchronous KDF work ran.
    const current = this.sqlite.prepare('SELECT * FROM accounts WHERE id=? AND enabled=1 AND session_version=? AND password_hash=?').get(row.id, row.session_version, row.password_hash) as AccountRow | undefined;
    if (!current) return null;
    if (this.attempts.get(ip) === attempt) this.attempts.delete(ip);
    return current;
  }

  public async create(username: string, password: string): Promise<AccountIdentity> {
    const id = randomUUID(), hash = await this.hashPassword(password);
    this.sqlite.prepare('INSERT INTO accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(id, username, hash, 'user', this.now());
    return { id, username, role: 'user' };
  }

  public async update(id: string, input: { username?: string | undefined; password?: string | undefined; enabled?: boolean | undefined }): Promise<void> {
    const row = this.sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    if (!row) throw new Error('Account not found');
    if (row.role === 'admin' && input.enabled === false) throw new Error('Administrator cannot be disabled');
    const hash = input.password ? await this.hashPassword(input.password) : row.password_hash;
    const result = this.sqlite.prepare('UPDATE accounts SET username=?, password_hash=?, enabled=?, session_version=session_version+1 WHERE id=? AND session_version=?').run(input.username ?? row.username, hash, input.enabled === undefined ? row.enabled : Number(input.enabled), id, row.session_version);
    if (result.changes !== 1) throw new Error('Account changed during update');
  }

  public sessionCookie(id: string, secure: boolean): string {
    const row = this.sqlite.prepare('SELECT session_version FROM accounts WHERE id=?').get(id) as AccountRow;
    const payload = `${id}.${row.session_version}.${Math.floor(this.now() / 1000) + 43200}`;
    return `imagine_session=${payload}.${this.signature(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`;
  }
  private signature(payload: string): string { return createHmac('sha256', this.secret).update(`accounts/v1/${payload}`).digest('hex'); }

  /** Called once before request authorization; later consumers never repeat the KDF. */
  public authenticateRequest(request: FastifyRequest): Promise<void> {
    let pending = this.requests.get(request);
    if (!pending) {
      pending = this.authenticateBasic(request);
      this.requests.set(request, pending);
    }
    return pending;
  }
  private async authenticateBasic(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !/^Basic /iu.test(header)) return;
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const separator = decoded.indexOf(':');
    try {
      const row = await this.login(separator < 0 ? '' : decoded.slice(0, separator), separator < 0 ? '' : decoded.slice(separator + 1), request.ip);
      if (row) this.basicSessions.set(request, { id: row.id, version: row.session_version });
    } catch (error) {
      // Preserve existing Basic-to-Cookie fallback without making Cookie sessions
      // depend on another client's failed password attempts on a shared IP.
      if (!(error instanceof AccountRateLimitError) || !this.cookieUser(request)) throw error;
    }
  }

  public user(request: FastifyRequest): AccountIdentity | null {
    const basic = this.basicSessions.get(request);
    if (basic) {
      const row = this.sqlite.prepare('SELECT id,username,role FROM accounts WHERE id=? AND enabled=1 AND session_version=?').get(basic.id, basic.version) as AccountIdentity | undefined;
      if (row) return this.identity(row);
    }
    return this.cookieUser(request);
  }
  private cookieUser(request: FastifyRequest): AccountIdentity | null {
    const token = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('imagine_session='))?.slice(16);
    if (!token) return null;
    const [id, version, expiry, signature, ...rest] = token.split('.');
    if (!id || !version || !expiry || !signature || rest.length || !/^\d+$/.test(expiry) || Number(expiry) <= this.now() / 1000) return null;
    const expected = Buffer.from(this.signature(`${id}.${version}.${expiry}`)), actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const row = this.sqlite.prepare('SELECT id,username,role FROM accounts WHERE id=? AND enabled=1 AND session_version=?').get(id, version) as AccountIdentity | undefined;
    return row ? this.identity(row) : null;
  }
  public override authenticated(request: FastifyRequest): boolean { return this.user(request) !== null; }
}
