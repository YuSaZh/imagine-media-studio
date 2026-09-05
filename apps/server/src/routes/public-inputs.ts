import type { FastifyInstance } from 'fastify';
import type { AssetRepository } from '../database/assets.js';
import type { PublicInputLinks } from '../security/public-input-links.js';
import { openStoredFile } from '../storage/path-safety.js';

export async function registerPublicInputRoutes(app: FastifyInstance, options: { links: PublicInputLinks; assets: AssetRepository; dataRoot: string }) {
  app.get<{ Params: { id: string; expires: string; signature: string } }>('/media-inputs/:id/:expires/:signature', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('cache-control', 'private, no-store, max-age=0');
    reply.header('referrer-policy', 'no-referrer');
    const asset = options.assets.get(request.params.id);
    if (!asset || !options.links.verify(asset, request.params.expires, request.params.signature)) return reply.code(404).send({ error: 'input_link_unavailable' });
    const handle = await openStoredFile(options.dataRoot, asset.filePath).catch(() => null);
    if (!handle) return reply.code(404).send({ error: 'input_link_unavailable' });
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== asset.fileSize) { await handle.close(); return reply.code(404).send({ error: 'input_link_unavailable' }); }
    reply.type(asset.mimeType).header('content-length', stat.size);
    if (request.method === 'HEAD') { await handle.close(); return reply.send(); }
    return reply.send(handle.createReadStream());
  });
}
