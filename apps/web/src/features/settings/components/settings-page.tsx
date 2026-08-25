import { useState, type ReactNode } from 'react';
import { Check, Cloud, Database, Download, HardDrive, PlugZap, SlidersHorizontal } from 'lucide-react';
import { NavLink, useOutletContext } from 'react-router-dom';

interface SettingsPageProps {
  section: 'general' | 'providers' | 'pwa' | 'storage';
}

const settingsNavigation = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={17} />, to: '/settings' },
  { id: 'providers', label: 'Providers', icon: <PlugZap size={17} />, to: '/settings/providers' },
  { id: 'storage', label: 'Storage', icon: <Database size={17} />, to: '/settings/storage' },
  { id: 'pwa', label: 'App', icon: <Download size={17} />, to: '/settings/pwa' },
] as const;

function SettingRow({ children, description, label }: { children: ReactNode; description: string; label: string }) {
  return (
    <div className="setting-row">
      <div><strong>{label}</strong><span>{description}</span></div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function GeneralSettings() {
  return (
    <>
      <div className="settings-heading"><p className="page-eyebrow">Workspace</p><h1>General</h1></div>
      <section className="settings-section" aria-labelledby="generation-defaults">
        <h2 id="generation-defaults">Generation defaults</h2>
        <SettingRow label="Default mode" description="Selected when the Composer opens.">
          <select aria-label="Default mode" defaultValue="image"><option value="image">Image</option><option value="video">Video</option></select>
        </SettingRow>
        <SettingRow label="Clear prompt after submit" description="Keep references until removed manually.">
          <label className="toggle"><input aria-label="Clear prompt after submit" defaultChecked type="checkbox" /><span /></label>
        </SettingRow>
        <SettingRow label="Reduce motion" description="Follow the system preference by default.">
          <select aria-label="Reduce motion" defaultValue="system"><option value="system">System</option><option value="always">Always</option><option value="never">Never</option></select>
        </SettingRow>
      </section>
      <section className="settings-section" aria-labelledby="gallery-defaults">
        <h2 id="gallery-defaults">Gallery</h2>
        <SettingRow label="Initial filter" description="The first view shown in Imagine.">
          <select aria-label="Initial filter" defaultValue="all"><option value="all">All media</option><option value="image">Images</option><option value="video">Videos</option></select>
        </SettingRow>
        <SettingRow label="Autoplay previews" description="Muted video previews on pointer hover.">
          <label className="toggle"><input aria-label="Autoplay previews" type="checkbox" /><span /></label>
        </SettingRow>
      </section>
    </>
  );
}

function ProviderSettings() {
  const [tested, setTested] = useState(false);
  return (
    <>
      <div className="settings-heading"><p className="page-eyebrow">Connections</p><h1>Providers</h1></div>
      <section className="provider-list" aria-label="Configured providers">
        <article className="provider-card">
          <div className="provider-card-heading">
            <span className="provider-icon"><Cloud size={19} /></span>
            <div><h2>Studio Mock</h2><p>Deterministic PR 1 fixture provider</p></div>
            <span className="provider-state"><Check size={14} />Default</span>
          </div>
          <div className="provider-fields">
            <label><span>Provider type</span><input disabled value="Mock Provider" readOnly /></label>
            <label><span>Models</span><input disabled value="Studio Image, Studio Motion" readOnly /></label>
          </div>
          <div className="provider-card-actions">
            <button onClick={() => setTested(true)} type="button">{tested ? 'Connection ready' : 'Test connection'}</button>
            <button disabled type="button">Configure</button>
          </div>
        </article>
      </section>
      <button className="add-provider-button" disabled type="button"><PlugZap size={17} />Add provider</button>
    </>
  );
}

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
        {section === 'general' && <GeneralSettings />}
        {section === 'providers' && <ProviderSettings />}
        {section === 'storage' && <StorageSettings />}
        {section === 'pwa' && <PwaSettings {...runtime} />}
      </div>
    </div>
  );
}
