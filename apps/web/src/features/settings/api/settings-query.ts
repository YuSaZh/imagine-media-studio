import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { JsonValue, JsonObject, ManualModelCreate } from "@imagine/shared";
import { internalClient } from "../../../api/internal-client";
import { internalQueryKeys } from "../../../api/query-keys";
export const GENERAL_SETTING_DEFAULTS = {
  'composer.clear_prompt_after_submit': true,
  'composer.default_mode': 'image',
  'gallery.autoplay_previews': false,
  'gallery.initial_filter': 'all',
  'pwa.update_notifications': true,
  'ui.reduce_motion': 'system',
} as const satisfies Readonly<Record<string, JsonValue>>;

export const PWA_SETTING_DEFAULTS = {
  'pwa.update_notifications': true,
} as const satisfies Readonly<Record<string, JsonValue>>;


export interface GeneralSettingsValues {
  autoplayPreviews: boolean;
  clearPromptAfterSubmit: boolean;
  defaultMode: 'image' | 'video';
  initialFilter: 'all' | 'image' | 'video';
  reduceMotion: 'always' | 'never' | 'system';
}

export interface PwaSettingsValues {
  updateNotifications: boolean;
}

function oneOf<T extends string>(value: JsonValue | undefined, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback;
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function readGeneralSettings(settings: JsonObject | undefined): GeneralSettingsValues {
  return {
    autoplayPreviews:
      typeof settings?.['gallery.autoplay_previews'] === 'boolean'
        ? settings['gallery.autoplay_previews']
        : false,
    clearPromptAfterSubmit:
      typeof settings?.['composer.clear_prompt_after_submit'] === 'boolean'
        ? settings['composer.clear_prompt_after_submit']
        : true,
    defaultMode: oneOf(settings?.['composer.default_mode'], ['image', 'video'], 'image'),
    initialFilter: oneOf(
      settings?.['gallery.initial_filter'],
      ['all', 'image', 'video'],
      'all',
    ),
    reduceMotion: oneOf(
      settings?.['ui.reduce_motion'],
      ['system', 'always', 'never'],
      'system',
    ),
  };
}

export function readPwaSettings(settings: JsonObject | undefined): PwaSettingsValues {
  const value = settings?.['pwa.update_notifications'];
  return {
    updateNotifications: typeof value === 'boolean' ? value : PWA_SETTING_DEFAULTS['pwa.update_notifications'],
  };
}


export interface ProviderWriteInput {
  apiKey?: string;
  baseUrl: string | null;
  config: JsonObject;
  enabled: boolean;
  headers?: Readonly<Record<string, string>>;
  isDefault: boolean;
  name: string;
  type: string;
}

export type ManualModelCreateInput = Omit<ManualModelCreate, 'enabled'> & { enabled?: boolean };

export const settingKey = [...internalQueryKeys.settings, "live"] as const;
export function useSettingsQuery() {
 return useQuery({ queryKey: settingKey, queryFn: () => internalClient.getSettings(), staleTime: 30000 });
}
export function usePatchSettings() {
 const client = useQueryClient();
 return useMutation({
  mutationKey: settingKey,
  scope: { id: 'account-settings' },
  mutationFn: (values: Readonly<Record<string, JsonValue>>) => internalClient.patchSettings(values),
  onMutate: values => {
   void client.cancelQueries({ queryKey: settingKey });
   client.setQueryData<{ settings: JsonObject }>(settingKey, current => current ? { ...current, settings: { ...current.settings, ...values } } : current);
  },
  onSettled: () => {
   if (client.isMutating({ mutationKey: settingKey }) === 1) void client.invalidateQueries({ queryKey: settingKey });
  },
 });
}
