import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseClient } from './client.js';
import { SettingsRepository } from './settings.js';
import { AccountSettingsRepository } from './account-settings.js';
import { accountContext } from '../security/account-context.js';
import { AccountAuth } from '../security/account-auth.js';
import { ChangeEventRepository } from './events.js';

const identity = { id: 'admin', username: 'admin', role: 'admin' as const };
describe('account settings persistence and events', () => {
  let directory: string, db: DatabaseClient;
  afterEach(async () => { db?.sqlite.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function setup() {
    directory = await mkdtemp(join(tmpdir(), 'imagine-setting-events-')); db = createDatabase(join(directory, 'app.db'));
    await AccountAuth.initialize(db.sqlite, 'fixture-secret', 'admin', 'admin');
    const global = new SettingsRepository(db.orm);
    return { settings: new AccountSettingsRepository(db.orm, db.sqlite, global), events: new ChangeEventRepository(db.orm) };
  }
  it('stores a long editor key and emits one event with names only for a mixed patch', async () => {
    const { settings, events } = await setup();
    const key = 'generation.edit.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222';
    accountContext.run(identity, () => settings.upsertMany({ [key]: { image: { selected: 'private-model' } }, 'gallery.initial_filter': 'video', 'network.allow_http_content': false }));
    const changes = events.listAfter(0, 100);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ type: 'settings.updated', entityId: 'admin', keys: [key, 'gallery.initial_filter'] });
    expect(JSON.stringify(changes)).not.toContain('private-model');
    expect(accountContext.run(identity, () => settings.get(key)?.value)).toEqual({ image: { selected: 'private-model' } });
    // An unrelated malformed row must not force a single-key lookup to parse it.
    db.sqlite.prepare('INSERT INTO account_settings VALUES (?,?,?,?)').run('admin', 'malformed.fixture', '{', Date.now());
    expect(accountContext.run(identity, () => settings.get(key)?.value)).toEqual({ image: { selected: 'private-model' } });
  });
  it('rolls back account/global values and events together', async () => {
    const { settings, events } = await setup();
    db.sqlite.exec("CREATE TRIGGER reject_review_setting BEFORE INSERT ON account_settings WHEN NEW.key = 'reject.fixture' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(() => accountContext.run(identity, () => settings.upsertMany({ 'network.allow_http_content': false, 'first.fixture': true, 'reject.fixture': true }))).toThrow();
    expect(accountContext.run(identity, () => settings.get('first.fixture'))).toBeNull();
    expect(accountContext.run(identity, () => settings.get('network.allow_http_content')?.value)).toBe(true);
    expect(events.listAfter(0, 100)).toEqual([]);
  });
});
