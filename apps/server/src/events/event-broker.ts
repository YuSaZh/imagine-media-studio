import type { InternalEvent } from '@imagine/shared';

export type StoredChangeEvent = InternalEvent;

export interface ChangeEventStore {
  latestId(): number;
  listAfter(id: number, limit: number): readonly StoredChangeEvent[];
}

export type EventListener = (event: StoredChangeEvent) => void;

export class EventBroker {
  private readonly listeners = new Set<EventListener>();

  public publish(event: StoredChangeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}
