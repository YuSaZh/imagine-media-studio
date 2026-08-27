export const internalQueryKeys = {
  all: ['internal'] as const,
  adapters: ['internal', 'adapters'] as const,
  assets: ['internal', 'assets'] as const,
  collections: ['internal', 'collections'] as const,
  gallery: ['internal', 'gallery'] as const,
  jobs: ['internal', 'jobs'] as const,
  models: ['internal', 'models'] as const,
  providers: ['internal', 'providers'] as const,
  settings: ['internal', 'settings'] as const,
};

export type AdapterKeyRef = Readonly<{
  kind: 'declarative-http' | 'trusted-javascript';
  adapterId: string;
  version: string;
  digest: string;
}>;

function refKey(ref: AdapterKeyRef | undefined): readonly [
  string | null,
  string | null,
  string | null,
  string | null,
] {
  return ref === undefined
    ? [null, null, null, null]
    : [ref.kind, ref.adapterId, ref.version, ref.digest];
}

/** Query keys keep provider and immutable revision identity in every custom entry. */
export const adapterQueryKeys = {
  all: internalQueryKeys.adapters,
  trusted: [...internalQueryKeys.adapters, 'trusted'] as const,
  trustedItem: (adapterId: string) => [...internalQueryKeys.adapters, 'trusted', adapterId] as const,
  trustedBindings: [...internalQueryKeys.adapters, 'trusted-bindings'] as const,
  trustedBindingCurrent: (providerId: string, ref?: AdapterKeyRef) => [
    ...internalQueryKeys.adapters,
    'trusted-bindings',
    'current',
    providerId,
    ...refKey(ref),
  ] as const,
  trustedBindingRevisions: (providerId: string, ref?: AdapterKeyRef, limit = 50) => [
    ...internalQueryKeys.adapters,
    'trusted-bindings',
    'revisions',
    providerId,
    ...refKey(ref),
    limit,
  ] as const,
  custom: [...internalQueryKeys.adapters, 'custom'] as const,
  customCurrent: (providerId: string, ref?: AdapterKeyRef) => [
    ...internalQueryKeys.adapters,
    'custom',
    'current',
    providerId,
    ...refKey(ref),
  ] as const,
  customRevisions: (providerId: string, ref?: AdapterKeyRef, limit = 50) => [
    ...internalQueryKeys.adapters,
    'custom',
    'revisions',
    providerId,
    ...refKey(ref),
    limit,
  ] as const,
  customRevision: (providerId: string, ref: AdapterKeyRef) => [
    ...internalQueryKeys.adapters,
    'custom',
    'revision',
    providerId,
    ...refKey(ref),
  ] as const,
};

export const adaptersQueryKey = internalQueryKeys.adapters;
