import { describe, expect, it } from 'vitest';
import { InternalEventSchema } from '@imagine/shared';
import { formatSseEvent } from '../routes/events.js';
import { settingsEventForAccount } from './settings-events.js';
import type { StoredChangeEvent } from './event-broker.js';

describe('settings event visibility', () => {
  const event: StoredChangeEvent = { version: 1, id: 1, type: 'settings.updated', entityId: 'alice', revision: 0, occurredAt: '2026-09-10T00:00:00.000Z', keys: ['generation.private-project'], globalSettingKeys: ['network.allow_http_content'] };
  it('projects mixed changes for owners and other accounts without internal metadata', () => {
    const own = settingsEventForAccount(event, 'alice');
    const other = settingsEventForAccount(event, 'bob');
    expect(own).toMatchObject({ entityId: 'alice', keys: ['generation.private-project', 'network.allow_http_content'] });
    expect(other).toMatchObject({ entityId: 'global', keys: ['network.allow_http_content'] });
    expect(InternalEventSchema.safeParse(own).success).toBe(true);
    expect(InternalEventSchema.safeParse(other).success).toBe(true);
    expect(formatSseEvent(event)).not.toContain('globalSettingKeys');
    expect(settingsEventForAccount({ ...event, globalSettingKeys: [] }, 'bob')).toBe(false);
    expect(settingsEventForAccount({ ...event, entityId: 'global', keys: ['network.allow_http_content'], globalSettingKeys: [] }, 'bob')).toMatchObject({ keys: ['network.allow_http_content'] });
  });
});
