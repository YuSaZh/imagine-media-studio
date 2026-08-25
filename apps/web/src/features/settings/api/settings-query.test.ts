import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GENERAL_SETTING_DEFAULTS,
  loadProviderModelsData,
  loadProvidersData,
  loadSettingsData,
  patchSettingsData,
  readGeneralSettings,
  refreshProviderModels,
  testProviderConnection,
} from './settings-query.js';
import {
  isVisualFixtureMode,
  VISUAL_FIXTURE_STORAGE_KEY,
  VISUAL_FIXTURE_STORAGE_VALUE,
} from '../../../visual-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings query fixture mode', () => {
  it('uses only the agreed sessionStorage key and value', () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === VISUAL_FIXTURE_STORAGE_KEY ? VISUAL_FIXTURE_STORAGE_VALUE : null),
    };
    expect(isVisualFixtureMode(storage)).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith('imagine.visual-fixtures');
    expect(isVisualFixtureMode({ getItem: () => 'true' })).toBe(false);
    expect(isVisualFixtureMode({ getItem: () => null })).toBe(false);
  });

  it('loads and mutates visual fixtures without any internal fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(loadSettingsData(true)).resolves.toEqual({
      settings: GENERAL_SETTING_DEFAULTS,
    });
    await expect(loadProvidersData(true)).resolves.toMatchObject({
      items: [{ name: 'Studio Mock', type: 'mock' }],
    });
    await expect(loadProviderModelsData(true)).resolves.toMatchObject({
      items: [{ displayName: 'Studio Image' }, { displayName: 'Studio Motion' }],
    });
    await expect(
      patchSettingsData(true, { 'composer.default_mode': 'video' }),
    ).resolves.toMatchObject({ settings: { 'composer.default_mode': 'video' } });
    await expect(testProviderConnection(true, 'provider-studio-mock')).resolves.toEqual({
      latencyMs: 12,
      message: 'Connection ready.',
      ok: true,
    });
    await expect(refreshProviderModels(true, 'provider-studio-mock')).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ providerId: 'provider-studio-mock' })]),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('readGeneralSettings', () => {
  it('reads persisted values and rejects invalid enum or type values', () => {
    expect(
      readGeneralSettings({
        'composer.clear_prompt_after_submit': false,
        'composer.default_mode': 'video',
        'gallery.autoplay_previews': true,
        'gallery.initial_filter': 'image',
        'ui.reduce_motion': 'always',
      }),
    ).toEqual({
      autoplayPreviews: true,
      clearPromptAfterSubmit: false,
      defaultMode: 'video',
      initialFilter: 'image',
      reduceMotion: 'always',
    });
    expect(
      readGeneralSettings({
        'composer.clear_prompt_after_submit': 'yes',
        'composer.default_mode': 'audio',
        'gallery.initial_filter': 'recent',
      }),
    ).toEqual({
      autoplayPreviews: false,
      clearPromptAfterSubmit: true,
      defaultMode: 'image',
      initialFilter: 'all',
      reduceMotion: 'system',
    });
  });
});
