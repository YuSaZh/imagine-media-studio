import { useEffect, useMemo, useReducer, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle, X } from 'lucide-react';
import {
  CustomAdapterRefSchema,
  TrustedAdapterManifestSchema,
  type CustomAdapterDefinitionDto,
  type CustomAdapterDefinitionResponse,
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
} from '../model/adapter-workspace.js';
import { CustomAdapterWorkspace } from '../../workspace/adapter-workspace.js';

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

/**
 * AdapterRevision values also carry display state. Keep only the immutable
 * reference fields before crossing the strict API/schema boundary.
 */
export function projectAdapterRevisionRef(value: AdapterRevisionRef): CustomAdapterRef {
  return CustomAdapterRefSchema.parse({
    kind: value.kind,
    adapterId: value.adapterId,
    version: value.version,
    digest: value.digest,
  });
}

const fromRef = projectAdapterRevisionRef;

function refsEqual(left: CustomAdapterRef, right: CustomAdapterRef): boolean {
  return left.kind === right.kind && left.adapterId === right.adapterId && left.version === right.version && left.digest === right.digest;
}

const EXACT_REVISION_NOT_FOUND_ERROR = new InternalApiError(
  404,
  'adapter_not_found',
  'The selected adapter revision was not found.',
);

/** Only an exact immutable ref may populate the revision editor. */
export function resolveExactAdapterDefinition(
  response: CustomAdapterDefinitionResponse | null | undefined,
  ref: CustomAdapterRef,
): CustomAdapterDefinitionDto | null {
  const definition = response?.definition ?? null;
  return definition !== null && refsEqual(definition.ref, ref) ? definition : null;
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

type CustomHttpLocalDraft = Pick<
  CustomHttpDraft,
  'format' | 'document' | 'version' | 'baseUrl' | 'requestJson' | 'simulationStatus' | 'simulationJson' | 'path' | 'pathTestJson'
>;

export interface CustomAdapterWorkspaceContainerState {
  readonly adminAvailable: boolean;
  readonly actionError: string | null;
  readonly customLocalDraft: Partial<CustomHttpLocalDraft>;
  readonly dirty: boolean;
  readonly message: string | null;
  readonly pendingAction: string | null;
  readonly preserveCustomDocument: boolean;
  readonly selectedRevision: CustomAdapterRef | null;
  readonly trustedLookupId: string;
}

export type CustomAdapterWorkspaceContainerAction =
  | { readonly type: 'reset' }
  | { readonly type: 'set-admin-available'; readonly value: boolean }
  | { readonly type: 'set-action-error'; readonly value: string | null }
  | { readonly type: 'set-custom-local-draft'; readonly value: Partial<CustomHttpLocalDraft> }
  | { readonly type: 'clear-custom-document-draft' }
  | { readonly type: 'set-dirty'; readonly value: boolean }
  | { readonly type: 'set-message'; readonly value: string | null }
  | { readonly type: 'set-pending-action'; readonly value: string | null }
  | { readonly type: 'set-preserve-custom-document'; readonly value: boolean }
  | { readonly type: 'set-selected-revision'; readonly value: CustomAdapterRef | null }
  | { readonly type: 'set-trusted-lookup-id'; readonly value: string }
  | { readonly type: 'delete-current-success' }
  | { readonly type: 'delete-current-success-preserve-draft' };

export function createCustomAdapterWorkspaceContainerState(): CustomAdapterWorkspaceContainerState {
  return {
    adminAvailable: true,
    actionError: null,
    customLocalDraft: {},
    dirty: false,
    message: null,
    pendingAction: null,
    preserveCustomDocument: false,
    selectedRevision: null,
    trustedLookupId: '',
  };
}

/** Keeps lifecycle resets and post-delete state changes atomic and testable. */
export function reduceCustomAdapterWorkspaceContainerState(
  state: CustomAdapterWorkspaceContainerState,
  action: CustomAdapterWorkspaceContainerAction,
): CustomAdapterWorkspaceContainerState {
  switch (action.type) {
    case 'reset':
      return createCustomAdapterWorkspaceContainerState();
    case 'set-admin-available':
      return { ...state, adminAvailable: action.value };
    case 'set-action-error':
      return { ...state, actionError: action.value };
    case 'set-custom-local-draft':
      return { ...state, customLocalDraft: action.value };
    case 'clear-custom-document-draft': {
      const { document: _document, version: _version, ...localDraft } = state.customLocalDraft;
      return { ...state, customLocalDraft: localDraft, preserveCustomDocument: false };
    }
    case 'set-dirty':
      return { ...state, dirty: action.value };
    case 'set-message':
      return { ...state, message: action.value };
    case 'set-pending-action':
      return { ...state, pendingAction: action.value };
    case 'set-preserve-custom-document':
      return { ...state, preserveCustomDocument: action.value };
    case 'set-selected-revision':
      return { ...state, selectedRevision: action.value };
    case 'set-trusted-lookup-id':
      return { ...state, trustedLookupId: action.value };
    case 'delete-current-success':
      return {
        ...state,
        actionError: null,
        customLocalDraft: {},
        dirty: false,
        preserveCustomDocument: false,
        selectedRevision: null,
      };
    case 'delete-current-success-preserve-draft':
      return {
        ...state,
        actionError: null,
        preserveCustomDocument: true,
        selectedRevision: null,
      };
  }
}

/** Dispatches the destructive cleanup only after the server mutation succeeds. */
export async function executeDeleteCurrentMutation(
  mutation: () => Promise<unknown>,
  dispatch: (action: CustomAdapterWorkspaceContainerAction) => void,
  shouldClearDraft: () => boolean = () => true,
): Promise<void> {
  await mutation();
  dispatch({ type: shouldClearDraft() ? 'delete-current-success' : 'delete-current-success-preserve-draft' });
}

/** Commits mutation state only when no newer local edit happened in flight. */
export async function executeMutationWithEditGuard(
  mutation: () => Promise<unknown>,
  snapshot: number,
  currentRevision: () => number,
  onUnchanged: () => void,
  onChanged?: () => void,
): Promise<void> {
  await mutation();
  if (currentRevision() === snapshot) onUnchanged();
  else onChanged?.();
}

function customDraft(
  definition: CustomAdapterDefinitionDto | null,
  localDraft: Partial<CustomHttpLocalDraft> = {},
  preserveDocument = false,
): Partial<CustomHttpDraft> {
  const { document: localDocument, version: localVersion, ...ephemeralDraft } = localDraft;
  return {
    ...(definition?.definition === null || definition?.definition === undefined
      ? {}
      : { document: JSON.stringify(definition.definition, null, 2), version: definition.ref.version }),
    ...(preserveDocument
      ? {
          ...(localDocument === undefined ? {} : { document: localDocument }),
          ...(localVersion === undefined ? {} : { version: localVersion }),
        }
      : {}),
    ...ephemeralDraft,
  };
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

export function resolveAdapterWorkspaceStatus(input: {
  readonly actionError?: string | null;
  readonly adminAvailable: boolean;
  readonly disabled: boolean;
  readonly hasData: boolean;
  readonly loading: boolean;
  readonly online: boolean;
  readonly queryError: unknown;
}): AdapterWorkspaceStatus {
  return !input.online
    ? 'offline'
    : !input.adminAvailable
      ? 'admin-unavailable'
      : isAdminError(input.queryError)
        ? 'admin-unavailable'
        : input.actionError !== null && input.actionError !== undefined
          ? 'error'
          : input.queryError
            ? 'error'
            : input.loading
              ? 'loading'
              : input.disabled
                ? 'disabled'
                : input.hasData
                  ? 'success'
                  : 'empty';
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

/** Records durable container-level feedback while preserving the outer action contract. */
export async function executeAdapterAction(
  label: string,
  task: () => Promise<void>,
  onMessage: (message: string) => void,
  onAdminError?: () => void,
  onActionError?: (message: string) => void,
): Promise<void> {
  try {
    await task();
    onMessage(`${label} complete.`);
  } catch (error) {
    if (isAdminError(error)) onAdminError?.();
    const failureMessage = errorMessage(error, `${label} failed.`);
    onMessage(failureMessage);
    onActionError?.(failureMessage);
    throw error;
  }
}

export function customAdapterWorkspaceContainerKey(input: {
  readonly open: boolean;
  readonly providerId: string;
  readonly providerType: ProviderDto['type'];
}): string {
  return JSON.stringify([input.providerId, input.providerType, input.open]);
}

/**
 * Keep session state below an identity boundary. Provider settings can swap
 * the managed Provider while the dialog remains open, and an effect-based
 * reset would otherwise run after the first render/query for the new identity.
 */
export function CustomAdapterWorkspaceContainer(props: CustomAdapterWorkspaceContainerProps) {
  return (
    <CustomAdapterWorkspaceContainerContent
      key={customAdapterWorkspaceContainerKey({
        open: props.open,
        providerId: props.provider.id,
        providerType: props.provider.type,
      })}
      {...props}
    />
  );
}

function CustomAdapterWorkspaceContainerContent({
  confirm: confirmAction,
  fixtureMode,
  onOpenChange,
  open,
  provider,
}: CustomAdapterWorkspaceContainerProps) {
  const isCustomHttp = provider.type === 'custom-http-v1';
  const isTrustedJs = provider.type === 'custom-js-v1';
  const online = useOnlineStatus();
  const [session, dispatch] = useReducer(
    reduceCustomAdapterWorkspaceContainerState,
    undefined,
    createCustomAdapterWorkspaceContainerState,
  );
  const {
    adminAvailable,
    actionError,
    customLocalDraft,
    dirty,
    message,
    pendingAction,
    preserveCustomDocument,
    selectedRevision,
    trustedLookupId,
  } = session;
  // The keyed workspace intentionally remounts for a new immutable revision.
  // Keep fields that are local test input so that remount cannot erase them.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const editRevisionRef = useRef(0);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const customCurrentQuery = useCustomAdapterQuery(provider.id, fixtureMode, open && isCustomHttp);
  const customRevisionsQuery = useCustomAdapterRevisionsQuery(provider.id, {}, fixtureMode, open && isCustomHttp);
  const customRevisionQuery = useCustomAdapterRevisionQuery(
    provider.id,
    selectedRevision ?? customCurrentQuery.data?.definition.ref ?? EMPTY_REF,
    fixtureMode,
    open && isCustomHttp && selectedRevision !== null,
  );
  const trustedBindingQuery = useTrustedBindingQuery(provider.id, undefined, fixtureMode, open && isTrustedJs);
  const trustedBindingsQuery = useTrustedBindingsQuery(provider.id, {}, fixtureMode, open && isTrustedJs);
  const trustedAdaptersQuery = useTrustedAdaptersQuery(fixtureMode, open && isTrustedJs);
  const trustedLookupQuery = useTrustedAdapterQuery(trustedLookupId || 'adapter-placeholder', fixtureMode, open && isTrustedJs && trustedLookupId.length > 0);

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
    if (open && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    dispatch({ type: 'reset' });
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
  const exactCustomDefinition = selectedRevision === null
    ? null
    : resolveExactAdapterDefinition(customRevisionQuery.data, selectedRevision);
  const customDefinition = isCustomHttp
    ? selectedRevision === null
      ? currentCustomDefinition
      : exactCustomDefinition
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
  const exactRevisionMissing = isCustomHttp && selectedRevision !== null && !exactRevisionPending && (exactRevisionError === null || exactRevisionError === undefined) && exactCustomDefinition === null;
  const resolvedExactRevisionError = exactRevisionError ?? (exactRevisionMissing ? EXACT_REVISION_NOT_FOUND_ERROR : null);
  const trustedLookupPending = isTrustedJs && trustedLookupId.length > 0 && (trustedLookupQuery.isPending || trustedLookupQuery.isFetching);
  const trustedLookupError = isTrustedJs && trustedLookupId.length > 0 ? trustedLookupQuery.error : null;
  const effectiveQueryError = resolvedExactRevisionError ?? trustedLookupError ?? queryError;

  const loading = exactRevisionPending || trustedLookupPending || (isCustomHttp
    ? customCurrentQuery.isPending || customRevisionsQuery.isPending
    : trustedBindingQuery.isPending || trustedBindingsQuery.isPending || trustedAdaptersQuery.isPending);
  const status = resolveAdapterWorkspaceStatus({
    actionError,
    adminAvailable,
    disabled: (isCustomHttp ? customDefinition?.disabled : trustedBinding?.disabled) === true,
    hasData: isCustomHttp ? customDefinition !== null || customRevisionItems.length > 0 : trustedBinding !== null || trustedItems.length > 0,
    loading,
    online,
    queryError: effectiveQueryError,
  });

  useEffect(() => {
    if (!isCustomHttp || selectedRevision === null || exactRevisionPending || resolvedExactRevisionError !== null || exactCustomDefinition === null) return;
    dispatch({ type: 'set-message', value: `Loaded revision ${selectedRevision.version}.` });
  }, [exactCustomDefinition, exactRevisionPending, isCustomHttp, resolvedExactRevisionError, selectedRevision]);

  const currentTrustedSummary = bindingSummary(trustedBinding);
  const retryFailedQueries = async () => {
    const requests: Array<() => Promise<unknown>> = [];
    if (isCustomHttp) {
      if (customCurrentQuery.error) requests.push(() => customCurrentQuery.refetch());
      if (customRevisionsQuery.error) requests.push(() => customRevisionsQuery.refetch());
      if (resolvedExactRevisionError) requests.push(() => customRevisionQuery.refetch());
    } else {
      if (trustedBindingQuery.error) requests.push(() => trustedBindingQuery.refetch());
      if (trustedBindingsQuery.error) requests.push(() => trustedBindingsQuery.refetch());
      if (trustedAdaptersQuery.error) requests.push(() => trustedAdaptersQuery.refetch());
      if (trustedLookupError) requests.push(() => trustedLookupQuery.refetch());
    }
    await Promise.all(requests.map((request) => request()));
  };

  const execute = async (label: string, task: () => Promise<void>) => {
    dispatch({ type: 'set-pending-action', value: label });
    dispatch({ type: 'set-message', value: null });
    dispatch({ type: 'set-action-error', value: null });
    try {
      await executeAdapterAction(
        label,
        task,
        (nextMessage) => dispatch({ type: 'set-message', value: nextMessage }),
        () => dispatch({ type: 'set-admin-available', value: false }),
        (nextMessage) => dispatch({ type: 'set-action-error', value: nextMessage }),
      );
    } finally {
      dispatch({ type: 'set-pending-action', value: null });
    }
  };

  const actions: CustomAdapterWorkspaceActions = {
    onCustomHttpChange: (draft) => {
      editRevisionRef.current += 1;
      dispatch({ type: 'set-action-error', value: null });
      dispatch({ type: 'set-dirty', value: true });
      dispatch({ type: 'set-preserve-custom-document', value: true });
      dispatch({
        type: 'set-custom-local-draft',
        value: {
          format: draft.format,
          document: draft.document,
          version: draft.version,
          baseUrl: draft.baseUrl,
          requestJson: draft.requestJson,
          simulationStatus: draft.simulationStatus,
          simulationJson: draft.simulationJson,
          path: draft.path,
          pathTestJson: draft.pathTestJson,
        },
      });
    },
    onTrustedJsChange: () => {
      editRevisionRef.current += 1;
      dispatch({ type: 'set-action-error', value: null });
      dispatch({ type: 'set-dirty', value: true });
    },
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
      const snapshot = editRevisionRef.current;
      await executeMutationWithEditGuard(
        () => put.mutateAsync({ providerId: provider.id, document: payload.document, formatOrOptions: { format: payload.format, version: payload.version ?? '1.0.0' } }),
        snapshot,
        () => editRevisionRef.current,
        () => {
          dispatch({ type: 'set-preserve-custom-document', value: false });
          dispatch({ type: 'set-dirty', value: false });
        },
        () => dispatch({ type: 'set-preserve-custom-document', value: true }),
      );
    }),
    onExport: (payload) => execute('Export', async () => {
      const ref = payload.ref === undefined ? undefined : fromRef(payload.ref);
      const result = await loadCustomAdapterExportData(fixtureMode, provider.id, { format: payload.format, ...(ref === undefined ? {} : { ref }) });
      const fallbackRef = ref ?? customDefinition?.ref ?? EMPTY_REF;
      downloadText(result.text, result.filename ?? formatAdapterExportName(toRef(fallbackRef), payload.format), result.contentType);
    }),
    onLoadRevision: (revision) => {
      if (dirty && !ask(`Discard unsaved changes and load revision ${revision.version}?`)) return false;
      dispatch({ type: 'set-action-error', value: null });
      dispatch({ type: 'clear-custom-document-draft' });
      dispatch({ type: 'set-dirty', value: false });
      dispatch({ type: 'set-selected-revision', value: fromRef(revision) });
      dispatch({ type: 'set-message', value: `Loading revision ${revision.version}.` });
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
          const failureMessage = 'Only the current revision can be deleted by this Provider API.';
          dispatch({ type: 'set-message', value: failureMessage });
          dispatch({ type: 'set-action-error', value: failureMessage });
          return false;
        }
      }
      if (!ask(`Delete adapter revision ${revision?.version ?? 'current'}?`)) return false;
      return execute('Delete', async () => {
        const exact = revision === undefined ? currentCustomDefinition?.ref : fromRef(revision);
        if (exact === undefined) throw new Error('A current adapter revision is required before deleting.');
        const snapshot = editRevisionRef.current;
        await executeDeleteCurrentMutation(
          () => deleteCurrent.mutateAsync({ providerId: provider.id, ref: exact }),
          dispatch,
          () => editRevisionRef.current === snapshot,
        );
      });
    },
    onManifestFileImport: (file) => file.text(),
    onSourceFileSelect: () => {
      editRevisionRef.current += 1;
      dispatch({ type: 'set-action-error', value: null });
      dispatch({ type: 'set-dirty', value: true });
    },
    onInstall: (payload) => execute('Install', async () => {
      const manifest = TrustedAdapterManifestSchema.parse(payload.manifest);
      const snapshot = editRevisionRef.current;
      await executeMutationWithEditGuard(
        () => installTrusted.mutateAsync({ manifest, source: payload.source, ...(payload.providerId ? { providerId: payload.providerId } : {}) }),
        snapshot,
        () => editRevisionRef.current,
        () => dispatch({ type: 'set-dirty', value: false }),
      );
    }),
    onListTrusted: () => execute('List', async () => { await trustedAdaptersQuery.refetch(); }),
    onGetTrusted: (adapterId) => {
      dispatch({ type: 'set-trusted-lookup-id', value: adapterId });
      dispatch({ type: 'set-message', value: `Loading ${adapterId}.` });
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
    dispatch({ type: 'set-dirty', value: false });
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
          <Dialog.Overlay className="panel-backdrop" />
          <Dialog.Content
            aria-describedby="custom-adapter-workspace-description"
            className="panel adapter-panel"
            onOpenAutoFocus={(event) => { event.preventDefault(); closeButtonRef.current?.focus(); }}
          >
            <header className="panel-header">
              <div>
                <Dialog.Title>{provider.name}</Dialog.Title>
                <Dialog.Description id="custom-adapter-workspace-description">{isCustomHttp ? '声明式 HTTP 适配器' : isTrustedJs ? '受信任 JavaScript 适配器' : '不支持的适配器类型'}</Dialog.Description>
              </div>
              <button aria-label="关闭适配器" className="tool" onClick={close} ref={closeButtonRef} title="关闭适配器" type="button"><X aria-hidden="true" size={18} /></button>
            </header>
            <div className="panel-body">
              {effectiveQueryError && (
                <div className="settings-inline-error" role="alert"><span>{errorMessage(effectiveQueryError, 'Adapter data could not be loaded.')}</span><button onClick={() => void retryFailedQueries()} type="button">Retry</button></div>
              )}
              {exactRevisionPending ? (
                <div aria-live="polite" className="custom-adapter-revision-loading" data-testid="custom-adapter-revision-loading" role="status">Loading selected revision</div>
              ) : resolvedExactRevisionError ? (
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
                  customHttp={customDraft(customDefinition, customLocalDraft, preserveCustomDocument)}
                  mode={isCustomHttp ? 'custom-http' : 'trusted-js'}
                  modeLocked
                  online={online}
                  pathTestResult={pathTest.data}
                  preview={toPreview(preview.data)}
                  providerId={provider.id}
                  revisions={isCustomHttp ? customRevisionItems : trustedBindingItems}
                  revisionsCursor={isCustomHttp ? customRevisionsQuery.hasNextPage ? 'next' : null : trustedBindingsQuery.hasNextPage ? 'next' : null}
                  simulationResult={simulate.data}
                  status={resolvedExactRevisionError ? 'error' : status}
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
            <footer className="adapter-footer"><span aria-live="polite" role="status">{actionError ?? (dirty ? '有未保存的修改' : status === 'success' ? '已保存' : '')}</span><button aria-label="关闭适配器" className="quiet-command" onClick={close} type="button">完成</button></footer>
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  );
}
