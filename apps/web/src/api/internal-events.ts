import { InternalEventSchema, type InternalEvent } from '@imagine/shared';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { internalQueryKeys } from './query-keys.js';

interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  onmessage: ((event: MessageEvent<string>) => void) | null;
}

type EventSourceFactory = (url: string) => EventSourceLike;

const defaultEventSourceFactory: EventSourceFactory = (url) => new EventSource(url);

function queryKeysForEvent(event: InternalEvent): readonly QueryKey[] {
  if (event.type.startsWith('job.')) {
    return [internalQueryKeys.jobs, internalQueryKeys.assets, internalQueryKeys.gallery];
  }
  if (event.type.startsWith('asset.')) {
    return [
      internalQueryKeys.assets,
      internalQueryKeys.jobs,
      internalQueryKeys.collections,
      internalQueryKeys.gallery,
    ];
  }
  if (event.type === 'collection.updated') {
    return [internalQueryKeys.collections, internalQueryKeys.assets, internalQueryKeys.gallery];
  }
  if (event.type === 'provider.updated') {
    return [internalQueryKeys.providers, internalQueryKeys.models];
  }
  if (event.type === 'model.updated') {
    return [internalQueryKeys.models];
  }
  return [internalQueryKeys.all];
}

export function subscribeToInternalEvents(
  queryClient: QueryClient,
  createEventSource: EventSourceFactory = defaultEventSourceFactory,
): () => void {
  const source = createEventSource('/internal/events');
  const invalidate = (queryKey: QueryKey) => {
    void queryClient.invalidateQueries({ queryKey });
  };
  const handleMessage = (message: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data) as unknown;
    } catch {
      return;
    }
    const parsed = InternalEventSchema.safeParse(payload);
    if (!parsed.success) return;
    for (const queryKey of queryKeysForEvent(parsed.data)) invalidate(queryKey);
  };
  source.onmessage = handleMessage;
  source.addEventListener('change', handleMessage);

  const refreshAll = () => invalidate(internalQueryKeys.all);
  const handleVisibility = () => {
    if (document.visibilityState === 'visible') refreshAll();
  };
  window.addEventListener('online', refreshAll);
  document.addEventListener('visibilitychange', handleVisibility);

  return () => {
    source.close();
    window.removeEventListener('online', refreshAll);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
