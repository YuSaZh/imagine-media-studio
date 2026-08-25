import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseClient } from './client.js';
import { ChangeEventRepository } from './events.js';
import {
  ModelRepository,
  ModelRepositoryError,
} from './models.js';
import { ProviderRepository } from './providers.js';

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const migrationsDirectory = fileURLToPath(new URL('../../migrations', import.meta.url));

afterEach(async () => {
  for (const database of databases.splice(0)) database.sqlite.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createHarness() {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-model-repository-test-'));
  temporaryDirectories.push(directory);
  const database = createDatabase(resolve(directory, 'app.db'), migrationsDirectory);
  databases.push(database);
  const providers = new ProviderRepository(database.orm);
  const models = new ModelRepository(database.orm);
  const provider = providers.create({ name: 'Catalog Provider', type: 'mock' });
  return { database, models, provider };
}

const capabilities = {
  operations: ['image.generate' as const],
  aspectRatios: ['1:1'],
  inputImageConstraints: { mimeTypes: ['image/png'] },
};

describe('ModelRepository manual catalog', () => {
  it('validates manual capability payloads and limits mutation to manual rows', async () => {
    const { database, models, provider } = await createHarness();
    const events = new ChangeEventRepository(database.orm);
    const providerModel = models.replaceForProvider(provider.id, [{
      modelId: 'provider-model',
      displayName: 'Provider model',
      capabilities,
      capabilitySource: 'provider',
    }])[0];
    if (!providerModel) throw new Error('Expected provider model.');

    expect(models.updateManual(providerModel.id, { displayName: 'Nope' })).toBeNull();
    expect(models.deleteManual(providerModel.id)).toBe(false);

    expect(() => models.saveManual({
      providerId: provider.id,
      modelId: 'invalid',
      displayName: 'Invalid',
      capabilities: { operations: ['image.generate'], unknown: true },
    })).toThrowError(ModelRepositoryError);

    const manual = models.saveManual({
      providerId: provider.id,
      modelId: providerModel.modelId,
      displayName: 'Manual model',
      capabilities,
      enabled: false,
    });
    expect(manual).toMatchObject({
      capabilitySource: 'manual',
      displayName: 'Manual model',
      enabled: false,
    });
    expect(events.replay().at(-1)).toMatchObject({
      aggregateType: 'model',
      aggregateId: manual.id,
      eventType: 'model.manual_saved',
    });
    const updated = models.updateManual(manual.id, {
      displayName: 'Renamed manual',
      enabled: true,
    });
    expect(updated).toMatchObject({
      capabilitySource: 'manual',
      displayName: 'Renamed manual',
      enabled: true,
    });
    expect(events.replay().at(-1)).toMatchObject({
      aggregateType: 'model',
      aggregateId: manual.id,
      eventType: 'model.manual_updated',
    });
    expect(models.deleteManual(manual.id)).toBe(true);
    expect(events.replay().at(-1)).toMatchObject({
      aggregateType: 'model',
      aggregateId: manual.id,
      eventType: 'model.manual_deleted',
    });
    expect(models.get(manual.id)).toBeNull();
  });

  it('keeps manual overrides enabled state and rows across provider refreshes', async () => {
    const { models, provider } = await createHarness();
    models.replaceForProvider(provider.id, [
      { modelId: 'shared', displayName: 'Provider shared', capabilities, capabilitySource: 'provider' },
      { modelId: 'stale', displayName: 'Stale', capabilities, capabilitySource: 'provider' },
    ]);
    const manual = models.saveManual({
      providerId: provider.id,
      modelId: 'shared',
      displayName: 'Manual shared',
      capabilities,
      enabled: false,
    });

    const refreshed = models.replaceForProvider(provider.id, [
      { modelId: 'shared', displayName: 'Provider changed', capabilities, capabilitySource: 'provider' },
      { modelId: 'fresh', displayName: 'Fresh', capabilities, capabilitySource: 'provider' },
    ]);
    expect(refreshed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, modelId: 'shared', capabilitySource: 'manual', enabled: false }),
      expect.objectContaining({ modelId: 'stale', capabilitySource: 'provider', enabled: false }),
      expect.objectContaining({ modelId: 'fresh', capabilitySource: 'provider', enabled: true }),
    ]));
    expect(refreshed.filter((model) => model.modelId === 'shared')).toHaveLength(1);
  });
});
