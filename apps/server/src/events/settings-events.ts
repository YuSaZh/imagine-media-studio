import type { InternalEvent } from '@imagine/shared';
import type { StoredChangeEvent } from './event-broker.js';

/** One durable mixed-scope write is projected to the keys each recipient can see. */
export function settingsEventForAccount(event: StoredChangeEvent, accountId: string): InternalEvent | false {
  const { globalSettingKeys = [], ...publicEvent } = event;
  const own = event.entityId === accountId || event.entityId === 'global';
  const keys = own ? [...(event.keys ?? []), ...globalSettingKeys] : [...globalSettingKeys];
  return keys.length ? { ...publicEvent, entityId: own ? event.entityId : 'global', keys } : false;
}
