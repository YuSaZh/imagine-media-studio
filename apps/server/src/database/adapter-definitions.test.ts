import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalDeclarativeSpec,
  parseDeclarativeJson,
} from '../providers/custom-http/index.js';
import { createDatabase, type DatabaseClient } from './client.js';
import {
  ProviderAdapterDefinitionError,
  ProviderAdapterDefinitionRepository,
} from './adapter-definitions.js';
import { JobRepository } from './jobs.js';
import { ProviderRepository, ProviderRepositoryError } from './providers.js';
import { toJobDto } from '../routes/dto.js';
import { toRunnerJob } from '../jobs/sqlite-adapters.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const fixturePath = fileURLToPath(new URL('../../../../fixtures/providers/custom-http/sync-image/adapter.json', import.meta.url));
const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createTestDatabase(): Promise<DatabaseClient> {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-adapter-definition-test-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  return database;
}

async function declarativeFixture(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
}

async function declarativeRef(): Promise<{ ref: { kind: 'declarative-http'; adapterId: string; version: string; digest: string }; definition: Record<string, unknown> }> {
  const definition = await declarativeFixture();
  const canonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(definition)));
  return {
    ref: {
      kind: 'declarative-http',
      adapterId: 'sync-image',
      version: '1.0.0',
      digest: createHash('sha256').update(canonical).digest('hex'),
    },
    definition,
  };
}

describe('ProviderAdapterDefinitionRepository', () => {
  it('stores both declarative and trusted JavaScript references without source or secrets', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const repository = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    const saved = repository.create(provider.id, declarative);
    expect(saved.ref).toEqual(declarative.ref);
    expect(saved.definition).toMatchObject({ id: 'sync-image' });
    expect(repository.get(provider.id)).toEqual(saved);
    expect(repository.update(provider.id, declarative).ref).toEqual(declarative.ref);
    expect(() => repository.create(provider.id, declarative)).toThrow(ProviderAdapterDefinitionError);
    expect(JSON.stringify(saved)).not.toContain('secret-value');
    expect(JSON.stringify(saved)).not.toContain('ciphertext');

    const trustedProvider = new ProviderRepository(database.orm).create({ name: 'Trusted', type: 'custom-js-v1' });
    const trusted = repository.replace(trustedProvider.id, {
      ref: { kind: 'trusted-javascript', adapterId: 'trusted-image', version: '2.0.0', digest: 'b'.repeat(64) },
    });
    expect(trusted.definition).toBeNull();
    expect(repository.get(trustedProvider.id)?.ref.kind).toBe('trusted-javascript');
    expect(database.sqlite.prepare('SELECT definition_json FROM provider_adapter_definitions WHERE provider_id = ?').get(trustedProvider.id)).toEqual({ definition_json: null });
  });

  it('requires canonical matching digests and rejects oversized, prototype, and secret-bearing definitions', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const repository = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    expect(() => repository.replace(provider.id, {
      ref: { ...declarative.ref, digest: 'c'.repeat(64) },
      definition: declarative.definition,
    })).toThrow(ProviderAdapterDefinitionError);
    expect(() => repository.replace(provider.id, {
      ref: declarative.ref,
      definition: { ...declarative.definition, source: 'adapter.mjs' },
    })).toThrow(ProviderAdapterDefinitionError);
    expect(() => repository.replace(provider.id, {
      ref: declarative.ref,
      definition: { ...declarative.definition, apiKey: 'secret-value' },
    })).toThrow(ProviderAdapterDefinitionError);
    const oversized = { ...declarative.definition, name: 'x'.repeat(5_000) };
    expect(() => repository.replace(provider.id, { ref: declarative.ref, definition: oversized })).toThrow(ProviderAdapterDefinitionError);
    const inherited = Object.assign(Object.create({ inherited: true }), declarative.definition);
    expect(() => repository.replace(provider.id, { ref: declarative.ref, definition: inherited })).toThrow(ProviderAdapterDefinitionError);
    const dangerous = JSON.parse(JSON.stringify(declarative.definition)) as Record<string, unknown>;
    const submit = dangerous.submit as Record<string, unknown>;
    Object.defineProperty(submit, '__proto__', { enumerable: true, value: {} });
    expect(() => repository.replace(provider.id, { ref: declarative.ref, definition: dangerous })).toThrow(ProviderAdapterDefinitionError);
    expect(() => repository.replace(provider.id, {
      ref: { kind: 'trusted-javascript', adapterId: 'trusted', version: '1', digest: 'd'.repeat(64) },
      definition: declarative.definition,
    })).toThrow(ProviderAdapterDefinitionError);
    expect(() => repository.replace(provider.id, {
      ref: { kind: 'trusted-javascript', adapterId: 'trusted', version: '1', digest: 'd'.repeat(64) },
    })).toThrow(ProviderAdapterDefinitionError);
    expect(() => repository.replace(provider.id, {
      ref: { ...declarative.ref, adapterId: 'other-id' },
      definition: declarative.definition,
    })).toThrow(ProviderAdapterDefinitionError);
    const credentialQuery = {
      ...declarative.definition,
      submit: {
        ...(declarative.definition.submit as Record<string, unknown>),
        query: { api_key: 'literal' },
      },
    };
    const credentialCanonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(credentialQuery)));
    expect(() => repository.replace(provider.id, {
      ref: { ...declarative.ref, digest: createHash('sha256').update(credentialCanonical).digest('hex') },
      definition: credentialQuery,
    })).toThrow(ProviderAdapterDefinitionError);
    const submitBase = declarative.definition.submit as Record<string, unknown>;
    const credentialBodies = [
      {
        type: 'json',
        value: { nested: { apiKey: '{{ request.apiKey }}' } },
      },
      {
        type: 'form',
        fields: { credential_token: 'literal' },
      },
      {
        type: 'multipart',
        fields: { safe: 'value' },
        files: [{ field: 'access-token', input: { role: 'source', index: 0 } }],
      },
    ];
    for (const body of credentialBodies) {
      const definition = { ...declarative.definition, submit: { ...submitBase, body } };
      const canonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(definition)));
      expect(() => repository.replace(provider.id, {
        ref: { ...declarative.ref, digest: createHash('sha256').update(canonical).digest('hex') },
        definition,
      })).toThrow(ProviderAdapterDefinitionError);
    }
    const multipartFieldDefinition = {
      ...declarative.definition,
      submit: {
        ...submitBase,
        body: {
          type: 'multipart',
          fields: { safe: 'value' },
          files: [{ field: 'safe', input: { role: 'source', index: 0 }, filename: '{{ request.filename }}' }],
        },
      },
    };
    expect(() => repository.replace(provider.id, {
      ref: { ...declarative.ref, digest: createHash('sha256').update(canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(multipartFieldDefinition)))).digest('hex') },
      definition: multipartFieldDefinition,
    })).not.toThrow();

    const model = (declarative.definition.models as Array<Record<string, unknown>>)[0]!;
    const modelCapabilities = model.capabilities as Record<string, unknown>;
    const unsafeMetadata = [
      { apiKey: 'static-secret' },
      { client_secret: 'static-secret' },
      { Authorization: 'Bearer static-secret' },
      { ui: { template: '{{ secret.apiKey }}' } },
      { apiKey: { foo: 'LEAK', type: 'string' } },
    ];
    for (const [index, customFields] of unsafeMetadata.entries()) {
      const definition = {
        ...declarative.definition,
        models: [{
          ...model,
          capabilities: { ...modelCapabilities, customFields },
        }],
      };
      const parsed = parseDeclarativeJson(JSON.stringify(definition));
      const canonical = canonicalDeclarativeSpec(parsed);
      expect(() => repository.replace(provider.id, {
        ref: {
          ...declarative.ref,
          digest: createHash('sha256').update(canonical).digest('hex'),
          version: `unsafe-${index + 1}`,
        },
        definition,
      })).toThrow(ProviderAdapterDefinitionError);
    }

    const safeMetadata = {
      description: 'The API key is configured separately.',
      labels: ['Authorization', 'safe label'],
      modelFields: { style: { description: 'A model field.' } },
    };
    const safeDefinition = {
      ...declarative.definition,
      models: [{
        ...model,
        capabilities: { ...modelCapabilities, customFields: safeMetadata },
      }],
    };
    const safeCanonical = canonicalDeclarativeSpec(parseDeclarativeJson(JSON.stringify(safeDefinition)));
    const savedSafe = repository.replace(provider.id, {
      ref: {
        ...declarative.ref,
        digest: createHash('sha256').update(safeCanonical).digest('hex'),
        version: 'safe-metadata',
      },
      definition: safeDefinition,
    });
    expect(savedSafe.definition).toMatchObject({ models: [{ capabilities: { customFields: safeMetadata } }] });
  });

  it('keeps old revisions for active and terminal jobs and blocks referenced deletion', async () => {
    const database = await createTestDatabase();
    const providers = new ProviderRepository(database.orm);
    const provider = providers.create({ name: 'Declarative', type: 'custom-http-v1' });
    const repository = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    repository.replace(provider.id, declarative);
    const jobs = new JobRepository(database.orm);
    const request = createMockGenerationRequest({ providerId: provider.id });
    const job = jobs.create(request, declarative.ref);
    const changed = { ...declarative.ref, version: '2.0.0' };
    expect(repository.replace(provider.id, { ref: changed, definition: declarative.definition }).isCurrent).toBe(true);
    expect(repository.getByRef(provider.id, declarative.ref)?.isCurrent).toBe(false);
    expect(repository.getCurrent(provider.id)?.ref.version).toBe('2.0.0');
    expect(() => repository.delete(provider.id, declarative.ref)).toThrow(
      expect.objectContaining({ code: 'referenced_jobs' }),
    );
    const claimed = jobs.claimQueued(job.id, job.revision);
    if (!claimed) throw new Error('Expected adapter job to be claimed.');
    expect(jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed')).not.toBeNull();
    expect(repository.replace(provider.id, { ref: changed, definition: declarative.definition }).ref.version).toBe('2.0.0');
    expect(repository.delete(provider.id)).toBe(true);
  });

  it('snapshots refs into jobs, preserves them through retry and SQLite reopen, and rejects partial persisted refs', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    definitions.replace(provider.id, declarative);
    const jobs = new JobRepository(database.orm);
    const job = jobs.create(createMockGenerationRequest({ providerId: provider.id }), declarative.ref);
    expect(job.adapterRef).toEqual(declarative.ref);
    const claimed = jobs.claimQueued(job.id, job.revision);
    if (!claimed) throw new Error('Expected adapter job to be claimed.');
    jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed');
    const retry = jobs.retry(job.id);
    expect(retry?.adapterRef).toEqual(declarative.ref);
    expect(toRunnerJob(retry!).adapterRef).toEqual(declarative.ref);
    expect(JSON.stringify(toJobDto(retry!, 1))).not.toContain('sync-image');

    const path = database.sqlite.name;
    database.sqlite.close();
    databases.splice(databases.indexOf(database), 1);
    const reopened = createDatabase(path, migrationsDirectory);
    databases.push(reopened);
    expect(new JobRepository(reopened.orm).get(retry!.id)?.adapterRef).toEqual(declarative.ref);
    reopened.sqlite.exec('DROP TRIGGER jobs_adapter_ref_update_check');
    reopened.sqlite.prepare('UPDATE jobs SET adapter_id = NULL WHERE id = ?').run(retry!.id);
    expect(() => new JobRepository(reopened.orm).get(retry!.id)).toThrow('Job adapter reference is invalid.');
  });

  it('atomically captures the validated current revision and fails closed for stale or built-in refs', async () => {
    const database = await createTestDatabase();
    const providers = new ProviderRepository(database.orm);
    const provider = providers.create({ name: 'Current snapshot', type: 'custom-http-v1' });
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const first = await declarativeRef();
    definitions.replace(provider.id, first);
    const jobs = new JobRepository(database.orm);
    const request = createMockGenerationRequest({ providerId: provider.id });

    const firstJob = jobs.createAtCurrent(request, first.ref);
    expect(firstJob.adapterRef).toEqual(first.ref);
    expect(() => jobs.create(request)).toThrow(
      expect.objectContaining({ code: 'adapter_ref_missing' }),
    );
    expect(() => jobs.createAtCurrent(request)).toThrow(
      expect.objectContaining({ code: 'adapter_ref_missing' }),
    );

    const secondRef = { ...first.ref, version: '2.0.0' };
    definitions.replace(provider.id, { ref: secondRef, definition: first.definition });
    expect(() => jobs.createAtCurrent(request, first.ref)).toThrow(
      expect.objectContaining({ code: 'adapter_ref_not_current' }),
    );
    expect(jobs.list()).toHaveLength(1);

    const claimed = jobs.claimQueued(firstJob.id, firstJob.revision);
    if (!claimed) throw new Error('Expected the current snapshot Job to be claimed.');
    expect(jobs.compareAndSetStatus(firstJob.id, claimed.revision, ['submitting'], 'failed', 'failed')).not.toBeNull();
    const retried = jobs.retry(firstJob.id);
    expect(retried?.adapterRef).toEqual(first.ref);
    expect(definitions.disable(provider.id)?.ref).toEqual(secondRef);
    expect(() => jobs.createAtCurrent(request, secondRef)).toThrow(
      expect.objectContaining({ code: 'adapter_ref_missing' }),
    );

    const builtin = providers.create({ name: 'Built-in snapshot', type: 'mock' });
    expect(() => jobs.create(
      createMockGenerationRequest({ providerId: builtin.id }),
      first.ref,
    )).toThrow(expect.objectContaining({ code: 'adapter_ref_provider_mismatch' }));
    expect(() => jobs.createAtCurrent(
      createMockGenerationRequest({ providerId: builtin.id }),
      first.ref,
    )).toThrow(expect.objectContaining({ code: 'adapter_ref_provider_mismatch' }));
  });

  it('cascades definitions when the owning provider is deleted', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const repository = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    repository.replace(provider.id, declarative);
    expect(new ProviderRepository(database.orm).delete(provider.id)).toBe(true);
    expect(repository.get(provider.id)).toBeNull();
  });

  it('emits revision events without definition content and supports disable/current switching', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const repository = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    const first = repository.create(provider.id, declarative);
    const secondRef = { ...declarative.ref, version: '2.0.0' };
    const second = repository.replace(provider.id, { ref: secondRef, definition: declarative.definition });
    expect(repository.getByRef(provider.id, first.ref)?.isCurrent).toBe(false);
    expect(second.isCurrent).toBe(true);
    expect(repository.getByRef(provider.id, first.ref)?.definition).toEqual(first.definition);
    expect(
      database.sqlite.prepare(
        'SELECT COUNT(*) AS count FROM provider_adapter_definitions WHERE provider_id = ?',
      ).get(provider.id),
    ).toEqual({ count: 2 });
    expect(() => database.sqlite.prepare(
      'UPDATE provider_adapter_definitions SET definition_json = ? WHERE provider_id = ?',
    ).run('{}', provider.id)).toThrow();
    const disabled = repository.disable(provider.id);
    expect(disabled?.disabled).toBe(true);
    expect(repository.getCurrent(provider.id)).toBeNull();
    const eventRows = database.sqlite
      .prepare("SELECT event_type, payload_json FROM change_events WHERE aggregate_type = 'provider_adapter_definition' ORDER BY id")
      .all() as Array<{ event_type: string; payload_json: string }>;
    expect(eventRows.map((row) => row.event_type)).toEqual([
      'provider_adapter_definition.created',
      'provider_adapter_definition.replaced',
      'provider_adapter_definition.disabled',
    ]);
    expect(eventRows.every((row) => !row.payload_json.includes('submit'))).toBe(true);
    expect(eventRows.every((row) => JSON.parse(row.payload_json).digest)).toBe(true);
  });

  it('rejects provider type changes and deletion while any retained job references a revision', async () => {
    const database = await createTestDatabase();
    const providers = new ProviderRepository(database.orm);
    const provider = providers.create({ name: 'Declarative', type: 'custom-http-v1' });
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    definitions.create(provider.id, declarative);
    const jobs = new JobRepository(database.orm);
    const job = jobs.create(createMockGenerationRequest({ providerId: provider.id }), declarative.ref);
    expect(() => providers.update(provider.id, { type: 'custom-js-v1' })).toThrow(ProviderRepositoryError);
    expect(() => providers.delete(provider.id)).toThrow(ProviderRepositoryError);
    const claimed = jobs.claimQueued(job.id, job.revision);
    if (!claimed) throw new Error('Expected adapter job to be claimed.');
    jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed');
    expect(jobs.softDelete(job.id)).toBe(true);
    expect(providers.update(provider.id, { type: 'custom-js-v1' })?.type).toBe('custom-js-v1');
    expect(providers.delete(provider.id)).toBe(true);
  });

  it('quarantines one job with a corrupt adapter ref or stage budget without blocking another job', async () => {
    const database = await createTestDatabase();
    const provider = new ProviderRepository(database.orm).create({ name: 'Declarative', type: 'custom-http-v1' });
    const definitions = new ProviderAdapterDefinitionRepository(database.orm);
    const declarative = await declarativeRef();
    definitions.create(provider.id, declarative);
    const jobs = new JobRepository(database.orm);
    const corruptRef = jobs.create(createMockGenerationRequest({ providerId: provider.id }), declarative.ref);
    const corruptBudget = jobs.create(createMockGenerationRequest({ providerId: provider.id }), declarative.ref);
    const healthy = jobs.create(createMockGenerationRequest({ providerId: provider.id }), declarative.ref);
    database.sqlite.exec('DROP TRIGGER jobs_adapter_ref_update_check');
    database.sqlite.prepare('UPDATE jobs SET adapter_id = NULL WHERE id = ?').run(corruptRef.id);
    database.sqlite.prepare('UPDATE jobs SET stage_retry_counts_json = ? WHERE id = ?').run(
      JSON.stringify({ poll: 0, download: 0, process: 0, padding: 'x'.repeat(17_000) }),
      corruptBudget.id,
    );
    const recoverable = jobs.listRecoverable();
    expect(recoverable.map((job) => job.id)).toEqual([healthy.id]);
    expect(jobs.get(corruptRef.id)?.errorCode).toBe('provider_adapter_ref_rejected');
    expect(jobs.get(corruptBudget.id)?.errorCode).toBe('provider_adapter_ref_rejected');
    expect(jobs.get(corruptRef.id)?.adapterRef).toBeNull();
    expect(jobs.get(corruptBudget.id)?.adapterRef).toBeNull();
  });
});
