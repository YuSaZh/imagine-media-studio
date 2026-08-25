import { useMemo, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { SafeConfigSchema, type ProviderDto } from '@imagine/shared';
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
  X,
} from 'lucide-react';

import {
  useCreateProvider,
  usePatchProvider,
  useProviderModelsQuery,
  useProvidersQuery,
  useSetProviderState,
  useTestProvider,
  type ProviderWriteInput,
} from '../api/settings-query.js';

export interface ProviderFormState {
  apiKey: string;
  baseUrl: string;
  configJson: string;
  enabled: boolean;
  isDefault: boolean;
  name: string;
  type: string;
}

export function providerToForm(provider: ProviderDto | null): ProviderFormState {
  return {
    apiKey: '',
    baseUrl: provider?.baseUrl ?? '',
    configJson: JSON.stringify(provider?.config ?? {}, null, 2),
    enabled: provider?.enabled ?? true,
    isDefault: provider?.isDefault ?? false,
    name: provider?.name ?? '',
    type: provider?.type ?? 'custom-http',
  };
}

export function buildProviderWriteInput(form: ProviderFormState): ProviderWriteInput {
  const name = form.name.trim();
  const type = form.type.trim();
  if (!name) throw new Error('Provider name is required.');
  if (!type) throw new Error('Provider type is required.');
  let config: unknown;
  try {
    config = JSON.parse(form.configJson || '{}') as unknown;
  } catch {
    throw new Error('Configuration must be valid JSON.');
  }
  if (config === null || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Configuration must be a JSON object.');
  }
  const safeConfig = SafeConfigSchema.safeParse(config);
  if (!safeConfig.success) {
    throw new Error('Configuration cannot contain Secret-like keys or non-JSON values.');
  }
  const apiKey = form.apiKey.trim();
  return {
    baseUrl: form.baseUrl.trim() || null,
    config: safeConfig.data,
    enabled: form.enabled,
    isDefault: form.isDefault,
    name,
    type,
    ...(apiKey ? { apiKey } : {}),
  };
}

function providerTypeLabel(type: string): string {
  return type === 'mock' ? 'Mock Provider' : type;
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
              Mock is available now. Other types are stored for later runtime adapters.
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
              <span>Provider type</span>
              <input
                maxLength={80}
                onChange={(event) => update('type', event.target.value)}
                required
                value={form.type}
              />
            </label>
          </div>
          <label>
            <span>Base URL</span>
            <input
              inputMode="url"
              onChange={(event) => update('baseUrl', event.target.value)}
              placeholder="https://api.example.com"
              type="url"
              value={form.baseUrl}
            />
          </label>
          <label>
            <span>API key</span>
            <span className="provider-secret-input">
              <KeyRound aria-hidden="true" size={15} />
              <input
                autoComplete="new-password"
                onChange={(event) => update('apiKey', event.target.value)}
                placeholder={provider?.hasApiKey ? 'Stored key remains unchanged' : 'Optional'}
                type="password"
                value={form.apiKey}
              />
            </span>
            <small>Write only. Saved credentials are never returned to this page.</small>
          </label>
          <label>
            <span>Configuration JSON</span>
            <textarea
              onChange={(event) => update('configJson', event.target.value)}
              rows={5}
              spellCheck={false}
              value={form.configJson}
            />
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
            <button className="is-primary" disabled={saving} type="submit">
              {saving && <LoaderCircle aria-hidden="true" className="is-spinning" size={15} />}
              {saving ? 'Saving' : 'Save provider'}
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
  const patchProvider = usePatchProvider(fixtureMode);
  const setProviderState = useSetProviderState(fixtureMode);
  const testProvider = useTestProvider(fixtureMode);
  const [editor, setEditor] = useState<ProviderDto | 'new' | null>(null);
  const [testResults, setTestResults] = useState<
    Readonly<Record<string, { message: string; ok: boolean }>>
  >({});
  const modelsByProvider = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const model of modelsQuery.data?.items ?? []) {
      const current = result.get(model.providerId) ?? [];
      current.push(model.displayName);
      result.set(model.providerId, current);
    }
    return result;
  }, [modelsQuery.data?.items]);
  const providers = providersQuery.data?.items ?? [];
  const busy = setProviderState.isPending || testProvider.isPending;

  const testConnection = async (provider: ProviderDto) => {
    const result = await testProvider.mutateAsync(provider.id);
    setTestResults((current) => ({
      ...current,
      [provider.id]: { message: result.message, ok: result.ok },
    }));
  };
  const saveProvider = async (input: ProviderWriteInput) => {
    if (editor === 'new') await createProvider.mutateAsync(input);
    else if (editor) await patchProvider.mutateAsync({ id: editor.id, input: {
      ...input,
      isDefault: editor.isDefault,
    } });
    setEditor(null);
  };

  return (
    <>
      <div className="settings-heading">
        <p className="page-eyebrow">Connections</p>
        <h1>Providers</h1>
      </div>
      {providersQuery.isError && (
        <div className="settings-inline-error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>Providers could not be loaded.</span>
          <button onClick={() => void providersQuery.refetch()} type="button">Retry</button>
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
          const unsupported = provider.type !== 'mock';
          return (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card-heading">
                <span className="provider-icon"><Cloud aria-hidden="true" size={19} /></span>
                <div>
                  <h2>{provider.name}</h2>
                  <p>
                    {fixtureMode
                      ? 'Deterministic PR 1 fixture provider'
                      : unsupported
                        ? 'Stored configuration · runtime adapter unavailable in PR 2'
                        : 'Built-in deterministic Mock Provider'}
                  </p>
                </div>
                <span className={`provider-state ${provider.enabled ? '' : 'is-muted'}`}>
                  {provider.isDefault && <Check aria-hidden="true" size={14} />}
                  {provider.isDefault ? 'Default' : provider.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="provider-fields">
                <label>
                  <span>Provider type</span>
                  <input disabled value={providerTypeLabel(provider.type)} readOnly />
                </label>
                <label>
                  <span>Models</span>
                  <input
                    disabled
                    value={
                      models.length > 0
                        ? models.join(', ')
                        : modelsQuery.isPending
                          ? 'Loading models…'
                          : unsupported
                            ? 'Unavailable until adapter support'
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
                  {unsupported && <span className="is-warning">Unsupported runtime</span>}
                </div>
              )}
              <div className="provider-card-actions">
                <button
                  disabled={busy || unsupported || !provider.enabled}
                  onClick={() => void testConnection(provider)}
                  type="button"
                >
                  {!fixtureMode && <RefreshCw aria-hidden="true" size={14} />}
                  {result?.ok ? 'Connection ready' : 'Test connection'}
                </button>
                {!fixtureMode && !provider.isDefault && (
                  <button
                    disabled={busy || !provider.enabled}
                    onClick={() => setProviderState.mutate({ id: provider.id, values: { isDefault: true } })}
                    type="button"
                  >
                    <Check aria-hidden="true" size={14} />Make default
                  </button>
                )}
                {!fixtureMode && (
                  <button
                    disabled={busy}
                    onClick={() => setProviderState.mutate({ id: provider.id, values: { enabled: !provider.enabled } })}
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
    </>
  );
}
