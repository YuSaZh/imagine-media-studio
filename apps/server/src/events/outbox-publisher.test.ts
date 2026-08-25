import type { InternalEvent } from '@imagine/shared';
import { describe, expect, it } from 'vitest';

import { EventBroker, type ChangeEventStore } from './event-broker.js';
import { OutboxPublisher } from './outbox-publisher.js';

function event(id: number, entityId = `entity-${id}`): InternalEvent {
  return {
    version: 1,
    id,
    type: 'asset.updated',
    entityId,
    revision: id,
    occurredAt: new Date(id * 1_000).toISOString(),
  };
}

class MemoryOutbox implements ChangeEventStore {
  public readonly events: InternalEvent[] = [];

  public latestId(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  public listAfter(id: number, limit: number): readonly InternalEvent[] {
    return this.events.filter((candidate) => candidate.id > id).slice(0, limit);
  }
}

describe('OutboxPublisher', () => {
  it('starts after historical rows and drains new rows once in ID order across batches', () => {
    const store = new MemoryOutbox();
    store.events.push(event(1));
    const broker = new EventBroker();
    const received: number[] = [];
    broker.subscribe((candidate) => received.push(candidate.id));
    const publisher = new OutboxPublisher(store, broker, 2);

    store.events.push(event(2), event(3), event(4));
    publisher.flush();
    publisher.flush();

    expect(received).toEqual([2, 3, 4]);
    expect(publisher.lastPublishedId).toBe(4);
  });
});
