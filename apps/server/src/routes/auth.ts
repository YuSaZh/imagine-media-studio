import { AuthLoginSchema } from '@imagine/shared';
import type { FastifyInstance } from 'fastify';

import type { PasswordAuth } from '../security/password-auth.js';

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: PasswordAuth,
): Promise<void> {
  app.get('/internal/auth/status', async (request) => ({
    required: auth.required,
    authenticated: auth.authenticated(request),
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
    return { required: true, authenticated: true };
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
