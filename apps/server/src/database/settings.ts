import { asc, eq } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { toChangeEventValues } from './events.js';
import { changeEvents, settings } from './schema.js';

export interface SettingRecord {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: Date;
}

function mapSetting(row: typeof settings.$inferSelect): SettingRecord {
  return {
    key: row.key,
    value: JSON.parse(row.valueJson) as unknown,
    updatedAt: row.updatedAt,
  };
}

export class SettingsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public list(): readonly SettingRecord[] {
    return this.database.select().from(settings).orderBy(asc(settings.key)).all().map(mapSetting);
  }

  public get(key: string): SettingRecord | null {
    const row = this.database.select().from(settings).where(eq(settings.key, key)).get();
    return row ? mapSetting(row) : null;
  }

  public upsertMany(values: Readonly<Record<string, unknown>>): readonly SettingRecord[] {
    const entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (key.length === 0 || value === undefined) {
        throw new TypeError('Setting keys must be non-empty and values cannot be undefined.');
      }
    }

    this.database.transaction((transaction) => {
      const updatedAt = new Date();
      for (const [key, value] of entries) {
        const valueJson = JSON.stringify(value);
        transaction
          .insert(settings)
          .values({ key, valueJson, updatedAt })
          .onConflictDoUpdate({
            target: settings.key,
            set: { valueJson, updatedAt },
          })
          .run();
        transaction
          .insert(changeEvents)
          .values(
            toChangeEventValues({
              aggregateType: 'setting',
              aggregateId: key,
              eventType: 'setting.updated',
              payload: { key },
              createdAt: updatedAt,
            }),
          )
          .run();
      }
    });

    return this.list();
  }
}
