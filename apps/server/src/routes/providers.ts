import {
  CursorPageQuerySchema,
  ManualModelCreateSchema,
  ManualModelPatchSchema,
  ProviderCreateSchema,
  ProviderPatchSchema,
} from '@imagine/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { OutboxPublisher } from '../events/outbox-publisher.js';
import {
  ManualModelServiceError,
  ModelCatalogServiceError,
} from '../providers/provider-service.js';
import {
  ProviderRegistryError,
} from '../providers/provider-registry.js';
import type { ProviderService } from '../providers/provider-service.js';
import { toModelDto } from './dto.js';

const ProviderPageQuerySchema = CursorPageQuerySchema.extend({
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  type: z.string().min(1).max(80).optional(),
}).strict();

export interface ProviderRoutesOptions {
  outbox: OutboxPublisher;
  providers: ProviderService;
}

function invalidRequest(reply: FastifyReply, issues: readonly unknown[]) {
  return reply.code(400).send({
    error: 'invalid_request',
    message: 'The request does not match the internal API contract.',
    issues,
  });
}

function providerError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProviderRegistryError) {
    const status = error.code === 'provider_not_found' ? 404 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  }
  if (error instanceof ManualModelServiceError) {
    const status = error.code === 'model_not_manual'
      ? 409
      : error.code === 'invalid_model'
        ? 400
        : 404;
    return reply.code(status).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof ModelCatalogServiceError) {
    return reply.code(502).send({ error: error.code, message: error.message });
  }
  return reply.code(502).send({
    error: 'provider_unavailable',
    message: 'Provider request could not be completed.',
  });
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT');
}

async function publishCommitted<T>(options: ProviderRoutesOptions, operation: () => T | Promise<T>) {
  const result = await operation();
  options.outbox.flush();
  return result;
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  options: ProviderRoutesOptions,
): Promise<void> {
  app.get('/internal/providers', async (request, reply) => {
    const query = ProviderPageQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error.issues);
    return options.providers.page({
      limit: query.data.limit,
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
      ...(query.data.enabled === undefined ? {} : { enabled: query.data.enabled }),
      ...(query.data.type === undefined ? {} : { type: query.data.type }),
    });
  });

  app.get<{ Params: { id: string } }>('/internal/providers/:id/models/catalog', async (request, reply) => {
    try { return await options.providers.discoverModels(request.params.id); }
    catch (error) { return providerError(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/internal/providers/:id', async (request, reply) => {
    const provider = options.providers.get(request.params.id);
    return provider
      ? { provider }
      : reply.code(404).send({ error: 'provider_not_found' });
  });

  app.post('/internal/providers', async (request, reply) => {
    const input = ProviderCreateSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply, input.error.issues);
    try {
      const provider = await publishCommitted(options, () => options.providers.create({
        name: input.data.name,
        type: input.data.type,
        config: input.data.config,
        enabled: input.data.enabled,
        isDefault: input.data.isDefault,
        ...(input.data.baseUrl === undefined ? {} : { baseUrl: input.data.baseUrl }),
        ...(input.data.apiKey === undefined ? {} : { apiKey: input.data.apiKey }),
        ...(input.data.headers === undefined ? {} : { headers: input.data.headers }),
      }));
      return reply.code(201).send({ provider });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: 'provider_name_conflict' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/internal/providers/:id', async (request, reply) => {
    const input = ProviderPatchSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply, input.error.issues);
    try {
      const provider = await publishCommitted(options, () =>
        options.providers.update(request.params.id, {
        ...(input.data.name === undefined ? {} : { name: input.data.name }),
        ...(input.data.type === undefined ? {} : { type: input.data.type }),
        ...(!('baseUrl' in input.data) ? {} : { baseUrl: input.data.baseUrl ?? null }),
        ...(!('apiKey' in input.data) ? {} : { apiKey: input.data.apiKey ?? null }),
        ...(!('headers' in input.data) ? {} : { headers: input.data.headers ?? null }),
        ...(input.data.config === undefined ? {} : { config: input.data.config }),
        ...(input.data.enabled === undefined ? {} : { enabled: input.data.enabled }),
        ...(input.data.isDefault === undefined ? {} : { isDefault: input.data.isDefault }),
        }),
      );
      return provider
        ? { provider }
        : reply.code(404).send({ error: 'provider_not_found' });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: 'provider_name_conflict' });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/internal/providers/:id', async (request, reply) => {
    const deleted = await publishCommitted(options, () => options.providers.delete(request.params.id));
    return deleted
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'provider_not_found' });
  });

  app.post<{ Params: { id: string } }>('/internal/providers/:id/test', async (request, reply) => {
    try {
      return await options.providers.testConnection(request.params.id);
    } catch (error) {
      return providerError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/internal/providers/:id/models/refresh',
    async (request, reply) => {
      try {
        const models = await publishCommitted(options, () =>
          options.providers.refreshModels(request.params.id),
        );
        return { items: models.map(toModelDto) };
      } catch (error) {
        return providerError(reply, error);
      }
    },
  );

  app.post('/internal/models', async (request, reply) => {
    const input = ManualModelCreateSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply, input.error.issues);
    try {
      const model = await publishCommitted(options, () => options.providers.saveManualModel({
        providerId: input.data.providerId,
        modelId: input.data.modelId,
        displayName: input.data.displayName,
        capabilities: input.data.capabilities,
        enabled: input.data.enabled,
      }));
      return reply.code(201).send({ model: toModelDto(model) });
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: 'model_id_conflict' });
      }
      return providerError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>('/internal/models/:id', async (request, reply) => {
    const input = ManualModelPatchSchema.safeParse(request.body);
    if (!input.success) return invalidRequest(reply, input.error.issues);
    try {
      const model = await publishCommitted(options, () => options.providers.updateManualModel(
        request.params.id,
        {
          ...(input.data.modelId === undefined ? {} : { modelId: input.data.modelId }),
          ...(input.data.displayName === undefined ? {} : { displayName: input.data.displayName }),
          ...(input.data.capabilities === undefined ? {} : { capabilities: input.data.capabilities }),
          ...(input.data.enabled === undefined ? {} : { enabled: input.data.enabled }),
        },
      ));
      return { model: toModelDto(model) };
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: 'model_id_conflict' });
      }
      return providerError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/internal/models/:id', async (request, reply) => {
    try {
      await publishCommitted(options, () => options.providers.deleteManualModel(request.params.id));
      return reply.code(204).send();
    } catch (error) {
      return providerError(reply, error);
    }
  });
}
