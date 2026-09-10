import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AccountRateLimitError, type AccountAuth } from '../security/account-auth.js';

const username = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
const password = z.string().min(1).max(1024);
export async function registerAccountRoutes(app: FastifyInstance, auth: AccountAuth): Promise<void> {
  const login = async (username: string, password: string, request: FastifyRequest, reply: FastifyReply) => {
    try { return await auth.login(username, password, request.ip); }
    catch (error) {
      if (!(error instanceof AccountRateLimitError)) throw error;
      void reply.code(429).header('retry-after', String(error.retryAfterSeconds)).send({ error: 'login_rate_limited' });
      return null;
    }
  };
  app.get('/internal/auth/status', async request => {
    const user = auth.user(request);
    return { required: true, authenticated: !!user, publicAccessWarning: false };
  });
  app.post('/internal/auth/login', async (request, reply) => {
    const input = z.object({ username: username.default('admin'), password }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const user = await login(input.data.username, input.data.password, request, reply);
    if (reply.sent) return;
    if (!user) return reply.code(401).send({ error: 'invalid_app_password', message: '用户名或密码不正确' });
    reply.header('set-cookie', auth.sessionCookie(user.id, request.protocol === 'https'));
    return { required: true, authenticated: true, publicAccessWarning: false };
  });
  app.post('/internal/auth/logout', async (request, reply) => reply.header('set-cookie', auth.clearCookie(request.protocol === 'https')).code(204).send());
  app.get('/internal/account', async (request, reply) => {
    const user = auth.user(request);
    return user ? { user } : reply.code(401).send({ error: 'authentication_required' });
  });
  app.patch('/internal/account', async (request, reply) => {
    const input = z.object({ currentPassword: password, username: username.optional(), password: password.optional() }).strict().safeParse(request.body);
    const user = auth.user(request);
    if (!user) return reply.code(401).send({ error: 'authentication_required' });
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const confirmed = await login(user.username, input.data.currentPassword, request, reply);
    if (reply.sent) return;
    if (!confirmed) return reply.code(403).send({ error: 'invalid_current_password' });
    try { await auth.update(user.id, input.data); }
    catch { return reply.code(409).send({ error: 'username_conflict' }); }
    reply.header('set-cookie', auth.sessionCookie(user.id, request.protocol === 'https'));
    return { user: { ...user, username: input.data.username ?? user.username } };
  });
  app.get('/internal/accounts', async (request, reply) => auth.user(request)?.role === 'admin' ? { users: auth.list() } : reply.code(403).send({ error: 'admin_required' }));
  app.post('/internal/accounts', async (request, reply) => {
    if (auth.user(request)?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const input = z.object({ username, password }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    try { return reply.code(201).send({ user: await auth.create(input.data.username, input.data.password) }); }
    catch { return reply.code(409).send({ error: 'username_conflict' }); }
  });
  app.patch<{ Params: { id: string } }>('/internal/accounts/:id', async (request, reply) => {
    if (auth.user(request)?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const input = z.object({ enabled: z.boolean().optional(), password: password.optional() }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    try { await auth.update(request.params.id, input.data); return { users: auth.list() }; }
    catch { return reply.code(400).send({ error: 'account_update_failed' }); }
  });
}
