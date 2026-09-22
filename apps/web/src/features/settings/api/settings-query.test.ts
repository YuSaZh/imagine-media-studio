import { describe, expect, it } from 'vitest';
import { readGeneralSettings, readPwaSettings } from './settings-query';

describe('readGeneralSettings', () => {
  it('reads persisted values and rejects invalid enum or type values', () => {
    expect(
      readGeneralSettings({
        'composer.clear_prompt_after_submit': false,
        'composer.default_mode': 'video',
        'gallery.autoplay_previews': true,
        'gallery.group_by_series': true,
        'gallery.group_concurrent_images': true,
        'gallery.series_cover': 'recent',
        'gallery.initial_filter': 'image',
        'ui.reduce_motion': 'always',
        'ui.theme': 'dark',
        'ui.language': 'ja',
      }),
    ).toEqual({
      theme: 'dark',
      language: 'ja',
      groupBySeries: true,
      groupConcurrentImages: true,
      groupUploadedReferences: false,
      seriesCover: 'recent',
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
        'gallery.group_by_series': 'yes',
        'gallery.series_cover': 'invalid',
        'ui.theme': 'sepia',
        'ui.language': 'unknown',
      }),
    ).toEqual({
      theme: 'light',
      language: 'zh-CN',
      groupBySeries: false,
      groupConcurrentImages: false,
      groupUploadedReferences: false,
      seriesCover: 'latest',
      autoplayPreviews: false,
      clearPromptAfterSubmit: true,
      defaultMode: 'image',
      initialFilter: 'all',
      reduceMotion: 'system',
    });
  });
});

describe('readPwaSettings', () => {
  it('reads the persisted update notification preference and defaults safely', () => {
    expect(readPwaSettings({ 'pwa.update_notifications': false })).toEqual({
      updateNotifications: false,
    });
    expect(readPwaSettings({ 'pwa.update_notifications': 'off' })).toEqual({
      updateNotifications: true,
    });
    expect(readPwaSettings(undefined)).toEqual({ updateNotifications: true });
  });
});
