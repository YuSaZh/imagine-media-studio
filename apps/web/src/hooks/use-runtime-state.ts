import { useSyncExternalStore } from 'react';

import {
  isNetworkAvailable,
  markBrowserOffline,
  markNetworkAvailable,
  subscribeToNetworkState,
} from '../pwa-offline-snapshot.js';

export interface RuntimeNavigatorLike {
  readonly maxTouchPoints?: number;
  readonly platform?: string;
  readonly standalone?: boolean;
  readonly userAgent?: string;
}

export interface RuntimeWindowLike {
  matchMedia(query: string): Pick<MediaQueryList, 'matches'>;
}

export function isIosDevice(
  navigatorLike: RuntimeNavigatorLike | null | undefined =
    typeof navigator === 'undefined' ? null : navigator,
): boolean {
  if (!navigatorLike) return false;
  const userAgent = navigatorLike.userAgent ?? '';
  const platform = navigatorLike.platform ?? '';
  return /iPad|iPhone|iPod/u.test(userAgent) ||
    (platform === 'MacIntel' && (navigatorLike.maxTouchPoints ?? 0) > 1);
}

export function isIosSafari(
  navigatorLike: RuntimeNavigatorLike | null | undefined =
    typeof navigator === 'undefined' ? null : navigator,
): boolean {
  if (!isIosDevice(navigatorLike)) return false;
  const userAgent = navigatorLike?.userAgent ?? '';
  if (!userAgent) return true;
  return /Safari\//u.test(userAgent) &&
    !/(CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo)/u.test(userAgent);
}

export function isStandaloneDisplayMode(
  windowLike: RuntimeWindowLike | null | undefined =
    typeof window === 'undefined' ? null : window,
  navigatorLike: RuntimeNavigatorLike | null | undefined =
    typeof navigator === 'undefined' ? null : navigator,
): boolean {
  return Boolean(
    windowLike?.matchMedia('(display-mode: standalone)').matches ||
      navigatorLike?.standalone,
  );
}

function subscribeOnline(listener: () => void): () => void {
  const unsubscribeRuntime = subscribeToNetworkState(listener);
  if (typeof window === 'undefined') return unsubscribeRuntime;
  const handleOnline = () => {
    markNetworkAvailable();
    listener();
  };
  const handleOffline = () => {
    markBrowserOffline();
    listener();
  };
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    unsubscribeRuntime();
  };
}

function getOnlineSnapshot(): boolean {
  return isNetworkAvailable();
}

function getOnlineServerSnapshot(): boolean {
  return true;
}

function subscribeStandalone(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const mediaQuery = window.matchMedia('(display-mode: standalone)');
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }
  mediaQuery.addListener(listener);
  return () => mediaQuery.removeListener(listener);
}

function getStandaloneSnapshot(): boolean {
  return isStandaloneDisplayMode();
}

function getStandaloneServerSnapshot(): boolean {
  return false;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineServerSnapshot);
}

export function useStandaloneMode(): boolean {
  return useSyncExternalStore(subscribeStandalone, getStandaloneSnapshot, getStandaloneServerSnapshot);
}
