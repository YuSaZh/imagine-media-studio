import { access, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockGenerationRequest } from '@imagine/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdapterStore,
  AdapterStoreError,
  digestAdapterSource,
  MAX_ADAPTER_SOURCE_BYTES,
  MAX_MANIFEST_BYTES,
} from '../adapters/index.js';
import {
  ProviderAdapterDefinitionError,
  ProviderAdapterDefinitionRepository,
} from '../database/adapter-definitions.js';
import { createDatabase, type DatabaseClient } from '../database/client.js';
import { JobRepository } from '../database/jobs.js';
import { ProviderRepository } from '../database/providers.js';
import { ChangeEventRepository } from '../database/events.js';
import { EventBroker } from '../events/event-broker.js';
import { OutboxPublisher } from '../events/outbox-publisher.js';
import {
  TrustedAdapterService,
  TrustedAdapterServiceError,
  type TrustedAdapterOutboxPort,
  type TrustedAdapterInstallRequest,
} from './trusted-adapter-service.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));
const fixtureDirectory = new URL('../providers/custom-js/fixtures/', import.meta.url);
const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const NOOP_OUTBOX: TrustedAdapterOutboxPort = { flush() {} };

interface Harness {
  readonly root: string;
  readonly database: DatabaseClient;
  readonly definitions: ProviderAdapterDefinitionRepository;
  readonly jobs: JobRepository;
  readonly providers: ProviderRepository;
  readonly provider: ReturnType<ProviderRepository['create']>;
  readonly store: AdapterStore;
  readonly service: TrustedAdapterService;
}

async function fixture(): Promise<{ readonly manifest: Record<string, unknown>; readonly source: Uint8Array }> {
  const [manifestText, source] = await Promise.all([
    readFile(new URL('trusted-fixture-manifest.json', fixtureDirectory), 'utf8'),
    readFile(new URL('trusted-fixture.mjs', fixtureDirectory)),
  ]);
  return {
    manifest: JSON.parse(manifestText) as Record<string, unknown>,
    source,
  };
}

async function harness(
  adminEnabled = true,
  providerType = 'custom-js-v1',
  outbox: TrustedAdapterOutboxPort = NOOP_OUTBOX,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'imagine-trusted-adapter-service-'));
  temporaryDirectories.push(root);
  const database = createDatabase(resolve(root, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const provider = providers.create({
    name: `Trusted fixture ${root}`,
    type: providerType,
  });
  const definitions = new ProviderAdapterDefinitionRepository(database.orm);
  const jobs = new JobRepository(database.orm);
  const store = new AdapterStore(join(root, 'adapters'), {
    adminEnabled: true,
    assertAdmin() {},
  });
  const service = new TrustedAdapterService({
    adminEnabled,
    store,
    adapterDefinitions: definitions,
    providers,
    jobs,
    outbox,
  });
  return { root, database, definitions, jobs, providers, provider, store, service };
}

function installRequest(
  input: Awaited<ReturnType<typeof fixture>>,
  providerId?: string,
): TrustedAdapterInstallRequest {
  return {
    manifest: input.manifest,
    source: input.source,
    ...(providerId === undefined ? {} : { providerId }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('TrustedAdapterService', () => {
  it('keeps every management operation fail-closed without APP_PASSWORD and close remains available', async () => {
    const harness = await harnessFactory(false);
    const input = await fixture();
    const install = installRequest(input, harness.provider.id);
    await expect(harness.service.install(install)).rejects.toMatchObject({
      code: 'administrator_required',
      statusCode: 403,
    });
    await expect(harness.service.list()).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.get('trusted-js-fixture')).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.bind({ providerId: harness.provider.id, ref: {
      kind: 'trusted-javascript',
      adapterId: 'trusted-js-fixture',
      version: '1.0.0',
      digest: '0'.repeat(64),
    } })).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.remove('trusted-js-fixture')).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.close()).resolves.toBeUndefined();
    await expect(access(join(harness.root, 'adapters'))).rejects.toThrow();
  });

  it('requires an outbox publisher in both constructor forms', async () => {
    const harness = await harnessFactory();
    const dependencies = {
      adminEnabled: true,
      store: harness.store,
      adapterDefinitions: harness.definitions,
      providers: harness.providers,
      jobs: harness.jobs,
    };
    // @ts-expect-error Management mutations require an outbox dependency.
    expect(() => new TrustedAdapterService(dependencies)).toThrow('outbox publisher');
    // @ts-expect-error The positional constructor also requires an outbox dependency.
    expect(() => new TrustedAdapterService(true, harness.store, harness.definitions, harness.providers, harness.jobs)).toThrow('outbox publisher');
  });

  it('does not accept an adminEnabled request field and does not expose source in its DTO', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const sourceText = new TextDecoder().decode(input.source);
    await expect(harness.service.install({
      ...installRequest(input, harness.provider.id),
      adminEnabled: true,
    } as never)).rejects.toMatchObject({ code: 'invalid_request' });
    const dto = await harness.service.install(installRequest(input, harness.provider.id));
    expect(Object.keys(dto).sort()).toEqual(['createdAt', 'manifest', 'ref', 'updatedAt']);
    expect(JSON.stringify(dto)).not.toContain(sourceText);
    expect('source' in dto).toBe(false);
    expect('definition' in dto).toBe(false);
    expect('providerId' in dto).toBe(false);
  });

  it('preflights digest and source before touching the Store', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const wrongManifest = { ...input.manifest, sha256: '0'.repeat(64) };
    await expect(harness.service.install({ manifest: wrongManifest, source: input.source })).rejects.toMatchObject({
      code: 'digest_mismatch',
      statusCode: 400,
    });
    await expect(access(join(harness.root, 'adapters'))).rejects.toThrow();
    await expect(harness.service.install({
      manifest: input.manifest,
      source: new TextEncoder().encode("import('not-allowed');"),
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });

  it('rejects source and manifest payloads above their limits before copying them', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const oversizedSource = new Uint8Array(MAX_ADAPTER_SOURCE_BYTES + 1);
    await expect(harness.service.install({ manifest: input.manifest, source: oversizedSource })).rejects.toMatchObject({
      code: 'source_too_large',
      statusCode: 413,
    });
    await expect(harness.service.install({
      manifest: 'x'.repeat(MAX_MANIFEST_BYTES + 1),
      source: input.source,
    })).rejects.toMatchObject({
      code: 'manifest_too_large',
      statusCode: 413,
    });
    await expect(access(join(harness.root, 'adapters'))).rejects.toThrow();
  });

  it('rejects duplicate installs and same-id upgrades while allowing a new immutable id', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const first = await harness.service.install(installRequest(input));
    await expect(harness.service.install(installRequest(input))).rejects.toMatchObject({
      code: 'already_exists',
      statusCode: 409,
    });
    const upgradedSource = new TextEncoder().encode(`${new TextDecoder().decode(input.source)}\n// upgraded revision\n`);
    const upgradedManifest = {
      ...input.manifest,
      version: '2.0.0',
      sha256: digestAdapterSource(upgradedSource),
    };
    await expect(harness.service.install({ manifest: upgradedManifest, source: upgradedSource })).rejects.toMatchObject({
      code: 'adapter_id_immutable',
      statusCode: 409,
    });
    const newIdManifest = { ...upgradedManifest, id: 'trusted-js-fixture-v2' };
    const second = await harness.service.install({ manifest: newIdManifest, source: upgradedSource });
    expect(second.ref.adapterId).toBe('trusted-js-fixture-v2');
    expect(first.ref.adapterId).toBe('trusted-js-fixture');
  });

  it('requires a custom-js Provider for create and bind operations', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const mismatch = harness.providers.create({
      name: `HTTP mismatch ${harness.root}`,
      type: 'custom-http-v1',
    });
    await expect(harness.service.install(installRequest(input, mismatch.id))).rejects.toMatchObject({
      code: 'provider_type_mismatch',
      statusCode: 409,
    });

    const installed = await harness.service.install(installRequest(input));
    await expect(harness.service.bind({ providerId: mismatch.id, ref: installed.ref })).rejects.toMatchObject({
      code: 'provider_type_mismatch',
    });
    const bound = await harness.service.bind({ providerId: harness.provider.id, ref: installed.ref });
    expect(bound.ref).toEqual(installed.ref);
    expect(harness.definitions.getCurrent(harness.provider.id)?.ref).toEqual(installed.ref);
  });

  it('maps Store permission failures without returning filesystem details', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    await harness.service.install(installRequest(input));
    await chmod(join(harness.root, 'adapters', 'trusted-js-fixture', 'adapter.mjs'), 0o644);
    const error = await harness.service.get('trusted-js-fixture').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'store_failure', statusCode: 500 });
    expect(error).toBeInstanceOf(TrustedAdapterServiceError);
    expect((error as Error).message).not.toContain('adapter.mjs');
  });

  it('protects removal from current, historical, cross-provider, and retained Job references', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input, harness.provider.id));
    await expect(harness.service.remove(installed.ref.adapterId)).rejects.toMatchObject({
      code: 'adapter_references_in_use',
      statusCode: 409,
    });
    const secondProvider = harness.providers.create({
      name: `Trusted second ${harness.root}`,
      type: 'custom-js-v1',
    });
    await expect(harness.service.bind({ providerId: secondProvider.id, ref: installed.ref })).resolves.toMatchObject({
      ref: installed.ref,
    });
    const job = harness.jobs.createAtCurrent(
      createMockGenerationRequest({ providerId: harness.provider.id, modelId: 'fixture-model' }),
      installed.ref,
    );
    expect(job.adapterRef).toEqual(installed.ref);
    await expect(harness.service.remove(installed.ref.adapterId)).rejects.toMatchObject({
      code: 'adapter_references_in_use',
    });
    expect(await harness.service.get(installed.ref.adapterId)).not.toBeNull();
  });

  it('rolls back the Store when definition persistence fails', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    vi.spyOn(harness.definitions, 'installTrustedAdapter').mockImplementation(() => {
      throw new ProviderAdapterDefinitionError('persisted_invalid', 'test failure');
    });
    await expect(harness.service.install(installRequest(input, harness.provider.id))).rejects.toMatchObject({
      code: 'definition_failure',
      statusCode: 500,
    });
    await expect(access(join(harness.root, 'adapters', 'trusted-js-fixture'))).rejects.toThrow();
    expect(harness.definitions.listByAdapterId('trusted-js-fixture')).toEqual([]);
  });

  it('rolls back the filesystem when the committed lifecycle event transaction fails', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    harness.database.sqlite.exec(`
      CREATE TRIGGER fail_trusted_install_event
      BEFORE INSERT ON change_events
      WHEN NEW.aggregate_type = 'trusted_adapter'
      BEGIN
        SELECT RAISE(ABORT, 'injected lifecycle event failure');
      END;
    `);
    await expect(harness.service.install(installRequest(input, harness.provider.id))).rejects.toMatchObject({
      code: 'definition_failure',
      statusCode: 500,
    });
    await expect(access(join(harness.root, 'adapters', 'trusted-js-fixture'))).rejects.toThrow();
    expect(harness.definitions.getTrustedAdapterInstallation('trusted-js-fixture')).toBeNull();
    expect(harness.definitions.listByAdapterId('trusted-js-fixture')).toEqual([]);
    expect(harness.database.sqlite.prepare("SELECT COUNT(*) AS count FROM change_events WHERE aggregate_type = 'trusted_adapter'").get()).toEqual({ count: 0 });
  });

  it('reconciles a legacy filesystem adapter once and keeps its lifecycle time stable', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    await harness.store.install({ manifest: input.manifest, source: input.source });
    expect(harness.definitions.getTrustedAdapterInstallation('trusted-js-fixture')).toBeNull();

    const first = await harness.service.get('trusted-js-fixture');
    expect(first).not.toBeNull();
    const persisted = harness.definitions.getTrustedAdapterInstallation('trusted-js-fixture');
    expect(persisted).not.toBeNull();
    expect(first!.createdAt.getTime()).toBe(persisted!.createdAt.getTime());
    expect(first!.updatedAt.getTime()).toBe(persisted!.updatedAt.getTime());
    const second = await harness.service.get('trusted-js-fixture');
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime());
    expect(second!.updatedAt.getTime()).toBe(first!.updatedAt.getTime());
    expect(harness.database.sqlite.prepare("SELECT COUNT(*) AS count FROM change_events WHERE event_type = 'trusted_adapter.installed'").get()).toEqual({ count: 1 });
  });

  it('restores bound and unbound lifecycle metadata after a database reopen', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const unbound = await harness.service.install(installRequest(input));
    const beforeBind = await harness.service.get(unbound.ref.adapterId);
    expect(beforeBind!.createdAt.getTime()).toBe(unbound.createdAt.getTime());
    expect(beforeBind!.updatedAt.getTime()).toBe(unbound.updatedAt.getTime());
    const bound = await harness.service.bind(harness.provider.id, unbound.ref);
    const databasePath = harness.database.sqlite.name;
    harness.database.sqlite.close();
    databases.splice(databases.indexOf(harness.database), 1);
    const reopened = createDatabase(databasePath, migrationsDirectory);
    databases.push(reopened);
    const providers = new ProviderRepository(reopened.orm);
    const definitions = new ProviderAdapterDefinitionRepository(reopened.orm);
    const jobs = new JobRepository(reopened.orm);
    const store = new AdapterStore(join(harness.root, 'adapters'), {
      adminEnabled: true,
      assertAdmin() {},
    });
    const service = new TrustedAdapterService({
      adminEnabled: true,
      store,
      adapterDefinitions: definitions,
      providers,
      jobs,
      outbox: NOOP_OUTBOX,
    });
    const restored = await service.get(unbound.ref.adapterId);
    expect(restored!.createdAt.getTime()).toBe(bound.createdAt.getTime());
    expect(restored!.updatedAt.getTime()).toBe(bound.updatedAt.getTime());
    const again = await service.get(unbound.ref.adapterId);
    expect(again!.createdAt.getTime()).toBe(restored!.createdAt.getTime());
    expect(again!.updatedAt.getTime()).toBe(restored!.updatedAt.getTime());
    expect(definitions.getCurrent(harness.provider.id)?.ref).toEqual(unbound.ref);
  });

  it('writes one tombstone event, keeps it after an FS failure, and retries cleanup without ID reuse', async () => {
    const flush = vi.fn();
    const harness = await harnessFactory(true, 'custom-js-v1', { flush });
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input));
    expect(flush).toHaveBeenCalledTimes(1);
    vi.spyOn(harness.store, 'remove').mockRejectedValueOnce(new AdapterStoreError('injected removal failure'));
    await expect(harness.service.remove(installed.ref.adapterId)).rejects.toMatchObject({ code: 'store_failure' });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(harness.definitions.getTombstone(installed.ref.adapterId)).toMatchObject({
      adapterId: installed.ref.adapterId,
      version: installed.ref.version,
      digest: installed.ref.digest,
    });
    expect(harness.definitions.getTrustedAdapterInstallation(installed.ref.adapterId)).toBeNull();
    await expect(harness.service.remove(installed.ref.adapterId)).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(2);
    await expect(access(join(harness.root, 'adapters', installed.ref.adapterId))).rejects.toThrow();
    await expect(harness.service.install(installRequest(input))).rejects.toMatchObject({
      code: 'adapter_id_immutable',
      statusCode: 409,
    });
    expect(() => harness.definitions.create(harness.provider.id, { ref: installed.ref })).toThrow(
      expect.objectContaining({ code: 'tombstoned' }),
    );
    const events = harness.database.sqlite
      .prepare("SELECT event_type, payload_json FROM change_events WHERE aggregate_type = 'trusted_adapter' ORDER BY id")
      .all() as { event_type: string; payload_json: string }[];
    expect(events.map((event) => event.event_type)).toEqual(['trusted_adapter.installed', 'trusted_adapter.tombstoned']);
    expect(events.every((event) => !event.payload_json.includes('adapter.mjs'))).toBe(true);
  });

  it('flushes the outbox once after one atomic bound installation', async () => {
    const flush = vi.fn();
    const harness = await harnessFactory(true, 'custom-js-v1', { flush });
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input));
    expect(installed.ref.adapterId).toBe('trusted-js-fixture');
    expect(flush).toHaveBeenCalledTimes(1);
    flush.mockClear();
    await harness.service.bind(harness.provider.id, installed.ref);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(harness.database.sqlite
      .prepare("SELECT event_type FROM change_events WHERE aggregate_type IN ('trusted_adapter', 'provider_adapter_definition') ORDER BY id")
      .all()).toEqual([
      { event_type: 'trusted_adapter.installed' },
      { event_type: 'provider_adapter_definition.created' },
    ]);
  });

  it('keeps the real OutboxPublisher receiver bound', async () => {
    const harness = await harnessFactory();
    const publisher = new OutboxPublisher(new ChangeEventRepository(harness.database.orm), new EventBroker());
    const service = new TrustedAdapterService({
      adminEnabled: true,
      store: harness.store,
      adapterDefinitions: harness.definitions,
      providers: harness.providers,
      jobs: harness.jobs,
      outbox: publisher,
    });
    const input = await fixture();
    await service.install(installRequest(input));
    expect(publisher.lastPublishedId).toBeGreaterThan(0);
  });

  it('does not flush failed mutations and preserves a committed state when flush fails', async () => {
    const flush = vi.fn();
    const harness = await harnessFactory(true, 'custom-js-v1', { flush });
    const input = await fixture();
    await expect(harness.service.install({
      manifest: { ...input.manifest, sha256: '0'.repeat(64) },
      source: input.source,
    })).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(flush).toHaveBeenCalledTimes(0);

    flush.mockImplementation(() => { throw new Error('publisher unavailable'); });
    await expect(harness.service.install(installRequest(input))).rejects.toMatchObject({
      code: 'outbox_failure',
      statusCode: 500,
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(await harness.store.get('trusted-js-fixture')).not.toBeNull();
    expect(harness.definitions.getTrustedAdapterInstallation('trusted-js-fixture')).not.toBeNull();
    expect(harness.database.sqlite.prepare("SELECT COUNT(*) AS count FROM change_events WHERE event_type = 'trusted_adapter.installed'").get()).toEqual({ count: 1 });
  });

  it('serializes concurrent same-id installs so exactly one revision wins', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const results = await Promise.allSettled([
      harness.service.install(installRequest(input)),
      harness.service.install(installRequest(input)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'already_exists' }),
    });
    expect((await harness.service.list()).map((item) => item.ref.adapterId)).toEqual(['trusted-js-fixture']);
  });

  it('returns null for a missing adapter while still requiring management authorization', async () => {
    const harness = await harnessFactory();
    await expect(harness.service.get('missing-adapter')).resolves.toBeNull();
    const denied = await harnessFactory(false);
    await expect(denied.service.get('missing-adapter')).rejects.toMatchObject({ code: 'administrator_required' });
  });

  it('reads current, exact historical, and disabled Provider bindings without ref fallback', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const first = await harness.service.install(installRequest(input));
    await harness.service.bind(harness.provider.id, first.ref);

    const upgradedSource = new TextEncoder().encode(`${new TextDecoder().decode(input.source)}\n// second immutable adapter\n`);
    const secondManifest = {
      ...input.manifest,
      id: 'trusted-js-fixture-v2',
      version: '2.0.0',
      sha256: digestAdapterSource(upgradedSource),
    };
    const second = await harness.service.install({ manifest: secondManifest, source: upgradedSource });
    await harness.service.bind(harness.provider.id, second.ref);

    const current = await harness.service.getBinding(harness.provider.id);
    expect(current).toMatchObject({
      providerId: harness.provider.id,
      ref: second.ref,
      isCurrent: true,
      disabled: false,
      definition: null,
      manifest: { id: second.ref.adapterId, version: second.ref.version, sha256: second.ref.digest },
    });
    expect(current?.installation.createdAt).toBeInstanceOf(Date);
    expect(current?.installation.updatedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(current)).not.toContain(new TextDecoder().decode(input.source));
    expect('source' in (current as object)).toBe(false);

    const historical = await harness.service.getBinding(harness.provider.id, first.ref);
    expect(historical).toMatchObject({
      providerId: harness.provider.id,
      ref: first.ref,
      isCurrent: false,
      disabled: false,
    });
    expect(await harness.service.getBinding(harness.provider.id, {
      ...first.ref,
      digest: '0'.repeat(64),
    })).toBeNull();
    expect((await harness.service.listBindings(harness.provider.id)).map((binding) => binding.ref.adapterId)).toEqual([
      first.ref.adapterId,
      second.ref.adapterId,
    ]);

    const disabled = await harness.service.disableBinding(harness.provider.id);
    expect(disabled).toMatchObject({ ref: second.ref, isCurrent: false, disabled: true });
    await expect(harness.service.getBinding(harness.provider.id)).resolves.toBeNull();
    await expect(harness.service.getBinding(harness.provider.id, second.ref)).resolves.toMatchObject({
      ref: second.ref,
      isCurrent: false,
      disabled: true,
    });
  });

  it('unbinds one Provider binding while retaining the immutable installation and another Provider binding', async () => {
    const harness = await harnessFactory();
    const secondProvider = harness.providers.create({ name: `Trusted other ${harness.root}`, type: 'custom-js-v1' });
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input, harness.provider.id));
    await harness.service.bind(secondProvider.id, installed.ref);

    await expect(harness.service.deleteBinding(harness.provider.id, installed.ref)).resolves.toBe(true);
    expect(harness.definitions.getByRef(harness.provider.id, installed.ref)).toBeNull();
    expect(await harness.service.getBinding(harness.provider.id)).toBeNull();
    expect(await harness.service.getBinding(secondProvider.id, installed.ref)).toMatchObject({
      providerId: secondProvider.id,
      ref: installed.ref,
      isCurrent: true,
    });
    expect(await harness.store.get(installed.ref.adapterId)).not.toBeNull();
    expect(harness.definitions.getTrustedAdapterInstallation(installed.ref.adapterId)).not.toBeNull();
  });

  it('maps retained Job references to conflict and leaves the global adapter intact', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input, harness.provider.id));
    const job = harness.jobs.createAtCurrent(
      createMockGenerationRequest({ providerId: harness.provider.id, modelId: 'fixture-model' }),
      installed.ref,
    );
    await expect(harness.service.deleteBinding(harness.provider.id, installed.ref)).rejects.toMatchObject({
      code: 'adapter_references_in_use',
      statusCode: 409,
    });
    expect(harness.definitions.getByRef(harness.provider.id, installed.ref)).not.toBeNull();
    expect(await harness.store.get(installed.ref.adapterId)).not.toBeNull();

    const claimed = harness.jobs.claimQueued(job.id, job.revision);
    if (!claimed) throw new Error('Expected adapter Job to be claimed.');
    harness.jobs.compareAndSetStatus(job.id, claimed.revision, ['submitting'], 'failed', 'failed');
    expect(harness.jobs.softDelete(job.id)).toBe(true);
    await expect(harness.service.unbind(harness.provider.id, installed.ref)).resolves.toBe(true);
    expect(await harness.store.get(installed.ref.adapterId)).not.toBeNull();
  });

  it('fails closed with a stable not_found error when the binding tombstone or source is absent', async () => {
    const harness = await harnessFactory();
    const input = await fixture();
    const installed = await harness.service.install(installRequest(input, harness.provider.id));
    await harness.store.remove(installed.ref.adapterId);
    await expect(harness.service.getBinding(harness.provider.id, installed.ref)).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
    await expect(harness.service.getBinding(harness.provider.id)).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });

    const tombstoned = await harnessFactory();
    const tombstoneInput = await fixture();
    const tombstoneInstall = await tombstoned.service.install(installRequest(tombstoneInput, tombstoned.provider.id));
    await tombstoned.service.unbind(tombstoned.provider.id, tombstoneInstall.ref);
    await tombstoned.service.remove(tombstoneInstall.ref.adapterId);
    await expect(tombstoned.service.getBinding(tombstoned.provider.id, tombstoneInstall.ref)).rejects.toMatchObject({
      code: 'not_found',
      statusCode: 404,
    });
  });

  it('requires administrator authorization for every binding lifecycle method', async () => {
    const harness = await harnessFactory(false);
    const ref = {
      kind: 'trusted-javascript' as const,
      adapterId: 'trusted-js-fixture',
      version: '1.0.0',
      digest: '0'.repeat(64),
    };
    await expect(harness.service.getBinding(harness.provider.id)).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.getBinding(harness.provider.id, ref)).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.listBindings(harness.provider.id)).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.disableBinding(harness.provider.id)).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.deleteBinding(harness.provider.id)).rejects.toMatchObject({ code: 'administrator_required' });
    await expect(harness.service.unbind(harness.provider.id)).rejects.toMatchObject({ code: 'administrator_required' });
  });
});

async function harnessFactory(
  adminEnabled = true,
  providerType = 'custom-js-v1',
  outbox: TrustedAdapterOutboxPort = NOOP_OUTBOX,
): Promise<Harness> {
  return harness(adminEnabled, providerType, outbox);
}
