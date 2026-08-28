import { afterEach, describe, expect, it, vi } from 'vitest';

const registerSwMock = vi.hoisted(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({ registerSW: registerSwMock }));

import {
  activatePwaUpdate,
  deferPwaUpdate,
  dismissOfflineReadyNotice,
  dismissPwaNotice,
  getPwaState,
  promptPwaInstall,
  registerPwa,
  setPwaDraftFlushHook,
} from './pwa-registration.js';

function installWindowTarget(): EventTarget {
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: target,
  });
  return target;
}

afterEach(() => {
  vi.restoreAllMocks();
  registerSwMock.mockReset();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined,
  });
});

describe('PWA registration state', () => {
  it('tracks install prompts, update deferral, and draft-safe update retries', async () => {
    const windowTarget = installWindowTarget();
    const callbacks: {
      onNeedRefresh: (() => void) | undefined;
      onOfflineReady: (() => void) | undefined;
      onRegisterError: ((error: unknown) => void) | undefined;
    } = { onNeedRefresh: undefined, onOfflineReady: undefined, onRegisterError: undefined };
    const update = vi.fn<((reloadPage?: boolean) => Promise<void>)>().mockResolvedValue(undefined);
    registerSwMock.mockImplementation((options: typeof callbacks) => {
      callbacks.onNeedRefresh = options.onNeedRefresh;
      callbacks.onOfflineReady = options.onOfflineReady;
      callbacks.onRegisterError = options.onRegisterError;
      return update;
    });
    registerPwa();

    callbacks.onOfflineReady?.();
    expect(getPwaState()).toMatchObject({ offlineReady: true });
    dismissOfflineReadyNotice();
    expect(getPwaState()).toMatchObject({
      offlineReady: true,
      offlineReadyNoticeDismissed: true,
      updateNoticeDismissed: false,
    });
    callbacks.onOfflineReady?.();
    expect(getPwaState()).toMatchObject({ offlineReady: true, offlineReadyNoticeDismissed: false });

    const failedPrompt = {
      platforms: ['web'],
      prompt: vi.fn().mockRejectedValue(new Error('not allowed')),
      userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
    };
    const failedInstallEvent = Object.assign(new Event('beforeinstallprompt'), {
      preventDefault: () => undefined,
      ...failedPrompt,
    });
    windowTarget.dispatchEvent(failedInstallEvent);
    await expect(promptPwaInstall()).resolves.toBeNull();
    expect(getPwaState()).toMatchObject({
      errorKind: 'install',
      installPromptAvailable: true,
      installPromptPending: false,
    });
    dismissPwaNotice();

    let prevented = false;
    const prompt = {
      platforms: ['web'],
      prompt: vi.fn().mockResolvedValue(undefined),
      userChoice: Promise.resolve({ outcome: 'accepted' as const, platform: 'web' }),
    };
    const installEvent = Object.assign(new Event('beforeinstallprompt'), {
      preventDefault: () => { prevented = true; },
      ...prompt,
    });
    windowTarget.dispatchEvent(installEvent);
    expect(prevented).toBe(true);
    expect(getPwaState()).toMatchObject({ installPromptAvailable: true });
    await expect(promptPwaInstall()).resolves.toBe('accepted');
    expect(prompt.prompt).toHaveBeenCalledOnce();
    expect(getPwaState()).toMatchObject({ installed: true, installPromptAvailable: false });

    callbacks.onNeedRefresh?.();
    expect(getPwaState()).toMatchObject({ updateAvailable: true, updateNoticeDismissed: false });
    deferPwaUpdate();
    expect(getPwaState()).toMatchObject({ updateAvailable: true, updateNoticeDismissed: true, offlineReady: true });
    callbacks.onNeedRefresh?.();
    expect(getPwaState()).toMatchObject({ updateAvailable: true, updateNoticeDismissed: false });

    const order: string[] = [];
    const disposeFlushHook = setPwaDraftFlushHook(async () => {
      order.push('flush');
    });
    await activatePwaUpdate();
    order.push('after');
    expect(order).toEqual(['flush', 'after']);
    expect(update).toHaveBeenCalledWith(true);
    expect(getPwaState()).toMatchObject({ updateAvailable: false, updating: false });
    disposeFlushHook();
  });

  it('keeps update state retryable when flushing or reloading fails', async () => {
    installWindowTarget();
    const callbacks: {
      onNeedRefresh: (() => void) | undefined;
      onRegisterError: ((error: unknown) => void) | undefined;
    } = {
      onNeedRefresh: undefined,
      onRegisterError: undefined,
    };
    const update = vi.fn<((reloadPage?: boolean) => Promise<void>)>().mockRejectedValue(new Error('offline'));
    registerSwMock.mockImplementation((options: typeof callbacks) => {
      callbacks.onNeedRefresh = options.onNeedRefresh;
      callbacks.onRegisterError = options.onRegisterError;
      return update;
    });
    registerPwa();
    callbacks.onRegisterError?.(new Error('registration failed'));
    expect(getPwaState()).toMatchObject({ errorKind: 'registration', updateAvailable: false });
    callbacks.onNeedRefresh?.();
    const flushError = setPwaDraftFlushHook(() => Promise.reject(new Error('draft')));
    await activatePwaUpdate();
    expect(update).not.toHaveBeenCalled();
    expect(getPwaState()).toMatchObject({ errorKind: 'update', updateAvailable: true, updating: false });
    flushError();

    await activatePwaUpdate();
    expect(update).toHaveBeenCalledWith(true);
    expect(getPwaState()).toMatchObject({ updateAvailable: true, updating: false });
  });
});
