import { useEffect, useSyncExternalStore } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Bookmark,
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
import {
  activatePwaUpdate,
  dismissPwaNotice,
  getPwaState,
  subscribeToPwaState,
} from '../../../pwa-registration';
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
  const pwaState = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const showPwaNotice = pwaState.updateAvailable || pwaState.offlineReady || pwaState.error;
  const clearAssetSelection = useUiStore((state) => state.clearAssetSelection);
  const closeViewer = useUiStore((state) => state.closeViewer);
  const setComposerParamsOpen = useUiStore((state) => state.setComposerParamsOpen);
  const composerParamsOpen = useUiStore((state) => state.composerParamsOpen);
  const pwaAnnouncement = pwaState.error
    ? pwaState.error
    : pwaState.updating
      ? 'Applying the application update.'
      : pwaState.updateAvailable
        ? 'An application update is available.'
        : pwaState.offlineReady
          ? 'Offline access is ready.'
          : '';

  useEffect(() => {
    clearAssetSelection();
    closeViewer();
    setComposerParamsOpen(false);
  }, [clearAssetSelection, closeViewer, pathname, setComposerParamsOpen]);

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

      <main className="shell-content">
        <span className="sr-only" role="status" aria-live="polite">
          {pwaAnnouncement}
        </span>
        <Outlet context={{ isOnline, isStandalone }} />
      </main>

      {showPwaNotice && !composerParamsOpen && (
        <aside className="toast-notice" aria-labelledby="pwa-notice-title">
          <div className="toast-copy">
            <strong id="pwa-notice-title">
              {pwaState.error
                ? 'Update unavailable'
                : pwaState.updateAvailable
                  ? 'Update available'
                  : 'Offline ready'}
            </strong>
            <span>
              {pwaState.error ??
                (pwaState.updateAvailable
                  ? 'Reload when you are ready.'
                  : 'The workspace can open without a connection.')}
            </span>
          </div>
          <div className="toast-actions">
            {pwaState.updateAvailable && (
              <IconButton
                disabled={pwaState.updating}
                icon={<RefreshCw size={17} />}
                label={pwaState.updating ? 'Updating' : 'Update now'}
                onClick={() => void activatePwaUpdate()}
                tone="primary"
              />
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
