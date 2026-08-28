import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  JsonObject,
  JsonValue,
  ManualModelCreate,
  ManualModelPatch,
  ModelDto,
  ProviderDto,
} from '@imagine/shared';

import { internalClient } from '../../../api/internal-client.js';
import { internalQueryKeys } from '../../../api/query-keys.js';
import { PR1_MOCK_PROVIDER } from '../../gallery/model/fixtures.js';

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

const FIXTURE_PROVIDER: ProviderDto = {
  baseUrl: null,
  config: { fixture: true },
  createdAt: '2026-08-25T00:00:00.000Z',
  enabled: true,
  hasApiKey: false,
  hasCustomHeaders: false,
  id: PR1_MOCK_PROVIDER.id,
  isDefault: true,
  name: PR1_MOCK_PROVIDER.displayName,
  type: PR1_MOCK_PROVIDER.type,
  updatedAt: '2026-08-25T00:00:00.000Z',
};

const FIXTURE_MODELS: readonly ModelDto[] = PR1_MOCK_PROVIDER.models.map((model) => ({
  capabilities: {
    aspectRatios: [...model.capabilities.aspectRatios],
    durations: [...model.capabilities.durations],
    maxBatchCount: model.capabilities.maxBatchCount,
    maxReferenceImages: model.capabilities.maxReferenceImages,
    operations: [...model.capabilities.operations],
    resolutions: [...model.capabilities.resolutions],
    supportsBatchCount: model.capabilities.supportsBatchCount,
    supportsCancel: model.capabilities.supportsCancel,
    supportsMask: model.capabilities.supportsMask,
    supportsProgress: model.capabilities.supportsProgress,
  },
  capabilitySource: 'mock',
  createdAt: '2026-08-25T00:00:00.000Z',
  displayName: model.displayName,
  enabled: true,
  id: model.id,
  modelId: model.id,
  providerId: PR1_MOCK_PROVIDER.id,
  updatedAt: '2026-08-25T00:00:00.000Z',
}));

interface ProviderPageData {
  items: readonly ProviderDto[];
  nextCursor: string | null;
}

interface ModelPageData {
  items: readonly ModelDto[];
  nextCursor: string | null;
}

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

function settingKey(fixture: boolean) {
  return [...internalQueryKeys.settings, fixture ? 'fixture' : 'live'] as const;
}

function providerKey(fixture: boolean) {
  return [...internalQueryKeys.providers, fixture ? 'fixture' : 'live'] as const;
}

function modelKey(fixture: boolean) {
  return [...internalQueryKeys.models, fixture ? 'fixture' : 'live'] as const;
}

export async function loadSettingsData(fixture: boolean) {
  return fixture
    ? { settings: { ...GENERAL_SETTING_DEFAULTS } }
    : internalClient.getSettings();
}

export async function loadProvidersData(fixture: boolean): Promise<ProviderPageData> {
  return fixture
    ? { items: [FIXTURE_PROVIDER], nextCursor: null }
    : internalClient.listProviders({ limit: 100 });
}

export async function loadProviderModelsData(fixture: boolean): Promise<ModelPageData> {
  return fixture
    ? { items: FIXTURE_MODELS, nextCursor: null }
    : internalClient.listModels({ limit: 100 });
}

export async function patchSettingsData(
  fixture: boolean,
  values: Readonly<Record<string, JsonValue>>,
) {
  return fixture
    ? { settings: { ...GENERAL_SETTING_DEFAULTS, ...values } }
    : internalClient.patchSettings(values);
}

export async function testProviderConnection(fixture: boolean, providerId: string) {
  return fixture
    ? { latencyMs: 12, message: 'Connection ready.', ok: true }
    : internalClient.testProvider(providerId);
}

export async function refreshProviderModels(fixture: boolean, providerId: string) {
  if (fixture) {
    return {
      items: FIXTURE_MODELS.filter((model) => model.providerId === providerId),
    };
  }
  return internalClient.refreshProviderModels(providerId);
}

export function useSettingsQuery(fixture: boolean) {
  return useQuery({
    queryKey: settingKey(fixture),
    queryFn: () => loadSettingsData(fixture),
    ...(fixture ? { initialData: { settings: { ...GENERAL_SETTING_DEFAULTS } } } : {}),
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function usePatchSettings(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: Readonly<Record<string, JsonValue>>) =>
      patchSettingsData(fixture, values),
    onMutate: async (values) => {
      const key = settingKey(fixture);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{ settings: JsonObject }>(key);
      queryClient.setQueryData(key, {
        settings: { ...(previous?.settings ?? GENERAL_SETTING_DEFAULTS), ...values },
      });
      return { previous };
    },
    onError: (_error, _values, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(settingKey(fixture), context.previous);
      }
    },
    onSuccess: (response) => queryClient.setQueryData(settingKey(fixture), response),
  });
}

export function useProvidersQuery(fixture: boolean) {
  return useQuery<ProviderPageData>({
    queryKey: providerKey(fixture),
    queryFn: () => loadProvidersData(fixture),
    ...(fixture ? { initialData: { items: [FIXTURE_PROVIDER], nextCursor: null } } : {}),
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useProviderModelsQuery(fixture: boolean) {
  return useQuery<ModelPageData>({
    queryKey: modelKey(fixture),
    queryFn: () => loadProviderModelsData(fixture),
    ...(fixture ? { initialData: { items: FIXTURE_MODELS, nextCursor: null } } : {}),
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

async function refreshProviderQueries(queryClient: QueryClient, fixture: boolean): Promise<void> {
  if (fixture) return;
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.providers }),
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.models }),
  ]);
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
export type ManualModelPatchInput = ManualModelPatch;

export function useCreateProvider(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (input: ProviderWriteInput) => {
      if (fixture) throw new Error('Visual fixtures cannot create Providers.');
      return internalClient.createProvider(input);
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function usePatchProvider(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async ({ id, input }: { id: string; input: ProviderWriteInput }) => {
      if (fixture) throw new Error('Visual fixtures cannot update Providers.');
      return internalClient.patchProvider(id, { ...input });
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function useSetProviderState(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: { enabled?: boolean; isDefault?: boolean } }) => {
      if (fixture) throw new Error('Visual fixtures cannot update Providers.');
      return internalClient.patchProvider(id, values);
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function useTestProvider(fixture: boolean) {
  return useMutation({
    mutationFn: async (providerId: string) => testProviderConnection(fixture, providerId),
  });
}

export function useRefreshProviderModels(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (providerId: string) => refreshProviderModels(fixture, providerId),
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function useCreateManualModel(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualModelCreateInput) => {
      if (fixture) throw new Error('Visual fixtures cannot create Models.');
      return internalClient.createModel(input);
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function usePatchManualModel(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: ManualModelPatchInput }) => {
      if (fixture) throw new Error('Visual fixtures cannot update Models.');
      return internalClient.patchModel(id, input);
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}

export function useDeleteManualModel(fixture: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (fixture) throw new Error('Visual fixtures cannot delete Models.');
      return internalClient.deleteModel(id);
    },
    onSuccess: async () => refreshProviderQueries(queryClient, fixture),
  });
}
