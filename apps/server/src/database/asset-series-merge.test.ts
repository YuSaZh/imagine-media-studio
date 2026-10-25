import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createMockGenerationRequest } from '@imagine/testkit';
import { createDatabase } from './client.js';
import { AssetRepository, AssetSeriesLimitError } from './assets.js';
import { JobRepository } from './jobs.js';
import { ProviderRepository } from './providers.js';
import { registerResourceRoutes, type ResourceRoutesOptions } from '../routes/resources.js';

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'imagine-series-merge-'));
  const database = createDatabase(resolve(directory, 'app.db'), resolve('apps/server/migrations'));
  const assets = new AssetRepository(database.orm, () => 'admin');
  const jobs = new JobRepository(database.orm);
  const provider = new ProviderRepository(database.orm).create({ name: 'Series fixture', type: 'mock' });
  let counter = 0;
  // Bulk fixtures exercise merge/traversal, not thousands of create/outbox calls.
  const insert = database.sqlite.prepare('INSERT INTO assets (id,owner_id,job_id,type,role,file_path,mime_type,file_size,sha256,metadata_json,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const asset = (jobId?: string) => {
    const id = `series-${counter++}`;
    insert.run(id, 'admin', jobId ?? null, 'image', jobId ? 'output' : 'upload', `${id}.png`, 'image/png', 1, 'a'.repeat(64), '{}', Date.now());
    return assets.get(id)!;
  };
  const snapshot = () => ({
    links: database.sqlite.prepare('SELECT * FROM asset_series_links ORDER BY asset_id,linked_asset_id').all(),
    events: database.sqlite.prepare('SELECT count(*) AS count FROM change_events').get(),
  });
  return { database, assets, jobs, provider, asset, snapshot,
    async close() { database.sqlite.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

it('rejects an unreadable output merge atomically and accepts the exact graph boundary', async () => {
  const f = await fixture(); const app = Fastify({ logger: false });
  try {
    const ids = f.database.sqlite.transaction(() => Array.from({ length: 501 }, () => f.asset(f.jobs.create(createMockGenerationRequest({ providerId: f.provider.id })).id).id))();
    await registerResourceRoutes(app, { assets: f.assets, outbox: { flush() {} } } as unknown as ResourceRoutesOptions);
    const before = f.snapshot();
    const response = await app.inject({ method: 'POST', url: '/internal/assets/series', payload: { assetIds: ids } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'series_too_large' });
    expect(f.snapshot()).toEqual(before);
    expect((await app.inject({ method: 'POST', url: '/internal/assets/series', payload: { assetIds: ids.slice(0, 500) } })).statusCode).toBe(204);
    for (const concurrent of [false, true]) for (const uploaded of [false, true]) {
      const series = f.assets.series(ids[0]!, concurrent, uploaded)!;
      expect(series.truncated).toBe(false);
      expect(series.assets).toHaveLength(500);
      expect(series.jobIds).toHaveLength(500);
    }
  } finally { await app.close(); await f.close(); }
});

it('counts whole existing families and deleted bridges, preserving links on rejection', async () => {
  const f = await fixture();
  try {
    const ids = f.database.sqlite.transaction(() => Array.from({ length: 1001 }, () => f.asset().id))();
    expect(f.assets.mergeSeries(ids.slice(0, 500))).toBe(true);
    expect(f.assets.mergeSeries(ids.slice(500, 1000))).toBe(true);
    expect(f.assets.mergeSeries([ids[0]!, ids[500]!])).toBe(true);
    expect(f.assets.series(ids[0]!)?.assets).toHaveLength(1000);
    // The tombstone is still an ancestry bridge and still consumes traversal budget.
    f.assets.softDelete(ids[1]!);
    const before = f.snapshot();
    expect(() => f.assets.mergeSeries([ids[0]!, ids[1000]!])).toThrow(AssetSeriesLimitError);
    expect(f.snapshot()).toEqual(before);
    expect(f.assets.series(ids[1000]!)?.assets).toHaveLength(1);
    expect(new AssetRepository(f.database.orm, () => 'other').mergeSeries([ids[0]!, ids[500]!])).toBe(false);
    expect(f.assets.mergeSeries([ids[0]!, 'missing'])).toBe(false);
    expect(f.snapshot()).toEqual(before);
  } finally { await f.close(); }
});

it('checks concurrent batches even when only one output from each batch was selected', async () => {
  const f = await fixture();
  try {
    const selected = f.database.sqlite.transaction(() => Array.from({ length: 17 }, () => {
      const batch = f.jobs.createBatch(createMockGenerationRequest({ providerId: f.provider.id }), 32);
      return batch.map(job => f.asset(job.id).id)[0]!;
    }))();
    const before = f.snapshot();
    expect(() => f.assets.mergeSeries(selected)).toThrow(AssetSeriesLimitError);
    expect(f.snapshot()).toEqual(before);
    expect(f.assets.series(selected[0]!, true)?.assets).toHaveLength(32);
  } finally { await f.close(); }
});

it('checks uploaded-reference ancestry as well as the alternative batch policy', async () => {
  const f = await fixture();
  try {
    const source = f.asset();
    const ids = f.database.sqlite.transaction(() => Array.from({ length: 500 }, () => f.asset(f.jobs.create(createMockGenerationRequest({ providerId: f.provider.id, inputs: [{ assetId: source.id, role: 'reference' }] })).id).id))();
    const before = f.snapshot();
    expect(() => f.assets.mergeSeries(ids.slice(0, 2))).toThrow(AssetSeriesLimitError);
    expect(f.snapshot()).toEqual(before);
    expect(f.assets.series(ids[0]!, true, false)?.truncated).toBe(false);
    expect(f.assets.series(ids[0]!, true, true)?.truncated).toBe(true);
  } finally { await f.close(); }
});
