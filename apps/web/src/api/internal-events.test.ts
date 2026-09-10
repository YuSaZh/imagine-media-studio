import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { subscribeToInternalEvents } from './internal-events.js';

class FakeEventSource {
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  public close = vi.fn();

  public addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  public emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installBrowserTargets(): void {
  const browserWindow = new EventTarget();
  const browserDocument = new EventTarget();
  Object.defineProperty(browserDocument, 'visibilityState', { value: 'visible' });
  vi.stubGlobal('window', browserWindow);
  vi.stubGlobal('document', browserDocument);
}

describe('subscribeToInternalEvents', () => {
  it('refreshes settings and only refreshes gallery data for recent-cover history', () => {
    installBrowserTargets();
    const client = new QueryClient(), source = new FakeEventSource();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const unsubscribe = subscribeToInternalEvents(client, () => source);
    const event = { version: 1, id: 1, type: 'settings.updated', entityId: 'admin', revision: 0, occurredAt: '2026-09-10T00:00:00.000Z', keys: ['composer.default_mode'] };
    source.emit(event);
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([['internal', 'settings']]);
    invalidate.mockClear();
    source.emit({ ...event, id: 2, keys: ['gallery.series_last_viewed'] });
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([['internal', 'settings'], ['internal', 'assets', 'workspace']]);
    unsubscribe();
  });

  it('invalidates only the authoritative query families affected by an event', async () => {
    installBrowserTargets();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const source = new FakeEventSource();
    const unsubscribe = subscribeToInternalEvents(queryClient, () => source);

    source.emit({
      version: 1,
      id: 4,
      type: 'asset.updated',
      entityId: 'asset-1',
      revision: 2,
      occurredAt: '2026-08-25T00:00:00.000Z',
    });

    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      ['internal', 'assets'],
      ['internal', 'jobs'],
      ['internal', 'collections'],
      ['internal', 'gallery'],
    ]);
    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('ignores malformed messages and refreshes all data when connectivity returns', () => {
    installBrowserTargets();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const source = new FakeEventSource();
    const unsubscribe = subscribeToInternalEvents(queryClient, () => source);

    source.emit({ type: 'asset.updated', secret: 'not-a-valid-event' });
    expect(invalidate).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['internal'] });

    unsubscribe();
  });
});

it('defers settings events until local optimistic writes finish', async () => {
  installBrowserTargets();
  const client = new QueryClient(), source = new FakeEventSource();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  const unsubscribe = subscribeToInternalEvents(client, () => source);
  let finish!: () => void;
  const mutation = client.getMutationCache().build(client, { mutationKey: ['internal', 'settings', 'live'], mutationFn: () => new Promise<void>(resolve => { finish = resolve; }) });
  const pending = mutation.execute(undefined);
  await expect.poll(() => typeof finish).toBe('function');
  const event = { version: 1, id: 1, type: 'settings.updated', entityId: 'admin', revision: 0, occurredAt: '2026-09-10T00:00:00.000Z', keys: ['gallery.series_last_viewed'] };
  source.emit(event); source.emit({ ...event, id: 2 });
  expect(invalidate).not.toHaveBeenCalled();
  finish(); await pending;
  expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([['internal', 'settings'], ['internal', 'assets', 'workspace']]);
  unsubscribe();
});
