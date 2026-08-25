import type { InternalEvent } from '@imagine/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { EventBroker, type ChangeEventStore } from '../events/event-broker.js';
import { OutboxPublisher } from '../events/outbox-publisher.js';
import { formatSseEvent, parseLastEventId, registerEventRoutes } from './events.js';

class MutableEventStore implements ChangeEventStore {
  public readonly events: InternalEvent[] = [];

  public latestId(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  public listAfter(id: number, limit: number): readonly InternalEvent[] {
    return this.events.filter((event) => event.id > id).slice(0, limit);
  }
}

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

  it('streams an outbox event committed after the Fastify SSE connection is online', async () => {
    const app = Fastify({ logger: false });
    const store = new MutableEventStore();
    const broker = new EventBroker();
    const outbox = new OutboxPublisher(store, broker);
    await registerEventRoutes(app, store, broker);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for a live SSE event.')), 2_000);
      app.inject(
        {
          method: 'GET',
          url: '/internal/events',
          headers: { 'last-event-id': '0' },
          payloadAsStream: true,
        },
        (error, response) => {
          if (error || !response) {
            clearTimeout(timeout);
            reject(error ?? new Error('SSE injection did not return a response.'));
            return;
          }
          let payload = '';
          response.stream().on('data', (chunk: Buffer) => {
            payload += chunk.toString('utf8');
            if (!payload.includes('"entityId":"asset-live"')) return;
            try {
              expect(payload.match(/"entityId":"asset-live"/g)).toHaveLength(1);
              response.raw.res.end();
              clearTimeout(timeout);
              resolve();
            } catch (assertionError) {
              clearTimeout(timeout);
              reject(assertionError);
            }
          });

          store.events.push({
            version: 1,
            id: 1,
            type: 'asset.created',
            entityId: 'asset-live',
            revision: 0,
            occurredAt: '2026-08-25T00:00:00.000Z',
          });
          outbox.flush();
          outbox.flush();
        },
      );
    });

    await app.close();
  });
});
