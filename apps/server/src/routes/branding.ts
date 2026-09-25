import type { FastifyInstance } from 'fastify';
import type { SettingsRepository } from '../database/settings.js';

/** Only the explicitly public site identity is available without authentication. */
export function registerBrandingRoutes(app: FastifyInstance, settings: SettingsRepository) {
  app.get('/internal/branding', async (_request, reply) => {
    const logo = settings.get('branding.logo');
    return reply.header('cache-control', 'no-store').send({
      name: settings.get('branding.name')?.value || 'Imagine.',
      logoUrl: logo?.value ? `/internal/branding/logo?v=${logo.updatedAt.getTime()}` : '/icons/app-icon-192.png',
    });
  });
  app.get('/internal/branding/logo', async (_request, reply) => {
    const logo = settings.get('branding.logo')?.value;
    if (typeof logo !== 'string' || !logo.startsWith('data:image/png;base64,')) return reply.redirect('/icons/app-icon-192.png');
    return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').type('image/png').send(Buffer.from(logo.slice('data:image/png;base64,'.length), 'base64'));
  });
}
