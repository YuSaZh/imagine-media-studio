import { useSyncExternalStore } from 'react';
import {
  Database,
  Download,
  HardDrive,
  PlugZap,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import { NavLink, useOutletContext } from 'react-router-dom';

import {
  activatePwaUpdate,
  getPwaState,
  promptPwaInstall,
  subscribeToPwaState,
} from '../../../pwa-registration';
import { isIosSafari } from '../../../hooks/use-runtime-state';
import { isVisualFixtureMode } from '../../../visual-fixture.js';
import { readPwaSettings, usePatchSettings, useSettingsQuery } from '../api/settings-query.js';
import { GeneralSettings } from './general-settings.js';
import { ProviderSettings } from './provider-settings.js';
import { SettingRow } from './settings-controls.js';

interface SettingsPageProps {
  section: 'general' | 'providers' | 'pwa' | 'storage';
}

const settingsNavigation = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={17} />, to: '/settings' },
  { id: 'providers', label: 'Providers', icon: <PlugZap size={17} />, to: '/settings/providers' },
  { id: 'storage', label: 'Storage', icon: <Database size={17} />, to: '/settings/storage' },
  { id: 'pwa', label: 'App', icon: <Download size={17} />, to: '/settings/pwa' },
] as const;

function StorageSettings() {
  return (
    <>
      <div className="settings-heading"><p className="page-eyebrow">Local data</p><h1>Storage</h1></div>
      <section className="settings-section" aria-labelledby="storage-location">
        <h2 id="storage-location">Data location</h2>
        <div className="storage-summary">
          <HardDrive size={21} />
          <div><strong>/data</strong><span>SQLite, original media, thumbnails, posters and backups</span></div>
          <span className="storage-capacity">Mock volume</span>
        </div>
        <SettingRow label="Original media" description="Keep provider results on local storage.">
          <label className="toggle"><input aria-label="Keep original media" defaultChecked type="checkbox" /><span /></label>
        </SettingRow>
        <SettingRow label="Temporary files" description="Remove interrupted downloads after 24 hours.">
          <select aria-label="Temporary file retention" defaultValue="24"><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select>
        </SettingRow>
      </section>
    </>
  );
}

export function PwaSettings({
  fixtureMode,
  isOnline,
  isStandalone,
}: {
  fixtureMode: boolean;
  isOnline: boolean;
  isStandalone: boolean;
}) {
  const settingsQuery = useSettingsQuery(fixtureMode);
  const patchSettings = usePatchSettings(fixtureMode);
  const pwaState = useSyncExternalStore(subscribeToPwaState, getPwaState, getPwaState);
  const values = readPwaSettings(settingsQuery.data?.settings);
  const disabled = settingsQuery.isPending || patchSettings.isPending;
  const installed = isStandalone || pwaState.installed;
  const iosInstallGuide = !installed && isIosSafari();
  const registrationError =
    pwaState.errorKind === 'registration' ||
    (!pwaState.errorKind && Boolean(pwaState.error && !pwaState.offlineReady && !pwaState.updateAvailable));
  const offlineShellUnavailable = Boolean(
    registrationError && !pwaState.offlineReady,
  );
  const offlineShellLabel = offlineShellUnavailable
    ? 'Unavailable'
    : pwaState.offlineReady
      ? 'Ready'
      : 'Checking';
  const offlineShellTone = offlineShellUnavailable
    ? 'is-danger'
    : pwaState.offlineReady
      ? 'is-success'
      : 'is-info';
  const updateUnavailable = pwaState.errorKind === 'update';
  const updateLabel = pwaState.updating
    ? 'Applying'
    : updateUnavailable
      ? 'Unavailable'
      : pwaState.updateAvailable
        ? 'Available'
        : 'Current';
  const updateTone = updateUnavailable
    ? 'is-danger'
    : pwaState.updateAvailable
      ? 'is-info'
      : 'is-success';

  return (
    <>
      <div className="settings-heading">
        <div><p className="page-eyebrow">Installed app</p><h1>App</h1></div>
        {!fixtureMode && (
          <span
            className={`settings-save-state ${settingsQuery.isError || patchSettings.isError ? 'is-error' : ''}`}
            role="status"
          >
            {settingsQuery.isError || patchSettings.isError
              ? 'Could not save'
              : patchSettings.isPending
                ? 'Saving'
                : 'Saved'}
          </span>
        )}
      </div>
      <section className="settings-section" aria-labelledby="app-status">
        <h2 id="app-status">Status</h2>
        <SettingRow label="Display mode" description="Current browser launch context."><span className="value-pill">{isStandalone ? 'Standalone' : 'Browser'}</span></SettingRow>
        <SettingRow label="Network" description="Generation requires a connection."><span className={`value-pill ${isOnline ? 'is-success' : 'is-warning'}`}>{isOnline ? 'Online' : 'Offline'}</span></SettingRow>
        <SettingRow label="Offline shell" description="Navigation and cached interface remain available."><span className={`value-pill ${offlineShellTone}`}>{offlineShellLabel}</span></SettingRow>
      </section>
      <section className="settings-section" aria-labelledby="app-installation">
        <h2 id="app-installation">Installation</h2>
        <SettingRow
          label="Install status"
          description={installed ? 'The workspace opens as an installed app.' : 'Keep the workspace close at hand.'}
        >
          <span className={`value-pill ${installed ? 'is-success' : ''}`}>
            {installed ? 'Installed' : pwaState.installPromptAvailable ? 'Ready' : iosInstallGuide ? 'Add to Home Screen' : 'Unavailable'}
          </span>
        </SettingRow>
        {!installed && pwaState.installPromptAvailable && (
          <div className="pwa-install-action">
            <button
              className="settings-command"
              disabled={pwaState.installPromptPending}
              onClick={() => void promptPwaInstall()}
              type="button"
            >
              <Download aria-hidden="true" size={16} />
              <span>{pwaState.installPromptPending ? 'Opening install' : 'Install app'}</span>
            </button>
          </div>
        )}
        {iosInstallGuide && (
          <div className="pwa-ios-guide" aria-label="Add to Home Screen">
            <strong>Add to Home Screen</strong>
            <ol className="pwa-ios-steps">
              <li><span className="pwa-ios-step-icon"><span aria-hidden="true">1</span></span><span>Open <b>Share</b></span></li>
              <li><span className="pwa-ios-step-icon"><span aria-hidden="true">2</span></span><span>Choose <b>Add to Home Screen</b></span></li>
              <li><span className="pwa-ios-step-icon"><span aria-hidden="true">3</span></span><span>Confirm <b>Add</b></span></li>
            </ol>
          </div>
        )}
      </section>
      <section className="settings-section" aria-labelledby="app-updates">
        <h2 id="app-updates">Updates</h2>
        <SettingRow label="Update notification" description="Ask before reloading into a new version.">
          <label className="toggle">
            <input
              aria-label="Update notification"
              checked={values.updateNotifications}
              disabled={disabled}
              onChange={(event) => patchSettings.mutate({ 'pwa.update_notifications': event.target.checked })}
              type="checkbox"
            />
            <span />
          </label>
        </SettingRow>
        <SettingRow
          label="Application update"
          description={
            updateUnavailable
              ? 'The last update could not be applied.'
              : pwaState.updateAvailable
                ? 'A new version is ready to apply.'
                : 'The installed application is up to date.'
          }
        >
          <span className={`value-pill ${updateTone}`}>{updateLabel}</span>
        </SettingRow>
        {pwaState.updateAvailable && (
          <div className="pwa-install-action pwa-update-action">
            <button
              aria-busy={pwaState.updating}
              className="settings-command"
              disabled={pwaState.updating}
              onClick={() => void activatePwaUpdate()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              <span>{pwaState.updating ? 'Applying update' : updateUnavailable ? 'Retry update' : 'Apply update'}</span>
            </button>
          </div>
        )}
      </section>
    </>
  );
}

export function SettingsPage({ section }: SettingsPageProps) {
  const runtime = useOutletContext<{ isOnline: boolean; isStandalone: boolean }>();
  const fixtureMode = isVisualFixtureMode();
  return (
    <div className="settings-page">
      <aside className="settings-navigation" aria-label="Settings navigation">
        {settingsNavigation.map((item) => (
          <NavLink end={item.id === 'general'} key={item.id} to={item.to}>
            {item.icon}<span>{item.label}</span>
          </NavLink>
        ))}
      </aside>
      <div className="settings-content">
        {section === 'general' && <GeneralSettings fixtureMode={fixtureMode} />}
        {section === 'providers' && <ProviderSettings fixtureMode={fixtureMode} />}
        {section === 'storage' && <StorageSettings />}
        {section === 'pwa' && <PwaSettings {...runtime} fixtureMode={fixtureMode} />}
      </div>
    </div>
  );
}
