import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  AdapterIdParamsSchema,
  CustomAdapterCapabilityPreviewRequestSchema,
  CustomAdapterDryRunRequestSchema,
  CustomAdapterPreviewRequestSchema,
  CustomAdapterRefSchema,
  CustomAdapterRevisionListQuerySchema,
  CustomAdapterSimulateRequestSchema,
  CustomAdapterValidateRequestSchema,
  AdapterDocumentFormatSchema,
  ProviderIdSchema,
  TrustedAdapterRevisionListQuerySchema,
  type CustomAdapterCapabilityPreviewRequest,
  type CustomAdapterDocument,
  type CustomAdapterDefinitionPage,
  type CustomAdapterDefinitionResponse,
  type CustomAdapterDryRunRequest,
  type CustomAdapterDryRunResponse,
  type CustomAdapterExtractedResponse,
  type CustomAdapterPathTestRequest,
  type CustomAdapterPathTestResponse,
  type CustomAdapterPreviewRequest,
  type CustomAdapterRef,
  type CustomAdapterSimulateRequest,
  type CustomAdapterValidateRequest,
  type CustomAdapterValidationResponse,
  type TrustedAdapterBindRequest,
  type TrustedAdapterBindingPage,
  type TrustedAdapterBindingResponse,
  type TrustedAdapterPage,
  type TrustedAdapterResponse,
} from '@imagine/shared';

import {
  InternalApiError,
  internalClient,
  type CustomAdapterExportDownload,
  type CustomAdapterExportOptions,
  type CustomAdapterPutInput,
  type CustomAdapterPutOptions,
  type InternalRequestOptions,
  type TrustedAdapterInstallInput,
} from '../../../api/internal-client.js';
import { readExportedYamlEnvelopeVersion } from '../../../api/adapter-document.js';
import { adapterQueryKeys, internalQueryKeys } from '../../../api/query-keys.js';


export type AdapterRevisionQuery = Readonly<{
  cursor?: string;
  digest?: string;
  kind?: 'declarative-http' | 'trusted-javascript';
  adapterId?: string;
  limit?: number;
  version?: string;
  ref?: CustomAdapterRef;
}>;

export type TrustedBindingRevisionQuery = Readonly<{
  cursor?: string;
  digest?: string;
  kind?: 'trusted-javascript';
  adapterId?: string;
  limit?: number;
  version?: string;
  ref?: CustomAdapterRef;
}>;

export type AdapterToolInput = Readonly<Record<string, unknown>>;
export type AdapterMutationOptions = InternalRequestOptions;

/** Reads only the top-level version from the deterministic YAML export envelope. */
export { readExportedYamlEnvelopeVersion };

type WithMutationOptions = Readonly<{
  options?: AdapterMutationOptions;
  signal?: AbortSignal;
}>;

function mutationOptions(input: WithMutationOptions): AdapterMutationOptions {
  if (input.options !== undefined) return input.options;
  return input.signal === undefined ? {} : { signal: input.signal };
}

function hasNestedInput(value: unknown): value is { input: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'input');
}

function fixtureModeKey(_fixture: boolean): 'fixture' | 'live' {
  return 'live';
}

function parseProviderId(providerId: string): string {
  return ProviderIdSchema.parse(providerId);
}

function parseAdapterId(adapterId: string): string {
  return AdapterIdParamsSchema.parse({ adapterId }).adapterId;
}

function parseRef(ref: CustomAdapterRef): CustomAdapterRef {
  return CustomAdapterRefSchema.parse(ref);
}

function parseRevisionQuery(options: AdapterRevisionQuery = {}): AdapterRevisionQuery & { limit: number } {
  const ref = options.ref === undefined ? undefined : parseRef(options.ref);
  const parsed = CustomAdapterRevisionListQuerySchema.parse({
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.kind === undefined && ref === undefined ? {} : { kind: ref?.kind ?? options.kind }),
    ...(options.adapterId === undefined && ref === undefined ? {} : { adapterId: ref?.adapterId ?? options.adapterId }),
    ...(options.version === undefined && ref === undefined ? {} : { version: ref?.version ?? options.version }),
    ...(options.digest === undefined && ref === undefined ? {} : { digest: ref?.digest ?? options.digest }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.adapterId === undefined ? {} : { adapterId: parsed.adapterId }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
    limit: parsed.limit,
  };
}

function trustedAdaptersKey(fixture: boolean) {
  return [...adapterQueryKeys.trusted, fixtureModeKey(fixture)] as const;
}

function trustedAdapterKey(fixture: boolean, adapterId: string) {
  return [...adapterQueryKeys.trustedItem(parseAdapterId(adapterId)), fixtureModeKey(fixture)] as const;
}

function customCurrentKey(fixture: boolean, providerId: string, ref?: CustomAdapterRef) {
  return [...adapterQueryKeys.customCurrent(parseProviderId(providerId), ref), fixtureModeKey(fixture)] as const;
}

function customRevisionsKey(fixture: boolean, providerId: string, ref: CustomAdapterRef | undefined, limit = 50) {
  return [...adapterQueryKeys.customRevisions(parseProviderId(providerId), ref, limit), fixtureModeKey(fixture)] as const;
}

function customRevisionKey(fixture: boolean, providerId: string, ref: CustomAdapterRef) {
  return [...adapterQueryKeys.customRevision(parseProviderId(providerId), parseRef(ref)), fixtureModeKey(fixture)] as const;
}

function trustedBindingCurrentKey(fixture: boolean, providerId: string, ref?: CustomAdapterRef) {
  return [...adapterQueryKeys.trustedBindingCurrent(parseProviderId(providerId), ref), fixtureModeKey(fixture)] as const;
}

function trustedBindingRevisionsKey(fixture: boolean, providerId: string, ref: CustomAdapterRef | undefined, limit = 50) {
  return [...adapterQueryKeys.trustedBindingRevisions(parseProviderId(providerId), ref, limit), fixtureModeKey(fixture)] as const;
}

function parseTrustedBindingRevisionQuery(
  options: TrustedBindingRevisionQuery = {},
): TrustedBindingRevisionQuery & { limit: number } {
  const ref = options.ref === undefined ? undefined : parseRef(options.ref);
  const parsed = TrustedAdapterRevisionListQuerySchema.parse({
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.kind === undefined && ref === undefined ? {} : { kind: ref?.kind ?? options.kind }),
    ...(options.adapterId === undefined && ref === undefined ? {} : { adapterId: ref?.adapterId ?? options.adapterId }),
    ...(options.version === undefined && ref === undefined ? {} : { version: ref?.version ?? options.version }),
    ...(options.digest === undefined && ref === undefined ? {} : { digest: ref?.digest ?? options.digest }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  return {
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
    ...(parsed.adapterId === undefined ? {} : { adapterId: parsed.adapterId }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
    limit: parsed.limit,
  };
}

export const trustedAdaptersQueryKey = trustedAdaptersKey;
export const trustedAdapterQueryKey = trustedAdapterKey;
export const customAdapterQueryKey = customCurrentKey;
export const customAdapterRevisionsQueryKey = customRevisionsKey;
export const customAdapterRevisionQueryKey = customRevisionKey;
export const trustedBindingQueryKey = trustedBindingCurrentKey;
export const trustedBindingsQueryKey = trustedBindingRevisionsKey;

export async function loadTrustedAdaptersData(
  _fixture: boolean,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterPage> {
  return internalClient.listTrustedAdapters(requestOptions);
}

export async function loadTrustedAdapterData(
  _fixture: boolean,
  adapterId: string,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterResponse | null> {
  const parsedAdapterId = parseAdapterId(adapterId);

  try {
    return await internalClient.getTrustedAdapter(parsedAdapterId, requestOptions);
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function loadTrustedBindingData(
  _fixture: boolean,
  providerId: string,
  ref?: CustomAdapterRef,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterBindingResponse | null> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = ref === undefined ? undefined : parseRef(ref);

  try {
    return await internalClient.getTrustedBinding(parsedProviderId, parsedRef, requestOptions);
  } catch (error) {
    if (error instanceof InternalApiError && error.status === 404) return null;
    throw error;
  }
}

export async function loadTrustedBindingsData(
  _fixture: boolean,
  providerId: string,
  options: TrustedBindingRevisionQuery = {},
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterBindingPage> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseTrustedBindingRevisionQuery(options);
  return internalClient.listTrustedBindings(parsedProviderId, {
    ...parsedOptions,
    ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
  });
}

export async function loadMoreTrustedBindings(
  fixture: boolean,
  providerId: string,
  options: TrustedBindingRevisionQuery,
  cursor: string,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterBindingPage> {
  const parsedCursor = TrustedAdapterRevisionListQuerySchema.parse({ cursor }).cursor;
  return parsedCursor === undefined
    ? loadTrustedBindingsData(fixture, providerId, options, requestOptions)
    : loadTrustedBindingsData(fixture, providerId, { ...options, cursor: parsedCursor }, requestOptions);
}

export async function loadCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse | null> {
  const parsedProviderId = parseProviderId(providerId);

  try {
    return await internalClient.getCustomAdapter(parsedProviderId, requestOptions);
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function loadCustomAdapterRevisionData(
  _fixture: boolean,
  providerId: string,
  ref: CustomAdapterRef,
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = parseRef(ref);
  const result = await internalClient.getCustomAdapterRevision(parsedProviderId, parsedRef, requestOptions);
  if (result === null) {
    throw new InternalApiError(404, 'adapter_not_found', 'Adapter revision was not found.');
  }
  return result;
}

export async function loadCustomAdapterRevisionsData(
  _fixture: boolean,
  providerId: string,
  options: AdapterRevisionQuery = {},
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionPage> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseRevisionQuery(options);

  return internalClient.listCustomAdapterRevisions(parsedProviderId, {
    ...parsedOptions,
    ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
  });
}

export async function loadMoreCustomAdapterRevisions(
  fixture: boolean,
  providerId: string,
  options: AdapterRevisionQuery,
  cursor: string,
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionPage> {
  const parsedCursor = CustomAdapterRevisionListQuerySchema.shape.cursor.parse(cursor);
  return parsedCursor === undefined
    ? loadCustomAdapterRevisionsData(fixture, providerId, options, requestOptions)
    : loadCustomAdapterRevisionsData(fixture, providerId, { ...options, cursor: parsedCursor }, requestOptions);
}

export async function loadCustomAdapterExportData(
  _fixture: boolean,
  providerId: string,
  options: CustomAdapterExportOptions = {},
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterExportDownload> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = options.ref === undefined ? undefined : parseRef(options.ref);
  const parsedFormat = options.format === undefined ? undefined : AdapterDocumentFormatSchema.parse(options.format);

  return internalClient.exportCustomAdapter(parsedProviderId, {
    ...(parsedRef === undefined ? {} : { ref: parsedRef }),
    ...(parsedFormat === undefined ? {} : { format: parsedFormat }),
  }, requestOptions);
}

export async function putCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  input: CustomAdapterPutInput | CustomAdapterDocument,
  formatOrOptions?: 'json' | 'yaml' | CustomAdapterPutOptions,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse> {
  const parsedProviderId = parseProviderId(providerId);

  return internalClient.putCustomAdapter(parsedProviderId, input, formatOrOptions, options);
}

export async function validateCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterValidateRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterValidationResponse> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterValidateRequestSchema.parse({ providerId: parsedProviderId, ...input });

  return internalClient.validateCustomAdapter(parsedProviderId, input, options);
}

export async function previewCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterPreviewRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<Awaited<ReturnType<typeof internalClient.previewCustomAdapter>>> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterPreviewRequestSchema.parse({ providerId: parsedProviderId, ...input });

  return internalClient.previewCustomAdapter(parsedProviderId, input, options);
}

export async function dryRunCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterDryRunRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<CustomAdapterDryRunResponse> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterDryRunRequestSchema.parse({ providerId: parsedProviderId, ...input });

  return internalClient.dryRunCustomAdapter(parsedProviderId, input, options);
}

export async function simulateCustomAdapterData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterSimulateRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterExtractedResponse> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterSimulateRequestSchema.parse({ providerId: parsedProviderId, ...input });

  return internalClient.simulateCustomAdapter(parsedProviderId, input, options);
}

export async function testCustomAdapterPathData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterPathTestRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterPathTestResponse> {
  const parsedProviderId = parseProviderId(providerId);

  return internalClient.testCustomAdapterPath(parsedProviderId, input, options);
}

export async function previewCustomAdapterCapabilitiesData(
  _fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterCapabilityPreviewRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<Awaited<ReturnType<typeof internalClient.previewCustomAdapterCapabilities>>> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterCapabilityPreviewRequestSchema.parse({ providerId: parsedProviderId, ...input });

  return internalClient.previewCustomAdapterCapabilities(parsedProviderId, input, options);
}

export function flattenCustomAdapterRevisionPages(
  data: InfiniteData<CustomAdapterDefinitionPage> | undefined,
): readonly CustomAdapterDefinitionPage['items'][number][] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

export function flattenTrustedBindingPages(
  data: InfiniteData<TrustedAdapterBindingPage> | undefined,
): readonly TrustedAdapterBindingPage['items'][number][] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

export function useTrustedAdaptersQuery(fixture = false, enabled = true) {
  return useQuery({
    queryKey: trustedAdaptersKey(fixture),
    queryFn: ({ signal }) => loadTrustedAdaptersData(fixture, { signal }),
    ...({}),
    enabled,
    staleTime: 30_000,
  });
}

export function useTrustedAdapterQuery(adapterId: string, fixture = false, enabled = true) {
  return useQuery({
    queryKey: trustedAdapterKey(fixture, adapterId),
    queryFn: ({ signal }) => loadTrustedAdapterData(fixture, adapterId, { signal }),
    enabled: enabled && adapterId.length > 0,
    staleTime: 30_000,
  });
}

export function useTrustedBindingQuery(
  providerId: string,
  ref?: CustomAdapterRef,
  fixture = false,
  enabled = true,
) {
  const parsedRef = ref === undefined ? undefined : parseRef(ref);
  return useQuery({
    queryKey: trustedBindingCurrentKey(fixture, providerId, parsedRef),
    queryFn: ({ signal }) => loadTrustedBindingData(fixture, providerId, parsedRef, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: 30_000,
  });
}

export function useTrustedBindingsQuery(
  providerId: string,
  options: TrustedBindingRevisionQuery = {},
  fixture = false,
  enabled = true,
) {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseTrustedBindingRevisionQuery(options);
  const keyRef = parsedOptions.kind !== undefined && parsedOptions.adapterId !== undefined && parsedOptions.version !== undefined && parsedOptions.digest !== undefined
    ? { kind: parsedOptions.kind, adapterId: parsedOptions.adapterId, version: parsedOptions.version, digest: parsedOptions.digest }
    : undefined;
  return useInfiniteQuery({
    queryKey: trustedBindingRevisionsKey(fixture, parsedProviderId, keyRef, parsedOptions.limit),
    queryFn: ({ pageParam, signal }) => loadTrustedBindingsData(fixture, parsedProviderId, {
      ...parsedOptions,
      ...(pageParam === undefined ? {} : { cursor: pageParam }),
    }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  });
}

export function useCustomAdapterQuery(providerId: string, fixture = false, enabled = true) {
  return useQuery({
    queryKey: customCurrentKey(fixture, providerId),
    queryFn: ({ signal }) => loadCustomAdapterData(fixture, providerId, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: 30_000,
  });
}

export function useCustomAdapterRevisionQuery(
  providerId: string,
  ref: CustomAdapterRef,
  fixture = false,
  enabled = true,
) {
  const parsedRef = parseRef(ref);
  return useQuery({
    queryKey: customRevisionKey(fixture, providerId, parsedRef),
    queryFn: ({ signal }) => loadCustomAdapterRevisionData(fixture, providerId, parsedRef, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: 30_000,
  });
}

export function useCustomAdapterRevisionsQuery(
  providerId: string,
  options: AdapterRevisionQuery = {},
  fixture = false,
  enabled = true,
) {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseRevisionQuery(options);
  const keyRef = parsedOptions.kind !== undefined && parsedOptions.adapterId !== undefined && parsedOptions.version !== undefined && parsedOptions.digest !== undefined
    ? { kind: parsedOptions.kind, adapterId: parsedOptions.adapterId, version: parsedOptions.version, digest: parsedOptions.digest }
    : undefined;
  return useInfiniteQuery({
    queryKey: customRevisionsKey(fixture, parsedProviderId, keyRef, parsedOptions.limit),
    queryFn: ({ pageParam, signal }) => loadCustomAdapterRevisionsData(fixture, parsedProviderId, {
      ...parsedOptions,
      ...(pageParam === undefined ? {} : { cursor: pageParam }),
    }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  });
}

async function invalidateAdapterQueries(queryClient: ReturnType<typeof useQueryClient>, _fixture: boolean): Promise<void> {

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.adapters }),
    queryClient.invalidateQueries({ queryKey: adapterQueryKeys.trustedBindings }),
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.providers }),
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.models }),
  ]);
}

export function useInstallTrustedAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: TrustedAdapterInstallInput & WithMutationOptions | Readonly<{ input: TrustedAdapterInstallInput }> & WithMutationOptions) => {

      if (hasNestedInput(value)) return internalClient.installTrustedAdapter(value.input as TrustedAdapterInstallInput, mutationOptions(value));
      const { options: _options, signal: _signal, ...input } = value;
      return internalClient.installTrustedAdapter(input, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useBindTrustedAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: TrustedAdapterBindRequest & WithMutationOptions | Readonly<{ input: TrustedAdapterBindRequest }> & WithMutationOptions) => {

      if (hasNestedInput(value)) return internalClient.bindTrustedAdapter(value.input as TrustedAdapterBindRequest, mutationOptions(value));
      const { options: _options, signal: _signal, ...input } = value;
      return internalClient.bindTrustedAdapter(input, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useDisableTrustedBinding(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref?: CustomAdapterRef }> & WithMutationOptions) => {

      return internalClient.disableTrustedBinding(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useUnbindTrustedBinding(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref: CustomAdapterRef }> & WithMutationOptions) => {

      return internalClient.unbindTrustedBinding(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useRemoveTrustedAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: string | (Readonly<{ adapterId: string }> & WithMutationOptions)) => {

      if (typeof value === 'string') return internalClient.removeTrustedAdapter(value);
      return internalClient.removeTrustedAdapter(value.adapterId, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function usePutCustomAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{
      providerId: string;
      document: CustomAdapterPutInput | CustomAdapterDocument;
      formatOrOptions?: 'json' | 'yaml' | CustomAdapterPutOptions;
    }> & WithMutationOptions) => putCustomAdapterData(fixture, input.providerId, input.document, input.formatOrOptions, mutationOptions(input)),
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useDeleteCustomAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (value: Readonly<{ providerId: string; ref: CustomAdapterRef }> & WithMutationOptions) => {

      return internalClient.deleteCustomAdapter(value.providerId, value.ref, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useDisableCustomAdapter(fixture = false) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref?: CustomAdapterRef }> & WithMutationOptions) => {

      return internalClient.disableCustomAdapter(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useValidateCustomAdapter(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterValidateRequest, 'providerId'> }> & WithMutationOptions) => validateCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function usePreviewCustomAdapter(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterPreviewRequest, 'providerId'> }> & WithMutationOptions) => previewCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useDryRunCustomAdapter(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterDryRunRequest, 'providerId'> }> & WithMutationOptions) => dryRunCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useSimulateCustomAdapter(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterSimulateRequest, 'providerId'> }> & WithMutationOptions) => simulateCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useTestCustomAdapterPath(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterPathTestRequest, 'providerId'> }> & WithMutationOptions) => testCustomAdapterPathData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function usePreviewCustomAdapterCapabilities(fixture = false) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterCapabilityPreviewRequest, 'providerId'> }> & WithMutationOptions) => previewCustomAdapterCapabilitiesData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}
