import { scrypt, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type DatabaseClient } from '../database/client.js';
import { AccountAuth, AccountRateLimitError, type AccountAuthOptions } from './account-auth.js';

const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
const request = (headers: Record<string, string>, ip = 'fixture-ip') => ({ headers, ip }) as FastifyRequest;
const basic = (username = 'admin', password = 'admin') => ({ authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` });

describe('account authentication service', () => {
  let directory: string;
  let db: DatabaseClient;
  const setup = async (options: AccountAuthOptions = {}) => {
    directory = await mkdtemp(join(tmpdir(), 'imagine-auth-service-'));
    db = createDatabase(join(directory, 'app.db'));
    return AccountAuth.initialize(db.sqlite, 'fixture-secret', 'admin', 'admin', options);
  };
  afterEach(async () => { db?.sqlite.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('reuses one asynchronous KDF per request and rechecks stream revocation without a KDF', async () => {
    const kdf = vi.fn(derive);
    const auth = await setup({ deriveKey: kdf });
    const account = await auth.create('alice', 'password');
    kdf.mockClear();
    const req = request(basic('alice', 'password'));
    await Promise.all([auth.authenticateRequest(req), auth.authenticateRequest(req)]);
    expect(auth.user(req)?.id).toBe(account.id);
    expect(auth.authenticated(req)).toBe(true);
    expect(kdf).toHaveBeenCalledTimes(1);
    await auth.update(account.id, { enabled: false });
    expect(auth.user(req)).toBeNull();
    expect(kdf).toHaveBeenCalledTimes(1);
  });

  it('shares attempt budgets, expires windows, clears after success and leaves Cookies independent', async () => {
    let now = 1_800_000_000_000;
    const kdf = vi.fn(derive), auth = await setup({ now: () => now, deriveKey: kdf });
    const cookieRequest = request({ cookie: auth.sessionCookie('admin', false) });
    kdf.mockClear();
    for (let i = 0; i < 10; i++) await auth.login('missing', 'wrong', 'fixture-ip');
    await expect(auth.authenticateRequest(request(basic('missing', 'wrong')))).rejects.toMatchObject({ retryAfterSeconds: 60 });
    expect(kdf).toHaveBeenCalledTimes(10);
    expect(auth.user(cookieRequest)?.id).toBe('admin');
    now += 60_000;
    await expect(auth.login('admin', 'admin', 'fixture-ip')).resolves.toMatchObject({ id: 'admin' });
    for (let i = 0; i < 9; i++) await auth.login('missing', 'wrong', 'fixture-ip');
    await auth.login('admin', 'admin', 'fixture-ip');
    for (let i = 0; i < 10; i++) await auth.login('missing', 'wrong', 'fixture-ip');
    await expect(auth.login('missing', 'wrong', 'fixture-ip')).rejects.toBeInstanceOf(AccountRateLimitError);
    now += 43_200_000;
    expect(auth.user(cookieRequest)).toBeNull();
  });

  it('retains legacy hashes and rejects account changes made during password work', async () => {
    let pause = false, blocked = false, release = () => {};
    const auth = await setup({ deriveKey: async (password, salt) => {
      const key = await derive(password, salt);
      if (pause) await new Promise<void>(resolve => { blocked = true; release = resolve; });
      return key;
    } });
    const alice = await auth.create('alice', 'password');
    const salt = 'legacy-salt';
    db.sqlite.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(`${salt}:${scryptSync('password', salt, 64).toString('hex')}`, alice.id);
    expect(await auth.login('alice', 'password', 'fixture-ip')).not.toBeNull();
    const cookie = request({ cookie: auth.sessionCookie(alice.id, false) });
    pause = true;
    const inFlight = auth.login('alice', 'password', 'fixture-ip');
    await expect.poll(() => blocked).toBe(true);
    await auth.update(alice.id, { enabled: false });
    release();
    expect(await inFlight).toBeNull();
    expect(auth.user(cookie)).toBeNull();
  });
});
