import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  activatePwaUpdate,
  dismissPwaNotice,
  getPwaState,
  subscribeToPwaState,
} from './pwa-registration';

function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const markOnline = () => setIsOnline(true);
    const markOffline = () => setIsOnline(false);

    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);

    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
    };
  }, []);

  return isOnline;
}

function useStandaloneMode(): boolean {
  const [isStandalone, setIsStandalone] = useState(() =>
    window.matchMedia('(display-mode: standalone)').matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const updateMode = () => setIsStandalone(mediaQuery.matches);

    mediaQuery.addEventListener('change', updateMode);
    return () => mediaQuery.removeEventListener('change', updateMode);
  }, []);

  return isStandalone;
}

export function App() {
  const isOnline = useOnlineStatus();
  const isStandalone = useStandaloneMode();
  const pwaState = useSyncExternalStore(
    subscribeToPwaState,
    getPwaState,
    getPwaState,
  );
  const pwaAnnouncement = pwaState.error
    ? pwaState.error
    : pwaState.updating
      ? 'Applying the application update.'
      : pwaState.updateAvailable
        ? 'An application update is available.'
        : pwaState.offlineReady
          ? 'Offline access is ready.'
          : '';

  return (
    <div className="app-frame">
      <header className="topbar">
        <a className="product-name" href="/" aria-label="Imagine Media Studio home">
          <span className="product-mark" aria-hidden="true" />
          Imagine Media Studio
        </a>
        <span
          className={`connection ${isOnline ? 'is-online' : 'is-offline'}`}
          role="status"
          aria-live="polite"
        >
          <span className="connection-dot" aria-hidden="true" />
          {isOnline ? 'Online' : 'Offline'}
        </span>
      </header>

      <main className="workspace">
        <span className="sr-only" role="status" aria-live="polite">
          {pwaAnnouncement}
        </span>
        <section className="baseline" aria-labelledby="workspace-title">
          <p className="phase-label">Workspace / PR 0</p>
          <h1 id="workspace-title">Foundation ready.</h1>
          <p className="summary">
            The application baseline is available. Generation tools will appear here in a later phase.
          </p>

          <dl className="runtime-list" aria-label="Application status">
            <div className="runtime-row">
              <dt>Network</dt>
              <dd>{isOnline ? 'Connected' : 'Unavailable'}</dd>
            </div>
            <div className="runtime-row">
              <dt>Display</dt>
              <dd>{isStandalone ? 'Standalone' : 'Browser'}</dd>
            </div>
            <div className="runtime-row">
              <dt>Interface</dt>
              <dd>Neutral baseline</dd>
            </div>
          </dl>
        </section>

        {(pwaState.updateAvailable || pwaState.offlineReady || pwaState.error) && (
          <aside className="pwa-notice" aria-labelledby="pwa-notice-title">
            <div>
              <p className="notice-title" id="pwa-notice-title">
                {pwaState.error
                  ? 'Update unavailable'
                  : pwaState.updateAvailable
                    ? 'Update available'
                    : 'Offline access ready'}
              </p>
              <p className="notice-detail">
                {pwaState.error ??
                  (pwaState.updateAvailable
                    ? 'Reload to use the latest version.'
                    : 'The application shell can now open without a connection.')}
              </p>
            </div>
            <div className="notice-actions">
              {pwaState.updateAvailable && (
                <button
                  className="action-button primary-action"
                  type="button"
                  disabled={pwaState.updating}
                  onClick={() => void activatePwaUpdate()}
                >
                  {pwaState.updating ? 'Updating' : 'Update now'}
                </button>
              )}
              <button className="action-button" type="button" onClick={dismissPwaNotice}>
                Dismiss
              </button>
            </div>
          </aside>
        )}
      </main>

      <footer className="footer">
        <span>Local-first media workspace</span>
        <span aria-hidden="true">00 / 01</span>
      </footer>
    </div>
  );
}
