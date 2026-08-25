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
