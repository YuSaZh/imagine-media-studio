import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bookmark,
  Clock3,
  FolderClosed,
  ListTodo,
  RefreshCw,
  Settings,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { IconButton } from '../../../components/icon-button';
import { useOnlineStatus, useStandaloneMode } from '../../../hooks/use-runtime-state';
import { useUiStore } from '../../../stores/ui-store';
import { isVisualFixtureMode } from '../../../visual-fixture';
import { readPwaSettings, useSettingsQuery } from '../../settings/api/settings-query';
import {
  activatePwaUpdate,
  deferPwaUpdate,
  dismissPwaNotice,
  getPwaState,
  subscribeToPwaState,
} from '../../../pwa-registration';
import type { PwaRegistrationState } from '../../../pwa-registration';
import { MobileMenu, type MobileNavigationItem } from './mobile-menu';

type NavigationItem = MobileNavigationItem;

const primaryNavigation: NavigationItem[] = [
  { icon: <Sparkles size={19} />, label: 'Imagine', to: '/imagine' },
  { icon: <Bookmark size={19} />, label: 'Saved', to: '/saved' },
  { icon: <FolderClosed size={19} />, label: 'Folders', to: '/folders/folder-editorial' },
  { icon: <ListTodo size={19} />, label: 'Jobs', to: '/jobs' },
];

const mobileNavigation: NavigationItem[] = [
  ...primaryNavigation,
  { icon: <Settings size={19} />, label: 'Settings', to: '/settings' },
];

export type PwaNoticeKind =
  | 'offline-ready'
  | 'registration-error'
  | 'install-error'
  | 'update'
  | 'update-error';

type PwaNoticeState = Pick<PwaRegistrationState, 'error' | 'offlineReady' | 'updateAvailable'> &
  Partial<
    Pick<
      PwaRegistrationState,
      'errorKind' | 'offlineReadyNoticeDismissed' | 'updateNoticeDismissed'
    >
  >;

export function getPwaNoticeKind(
  state: PwaNoticeState,
  updateNotifications: boolean,
): PwaNoticeKind | null {
  if (state.error) {
    if (state.errorKind === 'install') return 'install-error';
    if (state.errorKind === 'update' || (!state.errorKind && state.updateAvailable)) {
      return 'update-error';
    }
    return 'registration-error';
  }
  if (state.updateAvailable && !state.updateNoticeDismissed && updateNotifications) return 'update';
  if (state.offlineReady && !state.offlineReadyNoticeDismissed) return 'offline-ready';
  return null;
}

export function getPwaNoticeTitle(kind: PwaNoticeKind): string {
  switch (kind) {
    case 'offline-ready':
      return 'Offline ready';
    case 'registration-error':
      return 'Offline access unavailable';
    case 'install-error':
      return 'Installation unavailable';
    case 'update':
      return 'Update available';
    case 'update-error':
      return 'Update unavailable';
  }
}

function ShellLink({ icon, label, to }: NavigationItem) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <NavLink
          aria-label={label}
          className={({ isActive }) => `rail-link ${isActive ? 'is-active' : ''}`}
          to={to}
        >
          {icon}
        </NavLink>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" side="right" sideOffset={9}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const isOnline = useOnlineStatus();
  const isStandalone = useStandaloneMode();
  const queryClient = useQueryClient();
  const fixtureMode = isVisualFixtureMode();
  const settingsQuery = useSettingsQuery(fixtureMode);
  const updateNotifications = readPwaSettings(settingsQuery.data?.settings).updateNotifications;
  const pwaState = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const pwaNoticeKind = getPwaNoticeKind(pwaState, updateNotifications);
  const updateNoticeVisible = pwaNoticeKind === 'update' || pwaNoticeKind === 'update-error';
  const showPwaNotice = pwaNoticeKind !== null;
  const previousOnline = useRef(isOnline);
  const [networkNotice, setNetworkNotice] = useState<'restored' | null>(null);
  const clearAssetSelection = useUiStore((state) => state.clearAssetSelection);
  const closeViewer = useUiStore((state) => state.closeViewer);
  const setComposerParamsOpen = useUiStore((state) => state.setComposerParamsOpen);
  const composerParamsOpen = useUiStore((state) => state.composerParamsOpen);
  const pwaAnnouncement = !isOnline
    ? 'Offline. Cached workspace remains available and generation is paused.'
    : networkNotice === 'restored'
      ? 'Back online. Refreshing the workspace.'
      : pwaState.error
        ? pwaState.error
        : pwaState.updating
          ? 'Applying the application update.'
          : pwaNoticeKind === 'update'
            ? 'An application update is available.'
            : pwaNoticeKind === 'offline-ready'
              ? 'Offline access is ready.'
              : '';

  useEffect(() => {
    clearAssetSelection();
    closeViewer();
    setComposerParamsOpen(false);
  }, [clearAssetSelection, closeViewer, pathname, setComposerParamsOpen]);

  useEffect(() => {
    if (!isOnline) {
      previousOnline.current = false;
      setNetworkNotice(null);
      return;
    }
    if (!previousOnline.current) {
      setNetworkNotice('restored');
      void queryClient.invalidateQueries();
      const timeout = window.setTimeout(() => setNetworkNotice(null), 4200);
      previousOnline.current = true;
      return () => window.clearTimeout(timeout);
    }
    previousOnline.current = true;
    return undefined;
  }, [isOnline, queryClient]);

  return (
    <div className="app-shell">
      <aside className="navigation-rail">
        <NavLink className="brand-mark" to="/imagine" aria-label="Imagine Media Studio">
          <span aria-hidden="true">IM</span>
        </NavLink>
        <nav className="rail-navigation" aria-label="Primary navigation">
          {primaryNavigation.map((item) => (
            <ShellLink key={item.to} {...item} />
          ))}
        </nav>
        <div className="rail-footer">
          <span
            className={`network-indicator ${isOnline ? 'is-online' : 'is-offline'}`}
            aria-label={isOnline ? 'Online' : 'Offline'}
            role="status"
          />
          <ShellLink icon={<Settings size={19} />} label="Settings" to="/settings" />
        </div>
      </aside>

      <header className="mobile-header">
        <NavLink className="mobile-brand" to="/imagine">
          <span className="brand-mark" aria-hidden="true">IM</span>
          <span>Imagine</span>
        </NavLink>
        <div className="mobile-header-actions">
          {!isOnline && <WifiOff aria-label="Offline" size={18} />}
          <NavLink aria-label="Saved" className="mobile-header-link" to="/saved">
            <Bookmark size={19} />
          </NavLink>
          <MobileMenu isOnline={isOnline} items={mobileNavigation} />
        </div>
      </header>

      {!isOnline && (
        <div className="network-banner network-banner--offline" role="status" aria-live="polite">
          <WifiOff aria-hidden="true" size={16} />
          <div>
            <strong>Offline</strong>
            <span>Cached workspace available. Generation is paused.</span>
          </div>
        </div>
      )}
      {isOnline && networkNotice === 'restored' && (
        <div className="network-banner network-banner--online" role="status" aria-live="polite">
          <span className="network-banner-dot" aria-hidden="true" />
          <div>
            <strong>Back online</strong>
            <span>Workspace status is refreshing.</span>
          </div>
        </div>
      )}

      <main className="shell-content">
        <span className="sr-only" role="status" aria-live="polite">
          {pwaAnnouncement}
        </span>
        <Outlet context={{ isOnline, isStandalone }} />
      </main>

      {showPwaNotice && !composerParamsOpen && (
        <aside className="toast-notice" aria-labelledby="pwa-notice-title" role="status" aria-live="polite">
          <div className="toast-copy">
            <strong id="pwa-notice-title">
              {pwaNoticeKind ? getPwaNoticeTitle(pwaNoticeKind) : ''}
            </strong>
            <span>
              {pwaState.error ??
                (updateNoticeVisible
                  ? 'Reload when you are ready.'
                  : pwaNoticeKind === 'install-error'
                    ? 'Try again from App settings.'
                    : 'The workspace can open without a connection.')}
            </span>
          </div>
          <div className="toast-actions">
            {updateNoticeVisible && (
              <>
                <button
                  className="toast-command toast-command--primary"
                  disabled={pwaState.updating}
                  onClick={() => void activatePwaUpdate()}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={16} />
                  <span>{pwaState.updating ? 'Updating' : 'Update'}</span>
                </button>
                <button
                  className="toast-command"
                  disabled={pwaState.updating}
                  onClick={deferPwaUpdate}
                  type="button"
                >
                  <Clock3 aria-hidden="true" size={16} />
                  <span>Later</span>
                </button>
              </>
            )}
            <IconButton
              icon={<X size={17} />}
              label="Dismiss"
              onClick={dismissPwaNotice}
            />
          </div>
        </aside>
      )}
    </div>
  );
}
