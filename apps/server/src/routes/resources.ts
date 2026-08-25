import { createReadStream } from 'node:fs';

import {
  AssetPatchSchema,
  AssetRoleSchema,
  AssetTypeSchema,
  CollectionAssetsPatchSchema,
  CollectionCreateSchema,
  CollectionPatchSchema,
  CursorPageQuerySchema,
  GenerationRequestSchema,
  JobStatusSchema,
  SettingsPatchSchema,
} from '@imagine/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AssetRepository } from '../database/assets.js';
import {
  CollectionRepositoryError,
  type CollectionRepository,
} from '../database/collections.js';
import type { ChangeEventRepository } from '../database/events.js';
import { JobRepositoryError, type JobRepository } from '../database/jobs.js';
import type { ModelRepository } from '../database/models.js';
import type { SettingsRepository } from '../database/settings.js';
import type { EventBroker } from '../events/event-broker.js';
import type { ProviderRegistryPort } from '../jobs/ports.js';
import type { JobRunner } from '../jobs/job-runner.js';
import type { AssetMediaService } from '../media/asset-media-service.js';
import { planMediaResponse } from '../media/range.js';
import type { AssetVariant } from '../media/types.js';
import { ProviderRegistryError } from '../providers/provider-registry.js';
import { toAssetDto, toCollectionDto, toJobDto, toModelDto } from './dto.js';

const JobPageQuerySchema = CursorPageQuerySchema.extend({
  status: JobStatusSchema.optional(),
  providerId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
}).strict();

const AssetPageQuerySchema = CursorPageQuerySchema.extend({
  type: AssetTypeSchema.optional(),
  role: AssetRoleSchema.optional(),
  favorite: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  jobId: z.string().min(1).optional(),
  collectionId: z.string().min(1).optional(),
}).strict();

const ModelPageQuerySchema = CursorPageQuerySchema.extend({
  providerId: z.string().min(1).optional(),
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

type Parsed<T extends z.ZodType> = z.infer<T>;

export interface ResourceRoutesOptions {
  assets: AssetRepository;
  broker: EventBroker;
  changeEvents: ChangeEventRepository;
  collections: CollectionRepository;
  jobs: JobRepository;
  media: AssetMediaService;
  models: ModelRepository;
  providers: ProviderRegistryPort;
  runner: JobRunner;
  settings: SettingsRepository;
  maxUploadBytes: number;
}

function parseOrReply<T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): Parsed<T> | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  void reply.code(400).send({
    error: 'invalid_request',
    message: 'The request does not match the internal API contract.',
    issues: parsed.error.issues,
  });
  return null;
}

function errorResponse(reply: FastifyReply, status: number, error: string, message?: string) {
  return reply.code(status).send({ error, ...(message ? { message } : {}) });
}

function assetDto(options: ResourceRoutesOptions, assetId: string) {
  const asset = options.assets.get(assetId);
  return asset
    ? toAssetDto(asset, options.assets.collectionIdsForAsset(asset.id))
    : null;
}

function jobDto(options: ResourceRoutesOptions, jobId: string) {
  const job = options.jobs.get(jobId);
  return job ? toJobDto(job, options.jobs.listOutputs(job.id).length) : null;
}

async function publishCommitted<T>(
  options: Pick<ResourceRoutesOptions, 'broker' | 'changeEvents'>,
  operation: () => T | Promise<T>,
): Promise<T> {
  const previousId = options.changeEvents.latestId();
  const result = await operation();
  for (const event of options.changeEvents.listAfter(previousId, 1000)) {
    options.broker.publish(event);
  }
  return result;
}

function fieldValue(
  fields: Record<string, unknown>,
  name: string,
): string | undefined {
  const field = fields[name];
  if (field === undefined || field === null || typeof field !== 'object') return undefined;
  if (!('type' in field) || field.type !== 'field' || !('value' in field)) return undefined;
  return typeof field.value === 'string' ? field.value : undefined;
}

async function sendAsset(
  request: FastifyRequest,
  reply: FastifyReply,
  media: AssetMediaService,
  assetId: string,
  variant: AssetVariant,
) {
  const delivery = await media.getDelivery(assetId, variant);
  if (!delivery) return errorResponse(reply, 404, 'asset_media_not_found');
  const rangeHeader = request.headers.range;
  const ifRangeHeader = request.headers['if-range'];
  const plan = planMediaResponse({
    etag: delivery.etag,
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    size: delivery.fileSize,
    lastModified: delivery.lastModified,
    ...(typeof rangeHeader === 'string' ? { range: rangeHeader } : {}),
    ...(typeof ifRangeHeader === 'string' ? { ifRange: ifRangeHeader } : {}),
  });
  reply.code(plan.statusCode).headers({
    ...plan.headers,
    'cache-control': 'private, max-age=0, must-revalidate',
    'content-type': delivery.mimeType,
    'last-modified': delivery.lastModified.toUTCString(),
  });
  if (!plan.body || plan.start === null || plan.end === null) return reply.send();
  return reply.send(createReadStream(delivery.absolutePath, { start: plan.start, end: plan.end }));
}

function registerSettingsRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.get('/internal/settings', async () => ({
    settings: Object.fromEntries(options.settings.list().map((entry) => [entry.key, entry.value])),
  }));

  app.patch('/internal/settings', async (request, reply) => {
    const input = parseOrReply(SettingsPatchSchema, request.body, reply);
    if (!input) return;
    const records = await publishCommitted(options, () => options.settings.upsertMany(input.values));
    return { settings: Object.fromEntries(records.map((entry) => [entry.key, entry.value])) };
  });
}

function registerModelRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.get('/internal/models', async (request, reply) => {
    const query = parseOrReply(ModelPageQuerySchema, request.query, reply);
    if (!query) return;
    const page = options.models.page({
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.providerId === undefined ? {} : { providerId: query.providerId }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
    });
    return { items: page.items.map(toModelDto), nextCursor: page.nextCursor };
  });
}

function registerJobRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.get('/internal/jobs', async (request, reply) => {
    const query = parseOrReply(JobPageQuerySchema, request.query, reply);
    if (!query) return;
    const page = options.jobs.page({
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.providerId === undefined ? {} : { providerId: query.providerId }),
      ...(query.modelId === undefined ? {} : { modelId: query.modelId }),
    });
    return {
      items: page.items.map((job) => toJobDto(job, options.jobs.listOutputs(job.id).length)),
      nextCursor: page.nextCursor,
    };
  });

  app.get<{ Params: { id: string } }>('/internal/jobs/:id', async (request, reply) => {
    const job = options.jobs.get(request.params.id);
    if (!job) return errorResponse(reply, 404, 'job_not_found');
    const outputs = options.jobs.listOutputs(job.id);
    const outputAssets = outputs.flatMap((output) => {
      if (!output.assetId) return [];
      const dto = assetDto(options, output.assetId);
      return dto ? [dto] : [];
    });
    return {
      job: toJobDto(job, outputs.length),
      inputs: options.jobs.listInputs(job.id),
      assets: outputAssets,
    };
  });

  app.post('/internal/jobs', async (request, reply) => {
    const input = parseOrReply(GenerationRequestSchema, request.body, reply);
    if (!input) return;
    let registration;
    try {
      registration = await options.providers.resolve(input.providerId);
      await registration.adapter.validate(input, {
        providerId: input.providerId,
        secrets: registration.secrets,
      });
    } catch (error) {
      if (registration) {
        const normalized = registration.adapter.normalizeError(error);
        return errorResponse(reply, normalized.kind === 'rejected' ? 400 : 502, normalized.code, normalized.message);
      }
      if (error instanceof ProviderRegistryError) {
        const status = error.code === 'provider_type_unsupported' ? 400 : 503;
        return errorResponse(reply, status, error.code, error.message);
      }
      return errorResponse(reply, 503, 'provider_unavailable', error instanceof Error ? error.message : undefined);
    }
    try {
      const job = await publishCommitted(options, () => options.jobs.create(input));
      await options.runner.enqueue(job.id);
      return reply.code(202).send({ job: toJobDto(job, options.jobs.listOutputs(job.id).length) });
    } catch (error) {
      if (error instanceof JobRepositoryError) {
        return errorResponse(reply, 400, error.code, error.message);
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/internal/jobs/:id/retry', async (request, reply) => {
    try {
      const job = await publishCommitted(options, () => options.jobs.retry(request.params.id));
      if (!job) return errorResponse(reply, 409, 'job_not_retryable');
      await options.runner.enqueue(job.id);
      return reply.code(202).send({
        job: toJobDto(job, options.jobs.listOutputs(job.id).length),
        sourceJobId: request.params.id,
      });
    } catch (error) {
      if (error instanceof JobRepositoryError) return errorResponse(reply, 400, error.code, error.message);
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/internal/jobs/:id/cancel', async (request, reply) => {
    if (!options.jobs.get(request.params.id)) return errorResponse(reply, 404, 'job_not_found');
    await options.runner.cancel(request.params.id);
    const job = jobDto(options, request.params.id);
    if (!job) return errorResponse(reply, 404, 'job_not_found');
    return { job };
  });

  app.delete<{ Params: { id: string } }>('/internal/jobs/:id', async (request, reply) => {
    const deleted = await publishCommitted(options, () => options.jobs.softDelete(request.params.id));
    if (!deleted) return errorResponse(reply, 409, 'job_not_deletable');
    return reply.code(204).send();
  });
}

function registerAssetRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.post('/internal/assets/upload', async (request, reply) => {
    let upload;
    try {
      upload = await request.file({ limits: { files: 1, fileSize: options.maxUploadBytes } });
    } catch (error) {
      return errorResponse(reply, 413, 'upload_too_large', error instanceof Error ? error.message : undefined);
    }
    if (!upload) return errorResponse(reply, 400, 'file_required');
    const fields = upload.fields as unknown as Record<string, unknown>;
    const parsedRole = AssetRoleSchema.safeParse(fieldValue(fields, 'role') ?? 'upload');
    if (!parsedRole.success || parsedRole.data === 'output') {
      upload.file.resume();
      return errorResponse(reply, 400, 'invalid_upload_role');
    }
    const parentAssetId = fieldValue(fields, 'parentAssetId');
    try {
      const before = options.changeEvents.latestId();
      const asset = await options.media.materializeUpload({
        source: upload.file,
        role: parsedRole.data,
        originalFilename: upload.filename,
        claimedMimeType: upload.mimetype,
        ...(parentAssetId ? { parentAssetId } : {}),
      });
      for (const event of options.changeEvents.listAfter(before, 1000)) options.broker.publish(event);
      const dto = assetDto(options, asset.id);
      if (!dto) throw new Error(`Uploaded asset ${asset.id} was not persisted.`);
      return reply.code(201).send({ asset: dto });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const status = name.includes('TooLarge') ? 413 : 400;
      return errorResponse(reply, status, 'invalid_media_upload', error instanceof Error ? error.message : undefined);
    }
  });

  app.get('/internal/assets', async (request, reply) => {
    const query = parseOrReply(AssetPageQuerySchema, request.query, reply);
    if (!query) return;
    const page = options.assets.page({
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.favorite === undefined ? {} : { favorite: query.favorite }),
      ...(query.jobId === undefined ? {} : { jobId: query.jobId }),
      ...(query.collectionId === undefined ? {} : { collectionId: query.collectionId }),
    });
    return {
      items: page.items.map((asset) => toAssetDto(asset, options.assets.collectionIdsForAsset(asset.id))),
      nextCursor: page.nextCursor,
    };
  });

  app.get<{ Params: { id: string } }>('/internal/assets/:id', async (request, reply) => {
    const asset = assetDto(options, request.params.id);
    return asset ? { asset } : errorResponse(reply, 404, 'asset_not_found');
  });

  app.patch<{ Params: { id: string } }>('/internal/assets/:id', async (request, reply) => {
    const input = parseOrReply(AssetPatchSchema, request.body, reply);
    if (!input) return;
    const asset = await publishCommitted(options, () => options.assets.setFavorite(request.params.id, input.favorite));
    if (!asset) return errorResponse(reply, 404, 'asset_not_found');
    return { asset: toAssetDto(asset, options.assets.collectionIdsForAsset(asset.id)) };
  });

  for (const variant of ['content', 'thumbnail', 'poster'] as const) {
    app.route<{ Params: { id: string } }>({
      method: ['GET', 'HEAD'],
      url: `/internal/assets/:id/${variant}`,
      handler: (request, reply) => sendAsset(request, reply, options.media, request.params.id, variant),
    });
  }

  app.delete<{ Params: { id: string } }>('/internal/assets/:id', async (request, reply) => {
    const deleted = await publishCommitted(options, () => options.media.softDelete(request.params.id));
    if (!deleted) return errorResponse(reply, 404, 'asset_not_found');
    return reply.code(204).send();
  });
}

function registerCollectionRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.get('/internal/collections', async (request, reply) => {
    const query = parseOrReply(CursorPageQuerySchema, request.query, reply);
    if (!query) return;
    const page = options.collections.page({
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return { items: page.items.map(toCollectionDto), nextCursor: page.nextCursor };
  });

  app.post('/internal/collections', async (request, reply) => {
    const input = parseOrReply(CollectionCreateSchema, request.body, reply);
    if (!input) return;
    const collection = await publishCommitted(options, () => options.collections.create(input.name));
    return reply.code(201).send({ collection: toCollectionDto(collection) });
  });

  app.patch<{ Params: { id: string } }>('/internal/collections/:id', async (request, reply) => {
    const input = parseOrReply(CollectionPatchSchema, request.body, reply);
    if (!input) return;
    const collection = await publishCommitted(options, () => options.collections.rename(request.params.id, input.name));
    return collection
      ? { collection: toCollectionDto(collection) }
      : errorResponse(reply, 404, 'collection_not_found');
  });

  app.delete<{ Params: { id: string } }>('/internal/collections/:id', async (request, reply) => {
    const deleted = await publishCommitted(options, () => options.collections.delete(request.params.id));
    if (!deleted) return errorResponse(reply, 404, 'collection_not_found');
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/internal/collections/:id/assets', async (request, reply) => {
    const input = parseOrReply(CollectionAssetsPatchSchema, request.body, reply);
    if (!input) return;
    try {
      const added = await publishCommitted(options, () => options.collections.addAssets(request.params.id, input.assetIds));
      const collection = options.collections.get(request.params.id)!;
      return { collection: toCollectionDto(collection), added };
    } catch (error) {
      if (error instanceof CollectionRepositoryError) return errorResponse(reply, 404, error.code, error.message);
      throw error;
    }
  });

  app.delete<{ Params: { id: string; assetId: string } }>(
    '/internal/collections/:id/assets/:assetId',
    async (request, reply) => {
      const removed = await publishCommitted(options, () =>
        options.collections.removeAsset(request.params.id, request.params.assetId),
      );
      if (!removed) return errorResponse(reply, 404, 'collection_asset_not_found');
      return reply.code(204).send();
    },
  );
}

export async function registerResourceRoutes(
  app: FastifyInstance,
  options: ResourceRoutesOptions,
): Promise<void> {
  registerSettingsRoutes(app, options);
  registerModelRoutes(app, options);
  registerJobRoutes(app, options);
  registerAssetRoutes(app, options);
  registerCollectionRoutes(app, options);
}
