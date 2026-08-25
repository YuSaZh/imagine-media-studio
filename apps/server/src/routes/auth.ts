import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { PasswordAuth } from '../security/password-auth.js';

const LoginSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: PasswordAuth,
): Promise<void> {
  app.get('/internal/auth/status', async (request) => ({
    required: auth.required,
    authenticated: auth.authenticated(request),
  }));

  app.post('/internal/auth/login', async (request, reply) => {
    const input = LoginSchema.safeParse(request.body);
    if (!input.success || !auth.verifyPassword(input.data.password)) {
      return reply.code(401).send({
        error: 'invalid_app_password',
        message: 'The application password is incorrect.',
      });
    }
    reply.header('set-cookie', auth.createCookie(new Date(), request.protocol === 'https'));
    return { required: true, authenticated: true };
  });

  app.post('/internal/auth/logout', async (request, reply) => {
    reply.header('set-cookie', auth.clearCookie(request.protocol === 'https'));
    return reply.code(204).send();
  });
}
