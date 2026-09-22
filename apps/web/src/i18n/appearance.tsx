import { useLayoutEffect, useState, type ReactNode } from 'react';
import { readGeneralSettings, useSettingsQuery } from '../features/settings/api/settings-query';
import { setLanguage, useLanguage } from './index';

/** Account-scoped server preferences; never cache another account's selection on this device. */
export function Appearance({ children }: { children: ReactNode }) {
  const settings = useSettingsQuery();
  const preferences = readGeneralSettings(settings.data?.settings);
  const language = useLanguage();
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    let disposed = false;
    setFailed(false);
    void setLanguage(preferences.language).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [preferences.language]);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = preferences.theme === 'system' ? media.matches ? 'dark' : 'light' : preferences.theme;
      document.documentElement.dataset.theme = theme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141916' : '#fafafa');
    };
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [preferences.theme]);
  // A language change rerenders the existing tree, preserving drafts, dialogs and selections.
  return <>{failed && <p role="alert" className="appearance-error">Language resources could not load. Reload to retry.</p>}<div className="appearance-root" data-language={language}>{children}</div></>;
}
