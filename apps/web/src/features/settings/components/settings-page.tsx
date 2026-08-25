import { Database, Download, HardDrive, PlugZap, SlidersHorizontal } from 'lucide-react';
import { NavLink, useOutletContext } from 'react-router-dom';

import { isVisualFixtureMode } from '../../../visual-fixture.js';
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

function PwaSettings({ isOnline, isStandalone }: { isOnline: boolean; isStandalone: boolean }) {
  return (
    <>
      <div className="settings-heading"><p className="page-eyebrow">Installed app</p><h1>App</h1></div>
      <section className="settings-section" aria-labelledby="app-status">
        <h2 id="app-status">Status</h2>
        <SettingRow label="Display mode" description="Current browser launch context."><span className="value-pill">{isStandalone ? 'Standalone' : 'Browser'}</span></SettingRow>
        <SettingRow label="Network" description="Generation requires a connection."><span className={`value-pill ${isOnline ? 'is-success' : 'is-warning'}`}>{isOnline ? 'Online' : 'Offline'}</span></SettingRow>
        <SettingRow label="Offline shell" description="Navigation and cached interface remain available."><span className="value-pill is-success">Ready</span></SettingRow>
      </section>
      <section className="settings-section" aria-labelledby="app-updates">
        <h2 id="app-updates">Updates</h2>
        <SettingRow label="Update notification" description="Ask before reloading into a new version.">
          <label className="toggle"><input aria-label="Update notification" defaultChecked type="checkbox" /><span /></label>
        </SettingRow>
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
        {section === 'pwa' && <PwaSettings {...runtime} />}
      </div>
    </div>
  );
}
