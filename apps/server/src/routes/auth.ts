import { AuthLoginSchema } from '@imagine/shared';
import ipaddr from 'ipaddr.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { PasswordAuth } from '../security/password-auth.js';

const LOCAL_ADDRESS_RANGES = new Set(['loopback', 'private', 'uniqueLocal']);

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/**
 * Treat every non-IP hostname as potentially public. Only the explicitly
 * local address classes are exempt from the first-run password warning.
 */
function isPotentiallyPublicHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost') return false;
  if (!ipaddr.isValid(normalized)) return true;
  try {
    return !LOCAL_ADDRESS_RANGES.has(ipaddr.process(normalized).range());
  } catch {
    return true;
  }
}

function publicAccessWarning(request: FastifyRequest, auth: PasswordAuth): boolean {
  return !auth.required && isPotentiallyPublicHostname(request.hostname);
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: PasswordAuth,
): Promise<void> {
  app.get('/internal/auth/status', async (request) => ({
    required: auth.required,
    authenticated: auth.authenticated(request),
    publicAccessWarning: publicAccessWarning(request, auth),
  }));

  app.post('/internal/auth/login', async (request, reply) => {
    const input = AuthLoginSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'The request does not match the internal API contract.',
      });
    }
    if (!auth.verifyPassword(input.data.password)) {
      return reply.code(401).send({
        error: 'invalid_app_password',
        message: 'The application password is incorrect.',
      });
    }
    reply.header('set-cookie', auth.createCookie(new Date(), request.protocol === 'https'));
    return { required: true, authenticated: true, publicAccessWarning: false };
  });

  app.post('/internal/auth/logout', async (request, reply) => {
    if (request.body !== undefined) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Logout requests must not include a body.',
      });
    }
    reply.header('set-cookie', auth.clearCookie(request.protocol === 'https'));
    return reply.code(204).send();
  });
}
