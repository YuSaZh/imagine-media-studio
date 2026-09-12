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
  if (event.type === 'settings.updated') {
    return [internalQueryKeys.settings, ...(event.keys?.includes('gallery.series_last_viewed') ? [[...internalQueryKeys.assets, 'workspace']] : [])];
  }
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
    return [internalQueryKeys.collections, internalQueryKeys.assets, internalQueryKeys.jobs, internalQueryKeys.gallery];
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
  const pendingKeys = new Map<string, QueryKey>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false, closed = false;
  const scheduleRefresh = () => {
    if (closed || refreshing || timer !== undefined || !pendingKeys.size || queryClient.isMutating({ mutationKey: internalQueryKeys.settings }) > 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || queryClient.isMutating({ mutationKey: internalQueryKeys.settings }) > 0) return;
      const keys = [...pendingKeys.values()]; pendingKeys.clear();
      refreshing = true;
      // Replay bursts share each in-flight query. Events arriving during the
      // fetch stay queued for one trailing refresh, so newer state is not lost.
      void Promise.all(keys.map(queryKey => queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false })))
        .catch(() => undefined).finally(() => { refreshing = false; scheduleRefresh(); });
    }, 100);
  };
  const invalidate = (queryKey: QueryKey) => {
    if (closed) return;
    pendingKeys.set(JSON.stringify(queryKey), queryKey);
    scheduleRefresh();
  };
  const deferredKeys = new Map<string, QueryKey>();
  const unsubscribeMutations = queryClient.getMutationCache().subscribe(() => {
    if (queryClient.isMutating({ mutationKey: internalQueryKeys.settings }) > 0) return;
    const keys = [...deferredKeys.values()]; deferredKeys.clear();
    for (const key of keys) invalidate(key);
    scheduleRefresh();
  });
  const handleMessage = (message: MessageEvent<string>) => {
    let payload: unknown;
    try {
      payload = JSON.parse(message.data) as unknown;
    } catch {
      return;
    }
    const parsed = InternalEventSchema.safeParse(payload);
    if (!parsed.success) return;
    for (const queryKey of queryKeysForEvent(parsed.data)) {
      if (parsed.data.type === 'settings.updated' && queryClient.isMutating({ mutationKey: internalQueryKeys.settings }) > 0) {
        deferredKeys.set(JSON.stringify(queryKey), queryKey);
      } else invalidate(queryKey);
    }
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
    closed = true; clearTimeout(timer); pendingKeys.clear();
    source.close();
    unsubscribeMutations(); deferredKeys.clear();
    window.removeEventListener('online', refreshAll);
    document.removeEventListener('visibilitychange', handleVisibility);
  };
}
