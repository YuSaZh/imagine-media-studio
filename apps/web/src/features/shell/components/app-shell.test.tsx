import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Tooltip from '@radix-ui/react-tooltip';

const registerSwMock = vi.hoisted(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({ registerSW: registerSwMock }));

import {
  getPwaNoticeKind,
  getPwaNoticeTitle,
  isPwaNoticeInteractive,
  OFFLINE_READY_NOTICE_DURATION_MS,
  PwaNotice,
} from './app-shell.js';

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

  it('renders offline readiness as a short-lived passive live notice without actions', () => {
    const markup = renderToStaticMarkup(
      <PwaNotice
        kind="offline-ready"
        error={null}
        updating={false}
        onActivate={vi.fn()}
        onDefer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(OFFLINE_READY_NOTICE_DURATION_MS).toBeGreaterThanOrEqual(3000);
    expect(isPwaNoticeInteractive('offline-ready')).toBe(false);
    expect(markup).toContain('toast-notice--passive');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('toast-actions');
    expect(markup).not.toContain('<button');
  });

  it('keeps update notices interactive with explicit update and dismiss actions', () => {
    const markup = renderToStaticMarkup(
      <Tooltip.Provider>
        <PwaNotice
          kind="update-error"
          error="The update could not be applied."
          updating={false}
          onActivate={vi.fn()}
          onDefer={vi.fn()}
          onDismiss={vi.fn()}
        />
      </Tooltip.Provider>,
    );

    expect(isPwaNoticeInteractive('update-error')).toBe(true);
    expect(markup).toContain('toast-notice--interactive');
    expect(markup).toContain('toast-actions');
    expect(markup).toContain('Retry update');
    expect(markup).toContain('Later');
    expect(markup).toContain('aria-label="Dismiss"');
  });
});
