import type { InternalEvent } from '@imagine/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ChangeEventStore, EventBroker } from '../events/event-broker.js';

const MAX_REPLAY_EVENTS = 500;
const HEARTBEAT_INTERVAL_MS = 20_000;

export function formatSseEvent(event: InternalEvent): string {
  return `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}

export function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return 0;
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

export async function registerEventRoutes(
  app: FastifyInstance,
  store: ChangeEventStore,
  broker: EventBroker,
  visible?: (request: FastifyRequest, event: InternalEvent) => boolean,
): Promise<void> {
  app.get('/internal/events', (request, reply) => {
    const rawLastEventId = request.headers['last-event-id'];
    const lastEventId = parseLastEventId(
      Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId,
    );
    if (lastEventId === null) {
      return reply.code(400).send({
        error: 'invalid_last_event_id',
        message: 'Last-Event-ID must be a non-negative safe integer.',
      });
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n\n');

    let closed = false;
    let replaying = true;
    let highestWrittenId = lastEventId;
    const pendingLiveEvents: InternalEvent[] = [];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    const writeEvent = (event: InternalEvent) => {
      if (closed || event.id <= highestWrittenId) return;
      highestWrittenId = event.id;
      if (visible && !visible(request, event)) return;
      if (!response.write(formatSseEvent(event))) {
        cleanup();
        response.end();
      }
    };
    const unsubscribe = broker.subscribe((event) => {
      if (replaying) pendingLiveEvents.push(event);
      else writeEvent(event);
    });
    const heartbeat = setInterval(() => {
      if (!closed && !response.write(': heartbeat\n\n')) {
        cleanup();
        response.end();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    const replay = store.listAfter(lastEventId, MAX_REPLAY_EVENTS + 1);
    if (replay.length > MAX_REPLAY_EVENTS) {
      const latestId = store.latestId();
      if (latestId > 0) {
        writeEvent({
          version: 1,
          id: latestId,
          type: 'reset',
          entityId: 'all',
          revision: 0,
          occurredAt: new Date().toISOString(),
        });
      }
    } else {
      for (const event of replay) writeEvent(event);
    }
    replaying = false;
    for (const event of pendingLiveEvents.sort((left, right) => left.id - right.id)) {
      writeEvent(event);
    }

    request.raw.once('close', cleanup);
    response.once('close', cleanup);
    response.once('error', cleanup);
  });
}
