import { useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ManualModelCreateSchema,
  ProviderHeadersSchema,
  SafeConfigSchema,
  type ModelDto,
  type ProviderDto,
} from '@imagine/shared';
import {
  AlertTriangle,
  Check,
  Cloud,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Power,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';

import {
  useCreateProvider,
  useCreateManualModel,
  useDeleteManualModel,
  usePatchProvider,
  usePatchManualModel,
  useProviderModelsQuery,
  useProvidersQuery,
  useRefreshProviderModels,
  useSetProviderState,
  useTestProvider,
  type ManualModelCreateInput,
  type ProviderWriteInput,
} from '../api/settings-query.js';

export const PROVIDER_PROFILE_OPTIONS = [
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
] as const;

type ProviderProfile = (typeof PROVIDER_PROFILE_OPTIONS)[number]['value'];
const DEFAULT_PROVIDER_PROFILE: ProviderProfile = 'openai-images-v1';
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
  const type = provider?.type ?? DEFAULT_PROVIDER_PROFILE;
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
  if (type === 'openai-videos-v1-compatible' && baseUrl === null) {
    throw new Error('OpenAI-compatible Videos requires a Base URL.');
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

export function ProviderApiKeyField({
  hasStoredKey,
  onChange,
  value,
}: {
  hasStoredKey: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      <span>API key</span>
      <span className="provider-secret-input">
        <KeyRound aria-hidden="true" size={15} />
        <input
          aria-label="API key"
          autoComplete="new-password"
          onChange={(event) => onChange(event.target.value)}
          placeholder={hasStoredKey ? 'Stored key remains unchanged' : 'Optional'}
          type="password"
          value={value}
        />
      </span>
      <small>Write only. Saved credentials are never returned to this page.</small>
    </label>
  );
}

function providerTypeLabel(type: string): string {
  return PROVIDER_PROFILE_OPTIONS.find((option) => option.value === type)?.label ?? type;
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

export function ManualModelCapabilityField({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      <span>Capability JSON</span>
      <textarea
        aria-describedby="manual-model-capability-help"
        aria-label="Capability JSON"
        onChange={(event) => onChange(event.target.value)}
        rows={10}
        spellCheck={false}
        value={value}
      />
      <small id="manual-model-capability-help">
        Include at least one supported operation, such as image.generate.
      </small>
    </label>
  );
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

function ProviderEditor({
  onClose,
  onSave,
  provider,
  saving,
}: {
  onClose: () => void;
  onSave: (input: ProviderWriteInput) => Promise<void>;
  provider: ProviderDto | null;
  saving: boolean;
}) {
  const [form, setForm] = useState(() => providerToForm(provider));
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await onSave(buildProviderWriteInput(form));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Provider could not be saved.');
    }
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="provider-dialog-overlay" />
      <Dialog.Content className="provider-dialog-content">
        <header className="provider-dialog-heading">
          <div>
            <p className="page-eyebrow">Stored connection</p>
            <Dialog.Title>{provider ? 'Edit provider' : 'Add provider'}</Dialog.Title>
            <Dialog.Description className="provider-dialog-description">
              Choose a versioned Provider profile and keep credentials separate from configuration.
            </Dialog.Description>
          </div>
          <button aria-label="Close provider editor" onClick={onClose} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="provider-form" onSubmit={submit}>
          <div className="provider-form-grid">
            <label>
              <span>Name</span>
              <input
                autoFocus
                maxLength={120}
                onChange={(event) => update('name', event.target.value)}
                required
                value={form.name}
              />
            </label>
            <label>
              <span>Provider profile</span>
              <select
                disabled={provider?.type === 'mock' || form.unsupportedType}
                onChange={(event) => {
                  const profile = event.target.value as ProviderProfile;
                  update('profile', profile);
                  update('type', profile);
                  update('unsupportedType', false);
                }}
                value={form.profile}
              >
                {PROVIDER_PROFILE_OPTIONS.filter((option) => provider?.type === 'mock' || option.value !== 'mock').map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          {form.unsupportedType && (
            <p className="provider-form-error" role="alert">
              This stored Provider profile is not available in PR4 and cannot be edited.
            </p>
          )}
          {form.profile === 'openai-videos-v1-compatible' && !form.unsupportedType && (
            <p className="provider-form-warning" role="status">
              The OpenAI Videos API is scheduled to shut down on 2026-09-24. Use this profile only for compatible relays.
            </p>
          )}
          <label>
            <span>Base URL{form.profile === 'openai-videos-v1-compatible' ? ' (required)' : ''}</span>
            <input
              inputMode="url"
              onChange={(event) => update('baseUrl', event.target.value)}
              placeholder="https://api.example.com"
              type="url"
              value={form.baseUrl}
            />
          </label>
          <ProviderApiKeyField
            hasStoredKey={provider?.hasApiKey === true}
            onChange={(value) => update('apiKey', value)}
            value={form.apiKey}
          />
          <label>
            <span>Custom headers JSON</span>
            <textarea
              onChange={(event) => update('headersJson', event.target.value)}
              placeholder={provider?.hasCustomHeaders ? 'Stored headers remain unchanged' : '{ }'}
              rows={4}
              spellCheck={false}
              value={form.headersJson}
            />
            <small>Header values are encrypted at rest and are never placed in configuration.</small>
          </label>
          <label>
            <span>Configuration JSON</span>
            <textarea
              onChange={(event) => update('configJson', event.target.value)}
              rows={5}
              spellCheck={false}
              value={form.configJson}
            />
            <small>Do not put API keys or header values in configuration.</small>
          </label>
          <div className="provider-form-options">
            <label>
              <input
                checked={form.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
                type="checkbox"
              />
              Enabled
            </label>
            {!provider && (
              <label>
                <input
                  checked={form.isDefault}
                  onChange={(event) => update('isDefault', event.target.checked)}
                  type="checkbox"
                />
                Make default
              </label>
            )}
          </div>
          {error && <p className="provider-form-error" role="alert">{error}</p>}
          <footer className="provider-dialog-actions">
            <button disabled={saving} onClick={onClose} type="button">Cancel</button>
            <button className="is-primary" disabled={saving || form.unsupportedType} type="submit">
              {saving && <LoaderCircle aria-hidden="true" className="is-spinning" size={15} />}
              {saving ? 'Saving' : 'Save provider'}
            </button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

function ModelEditor({
  model,
  onClose,
  onSave,
  providerId,
  saving,
}: {
  model: ModelDto | null;
  onClose: () => void;
  onSave: (input: ManualModelCreateInput) => Promise<void>;
  providerId: string;
  saving: boolean;
}) {
  const [form, setForm] = useState(() => modelToForm(model, providerId));
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof ManualModelFormState>(key: K, value: ManualModelFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await onSave(buildManualModelWriteInput(form));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Model could not be saved.');
    }
  };

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="provider-dialog-overlay" />
      <Dialog.Content className="provider-dialog-content model-dialog-content">
        <header className="provider-dialog-heading">
          <div>
            <p className="page-eyebrow">Manual model catalog</p>
            <Dialog.Title>{model ? 'Edit manual model' : 'Add manual model'}</Dialog.Title>
            <Dialog.Description className="provider-dialog-description">
              Capability fields are validated before the model is saved.
            </Dialog.Description>
          </div>
          <button aria-label="Close model editor" onClick={onClose} type="button">
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <form className="provider-form" onSubmit={submit}>
          <div className="provider-form-grid">
            <label>
              <span>Model ID</span>
              <input
                autoFocus
                maxLength={255}
                onChange={(event) => update('modelId', event.target.value)}
                required
                value={form.modelId}
              />
            </label>
            <label>
              <span>Display name</span>
              <input
                maxLength={255}
                onChange={(event) => update('displayName', event.target.value)}
                required
                value={form.displayName}
              />
            </label>
          </div>
          <ManualModelCapabilityField
            onChange={(value) => update('capabilitiesJson', value)}
            value={form.capabilitiesJson}
          />
          <label className="provider-checkbox-row">
            <input
              checked={form.enabled}
              onChange={(event) => update('enabled', event.target.checked)}
              type="checkbox"
            />
            Enabled
          </label>
          {error && <p className="provider-form-error" role="alert">{error}</p>}
          <footer className="provider-dialog-actions">
            <button disabled={saving} onClick={onClose} type="button">Cancel</button>
            <button className="is-primary" disabled={saving} type="submit">
              {saving && <LoaderCircle aria-hidden="true" className="is-spinning" size={15} />}
              {saving ? 'Saving' : 'Save model'}
            </button>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export function ProviderSettings({ fixtureMode }: { fixtureMode: boolean }) {
  const providersQuery = useProvidersQuery(fixtureMode);
  const modelsQuery = useProviderModelsQuery(fixtureMode);
  const createProvider = useCreateProvider(fixtureMode);
  const createManualModel = useCreateManualModel(fixtureMode);
  const deleteManualModel = useDeleteManualModel(fixtureMode);
  const patchProvider = usePatchProvider(fixtureMode);
  const patchManualModel = usePatchManualModel(fixtureMode);
  const refreshModels = useRefreshProviderModels(fixtureMode);
  const setProviderState = useSetProviderState(fixtureMode);
  const testProvider = useTestProvider(fixtureMode);
  const [editor, setEditor] = useState<ProviderDto | 'new' | null>(null);
  const [modelEditor, setModelEditor] = useState<{
    model: ModelDto | null;
    providerId: string;
  } | null>(null);
  const [testResults, setTestResults] = useState<
    Readonly<Record<string, { message: string; ok: boolean }>>
  >({});
  const [refreshResults, setRefreshResults] = useState<
    Readonly<Record<string, { message: string; ok: boolean }>>
  >({});
  const [mutationError, setMutationError] = useState<string | null>(null);
  const modelsByProvider = useMemo(() => {
    const result = new Map<string, ModelDto[]>();
    for (const model of modelsQuery.data?.items ?? []) {
      const current = result.get(model.providerId) ?? [];
      current.push(model);
      result.set(model.providerId, current);
    }
    return result;
  }, [modelsQuery.data?.items]);
  const providers = providersQuery.data?.items ?? [];
  const busy = setProviderState.isPending || testProvider.isPending || refreshModels.isPending ||
    createManualModel.isPending || patchManualModel.isPending || deleteManualModel.isPending;

  const actionError = (caught: unknown, fallback: string): string => {
    if (caught instanceof Error && caught.message.length > 0 && caught.message.length < 220) {
      return caught.message;
    }
    return fallback;
  };

  const testConnection = async (provider: ProviderDto) => {
    try {
      const result = await testProvider.mutateAsync(provider.id);
      setTestResults((current) => ({
        ...current,
        [provider.id]: { message: result.message, ok: result.ok },
      }));
    } catch (caught) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { message: actionError(caught, 'Provider connection test failed.'), ok: false },
      }));
    }
  };
  const refreshProviderModels = async (provider: ProviderDto) => {
    try {
      const result = await refreshModels.mutateAsync(provider.id);
      setRefreshResults((current) => ({
        ...current,
        [provider.id]: { message: `${result.items.length} model(s) refreshed.`, ok: true },
      }));
    } catch (caught) {
      setRefreshResults((current) => ({
        ...current,
        [provider.id]: {
          message: actionError(caught, 'Models could not be refreshed.'),
          ok: false,
        },
      }));
    }
  };
  const updateProviderState = async (
    providerId: string,
    values: { enabled?: boolean; isDefault?: boolean },
  ) => {
    setMutationError(null);
    try {
      await setProviderState.mutateAsync({ id: providerId, values });
    } catch (caught) {
      setMutationError(actionError(caught, 'Provider could not be updated.'));
    }
  };
  const updateManualModel = async (id: string, values: { enabled?: boolean }) => {
    setMutationError(null);
    try {
      await patchManualModel.mutateAsync({ id, input: values });
    } catch (caught) {
      setMutationError(actionError(caught, 'Manual model could not be updated.'));
    }
  };
  const deleteManualModelWithConfirmation = async (model: ModelDto) => {
    if (!window.confirm(`Delete manual model ${model.displayName}?`)) return;
    setMutationError(null);
    try {
      await deleteManualModel.mutateAsync(model.id);
    } catch (caught) {
      setMutationError(actionError(caught, 'Manual model could not be deleted.'));
    }
  };
  const saveProvider = async (input: ProviderWriteInput) => {
    if (editor === 'new') await createProvider.mutateAsync(input);
    else if (editor) await patchProvider.mutateAsync({ id: editor.id, input: {
      ...input,
      isDefault: editor.isDefault,
      } });
    setEditor(null);
  };
  const saveModel = async (input: ManualModelCreateInput) => {
    if (!modelEditor) return;
    if (modelEditor.model) {
      await patchManualModel.mutateAsync({
        id: modelEditor.model.id,
        input: {
          capabilities: input.capabilities,
          displayName: input.displayName,
          enabled: input.enabled ?? true,
          modelId: input.modelId,
        },
      });
    } else {
      await createManualModel.mutateAsync(input);
    }
    setModelEditor(null);
  };

  return (
    <>
      <div className="settings-heading">
        <p className="page-eyebrow">Connections</p>
        <h1>Providers</h1>
      </div>
      {mutationError && (
        <div className="settings-inline-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>{mutationError}</span>
        </div>
      )}
      {providersQuery.isError && (
        <div className="settings-inline-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>Providers could not be loaded.</span>
          <button onClick={() => void providersQuery.refetch()} type="button">Retry</button>
        </div>
      )}
      {modelsQuery.isError && (
        <div className="settings-inline-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>Models could not be loaded.</span>
          <button onClick={() => void modelsQuery.refetch()} type="button">Retry</button>
        </div>
      )}
      <section className="provider-list" aria-label="Configured providers" aria-busy={providersQuery.isPending}>
        {providersQuery.isPending && <div className="provider-loading" role="status">Loading providers</div>}
        {!providersQuery.isPending && providers.length === 0 && (
          <div className="provider-empty">
            <PlugZap aria-hidden="true" size={20} />
            <strong>No providers configured</strong>
            <span>Add a stored connection to begin.</span>
          </div>
        )}
        {providers.map((provider) => {
          const models = modelsByProvider.get(provider.id) ?? [];
          const result = testResults[provider.id];
          const refreshResult = refreshResults[provider.id];
          return (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-heading">
                <span className="provider-icon"><Cloud aria-hidden="true" size={19} /></span>
                <div>
                  <h2>{provider.name}</h2>
                  <p>
                    {fixtureMode
                      ? 'Deterministic PR 1 fixture provider'
                      : `${providerTypeLabel(provider.type)} · dynamic model catalog`}
                  </p>
                </div>
                <span className={`provider-state ${provider.enabled ? '' : 'is-muted'}`}>
                  {provider.isDefault && <Check aria-hidden="true" size={14} />}
                  {provider.isDefault ? 'Default' : provider.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="provider-fields">
                <label>
                  <span>Provider profile</span>
                  <input disabled value={providerTypeLabel(provider.type)} readOnly />
                </label>
                <label>
                  <span>Models</span>
                  <input
                    disabled
                    value={
                      models.length > 0
                        ? models.map((model) => model.displayName).join(', ')
                        : modelsQuery.isPending
                          ? 'Loading models...'
                          : 'No models discovered'
                    }
                    readOnly
                  />
                </label>
              </div>
              {!fixtureMode && (
                <div className="provider-security-row">
                  <span className={provider.hasApiKey ? 'is-present' : ''}>
                    <KeyRound aria-hidden="true" size={13} />
                    {provider.hasApiKey ? 'API key stored' : 'No API key'}
                  </span>
                  {provider.hasCustomHeaders && <span>Custom headers stored</span>}
                </div>
              )}
              <section className="provider-models" aria-label={`${provider.name} models`}>
                <div className="provider-models-heading">
                  <h3>Model catalog</h3>
                  {!fixtureMode && (
                    <div className="provider-models-actions">
                      <button
                        disabled={busy || !provider.enabled}
                        onClick={() => void refreshProviderModels(provider)}
                        type="button"
                      >
                        <RefreshCw aria-hidden="true" size={14} />
                        {refreshModels.isPending ? 'Refreshing models' : 'Refresh models'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setModelEditor({ model: null, providerId: provider.id })}
                        type="button"
                      >
                        <PlugZap aria-hidden="true" size={14} />Add manual model
                      </button>
                    </div>
                  )}
                </div>
                {models.length === 0 && (
                  <p className="provider-models-empty">No models discovered for this provider.</p>
                )}
                {models.map((model) => {
                  const manual = model.capabilitySource === 'manual';
                  return (
                    <div className="provider-model-row" key={model.id}>
                      <div className="provider-model-copy">
                        <strong>{model.displayName}</strong>
                        <span>{model.modelId}</span>
                      </div>
                      <div className="provider-model-meta">
                        <span className={manual ? 'is-manual' : ''}>
                          {manual ? 'Manual override' : `${model.capabilitySource} catalog`}
                        </span>
                        <span className={model.enabled ? 'is-enabled' : 'is-disabled'}>
                          {model.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                      {manual && !fixtureMode && (
                        <div className="provider-model-actions">
                          <button
                            aria-label={`Edit ${model.displayName}`}
                            disabled={busy}
                            onClick={() => setModelEditor({ model, providerId: provider.id })}
                            title="Edit manual model"
                            type="button"
                          >
                            <Pencil aria-hidden="true" size={14} />
                          </button>
                          <button
                            aria-label={`${model.enabled ? 'Disable' : 'Enable'} ${model.displayName}`}
                            disabled={busy}
                            onClick={() => void updateManualModel(model.id, { enabled: !model.enabled })}
                            title={model.enabled ? 'Disable manual model' : 'Enable manual model'}
                            type="button"
                          >
                            <Power aria-hidden="true" size={14} />
                          </button>
                          <button
                            aria-label={`Delete ${model.displayName}`}
                            disabled={busy}
                            onClick={() => void deleteManualModelWithConfirmation(model)}
                            title="Delete manual model"
                            type="button"
                          >
                            <Trash2 aria-hidden="true" size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
              <div className="provider-card-actions">
                <button
                  disabled={busy || !provider.enabled}
                  onClick={() => void testConnection(provider)}
                  type="button"
                >
                  {!fixtureMode && <RefreshCw aria-hidden="true" size={14} />}
                  {result?.ok ? 'Connection ready' : 'Test connection'}
                </button>
                {!fixtureMode && !provider.isDefault && (
                  <button
                    disabled={busy || !provider.enabled}
                    onClick={() => void updateProviderState(provider.id, { isDefault: true })}
                    type="button"
                  >
                    <Check aria-hidden="true" size={14} />Make default
                  </button>
                )}
                {!fixtureMode && (
                  <button
                    disabled={busy}
                    onClick={() => void updateProviderState(provider.id, { enabled: !provider.enabled })}
                    type="button"
                  >
                    <Power aria-hidden="true" size={14} />{provider.enabled ? 'Disable' : 'Enable'}
                  </button>
                )}
                <button disabled={fixtureMode || busy} onClick={() => setEditor(provider)} type="button">
                  <Pencil aria-hidden="true" size={14} />Configure
                </button>
              </div>
              {result && (
                <p className={`provider-test-result ${result.ok ? 'is-success' : 'is-error'}`} role="status">
                  {result.message}
                </p>
              )}
              {refreshResult && (
                <p className={`provider-test-result ${refreshResult.ok ? 'is-success' : 'is-error'}`} role="status">
                  {refreshResult.message}
                </p>
              )}
            </article>
          );
        })}
      </section>
      <button
        className="add-provider-button"
        disabled={fixtureMode}
        onClick={() => setEditor('new')}
        type="button"
      >
        <PlugZap aria-hidden="true" size={17} />Add provider
      </button>
      <Dialog.Root open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        {editor !== null && (
          <ProviderEditor
            key={editor === 'new' ? 'new' : editor.id}
            onClose={() => setEditor(null)}
            onSave={saveProvider}
            provider={editor === 'new' ? null : editor}
            saving={createProvider.isPending || patchProvider.isPending}
          />
        )}
      </Dialog.Root>
      <Dialog.Root open={modelEditor !== null} onOpenChange={(open) => !open && setModelEditor(null)}>
        {modelEditor !== null && (
          <ModelEditor
            key={modelEditor.model?.id ?? 'new-model'}
            model={modelEditor.model}
            onClose={() => setModelEditor(null)}
            onSave={saveModel}
            providerId={modelEditor.providerId}
            saving={createManualModel.isPending || patchManualModel.isPending}
          />
        )}
      </Dialog.Root>
    </>
  );
}
