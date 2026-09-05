import type Database from 'better-sqlite3';
import type { AppDatabase } from './client.js';
import { SettingsRepository, type SettingRecord } from './settings.js';
import { accountContext, requestOwner } from '../security/account-context.js';

export class AccountSettingsRepository extends SettingsRepository {
  constructor(database: AppDatabase, private readonly sqlite: Database.Database, private readonly global: SettingsRepository, private readonly initialUrl = '') { super(database); }
  public publicBaseUrl(): string { return String(this.global.get('public_base_url')?.value ?? this.initialUrl); }
  public override list(): SettingRecord[] {
    const rows = this.sqlite.prepare('SELECT key,value_json,updated_at FROM account_settings WHERE owner_id=? ORDER BY key').all(requestOwner()) as { key: string; value_json: string; updated_at: number }[];
    return [...rows.filter(row => row.key !== 'public_base_url').map(row => ({ key: row.key, value: JSON.parse(row.value_json) as unknown, updatedAt: new Date(row.updated_at) })), { key: 'public_base_url', value: this.publicBaseUrl(), updatedAt: new Date() }];
  }
  public override get(key: string): SettingRecord | null { return this.list().find(row => row.key === key) ?? null; }
  public override upsertMany(values: Readonly<Record<string, unknown>>): readonly SettingRecord[] {
    if ('public_base_url' in values) {
      if (accountContext.getStore()?.role !== 'admin') throw Object.assign(new Error('Administrator required'), { statusCode: 403 });
      const value = values.public_base_url;
      let valid = typeof value === 'string' && value === '';
      if (typeof value === 'string' && value !== '') {
        try { const url = new URL(value); valid = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'; } catch { valid = false; }
      }
      if (!valid) throw Object.assign(new Error('公网地址必须是 HTTPS 域名地址'), { statusCode: 400 });
    }
    this.sqlite.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (key === 'public_base_url') { this.global.upsertMany({ [key]: value }); continue; }
        this.sqlite.prepare('INSERT INTO account_settings(owner_id,key,value_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at').run(requestOwner(), key, JSON.stringify(value), Date.now());
      }
    })();
    return this.list();
  }
}
