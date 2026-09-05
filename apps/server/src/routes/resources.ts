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
  ModelCapabilitiesSchema,
  applyModelParameters,
  resolveModelProfile,
  normalizeAutomaticParameters,
  providerGenerationRequest,
} from '@imagine/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AssetRepository } from '../database/assets.js';
import {
  CollectionRepositoryError,
  type CollectionRepository,
} from '../database/collections.js';
import { JobRepositoryError, type JobRepository } from '../database/jobs.js';
import type { ModelRepository } from '../database/models.js';
import type { SettingsRepository } from '../database/settings.js';
import type { OutboxPublisher } from '../events/outbox-publisher.js';
import type { ProviderInputLoaderPort, ProviderRegistryPort } from '../jobs/ports.js';
import type { JobRunner } from '../jobs/job-runner.js';
import {
  GenerationInputError,
  type GenerationInputResolver,
} from '../jobs/generation-input-resolver.js';
import type { AssetMediaService } from '../media/asset-media-service.js';
import { planMediaResponse } from '../media/range.js';
import type { AssetVariant } from '../media/types.js';
import { ProviderRegistryError } from '../providers/provider-registry.js';
import { ProviderInputLoaderError } from '../providers/provider-input-loader.js';
import { isSecretLikeKey, sanitizeLegacyJsonValue } from '../security/config-sanitizer.js';
import { discardStagedFile, stageReadable, type StagedFile } from '../storage/atomic-file.js';
import type { StoragePaths } from '../storage/paths.js';
import { AccountSettingsRepository } from '../database/account-settings.js';
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
  search: z.string().trim().max(200).optional(),
  includeJobs: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

const ModelPageQuerySchema = CursorPageQuerySchema.extend({
  providerId: z.string().min(1).optional(),
  enabled: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).strict();

type Parsed<T extends z.ZodType> = z.infer<T>;

export interface ResourceRoutesOptions {
  assets: AssetRepository;
  collections: CollectionRepository;
  jobs: JobRepository;
  inputResolver: GenerationInputResolver;
  inputLoader: ProviderInputLoaderPort;
  media: AssetMediaService;
  models: ModelRepository;
  outbox: OutboxPublisher;
  providers: ProviderRegistryPort;
  runner: JobRunner;
  settings: SettingsRepository;
  storage: StoragePaths;
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

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT');
}

function isUploadTooLarge(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name.includes('TooLarge')) return true;
  return 'code' in error && error.code === 'FST_REQ_FILE_TOO_LARGE';
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
  options: Pick<ResourceRoutesOptions, 'outbox'>,
  operation: () => T | Promise<T>,
): Promise<T> {
  const result = await operation();
  options.outbox.flush();
  return result;
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
  const safeSettings = (entries: readonly { key: string; value: unknown }[]) => Object.fromEntries(
    entries
      .filter((entry) => !isSecretLikeKey(entry.key))
      .map((entry) => [entry.key, sanitizeLegacyJsonValue(entry.value)]),
  );

  app.get('/internal/settings', async () => ({
    settings: safeSettings(options.settings.list()),
  }));

  app.patch('/internal/settings', async (request, reply) => {
    const input = parseOrReply(SettingsPatchSchema, request.body, reply);
    if (!input) return;
    let records;
    try { records = await publishCommitted(options, () => options.settings.upsertMany(input.values)); }
    catch (error) {
      if (options.settings instanceof AccountSettingsRepository && error instanceof Error && 'statusCode' in error && (error.statusCode === 400 || error.statusCode === 403)) return errorResponse(reply, error.statusCode, 'settings_invalid', error.message);
      throw error;
    }
    return {
      settings: safeSettings(records),
    };
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
    let input = parseOrReply(GenerationRequestSchema, request.body, reply);
    if (!input) return;
    if (input.collectionId && !options.collections.get(input.collectionId)) return errorResponse(reply, 400, 'collection_not_found', '项目不存在或已删除');
    let registration;
    try {
      registration = await options.providers.resolve(input.providerId);
    } catch (error) {
      if (error instanceof ProviderRegistryError) {
        const status = error.code === 'provider_type_unsupported' ? 400 : 503;
        return errorResponse(reply, status, error.code, error.message);
      }
      return errorResponse(reply, 503, 'provider_unavailable', error instanceof Error ? error.message : undefined);
    }
    try {
      const resolved = options.inputResolver.resolve(input);
      const capabilities = ModelCapabilitiesSchema.parse(resolved.model.capabilities);
      // Protocol and parameter policy come from the persisted model, never the client.
      delete input.profile;
      input = normalizeAutomaticParameters(applyModelParameters(normalizeAutomaticParameters(input), capabilities.parameters));
      if (['openai', 'gemini', 'xai'].includes(registration.adapter.type)) {
        const profile = resolveModelProfile(registration.adapter.type, input.operation, input.modelId, capabilities.profile);
        if (profile) input.profile = profile;
      }
    } catch (error) {
      if (error instanceof GenerationInputError) {
        return errorResponse(reply, 400, error.code, error.message);
      }
      return errorResponse(reply, 400, 'model_parameters_invalid', error instanceof Error ? error.message : '模型参数无效');
    }
    const batchCount = input.count ?? 1;
    input = { ...input, count: 1 };
    let loadedInputs: Awaited<ReturnType<ProviderInputLoaderPort['load']>>;
    try {
      loadedInputs = await options.inputLoader.load(input);
    } catch (error) {
      if (error instanceof ProviderInputLoaderError) {
        const status = error.code === 'provider_input_too_large' ? 413 : 400;
        return errorResponse(reply, status, error.code, error.message);
      }
      return errorResponse(reply, 400, 'provider_input_invalid');
    }
    try {
      await registration.adapter.validate(providerGenerationRequest(input), {
        providerId: input.providerId,
        ...(registration.baseUrl ? { baseUrl: registration.baseUrl } : {}),
        config: registration.config ?? {},
        ...(registration.http ? { http: registration.http } : {}),
        inputs: loadedInputs,
        secrets: registration.secrets,
      });
    } catch (error) {
      const normalized = await Promise.resolve()
        .then(() => registration.adapter.normalizeError(error))
        .catch(() => null);
      if (normalized === null) {
        return errorResponse(reply, 502, 'provider_unknown', 'The provider operation failed.');
      }
      return errorResponse(reply, normalized.kind === 'rejected' ? 400 : 502, normalized.code, normalized.message);
    }
    try {
      const batch = await publishCommitted(options, () => options.jobs.createBatch(
        input,
        batchCount,
        registration.adapterRef ?? null,
      ));
      await Promise.all(batch.map(job => options.runner.enqueue(job.id)));
      const results = batch.map(job => toJobDto(job, options.jobs.listOutputs(job.id).length));
      return reply.code(202).send({ job: results[0], ...(results.length > 1 ? { jobs: results } : {}) });
    } catch (error) {
      if (error instanceof JobRepositoryError) {
        return errorResponse(
          reply,
          error.code === 'adapter_ref_not_current' ? 409 : 400,
          error.code,
          error.message,
        );
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/internal/jobs/:id/retry', async (request, reply) => {
    if (!options.jobs.get(request.params.id)) return errorResponse(reply, 404, 'job_not_found');
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
    if (!options.jobs.get(request.params.id)) return errorResponse(reply, 404, 'job_not_found');
    const deleted = await publishCommitted(options, () => options.jobs.softDelete(request.params.id));
    if (!deleted) return errorResponse(reply, 409, 'job_not_deletable');
    return reply.code(204).send();
  });
}

function registerAssetRoutes(app: FastifyInstance, options: ResourceRoutesOptions) {
  app.post('/internal/assets/upload', async (request, reply) => {
    let staged: StagedFile | null = null;
    let filename: string | null = null;
    let mimetype: string | null = null;
    const fields = new Map<string, string>();
    try {
      const parts = request.parts({ limits: { files: 1, fileSize: options.maxUploadBytes, fields: 2, parts: 3 } });
      for await (const part of parts) {
        if (part.type === 'file') {
          if (staged !== null) {
            part.file.resume();
            await discardStagedFile(staged);
            staged = null;
            return errorResponse(reply, 400, 'multiple_files_not_allowed');
          }
          staged = await stageReadable({
            dataRoot: options.storage.root,
            maxBytes: options.maxUploadBytes,
            source: part.file,
            temporaryDirectory: options.storage.temporary,
          });
          if (part.file.truncated) {
            await discardStagedFile(staged);
            staged = null;
            return errorResponse(reply, 413, 'upload_too_large');
          }
          filename = part.filename;
          mimetype = part.mimetype;
          continue;
        }
        if (!['parentAssetId', 'role'].includes(part.fieldname) || fields.has(part.fieldname)) {
          if (staged) await discardStagedFile(staged);
          staged = null;
          return errorResponse(reply, 400, 'invalid_upload_field');
        }
        if (typeof part.value !== 'string') {
          if (staged) await discardStagedFile(staged);
          staged = null;
          return errorResponse(reply, 400, 'invalid_upload_field');
        }
        fields.set(part.fieldname, part.value);
      }
    } catch (error) {
      if (staged) await discardStagedFile(staged);
      return errorResponse(
        reply,
        isUploadTooLarge(error) ? 413 : 400,
        isUploadTooLarge(error) ? 'upload_too_large' : 'invalid_multipart_upload',
        error instanceof Error ? error.message : undefined,
      );
    }
    if (!staged || filename === null || mimetype === null) return errorResponse(reply, 400, 'file_required');
    const parsedRole = AssetRoleSchema.safeParse(fields.get('role') ?? 'upload');
    if (!parsedRole.success || parsedRole.data === 'output') {
      await discardStagedFile(staged);
      return errorResponse(reply, 400, 'invalid_upload_role');
    }
    const parentAssetId = fields.get('parentAssetId');
    try {
      const asset = await options.media.materializeUpload({
        source: createReadStream(staged.temporaryPath),
        role: parsedRole.data,
        originalFilename: filename,
        claimedMimeType: mimetype,
        ...(parentAssetId ? { parentAssetId } : {}),
      });
      options.outbox.flush();
      const dto = assetDto(options, asset.id);
      if (!dto) throw new Error(`Uploaded asset ${asset.id} was not persisted.`);
      return reply.code(201).send({ asset: dto });
    } catch (error) {
      const status = isUploadTooLarge(error) ? 413 : 400;
      return errorResponse(reply, status, 'invalid_media_upload', error instanceof Error ? error.message : undefined);
    } finally {
      await discardStagedFile(staged);
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
      ...(query.search === undefined ? {} : { search: query.search }),
    });
    return {
      items: page.items.map((asset) => toAssetDto(asset, options.assets.collectionIdsForAsset(asset.id))),
      nextCursor: page.nextCursor,
      ...(query.includeJobs ? {
        jobs: [...new Set(page.items.flatMap((asset) => asset.jobId ? [asset.jobId] : []))]
          .flatMap((id) => {
            const job = options.jobs.get(id);
            return job ? [toJobDto(job, options.assets.countForJob(job.id))] : [];
          }),
      } : {}),
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
    try {
      const collection = await publishCommitted(options, () => options.collections.create(input.name));
      return reply.code(201).send({ collection: toCollectionDto(collection) });
    } catch (error) {
      if (isSqliteConstraint(error)) return errorResponse(reply, 409, 'collection_name_conflict');
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/internal/collections/:id', async (request, reply) => {
    const input = parseOrReply(CollectionPatchSchema, request.body, reply);
    if (!input) return;
    try {
      const collection = await publishCommitted(options, () => options.collections.rename(request.params.id, input.name));
      return collection
        ? { collection: toCollectionDto(collection) }
        : errorResponse(reply, 404, 'collection_not_found');
    } catch (error) {
      if (isSqliteConstraint(error)) return errorResponse(reply, 409, 'collection_name_conflict');
      throw error;
    }
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
