import { GenerationRequestSchema } from '@imagine/shared';
import type { ProviderAdapter } from '@imagine/provider-contract';
import type { FastifyInstance } from 'fastify';

import type { JobRepository } from '../database/jobs.js';
import type { JobRunner } from '../jobs/job-runner.js';

interface InternalRoutesOptions {
  jobs: JobRepository;
  runner: JobRunner;
  provider: ProviderAdapter;
  mockProviderEnabled: boolean;
}

export async function registerInternalRoutes(
  app: FastifyInstance,
  options: InternalRoutesOptions,
): Promise<void> {
  app.get('/internal/health', async () => ({
    status: 'ok',
    database: 'ok',
  }));

  app.get('/internal/app-info', async () => ({
    name: 'Imagine Media Studio',
    version: '0.0.0',
    mockProviderEnabled: options.mockProviderEnabled,
  }));

  app.get('/internal/jobs', async () => ({ jobs: options.jobs.list() }));

  app.get<{ Params: { id: string } }>('/internal/jobs/:id', async (request, reply) => {
    const job = options.jobs.get(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: 'job_not_found' });
    }
    return { job };
  });

  app.post('/internal/jobs', async (request, reply) => {
    if (!options.mockProviderEnabled) {
      return reply.code(503).send({ error: 'mock_provider_disabled' });
    }

    const parsed = GenerationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_generation_request',
        issues: parsed.error.issues,
      });
    }

    try {
      await options.provider.validate(parsed.data, {
        providerId: parsed.data.providerId,
        secrets: {},
      });
    } catch (error) {
      const normalized = options.provider.normalizeError(error);
      return reply.code(400).send({
        error: normalized.code,
        message: normalized.message,
      });
    }

    const job = options.jobs.create(parsed.data);
    await options.runner.enqueue(job.id);
    return reply.code(202).send({ job });
  });
}
