import type { InternalEvent } from '@imagine/shared';

import type { ChangeEventStore, EventBroker } from './event-broker.js';

const DEFAULT_BATCH_SIZE = 500;

/**
 * Publishes committed outbox rows exactly once per process and in database ID order.
 * Historical rows are left for SSE replay; live publication starts at construction.
 */
export class OutboxPublisher {
  private cursor: number;

  public constructor(
    private readonly store: ChangeEventStore,
    private readonly broker: Pick<EventBroker, 'publish'>,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new RangeError('Outbox batch size must be between 1 and 1000.');
    }
    this.cursor = store.latestId();
  }

  public flush(): void {
    for (;;) {
      const events = this.store.listAfter(this.cursor, this.batchSize);
      if (events.length === 0) return;
      for (const event of events) this.publishOne(event);
    }
  }

  /** RunnerEventPort-compatible after-commit notification. */
  public publish(_event?: unknown): void {
    this.flush();
  }

  public get lastPublishedId(): number {
    return this.cursor;
  }

  private publishOne(event: InternalEvent): void {
    if (event.id <= this.cursor) return;
    this.broker.publish(event);
    this.cursor = event.id;
  }
}
