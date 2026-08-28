import { describe, expect, it, vi } from 'vitest';

const registerSwMock = vi.hoisted(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({ registerSW: registerSwMock }));

import { getPwaNoticeKind, getPwaNoticeTitle } from './app-shell.js';

describe('app shell PWA notices', () => {
  it('keeps registration errors visible while honoring update notification settings', () => {
    expect(getPwaNoticeKind({ error: 'registration failed', offlineReady: false, updateAvailable: false }, false))
      .toBe('registration-error');
    expect(getPwaNoticeKind({ error: null, offlineReady: false, updateAvailable: true }, false))
      .toBeNull();
    expect(getPwaNoticeKind({ error: null, offlineReady: false, updateAvailable: true }, true))
      .toBe('update');
    expect(getPwaNoticeKind({ error: 'reload failed', offlineReady: false, updateAvailable: true }, false))
      .toBe('update-error');
    expect(getPwaNoticeKind({ error: 'prompt failed', errorKind: 'install', offlineReady: false, updateAvailable: false }, true))
      .toBe('install-error');
    expect(getPwaNoticeKind({ error: 'registration failed', errorKind: 'registration', offlineReady: false, updateAvailable: true }, true))
      .toBe('registration-error');
  });

  it('only reports offline readiness after service-worker confirmation', () => {
    expect(getPwaNoticeKind({ error: null, offlineReady: false, updateAvailable: false }, true))
      .toBeNull();
    expect(getPwaNoticeKind({ error: null, offlineReady: true, updateAvailable: false }, true))
      .toBe('offline-ready');
    expect(getPwaNoticeKind({ error: null, offlineReady: true, offlineReadyNoticeDismissed: true, updateAvailable: false }, true))
      .toBeNull();
    expect(getPwaNoticeKind({ error: null, offlineReady: false, updateAvailable: true, updateNoticeDismissed: true }, true))
      .toBeNull();
  });

  it('uses operation-specific titles for visible failures', () => {
    expect(getPwaNoticeTitle('registration-error')).toBe('Offline access unavailable');
    expect(getPwaNoticeTitle('install-error')).toBe('Installation unavailable');
    expect(getPwaNoticeTitle('update-error')).toBe('Update unavailable');
  });
});
