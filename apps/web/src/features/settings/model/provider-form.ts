import { PROVIDER_FAMILIES, providerFamily, ProviderHeadersSchema, SafeConfigSchema, ManualModelCreateSchema, type ModelDto, type ProviderDto } from '@imagine/shared';
import type { ProviderWriteInput, ManualModelCreateInput } from '../api/settings-query';


export const PROVIDER_PROFILE_OPTIONS = [
  ...PROVIDER_FAMILIES,
  { value: 'mock', label: 'Mock Provider' },
  { value: 'openai-images-v1', label: 'OpenAI Images v1' },
  { value: 'openai-responses-image-v1', label: 'OpenAI Responses Image v1' },
  { value: 'gemini-interactions-image-v1', label: 'Gemini Interactions Image v1' },
  { value: 'gemini-generate-content-image-v1', label: 'Gemini Generate Content Image v1' },
  { value: 'gemini-veo-operation-v1', label: 'Gemini Veo Operation v1' },
  { value: 'gemini-omni-interactions-video-v1', label: 'Gemini Omni Interactions Video v1' },
  { value: 'xai-imagine-image-v1', label: 'xAI Imagine Image v1' },
  { value: 'xai-imagine-video-v1', label: 'xAI Imagine Video v1' },
  { value: 'openai-videos-v1-compatible', label: 'OpenAI-compatible Videos v1' },
  { value: 'custom-http-v1', label: 'Custom HTTP Adapter' },
  { value: 'custom-js-v1', label: 'Trusted JavaScript Adapter' },
] as const;


type ProviderProfile = (typeof PROVIDER_PROFILE_OPTIONS)[number]['value'];

const DEFAULT_PROVIDER_PROFILE: ProviderProfile = 'openai';

const KNOWN_PROVIDER_PROFILES = new Set<string>(PROVIDER_PROFILE_OPTIONS.map(({ value }) => value));


export interface ProviderFormState {
  apiKey: string;
  baseUrl: string;
  configJson: string;
  enabled: boolean;
  headersJson: string;
  isDefault: boolean;
  name: string;
  profile: ProviderProfile;
  type: string;
  unsupportedType: boolean;
}


export function providerToForm(provider: ProviderDto | null): ProviderFormState {
  const type = provider ? providerFamily(provider.type) ?? provider.type : DEFAULT_PROVIDER_PROFILE;
  const profile: ProviderProfile = KNOWN_PROVIDER_PROFILES.has(type)
    ? type as ProviderProfile
    : DEFAULT_PROVIDER_PROFILE;
  return {
    apiKey: '',
    baseUrl: provider?.baseUrl ?? '',
    configJson: JSON.stringify(provider?.config ?? {}, null, 2),
    enabled: provider?.enabled ?? true,
    headersJson: '',
    isDefault: provider?.isDefault ?? false,
    name: provider?.name ?? '',
    profile,
    type,
    unsupportedType: provider !== null && !KNOWN_PROVIDER_PROFILES.has(type),
  };
}


function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}') as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}


export function buildProviderWriteInput(form: ProviderFormState): ProviderWriteInput {
  const name = form.name.trim();
  if (form.unsupportedType) {
    throw new Error('This Provider profile is no longer supported in PR4.');
  }
  const type = form.profile;
  if (!name) throw new Error('Provider name is required.');
  if (!type) throw new Error('Provider type is required.');
  const baseUrl = form.baseUrl.trim() || null;
  if ((type === 'openai-videos-v1-compatible' || type === 'custom-http-v1') && baseUrl === null) {
    throw new Error(`${type === 'custom-http-v1' ? 'Custom HTTP Adapter' : 'OpenAI-compatible Videos'} requires a Base URL.`);
  }
  if (baseUrl !== null) {
    try {
      const parsed = new URL(baseUrl);
      if (
        (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error('Provider Base URL must use HTTP or HTTPS without credentials, query, or fragment.');
      }
    } catch (caught) {
      if (caught instanceof Error && caught.message.startsWith('Provider Base URL')) throw caught;
      throw new Error('Provider Base URL must be a valid HTTP or HTTPS URL.', { cause: caught });
    }
  }
  const config = parseJsonObject(form.configJson, 'Configuration');
  const safeConfig = SafeConfigSchema.safeParse(config);
  if (!safeConfig.success) {
    throw new Error('Configuration cannot contain Secret-like keys or non-JSON values.');
  }
  const apiKey = form.apiKey.trim();
  const headersText = form.headersJson.trim();
  const headers = headersText
    ? ProviderHeadersSchema.safeParse(parseJsonObject(headersText, 'Headers'))
    : null;
  if (headers && !headers.success) throw new Error('Headers must be a JSON object of safe text values.');
  return {
    baseUrl,
    config: safeConfig.data,
    enabled: form.enabled,
    isDefault: form.isDefault,
    name,
    type,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers: headers.data } : {}),
  };
}


export interface ManualModelFormState {
  capabilitiesJson: string;
  displayName: string;
  enabled: boolean;
  modelId: string;
  providerId: string;
}


export function modelToForm(model: ModelDto | null, providerId: string): ManualModelFormState {
  return {
    capabilitiesJson: JSON.stringify(model?.capabilities ?? { operations: ['image.generate'] }, null, 2),
    displayName: model?.displayName ?? '',
    enabled: model?.enabled ?? true,
    modelId: model?.modelId ?? '',
    providerId: model?.providerId ?? providerId,
  };
}


export function buildManualModelWriteInput(form: ManualModelFormState): ManualModelCreateInput {
  const modelId = form.modelId.trim();
  const displayName = form.displayName.trim();
  if (!modelId) throw new Error('Model ID is required.');
  if (!displayName) throw new Error('Model display name is required.');
  const capabilities = parseJsonObject(form.capabilitiesJson, 'Capabilities');
  const parsed = ManualModelCreateSchema.safeParse({
    providerId: form.providerId,
    modelId,
    displayName,
    capabilities,
    enabled: form.enabled,
  });
  if (!parsed.success) throw new Error('Capabilities must match the supported Capability schema.');
  return parsed.data;
}
