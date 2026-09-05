import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AccountAuth } from '../security/account-auth.js';

const username = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
const password = z.string().min(1).max(1024);
export async function registerAccountRoutes(app: FastifyInstance, auth: AccountAuth): Promise<void> {
  const attempts = new Map<string, { count: number; expires: number }>();
  app.get('/internal/auth/status', async request => {
    const user = auth.user(request);
    return { required: true, authenticated: !!user, publicAccessWarning: false };
  });
  app.post('/internal/auth/login', async (request, reply) => {
    const input = z.object({ username: username.default('admin'), password }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    for (const [key, value] of attempts) if (value.expires <= Date.now()) attempts.delete(key);
    const key = request.ip;
    const attempt = attempts.get(key) ?? { count: 0, expires: Date.now() + 60000 };
    if (attempt.count >= 10 || attempts.size > 10000) return reply.code(429).header('retry-after', '60').send({ error: 'login_rate_limited' });
    attempt.count++; attempts.set(key, attempt);
    const user = auth.login(input.data.username, input.data.password);
    if (!user) return reply.code(401).send({ error: 'invalid_app_password', message: '用户名或密码不正确' });
    attempts.delete(key);
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
    if (!auth.login(user.username, input.data.currentPassword)) return reply.code(403).send({ error: 'invalid_current_password' });
    try { auth.update(user.id, input.data); }
    catch { return reply.code(409).send({ error: 'username_conflict' }); }
    reply.header('set-cookie', auth.sessionCookie(user.id, request.protocol === 'https'));
    return { user: { ...user, username: input.data.username ?? user.username } };
  });
  app.get('/internal/accounts', async (request, reply) => auth.user(request)?.role === 'admin' ? { users: auth.list() } : reply.code(403).send({ error: 'admin_required' }));
  app.post('/internal/accounts', async (request, reply) => {
    if (auth.user(request)?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const input = z.object({ username, password }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    try { return reply.code(201).send({ user: auth.create(input.data.username, input.data.password) }); }
    catch { return reply.code(409).send({ error: 'username_conflict' }); }
  });
  app.patch<{ Params: { id: string } }>('/internal/accounts/:id', async (request, reply) => {
    if (auth.user(request)?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const input = z.object({ enabled: z.boolean().optional(), password: password.optional() }).strict().safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    try { auth.update(request.params.id, input.data); return { users: auth.list() }; }
    catch { return reply.code(400).send({ error: 'account_update_failed' }); }
  });
}
