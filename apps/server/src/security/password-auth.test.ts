import { describe, expect, it } from 'vitest';

import { PasswordAuth } from './password-auth.js';

function request(headers: Record<string, string> = {}) {
  return { headers } as never;
}

describe('PasswordAuth', () => {
  it('creates an expiring signed HttpOnly session and rejects tampering', () => {
    const auth = new PasswordAuth({
      appSecret: 'test-app-secret-with-at-least-32-characters',
      password: 'correct horse battery staple',
      sessionSeconds: 3600,
    });
    const now = new Date('2026-08-25T00:00:00.000Z');
    const cookie = auth.createCookie(now, true);
    const pair = cookie.split(';')[0]!;

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(auth.authenticated(request({ cookie: pair }), new Date(now.getTime() + 1000))).toBe(true);
    expect(auth.authenticated(request({ cookie: `${pair}x` }), new Date(now.getTime() + 1000))).toBe(false);
    expect(auth.authenticated(request({ cookie: pair }), new Date(now.getTime() + 3601_000))).toBe(false);
  });

  it('accepts Basic credentials and bypasses authentication when disabled', () => {
    const enabled = new PasswordAuth({ appSecret: '0123456789abcdef', password: 'secret' });
    const basic = Buffer.from('studio:secret').toString('base64');
    expect(enabled.authenticated(request({ authorization: `Basic ${basic}` }))).toBe(true);
    expect(enabled.authenticated(request({ authorization: 'Basic invalid' }))).toBe(false);

    const disabled = new PasswordAuth({ appSecret: '0123456789abcdef', password: null });
    expect(disabled.authenticated(request())).toBe(true);
  });
});
