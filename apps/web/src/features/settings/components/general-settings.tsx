import type { JsonValue } from '@imagine/shared';

import {
  readGeneralSettings,
  usePatchSettings,
  useSettingsQuery,
} from '../api/settings-query.js';
import { SettingRow } from './settings-controls.js';

export function GeneralSettings({ fixtureMode }: { fixtureMode: boolean }) {
  const settingsQuery = useSettingsQuery(fixtureMode);
  const patchSettings = usePatchSettings(fixtureMode);
  const values = readGeneralSettings(settingsQuery.data?.settings);
  const persist = (key: string, value: JsonValue) => patchSettings.mutate({ [key]: value });
  const disabled = settingsQuery.isPending || patchSettings.isPending;

  return (
    <>
      <div className="settings-heading">
        <div>
          <p className="page-eyebrow">Workspace</p>
          <h1>General</h1>
        </div>
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
      <section className="settings-section" aria-labelledby="generation-defaults">
        <h2 id="generation-defaults">Generation defaults</h2>
        <SettingRow label="Default mode" description="Selected when the Composer opens.">
          <select
            aria-label="Default mode"
            disabled={disabled}
            onChange={(event) => persist('composer.default_mode', event.target.value)}
            value={values.defaultMode}
          >
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Clear prompt after submit"
          description="Keep references until removed manually."
        >
          <label className="toggle">
            <input
              aria-label="Clear prompt after submit"
              checked={values.clearPromptAfterSubmit}
              disabled={disabled}
              onChange={(event) =>
                persist('composer.clear_prompt_after_submit', event.target.checked)}
              type="checkbox"
            />
            <span />
          </label>
        </SettingRow>
        <SettingRow label="Reduce motion" description="Follow the system preference by default.">
          <select
            aria-label="Reduce motion"
            disabled={disabled}
            onChange={(event) => persist('ui.reduce_motion', event.target.value)}
            value={values.reduceMotion}
          >
            <option value="system">System</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </SettingRow>
      </section>
      <section className="settings-section" aria-labelledby="gallery-defaults">
        <h2 id="gallery-defaults">Gallery</h2>
        <SettingRow label="Initial filter" description="The first view shown in Imagine.">
          <select
            aria-label="Initial filter"
            disabled={disabled}
            onChange={(event) => persist('gallery.initial_filter', event.target.value)}
            value={values.initialFilter}
          >
            <option value="all">All media</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
          </select>
        </SettingRow>
        <SettingRow label="Autoplay previews" description="Muted video previews on pointer hover.">
          <label className="toggle">
            <input
              aria-label="Autoplay previews"
              checked={values.autoplayPreviews}
              disabled={disabled}
              onChange={(event) => persist('gallery.autoplay_previews', event.target.checked)}
              type="checkbox"
            />
            <span />
          </label>
        </SettingRow>
      </section>
    </>
  );
}
