import { describe, expect, it } from 'vitest';

import { formatSseEvent, parseLastEventId } from './events.js';

describe('SSE wire helpers', () => {
  it('formats ordered change events without additional entity data', () => {
    expect(
      formatSseEvent({
        version: 1,
        id: 7,
        type: 'job.updated',
        entityId: 'job-1',
        revision: 3,
        occurredAt: '2026-08-25T00:00:00.000Z',
      }),
    ).toBe(
      'id: 7\nevent: change\ndata: {"version":1,"id":7,"type":"job.updated","entityId":"job-1","revision":3,"occurredAt":"2026-08-25T00:00:00.000Z"}\n\n',
    );
  });

  it('accepts only non-negative safe Last-Event-ID values', () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId('0')).toBe(0);
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId('-1')).toBeNull();
    expect(parseLastEventId('1.5')).toBeNull();
    expect(parseLastEventId('9007199254740992')).toBeNull();
  });
});
