import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

const COOKIE_NAME = 'imagine_session';
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;

export interface PasswordAuthOptions {
  appSecret: string;
  password: string | null;
  sessionSeconds?: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Invalid cookies are ignored and cannot authenticate a request.
    }
  }
  return cookies;
}

function basicPassword(header: string | undefined): string | null {
  if (!header || !/^Basic /iu.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator < 0 ? null : decoded.slice(separator + 1);
  } catch {
    return null;
  }
}

export class PasswordAuth {
  private readonly appSecret: string;
  private readonly password: string | null;
  private readonly sessionSeconds: number;

  public constructor(options: PasswordAuthOptions) {
    this.appSecret = options.appSecret;
    this.password = options.password;
    this.sessionSeconds = options.sessionSeconds ?? DEFAULT_SESSION_SECONDS;
    if (!Number.isSafeInteger(this.sessionSeconds) || this.sessionSeconds < 60) {
      throw new RangeError('Password session duration must be at least 60 seconds.');
    }
  }

  public get required(): boolean {
    return this.password !== null;
  }

  public verifyPassword(candidate: string): boolean {
    return this.password !== null && constantTimeEqual(candidate, this.password);
  }

  public authenticated(request: FastifyRequest, now = new Date()): boolean {
    if (!this.required) return true;
    const authorizationPassword = basicPassword(request.headers.authorization);
    if (authorizationPassword !== null && this.verifyPassword(authorizationPassword)) return true;
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    return token !== undefined && this.verifyToken(token, now);
  }

  public createCookie(now = new Date(), secure = false): string {
    const expiresAt = Math.floor(now.getTime() / 1000) + this.sessionSeconds;
    const payload = String(expiresAt);
    const signature = this.sign(payload);
    return [
      `${COOKIE_NAME}=${encodeURIComponent(`${payload}.${signature}`)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${this.sessionSeconds}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }

  public clearCookie(secure = false): string {
    return [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; ');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.appSecret)
      .update(`imagine-media-studio/session/v1/${payload}`, 'utf8')
      .digest('base64url');
  }

  private verifyToken(token: string, now: Date): boolean {
    const [expiresValue, signature, ...rest] = token.split('.');
    if (!expiresValue || !signature || rest.length > 0 || !/^\d+$/.test(expiresValue)) return false;
    const expiresAt = Number(expiresValue);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now.getTime() / 1000)) return false;
    return constantTimeEqual(signature, this.sign(expiresValue));
  }
}
