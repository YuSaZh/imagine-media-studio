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
  CustomAdapterCapabilityPreviewSchema,
  CustomAdapterCompiledPreviewSchema,
  CustomAdapterDefinitionResponseSchema,
  CustomAdapterDryRunRequestSchema,
  CustomAdapterDryRunResponseSchema,
  CustomAdapterExtractedResponseSchema,
  CustomAdapterPathTestRequestSchema,
  CustomAdapterPathTestResponseSchema,
  CustomAdapterPreviewRequestSchema,
  CustomAdapterRefSchema,
  CustomAdapterRevisionListResponseSchema,
  CustomAdapterRevisionListQuerySchema,
  CustomAdapterSimulateRequestSchema,
  CustomAdapterValidateRequestSchema,
  CustomAdapterValidationResponseSchema,
  AdapterDocumentFormatSchema,
  BoundedJsonValueSchema,
  ProviderCapabilitiesSchema,
  ProviderIdSchema,
  TrustedAdapterBindingPageSchema,
  TrustedAdapterBindingResponseSchema,
  TrustedAdapterRevisionListQuerySchema,
  TrustedAdapterManifestSchema,
  TrustedAdapterPageSchema,
  TrustedAdapterResponseSchema,
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
  type TrustedAdapterManifest,
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
import { isVisualFixtureMode } from '../../../visual-fixture.js';
import { PR1_MOCK_PROVIDER } from '../../gallery/model/fixtures.js';

const FIXTURE_TIME = '2026-08-25T00:00:00.000Z';
const FIXTURE_PROVIDER_ID = PR1_MOCK_PROVIDER.id;
const FIXTURE_CUSTOM_REF: CustomAdapterRef = {
  kind: 'declarative-http',
  adapterId: 'studio-custom-http',
  version: '1.0.0',
  digest: 'b'.repeat(64),
};
const FIXTURE_CUSTOM_OLD_REF: CustomAdapterRef = {
  ...FIXTURE_CUSTOM_REF,
  version: '0.9.0',
  digest: 'a'.repeat(64),
};

const FIXTURE_CAPABILITIES = ProviderCapabilitiesSchema.parse({
  providerType: 'custom-http-v1',
  models: [{
    id: 'studio-custom-image',
    displayName: 'Studio Custom Image',
    capabilities: {
      operations: ['image.generate'],
      aspectRatios: ['1:1'],
      maxReferenceImages: 0,
      supportsBatchCount: false,
      maxBatchCount: 1,
    },
  }],
});

const CustomAdapterPreviewResponseSchema = CustomAdapterCompiledPreviewSchema.extend({
  capabilities: ProviderCapabilitiesSchema,
}).strict();

const FIXTURE_DEFINITION = {
  id: FIXTURE_CUSTOM_REF.adapterId,
  name: 'Studio Custom HTTP',
  operations: ['image.generate'],
  models: FIXTURE_CAPABILITIES.models,
};

const FIXTURE_CUSTOM_CURRENT: CustomAdapterDefinitionResponse = CustomAdapterDefinitionResponseSchema.parse({
  definition: {
    providerId: FIXTURE_PROVIDER_ID,
    ref: FIXTURE_CUSTOM_REF,
    definition: FIXTURE_DEFINITION,
    isCurrent: true,
    disabled: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  },
});

const FIXTURE_CUSTOM_OLD: CustomAdapterDefinitionResponse = CustomAdapterDefinitionResponseSchema.parse({
  definition: {
    providerId: FIXTURE_PROVIDER_ID,
    ref: FIXTURE_CUSTOM_OLD_REF,
    definition: FIXTURE_DEFINITION,
    isCurrent: false,
    disabled: false,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  },
});

const FIXTURE_TRUSTED_MANIFEST: TrustedAdapterManifest = TrustedAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'studio-trusted-fixture',
  version: '1.0.0',
  displayName: 'Studio Trusted Fixture',
  sha256: 'c'.repeat(64),
  operations: ['image.generate'],
  capabilities: FIXTURE_CAPABILITIES,
  allowedHosts: ['api.example.invalid'],
  requiredSecrets: [],
  resourceLimits: {
    timeoutMs: 30_000,
    maxMessageBytes: 1_048_576,
    maxOutputBytes: 1_048_576,
    maxLogBytes: 262_144,
    maxOldGenerationSizeMb: 64,
    maxYoungGenerationSizeMb: 16,
    stackSizeMb: 4,
  },
});

const FIXTURE_TRUSTED: TrustedAdapterResponse = TrustedAdapterResponseSchema.parse({
  adapter: {
    manifest: FIXTURE_TRUSTED_MANIFEST,
    ref: {
      kind: 'trusted-javascript',
      adapterId: FIXTURE_TRUSTED_MANIFEST.id,
      version: FIXTURE_TRUSTED_MANIFEST.version,
      digest: FIXTURE_TRUSTED_MANIFEST.sha256,
    },
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  },
});

const FIXTURE_TRUSTED_PAGE: TrustedAdapterPage = TrustedAdapterPageSchema.parse({
  items: [FIXTURE_TRUSTED.adapter],
});

const FIXTURE_TRUSTED_OLD_MANIFEST: TrustedAdapterManifest = TrustedAdapterManifestSchema.parse({
  ...FIXTURE_TRUSTED_MANIFEST,
  id: 'studio-trusted-fixture-old',
  version: '0.9.0',
  sha256: 'd'.repeat(64),
});
const FIXTURE_TRUSTED_OLD: TrustedAdapterResponse = TrustedAdapterResponseSchema.parse({
  adapter: {
    manifest: FIXTURE_TRUSTED_OLD_MANIFEST,
    ref: {
      kind: 'trusted-javascript',
      adapterId: FIXTURE_TRUSTED_OLD_MANIFEST.id,
      version: FIXTURE_TRUSTED_OLD_MANIFEST.version,
      digest: FIXTURE_TRUSTED_OLD_MANIFEST.sha256,
    },
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  },
});

const FIXTURE_TRUSTED_BINDING: TrustedAdapterBindingResponse = TrustedAdapterBindingResponseSchema.parse({
  binding: {
    providerId: FIXTURE_PROVIDER_ID,
    adapter: FIXTURE_TRUSTED.adapter,
    isCurrent: true,
    disabled: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  },
});
const FIXTURE_TRUSTED_OLD_BINDING: TrustedAdapterBindingResponse = TrustedAdapterBindingResponseSchema.parse({
  binding: {
    providerId: FIXTURE_PROVIDER_ID,
    adapter: FIXTURE_TRUSTED_OLD.adapter,
    isCurrent: false,
    disabled: false,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  },
});
const FIXTURE_TRUSTED_BINDING_PAGE: TrustedAdapterBindingPage = TrustedAdapterBindingPageSchema.parse({
  items: [FIXTURE_TRUSTED_BINDING.binding, FIXTURE_TRUSTED_OLD_BINDING.binding],
  nextCursor: null,
});

const FIXTURE_COMPILED_PREVIEW = {
  method: 'POST' as const,
  relativePath: '/v1/images/generations',
  query: {},
  headers: {},
  body: { type: 'json' as const, value: { prompt: '{{ request.prompt }}' } },
  url: 'https://api.example.invalid/v1/images/generations',
  endpoint: 'submit' as const,
};

const FIXTURE_PREVIEW = {
  ...FIXTURE_COMPILED_PREVIEW,
  capabilities: FIXTURE_CAPABILITIES,
};

const FIXTURE_EXPORT_JSON = JSON.stringify({
  schemaVersion: 1,
  version: FIXTURE_CUSTOM_REF.version,
  definition: FIXTURE_DEFINITION,
}, null, 2) + '\n';

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

function fixtureModeKey(fixture: boolean): 'fixture' | 'live' {
  return fixture ? 'fixture' : 'live';
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

function exactRefMatches(left: CustomAdapterRef, right: CustomAdapterRef): boolean {
  return left.kind === right.kind &&
    left.adapterId === right.adapterId &&
    left.version === right.version &&
    left.digest === right.digest;
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

function trustedBindingMatches(
  binding: TrustedAdapterBindingResponse['binding'],
  ref: CustomAdapterRef,
): boolean {
  return exactRefMatches(binding.adapter.ref, ref);
}

export const trustedAdaptersQueryKey = trustedAdaptersKey;
export const trustedAdapterQueryKey = trustedAdapterKey;
export const customAdapterQueryKey = customCurrentKey;
export const customAdapterRevisionsQueryKey = customRevisionsKey;
export const customAdapterRevisionQueryKey = customRevisionKey;
export const trustedBindingQueryKey = trustedBindingCurrentKey;
export const trustedBindingsQueryKey = trustedBindingRevisionsKey;

function fixtureCustomResponse(ref?: CustomAdapterRef): CustomAdapterDefinitionResponse | null {
  if (ref === undefined || exactRefMatches(ref, FIXTURE_CUSTOM_REF)) return FIXTURE_CUSTOM_CURRENT;
  if (exactRefMatches(ref, FIXTURE_CUSTOM_OLD_REF)) return FIXTURE_CUSTOM_OLD;
  return null;
}

function fixtureCustomPage(options: AdapterRevisionQuery = {}): CustomAdapterDefinitionPage {
  const parsed = parseRevisionQuery(options);
  if (parsed.cursor !== undefined && parsed.cursor !== 'fixture:1') {
    throw new Error('Fixture adapter revision cursor is invalid.');
  }
  const exact = parsed.ref === undefined &&
    parsed.kind !== undefined &&
    parsed.adapterId !== undefined &&
    parsed.version !== undefined &&
    parsed.digest !== undefined
    ? {
        kind: parsed.kind,
        adapterId: parsed.adapterId,
        version: parsed.version,
        digest: parsed.digest,
      }
    : undefined;
  const all = [FIXTURE_CUSTOM_CURRENT.definition, FIXTURE_CUSTOM_OLD.definition];
  const filtered = exact === undefined
    ? all
    : all.filter((item) => exactRefMatches(item.ref, exact));
  const start = parsed.cursor === 'fixture:1' ? 1 : 0;
  const items = filtered.slice(start, start + parsed.limit);
  const hasMore = start + items.length < filtered.length;
  return CustomAdapterRevisionListResponseSchema.parse({
    items,
    nextCursor: hasMore ? 'fixture:1' : null,
  });
}

function fixtureExport(options: CustomAdapterExportOptions = {}): CustomAdapterExportDownload {
  const ref = options.ref === undefined ? FIXTURE_CUSTOM_REF : parseRef(options.ref);
  const response = fixtureCustomResponse(ref);
  if (response === null) throw new Error('Fixture adapter revision was not found.');
  const format = options.format ?? 'json';
  if (format === 'yaml') {
    const text = `schemaVersion: 1\nversion: ${ref.version}\ndefinition:\n  id: ${ref.adapterId}\n  name: Studio Custom HTTP\n`;
    return {
      text,
      content: text,
      filename: `adapter-${ref.adapterId}-${ref.version}.yaml`,
      contentType: 'application/yaml; charset=utf-8',
    };
  }
  const text = ref.version === FIXTURE_CUSTOM_REF.version ? FIXTURE_EXPORT_JSON : FIXTURE_EXPORT_JSON.replace(
    `version: ${FIXTURE_CUSTOM_REF.version}`,
    `version: ${ref.version}`,
  );
  return {
    text,
    content: text,
    filename: `adapter-${ref.adapterId}-${ref.version}.json`,
    contentType: 'application/json; charset=utf-8',
  };
}

const FIXTURE_CREDENTIAL_KEY = /(?:^|[-_.])(api[-_.]?key|authorization|cookie|password|secret|token|headers?|custom[-_.]?headers?)(?:$|[-_.])/iu;

function fixturePathDocument(value: unknown): unknown {
  if (typeof value !== 'string') return BoundedJsonValueSchema.parse(value);
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > 2 * 1024 * 1024) throw new Error('Fixture path test document is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('Fixture path test document is invalid JSON.');
  }
  return BoundedJsonValueSchema.parse(parsed);
}

function fixtureRedactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && key.toLowerCase() !== 'headers' && FIXTURE_CREDENTIAL_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
      .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/gu, '[REDACTED]')
      .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password|signature|authorization|auth|credential(?:s)?|idempotency[-_]?key|cookie|set-cookie)\s*[=:]\s*[^\s,;]+/giu, '[REDACTED]');
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => fixtureRedactValue(item));
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) output[childKey] = fixtureRedactValue(child, childKey);
  return output;
}

function fixturePathTest(input: Omit<CustomAdapterPathTestRequest, 'providerId'>): CustomAdapterPathTestResponse {
  const parsed = CustomAdapterPathTestRequestSchema.parse({ providerId: FIXTURE_PROVIDER_ID, ...input });
  let source: unknown = parsed.document;
  if (source === undefined && parsed.response !== undefined) {
    const response = parsed.response as unknown as Record<string, unknown>;
    source = response.json !== undefined
      ? response.json
      : response.body !== undefined
        ? response.body
        : response.text;
  }
  if (source === undefined) source = parsed.json ?? parsed.text;
  if (source === undefined) throw new Error('Fixture path test document is required.');
  const document = fixturePathDocument(source);
  const rawSegments = parsed.path.slice(1).split('/');
  if (rawSegments.length > 32) throw new Error('Fixture response path contains too many segments.');
  const segments = rawSegments.map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let value: unknown = document;
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new Error('Fixture response path contains a prototype-related key.');
    }
    if (Array.isArray(value)) {
      if (!/^0$|^[1-9][0-9]*$/u.test(segment)) return { path: parsed.path, found: false };
      value = value[Number(segment)];
    } else if (value !== null && typeof value === 'object') {
      if (!Object.hasOwn(value, segment)) return { path: parsed.path, found: false };
      value = (value as Record<string, unknown>)[segment];
    } else {
      return { path: parsed.path, found: false };
    }
  }
  if (value === undefined) return { path: parsed.path, found: false };
  return CustomAdapterPathTestResponseSchema.parse({ path: parsed.path, found: true, value: fixtureRedactValue(value, segments.at(-1)) });
}

export async function loadTrustedAdaptersData(
  fixture: boolean,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterPage> {
  return fixture ? FIXTURE_TRUSTED_PAGE : internalClient.listTrustedAdapters(requestOptions);
}

export async function loadTrustedAdapterData(
  fixture: boolean,
  adapterId: string,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterResponse | null> {
  const parsedAdapterId = parseAdapterId(adapterId);
  if (fixture) {
    return FIXTURE_TRUSTED.adapter.ref.adapterId === parsedAdapterId ? FIXTURE_TRUSTED : null;
  }
  try {
    return await internalClient.getTrustedAdapter(parsedAdapterId, requestOptions);
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function loadTrustedBindingData(
  fixture: boolean,
  providerId: string,
  ref?: CustomAdapterRef,
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterBindingResponse | null> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = ref === undefined ? undefined : parseRef(ref);
  if (fixture) {
    if (parsedProviderId !== FIXTURE_PROVIDER_ID) return null;
    const binding = parsedRef === undefined
      ? FIXTURE_TRUSTED_BINDING
      : [FIXTURE_TRUSTED_BINDING, FIXTURE_TRUSTED_OLD_BINDING].find((item) =>
          trustedBindingMatches(item.binding, parsedRef),
        );
    return binding ?? null;
  }
  try {
    return await internalClient.getTrustedBinding(parsedProviderId, parsedRef, requestOptions);
  } catch (error) {
    if (error instanceof InternalApiError && error.status === 404) return null;
    throw error;
  }
}

export async function loadTrustedBindingsData(
  fixture: boolean,
  providerId: string,
  options: TrustedBindingRevisionQuery = {},
  requestOptions: InternalRequestOptions = {},
): Promise<TrustedAdapterBindingPage> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseTrustedBindingRevisionQuery(options);
  if (!fixture) return internalClient.listTrustedBindings(parsedProviderId, {
    ...parsedOptions,
    ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
  });
  if (parsedProviderId !== FIXTURE_PROVIDER_ID) return { items: [], nextCursor: null };

  if (parsedOptions.cursor !== undefined && parsedOptions.cursor !== 'fixture:1') {
    throw new Error('Fixture trusted binding cursor is invalid.');
  }
  const exact = parsedOptions.kind !== undefined &&
    parsedOptions.adapterId !== undefined &&
    parsedOptions.version !== undefined &&
    parsedOptions.digest !== undefined
    ? {
        kind: parsedOptions.kind,
        adapterId: parsedOptions.adapterId,
        version: parsedOptions.version,
        digest: parsedOptions.digest,
      }
    : undefined;
  const all = FIXTURE_TRUSTED_BINDING_PAGE.items;
  const filtered = exact === undefined ? all : all.filter((item) => exactRefMatches(item.adapter.ref, exact));
  const start = parsedOptions.cursor === 'fixture:1' ? 1 : 0;
  const items = filtered.slice(start, start + parsedOptions.limit);
  return TrustedAdapterBindingPageSchema.parse({
    items,
    nextCursor: start + items.length < filtered.length ? 'fixture:1' : null,
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
  fixture: boolean,
  providerId: string,
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse | null> {
  const parsedProviderId = parseProviderId(providerId);
  if (fixture) return parsedProviderId === FIXTURE_PROVIDER_ID ? FIXTURE_CUSTOM_CURRENT : null;
  try {
    return await internalClient.getCustomAdapter(parsedProviderId, requestOptions);
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
}

export async function loadCustomAdapterRevisionData(
  fixture: boolean,
  providerId: string,
  ref: CustomAdapterRef,
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = parseRef(ref);
  const result = fixture
    ? parsedProviderId === FIXTURE_PROVIDER_ID ? fixtureCustomResponse(parsedRef) : null
    : await internalClient.getCustomAdapterRevision(parsedProviderId, parsedRef, requestOptions);
  if (result === null) {
    throw new InternalApiError(404, 'adapter_not_found', 'Adapter revision was not found.');
  }
  return result;
}

export async function loadCustomAdapterRevisionsData(
  fixture: boolean,
  providerId: string,
  options: AdapterRevisionQuery = {},
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionPage> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedOptions = parseRevisionQuery(options);
  if (fixture) return parsedProviderId === FIXTURE_PROVIDER_ID ? fixtureCustomPage(parsedOptions) : { items: [], nextCursor: null };
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
  fixture: boolean,
  providerId: string,
  options: CustomAdapterExportOptions = {},
  requestOptions: InternalRequestOptions = {},
): Promise<CustomAdapterExportDownload> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedRef = options.ref === undefined ? undefined : parseRef(options.ref);
  const parsedFormat = options.format === undefined ? undefined : AdapterDocumentFormatSchema.parse(options.format);
  if (fixture) {
    if (parsedProviderId !== FIXTURE_PROVIDER_ID) throw new Error('Fixture adapter Provider was not found.');
    return fixtureExport({ ...(parsedRef === undefined ? {} : { ref: parsedRef }), ...(parsedFormat === undefined ? {} : { format: parsedFormat }) });
  }
  return internalClient.exportCustomAdapter(parsedProviderId, {
    ...(parsedRef === undefined ? {} : { ref: parsedRef }),
    ...(parsedFormat === undefined ? {} : { format: parsedFormat }),
  }, requestOptions);
}

export async function putCustomAdapterData(
  fixture: boolean,
  providerId: string,
  input: CustomAdapterPutInput | CustomAdapterDocument,
  formatOrOptions?: 'json' | 'yaml' | CustomAdapterPutOptions,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterDefinitionResponse> {
  const parsedProviderId = parseProviderId(providerId);
  if (fixture) throw new Error('Visual fixtures cannot mutate adapters.');
  return internalClient.putCustomAdapter(parsedProviderId, input, formatOrOptions, options);
}

export async function validateCustomAdapterData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterValidateRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterValidationResponse> {
  const parsedProviderId = parseProviderId(providerId);
  const parsedInput = CustomAdapterValidateRequestSchema.parse({ providerId: parsedProviderId, ...input });
  if (fixture) {
    const document = parsedInput.document;
    const spec = typeof document === 'object' ? document : FIXTURE_DEFINITION;
    return CustomAdapterValidationResponseSchema.parse({ valid: true, adapterId: FIXTURE_CUSTOM_REF.adapterId, canonical: JSON.stringify(spec), spec });
  }
  return internalClient.validateCustomAdapter(parsedProviderId, input, options);
}

export async function previewCustomAdapterData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterPreviewRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<ReturnType<typeof CustomAdapterPreviewResponseSchema.parse>> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterPreviewRequestSchema.parse({ providerId: parsedProviderId, ...input });
  if (fixture) return CustomAdapterPreviewResponseSchema.parse(FIXTURE_PREVIEW);
  return internalClient.previewCustomAdapter(parsedProviderId, input, options);
}

export async function dryRunCustomAdapterData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterDryRunRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<CustomAdapterDryRunResponse> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterDryRunRequestSchema.parse({ providerId: parsedProviderId, ...input });
  if (fixture) return CustomAdapterDryRunResponseSchema.parse({ network: false, performed: false, request: FIXTURE_COMPILED_PREVIEW, preview: FIXTURE_COMPILED_PREVIEW, endpoint: 'submit', capabilities: FIXTURE_CAPABILITIES });
  return internalClient.dryRunCustomAdapter(parsedProviderId, input, options);
}

export async function simulateCustomAdapterData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterSimulateRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterExtractedResponse> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterSimulateRequestSchema.parse({ providerId: parsedProviderId, ...input });
  if (fixture) return CustomAdapterExtractedResponseSchema.parse({ state: 'completed', assets: [] });
  return internalClient.simulateCustomAdapter(parsedProviderId, input, options);
}

export async function testCustomAdapterPathData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterPathTestRequest, 'providerId'>,
  options: InternalRequestOptions = {},
): Promise<CustomAdapterPathTestResponse> {
  const parsedProviderId = parseProviderId(providerId);
  if (fixture) {
    if (parsedProviderId !== FIXTURE_PROVIDER_ID) throw new Error('Fixture adapter Provider was not found.');
    return fixturePathTest(input);
  }
  return internalClient.testCustomAdapterPath(parsedProviderId, input, options);
}

export async function previewCustomAdapterCapabilitiesData(
  fixture: boolean,
  providerId: string,
  input: Omit<CustomAdapterCapabilityPreviewRequest, 'providerId'> = {},
  options: InternalRequestOptions = {},
): Promise<ReturnType<typeof CustomAdapterCapabilityPreviewSchema.parse>> {
  const parsedProviderId = parseProviderId(providerId);
  CustomAdapterCapabilityPreviewRequestSchema.parse({ providerId: parsedProviderId, ...input });
  if (fixture) return CustomAdapterCapabilityPreviewSchema.parse({ capabilities: FIXTURE_CAPABILITIES });
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

export function useTrustedAdaptersQuery(fixture = isVisualFixtureMode(), enabled = true) {
  return useQuery({
    queryKey: trustedAdaptersKey(fixture),
    queryFn: ({ signal }) => loadTrustedAdaptersData(fixture, { signal }),
    ...(fixture && enabled ? { initialData: FIXTURE_TRUSTED_PAGE } : {}),
    enabled,
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useTrustedAdapterQuery(adapterId: string, fixture = isVisualFixtureMode(), enabled = true) {
  return useQuery({
    queryKey: trustedAdapterKey(fixture, adapterId),
    queryFn: ({ signal }) => loadTrustedAdapterData(fixture, adapterId, { signal }),
    enabled: enabled && adapterId.length > 0,
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useTrustedBindingQuery(
  providerId: string,
  ref?: CustomAdapterRef,
  fixture = isVisualFixtureMode(),
  enabled = true,
) {
  const parsedRef = ref === undefined ? undefined : parseRef(ref);
  return useQuery({
    queryKey: trustedBindingCurrentKey(fixture, providerId, parsedRef),
    queryFn: ({ signal }) => loadTrustedBindingData(fixture, providerId, parsedRef, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useTrustedBindingsQuery(
  providerId: string,
  options: TrustedBindingRevisionQuery = {},
  fixture = isVisualFixtureMode(),
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
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useCustomAdapterQuery(providerId: string, fixture = isVisualFixtureMode(), enabled = true) {
  return useQuery({
    queryKey: customCurrentKey(fixture, providerId),
    queryFn: ({ signal }) => loadCustomAdapterData(fixture, providerId, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useCustomAdapterRevisionQuery(
  providerId: string,
  ref: CustomAdapterRef,
  fixture = isVisualFixtureMode(),
  enabled = true,
) {
  const parsedRef = parseRef(ref);
  return useQuery({
    queryKey: customRevisionKey(fixture, providerId, parsedRef),
    queryFn: ({ signal }) => loadCustomAdapterRevisionData(fixture, providerId, parsedRef, { signal }),
    enabled: enabled && providerId.length > 0,
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

export function useCustomAdapterRevisionsQuery(
  providerId: string,
  options: AdapterRevisionQuery = {},
  fixture = isVisualFixtureMode(),
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
    staleTime: fixture ? Number.POSITIVE_INFINITY : 30_000,
  });
}

async function invalidateAdapterQueries(queryClient: ReturnType<typeof useQueryClient>, fixture: boolean): Promise<void> {
  if (fixture) return;
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.adapters }),
    queryClient.invalidateQueries({ queryKey: adapterQueryKeys.trustedBindings }),
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.providers }),
    queryClient.invalidateQueries({ queryKey: internalQueryKeys.models }),
  ]);
}

export function useInstallTrustedAdapter(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: TrustedAdapterInstallInput & WithMutationOptions | Readonly<{ input: TrustedAdapterInstallInput }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot install adapters.');
      if (hasNestedInput(value)) return internalClient.installTrustedAdapter(value.input as TrustedAdapterInstallInput, mutationOptions(value));
      const { options: _options, signal: _signal, ...input } = value;
      return internalClient.installTrustedAdapter(input, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useBindTrustedAdapter(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: TrustedAdapterBindRequest & WithMutationOptions | Readonly<{ input: TrustedAdapterBindRequest }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot bind adapters.');
      if (hasNestedInput(value)) return internalClient.bindTrustedAdapter(value.input as TrustedAdapterBindRequest, mutationOptions(value));
      const { options: _options, signal: _signal, ...input } = value;
      return internalClient.bindTrustedAdapter(input, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useDisableTrustedBinding(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref?: CustomAdapterRef }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot disable Provider bindings.');
      return internalClient.disableTrustedBinding(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useUnbindTrustedBinding(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref: CustomAdapterRef }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot unbind Provider bindings.');
      return internalClient.unbindTrustedBinding(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useRemoveTrustedAdapter(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (value: string | (Readonly<{ adapterId: string }> & WithMutationOptions)) => {
      if (fixture) throw new Error('Visual fixtures cannot remove adapters.');
      if (typeof value === 'string') return internalClient.removeTrustedAdapter(value);
      return internalClient.removeTrustedAdapter(value.adapterId, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function usePutCustomAdapter(fixture = isVisualFixtureMode()) {
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

export function useDeleteCustomAdapter(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (value: Readonly<{ providerId: string; ref: CustomAdapterRef }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot delete adapters.');
      return internalClient.deleteCustomAdapter(value.providerId, value.ref, mutationOptions(value));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useDisableCustomAdapter(fixture = isVisualFixtureMode()) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; ref?: CustomAdapterRef }> & WithMutationOptions) => {
      if (fixture) throw new Error('Visual fixtures cannot disable adapters.');
      return internalClient.disableCustomAdapter(input.providerId, input.ref, mutationOptions(input));
    },
    onSuccess: () => invalidateAdapterQueries(queryClient, fixture),
  });
}

export function useValidateCustomAdapter(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterValidateRequest, 'providerId'> }> & WithMutationOptions) => validateCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function usePreviewCustomAdapter(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterPreviewRequest, 'providerId'> }> & WithMutationOptions) => previewCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useDryRunCustomAdapter(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterDryRunRequest, 'providerId'> }> & WithMutationOptions) => dryRunCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useSimulateCustomAdapter(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterSimulateRequest, 'providerId'> }> & WithMutationOptions) => simulateCustomAdapterData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function useTestCustomAdapterPath(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request: Omit<CustomAdapterPathTestRequest, 'providerId'> }> & WithMutationOptions) => testCustomAdapterPathData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}

export function usePreviewCustomAdapterCapabilities(fixture = isVisualFixtureMode()) {
  return useMutation({
    gcTime: 0,
    mutationFn: (input: Readonly<{ providerId: string; request?: Omit<CustomAdapterCapabilityPreviewRequest, 'providerId'> }> & WithMutationOptions) => previewCustomAdapterCapabilitiesData(fixture, input.providerId, input.request, mutationOptions(input)),
  });
}
