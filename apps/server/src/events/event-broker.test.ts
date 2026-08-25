import { describe, expect, it, vi } from 'vitest';

import { EventBroker, type StoredChangeEvent } from './event-broker.js';

const event: StoredChangeEvent = {
  version: 1,
  id: 1,
  type: 'job.updated',
  entityId: 'job-1',
  revision: 2,
  occurredAt: '2026-08-25T00:00:00.000Z',
};

describe('EventBroker', () => {
  it('fans out committed events and releases disconnected listeners', () => {
    const broker = new EventBroker();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = broker.subscribe(first);
    broker.subscribe(second);

    broker.publish(event);
    unsubscribeFirst();
    broker.publish({ ...event, id: 2 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(broker.listenerCount).toBe(1);
  });
});
