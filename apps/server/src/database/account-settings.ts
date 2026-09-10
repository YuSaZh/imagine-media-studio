import type Database from 'better-sqlite3';
import type { AppDatabase } from './client.js';
import { SettingsRepository, type SettingRecord } from './settings.js';
import { accountContext, requestOwner } from '../security/account-context.js';

export class AccountSettingsRepository extends SettingsRepository {
  constructor(database: AppDatabase, private readonly sqlite: Database.Database, private readonly global: SettingsRepository, private readonly initialUrl = '') { super(database); }
  public publicBaseUrl(): string { return String(this.global.get('public_base_url')?.value ?? this.initialUrl); }
  public override list(): SettingRecord[] {
    const rows = this.sqlite.prepare('SELECT key,value_json,updated_at FROM account_settings WHERE owner_id=? ORDER BY key').all(requestOwner()) as { key: string; value_json: string; updated_at: number }[];
    return [...rows.filter(row => row.key !== 'public_base_url' && row.key !== 'network.allow_http_content').map(row => ({ key: row.key, value: JSON.parse(row.value_json) as unknown, updatedAt: new Date(row.updated_at) })), { key: 'public_base_url', value: this.publicBaseUrl(), updatedAt: new Date() }, { key: 'network.allow_http_content', value: this.global.get('network.allow_http_content')?.value ?? true, updatedAt: new Date() }];
  }
  public override get(key: string): SettingRecord | null {
    if (key === 'public_base_url') return this.global.get(key) ?? { key, value: this.initialUrl, updatedAt: new Date(0) };
    if (key === 'network.allow_http_content') return this.global.get(key) ?? { key, value: true, updatedAt: new Date(0) };
    const row = this.sqlite.prepare('SELECT value_json,updated_at FROM account_settings WHERE owner_id=? AND key=?').get(requestOwner(), key) as { value_json: string; updated_at: number } | undefined;
    return row ? { key, value: JSON.parse(row.value_json) as unknown, updatedAt: new Date(row.updated_at) } : null;
  }
  public override upsertMany(values: Readonly<Record<string, unknown>>): readonly SettingRecord[] {
    if ('network.allow_http_content' in values && accountContext.getStore()?.role !== 'admin') {
      throw Object.assign(new Error('Administrator required'), { statusCode: 403 });
    }
    if ('public_base_url' in values) {
      if (accountContext.getStore()?.role !== 'admin') throw Object.assign(new Error('Administrator required'), { statusCode: 403 });
      const value = values.public_base_url;
      let valid = typeof value === 'string' && value === '';
      if (typeof value === 'string' && value !== '') {
        try { const url = new URL(value); valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; } catch { valid = false; }
      }
      if (!valid) throw Object.assign(new Error('公网地址必须是 HTTPS 域名地址'), { statusCode: 400 });
    }
    const globalKeys: string[] = Object.keys(values).filter(key => key === 'public_base_url' || key === 'network.allow_http_content');
    const keys = Object.keys(values).filter(key => !globalKeys.includes(key));
    this.sqlite.transaction(() => {
      const now = Date.now();
      if (globalKeys.length) this.global.upsertMany(Object.fromEntries(globalKeys.map(key => [key, values[key]])), false);
      for (const key of keys) {
        this.sqlite.prepare('INSERT INTO account_settings(owner_id,key,value_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(requestOwner(), key, JSON.stringify(values[key]), now);
      }
      if (keys.length || globalKeys.length) this.sqlite.prepare('INSERT INTO change_events(aggregate_type,aggregate_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)').run(
        'setting', keys.length ? requestOwner() : 'global', 'settings.updated',
        JSON.stringify(keys.length ? { keys, globalKeys } : { keys: globalKeys }), now,
      );
    })();
    return this.list();
  }
}
