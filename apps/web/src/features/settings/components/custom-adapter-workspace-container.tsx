import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle, X } from 'lucide-react';
import {
  CustomAdapterRefSchema,
  TrustedAdapterManifestSchema,
  type CustomAdapterDefinitionDto,
  type CustomAdapterRef,
  type ProviderDto,
  type TrustedAdapterBindingDto,
  type TrustedAdapterManagementDto,
} from '@imagine/shared';

import { InternalApiError } from '../../../api/internal-client.js';
import { useOnlineStatus } from '../../../hooks/use-runtime-state.js';
import {
  flattenCustomAdapterRevisionPages,
  flattenTrustedBindingPages,
  loadCustomAdapterExportData,
  readExportedYamlEnvelopeVersion,
  useBindTrustedAdapter,
  useCustomAdapterQuery,
  useCustomAdapterRevisionQuery,
  useCustomAdapterRevisionsQuery,
  useDeleteCustomAdapter,
  useDisableCustomAdapter,
  useDisableTrustedBinding,
  useDryRunCustomAdapter,
  useInstallTrustedAdapter,
  usePreviewCustomAdapter,
  usePreviewCustomAdapterCapabilities,
  usePutCustomAdapter,
  useRemoveTrustedAdapter,
  useSimulateCustomAdapter,
  useTestCustomAdapterPath,
  useTrustedAdapterQuery,
  useTrustedAdaptersQuery,
  useTrustedBindingQuery,
  useTrustedBindingsQuery,
  useUnbindTrustedBinding,
  useValidateCustomAdapter,
} from '../api/adapter-query.js';
import {
  CustomAdapterWorkspace,
  formatAdapterExportName,
  isAdapterRevisionDisabled,
  type AdapterRevision,
  type AdapterRevisionRef,
  type AdapterWorkspaceStatus,
  type CustomAdapterMode,
  type CustomAdapterWorkspaceActions,
  type CustomHttpDraft,
  type CustomHttpPreview,
  type ImportedAdapterDocument,
  type TrustedAdapterSummary,
  type TrustedJsDraft,
  type TrustedManifestSummary,
} from './custom-adapter-workspace.js';

export interface CustomAdapterWorkspaceContainerProps {
  readonly confirm?: (message: string) => boolean;
  readonly fixtureMode: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly provider: ProviderDto;
}

const EMPTY_REF: CustomAdapterRef = {
  kind: 'declarative-http',
  adapterId: 'adapter-placeholder',
  version: '0.0.0',
  digest: '0'.repeat(64),
};

function toRef(value: CustomAdapterRef): AdapterRevisionRef {
  return {
    kind: value.kind,
    adapterId: value.adapterId,
    version: value.version,
    digest: value.digest,
  };
}

function fromRef(value: AdapterRevisionRef): CustomAdapterRef {
  return CustomAdapterRefSchema.parse(value);
}

function refsEqual(left: CustomAdapterRef, right: CustomAdapterRef): boolean {
  return left.kind === right.kind && left.adapterId === right.adapterId && left.version === right.version && left.digest === right.digest;
}

function trustedManifestSummary(manifest: TrustedAdapterManagementDto['manifest']): TrustedManifestSummary {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    displayName: manifest.displayName,
    sha256: manifest.sha256,
    capabilities: manifest.capabilities,
    operations: manifest.operations,
    allowedHosts: manifest.allowedHosts,
    requiredSecrets: manifest.requiredSecrets,
    resourceLimits: manifest.resourceLimits,
  };
}

function trustedAdapterSummary(adapter: TrustedAdapterManagementDto): TrustedAdapterSummary {
  return {
    adapterId: adapter.ref.adapterId,
    version: adapter.ref.version,
    displayName: adapter.manifest.displayName,
    ref: toRef(adapter.ref),
    manifest: trustedManifestSummary(adapter.manifest),
    updatedAt: adapter.updatedAt,
  };
}

export const mapTrustedAdapterToSummary = trustedAdapterSummary;

function bindingSummary(binding: TrustedAdapterBindingDto | null): TrustedAdapterSummary | null {
  return binding === null ? null : trustedAdapterSummary(binding.adapter);
}

function customRevisionSummary(item: CustomAdapterDefinitionDto): AdapterRevision {
  return {
    ...toRef(item.ref),
    current: item.isCurrent,
    disabled: item.disabled,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    displayName: typeof item.definition?.name === 'string' ? item.definition.name : item.ref.adapterId,
  };
}

export const mapCustomRevisionToSummary = customRevisionSummary;

function trustedBindingRevisionSummary(item: TrustedAdapterBindingDto): AdapterRevision {
  return {
    ...toRef(item.adapter.ref),
    current: item.isCurrent,
    disabled: item.disabled,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    displayName: item.adapter.manifest.displayName,
  };
}

export const mapTrustedBindingRevisionToSummary = trustedBindingRevisionSummary;

export function projectTrustedWorkspaceState(
  currentOrDisabled: TrustedAdapterBindingDto | null,
  visibleHistory: readonly TrustedAdapterBindingDto[],
): {
  readonly binding: TrustedAdapterBindingDto | null;
  readonly bindingHistory: readonly AdapterRevision[];
} {
  return {
    binding: currentOrDisabled,
    bindingHistory: visibleHistory.map(trustedBindingRevisionSummary),
  };
}

function workspaceRefKey(ref: CustomAdapterRef | null | undefined): readonly string[] | null {
  return ref === null || ref === undefined
    ? null
    : [ref.kind, ref.adapterId, ref.version, ref.digest];
}

export function customAdapterWorkspaceKey(input: {
  readonly providerId: string;
  readonly mode: CustomAdapterMode;
  readonly customRef?: CustomAdapterRef | null;
  readonly trustedBindingRef?: CustomAdapterRef | null;
  readonly trustedLookupRef?: CustomAdapterRef | null;
}): string {
  return JSON.stringify([
    input.providerId,
    input.mode,
    workspaceRefKey(input.customRef),
    workspaceRefKey(input.trustedBindingRef),
    workspaceRefKey(input.trustedLookupRef),
  ]);
}

function customDraft(definition: CustomAdapterDefinitionDto | null): Partial<CustomHttpDraft> {
  return definition?.definition === null || definition?.definition === undefined
    ? {}
    : { document: JSON.stringify(definition.definition, null, 2), version: definition.ref.version };
}

export const mapCustomDefinitionToDraft = customDraft;

function trustedDraft(binding: TrustedAdapterBindingDto | null): Partial<TrustedJsDraft> {
  return binding === null
    ? {}
    : { manifest: JSON.stringify(binding.adapter.manifest, null, 2) };
}

export const mapTrustedBindingToDraft = trustedDraft;

function documentFormatForFile(file: File): 'json' | 'yaml' {
  const lowerName = file.name.toLowerCase();
  return file.type === 'application/yaml' || file.type === 'text/yaml' || lowerName.endsWith('.yaml') || lowerName.endsWith('.yml') ? 'yaml' : 'json';
}

export async function readImportedDocument(file: File): Promise<ImportedAdapterDocument> {
  const format = documentFormatForFile(file);
  const text = await file.text();
  if (format === 'json') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        if (candidate.schemaVersion === 1 && typeof candidate.version === 'string' && candidate.definition !== undefined) {
          return { document: JSON.stringify(candidate.definition, null, 2), format, version: candidate.version };
        }
      }
    } catch {
      // Keep invalid input in the editor so the inline validator can explain it.
    }
  }
  const version = format === 'yaml' ? readExportedYamlEnvelopeVersion(text) : undefined;
  return { document: text, format, ...(version === undefined ? {} : { version }) };
}

function toPreview(value: unknown): CustomHttpPreview | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.method !== 'string' || typeof candidate.url !== 'string') return null;
  if (candidate.headers === null || typeof candidate.headers !== 'object' || Array.isArray(candidate.headers)) return null;
  if (candidate.query === null || typeof candidate.query !== 'object' || Array.isArray(candidate.query)) return null;
  if (candidate.body === null || typeof candidate.body !== 'object' || Array.isArray(candidate.body)) return null;
  return candidate as unknown as CustomHttpPreview;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 && error.message.length < 320 ? error.message : fallback;
}

function isAdminError(error: unknown): boolean {
  return error instanceof InternalApiError && (error.code === 'administrator_required' || error.status === 403);
}

function downloadText(text: string, filename: string, contentType: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Records container-level failures while preserving the outer action contract. */
export async function executeAdapterAction(
  label: string,
  task: () => Promise<void>,
  onError: (message: string) => void,
  onAdminError?: () => void,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (isAdminError(error)) onAdminError?.();
    onError(errorMessage(error, `${label} failed.`));
    throw error;
  }
}

export function CustomAdapterWorkspaceContainer({
  confirm: confirmAction,
  fixtureMode,
  onOpenChange,
  open,
  provider,
}: CustomAdapterWorkspaceContainerProps) {
  const isCustomHttp = provider.type === 'custom-http-v1';
  const isTrustedJs = provider.type === 'custom-js-v1';
  const online = useOnlineStatus();
  const [adminAvailable, setAdminAvailable] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<CustomAdapterRef | null>(null);
  const [trustedLookupId, setTrustedLookupId] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const customCurrentQuery = useCustomAdapterQuery(provider.id, fixtureMode, isCustomHttp);
  const customRevisionsQuery = useCustomAdapterRevisionsQuery(provider.id, {}, fixtureMode, isCustomHttp);
  const customRevisionQuery = useCustomAdapterRevisionQuery(
    provider.id,
    selectedRevision ?? customCurrentQuery.data?.definition.ref ?? EMPTY_REF,
    fixtureMode,
    isCustomHttp && selectedRevision !== null,
  );
  const trustedBindingQuery = useTrustedBindingQuery(provider.id, undefined, fixtureMode, isTrustedJs);
  const trustedBindingsQuery = useTrustedBindingsQuery(provider.id, {}, fixtureMode, isTrustedJs);
  const trustedAdaptersQuery = useTrustedAdaptersQuery(fixtureMode, isTrustedJs);
  const trustedLookupQuery = useTrustedAdapterQuery(trustedLookupId || 'adapter-placeholder', fixtureMode, isTrustedJs && trustedLookupId.length > 0);

  const validate = useValidateCustomAdapter(fixtureMode);
  const preview = usePreviewCustomAdapter(fixtureMode);
  const dryRun = useDryRunCustomAdapter(fixtureMode);
  const simulate = useSimulateCustomAdapter(fixtureMode);
  const pathTest = useTestCustomAdapterPath(fixtureMode);
  const capabilities = usePreviewCustomAdapterCapabilities(fixtureMode);
  const put = usePutCustomAdapter(fixtureMode);
  const deleteCurrent = useDeleteCustomAdapter(fixtureMode);
  const disableCustom = useDisableCustomAdapter(fixtureMode);
  const installTrusted = useInstallTrustedAdapter(fixtureMode);
  const bindTrusted = useBindTrustedAdapter(fixtureMode);
  const disableTrustedBinding = useDisableTrustedBinding(fixtureMode);
  const unbindTrusted = useUnbindTrustedBinding(fixtureMode);
  const removeTrusted = useRemoveTrustedAdapter(fixtureMode);
  const ask = (prompt: string): boolean => confirmAction ? confirmAction(prompt) : typeof window === 'undefined' ? true : window.confirm(prompt);

  useEffect(() => {
    if (!open) return undefined;
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    setDirty(false);
    setMessage(null);
    setAdminAvailable(true);
    return undefined;
  }, [open, provider.id]);

  useEffect(() => {
    if (typeof window === 'undefined' || !open) return undefined;
    const viewport = window.visualViewport;
    if (!viewport) return undefined;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty('--keyboard-offset', `${Math.round(offset)}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      document.documentElement.style.setProperty('--keyboard-offset', '0px');
    };
  }, [open]);

  const currentCustomDefinition = isCustomHttp ? customCurrentQuery.data?.definition ?? null : null;
  const customDefinition = isCustomHttp
    ? selectedRevision === null
      ? currentCustomDefinition
      : customRevisionQuery.data?.definition ?? null
    : null;
  const customRevisionItems = useMemo(() => flattenCustomAdapterRevisionPages(customRevisionsQuery.data).map(customRevisionSummary), [customRevisionsQuery.data]);
  const trustedBindingRecords = useMemo(() => flattenTrustedBindingPages(trustedBindingsQuery.data), [trustedBindingsQuery.data]);
  const trustedWorkspaceState = useMemo(() => projectTrustedWorkspaceState(
    isTrustedJs ? trustedBindingQuery.data?.binding ?? null : null,
    trustedBindingRecords,
  ), [isTrustedJs, trustedBindingQuery.data?.binding, trustedBindingRecords]);
  const trustedBinding = trustedWorkspaceState.binding;
  const trustedBindingItems = trustedWorkspaceState.bindingHistory;
  const trustedItems = useMemo(() => (trustedAdaptersQuery.data?.items ?? []).map((item) => trustedAdapterSummary(item)), [trustedAdaptersQuery.data?.items]);
  const queryError = isCustomHttp
    ? customCurrentQuery.error ?? customRevisionsQuery.error
    : trustedBindingQuery.error ?? trustedBindingsQuery.error ?? trustedAdaptersQuery.error;
  const exactRevisionPending = isCustomHttp && selectedRevision !== null && (customRevisionQuery.isPending || customRevisionQuery.isFetching);
  const exactRevisionError = isCustomHttp && selectedRevision !== null ? customRevisionQuery.error : null;
  const trustedLookupPending = isTrustedJs && trustedLookupId.length > 0 && (trustedLookupQuery.isPending || trustedLookupQuery.isFetching);
  const trustedLookupError = isTrustedJs && trustedLookupId.length > 0 ? trustedLookupQuery.error : null;
  const effectiveQueryError = exactRevisionError ?? trustedLookupError ?? queryError;

  const loading = exactRevisionPending || trustedLookupPending || (isCustomHttp
    ? customCurrentQuery.isPending || customRevisionsQuery.isPending
    : trustedBindingQuery.isPending || trustedBindingsQuery.isPending || trustedAdaptersQuery.isPending);
  const status: AdapterWorkspaceStatus = !online
    ? 'offline'
    : !adminAvailable
      ? 'admin-unavailable'
    : isAdminError(effectiveQueryError)
      ? 'admin-unavailable'
      : effectiveQueryError
        ? 'error'
        : loading
          ? 'loading'
          : (isCustomHttp ? customDefinition?.disabled : trustedBinding?.disabled) === true
            ? 'disabled'
            : (isCustomHttp ? customDefinition !== null || customRevisionItems.length > 0 : trustedBinding !== null || trustedItems.length > 0)
              ? 'success'
              : 'empty';
  const currentTrustedSummary = bindingSummary(trustedBinding);
  const retryFailedQueries = async () => {
    const requests: Array<() => Promise<unknown>> = [];
    if (isCustomHttp) {
      if (customCurrentQuery.error) requests.push(() => customCurrentQuery.refetch());
      if (customRevisionsQuery.error) requests.push(() => customRevisionsQuery.refetch());
      if (exactRevisionError) requests.push(() => customRevisionQuery.refetch());
    } else {
      if (trustedBindingQuery.error) requests.push(() => trustedBindingQuery.refetch());
      if (trustedBindingsQuery.error) requests.push(() => trustedBindingsQuery.refetch());
      if (trustedAdaptersQuery.error) requests.push(() => trustedAdaptersQuery.refetch());
      if (trustedLookupError) requests.push(() => trustedLookupQuery.refetch());
    }
    await Promise.all(requests.map((request) => request()));
  };

  const execute = async (label: string, task: () => Promise<void>) => {
    setPendingAction(label);
    setMessage(null);
    try {
      await executeAdapterAction(label, task, setMessage, () => setAdminAvailable(false));
    } finally {
      setPendingAction(null);
    }
  };

  const actions: CustomAdapterWorkspaceActions = {
    onCustomHttpChange: () => setDirty(true),
    onTrustedJsChange: () => setDirty(true),
    onImportDocument: (file) => readImportedDocument(file),
    onValidate: (payload) => execute('Validate', async () => {
      await validate.mutateAsync({ providerId: provider.id, request: { document: payload.document, format: payload.format, ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}), ...(payload.request === undefined ? {} : { request: payload.request as never }) } });
    }),
    onPreview: (payload) => execute('Preview', async () => {
      await preview.mutateAsync({ providerId: provider.id, request: { document: payload.document, format: payload.format, ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}), ...(payload.request === undefined ? {} : { request: payload.request as never }) } });
    }),
    onDryRun: (payload) => execute('Dry run', async () => {
      await dryRun.mutateAsync({ providerId: provider.id, request: { document: payload.document, format: payload.format, ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}), ...(payload.request === undefined ? {} : { request: payload.request as never }) } });
    }),
    onSimulate: (payload) => execute('Simulate', async () => {
      await simulate.mutateAsync({ providerId: provider.id, request: { document: payload.document, format: payload.format, response: payload.response } as never });
    }),
    onPathTest: (payload) => execute('Path test', async () => {
      await pathTest.mutateAsync({ providerId: provider.id, request: { path: payload.path, json: payload.json } });
    }),
    onCapabilitiesPreview: (payload) => execute('Capability preview', async () => {
      await capabilities.mutateAsync({ providerId: provider.id, request: { document: payload.document, format: payload.format } });
    }),
    onSave: (payload) => execute('Save', async () => {
      await put.mutateAsync({ providerId: provider.id, document: payload.document, formatOrOptions: { format: payload.format, version: payload.version ?? '1.0.0' } });
      setDirty(false);
    }),
    onExport: (payload) => execute('Export', async () => {
      const ref = payload.ref === undefined ? undefined : fromRef(payload.ref);
      const result = await loadCustomAdapterExportData(fixtureMode, provider.id, { format: payload.format, ...(ref === undefined ? {} : { ref }) });
      const fallbackRef = ref ?? customDefinition?.ref ?? EMPTY_REF;
      downloadText(result.text, result.filename ?? formatAdapterExportName(toRef(fallbackRef), payload.format), result.contentType);
    }),
    onLoadRevision: (revision) => {
      if (dirty && !ask(`Discard unsaved changes and load revision ${revision.version}?`)) return false;
      setDirty(false);
      setSelectedRevision(fromRef(revision));
      setMessage(`Loaded revision ${revision.version}.`);
    },
    onLoadMoreRevisions: () => execute('Load more revisions', async () => { await customRevisionsQuery.fetchNextPage(); }),
    onLoadMoreTrustedBindings: () => execute('Load more binding history', async () => { await trustedBindingsQuery.fetchNextPage(); }),
    onDisable: (revision) => {
      if (!ask(`Disable adapter revision ${revision?.version ?? 'current'}?`)) return false;
      return execute('Disable', async () => { await disableCustom.mutateAsync({ providerId: provider.id, ...(revision === undefined ? {} : { ref: fromRef(revision) }) }); });
    },
    onDelete: (revision) => {
      if (revision !== undefined) {
        const exact = fromRef(revision);
        if (currentCustomDefinition?.ref === undefined || !refsEqual(currentCustomDefinition.ref, exact)) {
          setMessage('Only the current revision can be deleted by this Provider API.');
          return false;
        }
      }
      if (!ask(`Delete adapter revision ${revision?.version ?? 'current'}?`)) return false;
      return execute('Delete', async () => { await deleteCurrent.mutateAsync(provider.id); setDirty(false); });
    },
    onManifestFileImport: (file) => file.text(),
    onSourceFileSelect: () => setDirty(true),
    onInstall: (payload) => execute('Install', async () => {
      const manifest = TrustedAdapterManifestSchema.parse(payload.manifest);
      await installTrusted.mutateAsync({ manifest, source: payload.source, ...(payload.providerId ? { providerId: payload.providerId } : {}) });
      setDirty(false);
    }),
    onListTrusted: () => execute('List', async () => { await trustedAdaptersQuery.refetch(); }),
    onGetTrusted: (adapterId) => {
      setTrustedLookupId(adapterId);
      setMessage(`Loading ${adapterId}.`);
    },
    onRemoveTrusted: (adapterId) => {
      if (!ask(`Remove trusted adapter ${adapterId}?`)) return false;
      return execute('Remove', async () => { await removeTrusted.mutateAsync(adapterId); });
    },
    onBindProvider: (payload) => execute('Bind', async () => {
      if (payload.ref === undefined) throw new Error('Choose an installed adapter before binding.');
      if (isAdapterRevisionDisabled(payload.ref, trustedBindingItems)) {
        throw new Error('Disabled trusted adapter revisions cannot be rebound.');
      }
      const ref = fromRef(payload.ref);
      if (payload.ref.kind !== 'trusted-javascript') throw new Error('Choose a trusted JavaScript adapter before binding.');
      await bindTrusted.mutateAsync({ providerId: payload.providerId, ref: { ...ref, kind: 'trusted-javascript' } });
    }),
    onDisableProviderBinding: (ref) => {
      if (!ask('Disable this Provider binding?')) return false;
      return execute('Disable binding', async () => { await disableTrustedBinding.mutateAsync({ providerId: provider.id, ...(ref ? { ref: fromRef(ref) } : {}) }); });
    },
    onUnbindProvider: (ref) => {
      if (ref === undefined) return false;
      if (!ask('Unbind this Provider?')) return false;
      return execute('Unbind', async () => { await unbindTrusted.mutateAsync({ providerId: provider.id, ref: fromRef(ref) }); });
    },
  };

  const trustedLookup = trustedLookupQuery.data?.adapter;
  const loadedCustomRef = customDefinition?.ref ?? selectedRevision;
  const statusMessage = message ?? (pendingAction ? `${pendingAction} in progress.` : undefined);
  const close = () => {
    if (dirty && !ask('Discard unsaved adapter changes?')) return;
    setDirty(false);
    const restore = restoreFocusRef.current;
    onOpenChange(false);
    if (restore && typeof window !== 'undefined') window.setTimeout(() => restore.focus(), 0);
  };
  const displayTrustedItems = trustedLookup === undefined
    ? trustedItems
    : [...trustedItems.filter((item) => item.adapterId !== trustedLookup.ref.adapterId), trustedAdapterSummary(trustedLookup)];

  return (
    <Dialog.Root open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
      {open && (
        <Dialog.Portal>
          <Dialog.Overlay className="custom-adapter-dialog-overlay" />
          <Dialog.Content
            aria-describedby="custom-adapter-workspace-description"
            className="custom-adapter-dialog-content"
            onOpenAutoFocus={(event) => { event.preventDefault(); closeButtonRef.current?.focus(); }}
          >
            <header className="custom-adapter-dialog-header">
              <div>
                <p className="page-eyebrow">Adapter workspace</p>
                <Dialog.Title>{provider.name}</Dialog.Title>
                <Dialog.Description id="custom-adapter-workspace-description">{isCustomHttp ? 'Declarative HTTP adapter' : isTrustedJs ? 'Trusted JavaScript adapter' : 'Unsupported adapter profile'}</Dialog.Description>
              </div>
              <button aria-label="Close adapter workspace" className="custom-adapter-dialog-close" onClick={close} ref={closeButtonRef} title="Close adapter workspace" type="button"><X aria-hidden="true" size={18} /></button>
            </header>
            <div className="custom-adapter-dialog-body">
              {effectiveQueryError && (
                <div className="settings-inline-error" role="alert"><span>{errorMessage(effectiveQueryError, 'Adapter data could not be loaded.')}</span><button onClick={() => void retryFailedQueries()} type="button">Retry</button></div>
              )}
              {exactRevisionPending ? (
                <div aria-live="polite" className="custom-adapter-revision-loading" data-testid="custom-adapter-revision-loading" role="status">Loading selected revision</div>
              ) : exactRevisionError ? (
                <div aria-live="polite" className="custom-adapter-revision-error" data-testid="custom-adapter-revision-error" role="alert">Select Retry to load the revision.</div>
              ) : isCustomHttp || isTrustedJs ? (
                <CustomAdapterWorkspace
                  key={customAdapterWorkspaceKey({
                    providerId: provider.id,
                    mode: isCustomHttp ? 'custom-http' : 'trusted-js',
                    customRef: loadedCustomRef ?? null,
                    trustedBindingRef: trustedBinding?.adapter.ref ?? null,
                    trustedLookupRef: trustedLookup?.ref ?? null,
                  })}
                  actions={actions}
                  adminAvailable={adminAvailable}
                  capabilityPreview={capabilities.data}
                  customHttp={customDraft(customDefinition)}
                  mode={isCustomHttp ? 'custom-http' : 'trusted-js'}
                  modeLocked
                  online={online}
                  pathTestResult={pathTest.data}
                  preview={toPreview(preview.data)}
                  providerId={provider.id}
                  revisions={isCustomHttp ? customRevisionItems : trustedBindingItems}
                  revisionsCursor={isCustomHttp ? customRevisionsQuery.hasNextPage ? 'next' : null : trustedBindingsQuery.hasNextPage ? 'next' : null}
                  simulationResult={simulate.data}
                  status={exactRevisionError ? 'error' : status}
                  statusMessage={statusMessage ?? ''}
                  dryRunResult={dryRun.data}
                  trustedAdapterRef={currentTrustedSummary?.ref ?? null}
                  trustedAdapters={displayTrustedItems}
                  trustedBinding={currentTrustedSummary}
                  trustedBindingDisabled={trustedBinding?.disabled ?? false}
                  trustedBindingHistory={trustedBindingItems}
                  trustedBindingHistoryCursor={trustedBindingsQuery.hasNextPage ? 'next' : null}
                  trustedJs={trustedLookup ? { manifest: JSON.stringify(trustedLookup.manifest) } : trustedDraft(trustedBinding)}
                />
              ) : (
                <div className="settings-inline-error" role="alert">Unsupported Provider adapter profile.</div>
              )}
              {pendingAction && <p aria-live="polite" className="custom-adapter-dialog-pending" role="status"><LoaderCircle aria-hidden="true" className="is-spinning" size={15} />{pendingAction} in progress</p>}
            </div>
            <footer className="custom-adapter-dialog-footer"><span aria-live="polite" role="status">{dirty ? 'Unsaved changes' : status === 'success' ? 'Saved' : ''}</span><button aria-label="Close adapter workspace" className="custom-adapter-dialog-footer-close" onClick={close} type="button">Done</button></footer>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
