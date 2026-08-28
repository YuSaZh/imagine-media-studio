import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import type * as AdapterQueryModule from '../api/adapter-query.js';
import type * as WorkspaceModule from './custom-adapter-workspace.js';
import type { CustomAdapterWorkspaceActions, AdapterRevision } from './custom-adapter-workspace.js';

const actionState = vi.hoisted(() => ({
  workspaceProps: undefined as { readonly actions?: CustomAdapterWorkspaceActions } | undefined,
  queryEnabled: [] as boolean[],
  export: vi.fn(),
  validate: vi.fn(),
  disable: vi.fn(),
  delete: vi.fn(),
}));

const exactRef = {
  kind: 'declarative-http' as const,
  adapterId: 'custom-fixture',
  version: '1.0.0',
  digest: 'b'.repeat(64),
};

const displayedRevision = {
  ...exactRef,
  current: true,
  disabled: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  displayName: 'Custom fixture',
} satisfies AdapterRevision;

const currentDefinition = {
  providerId: 'provider-1',
  ref: exactRef,
  definition: { id: exactRef.adapterId, name: 'Custom fixture' },
  isCurrent: true,
  disabled: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

function query<T>(data: T) {
  return {
    data,
    error: null,
    isPending: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({ data }),
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('./custom-adapter-workspace.js', async () => {
  const actual = await vi.importActual<typeof WorkspaceModule>('./custom-adapter-workspace.js');
  return {
    ...actual,
    CustomAdapterWorkspace: (props: { readonly actions?: CustomAdapterWorkspaceActions }) => {
      actionState.workspaceProps = props;
      return createElement('div');
    },
  };
});

vi.mock('@radix-ui/react-dialog', () => {
  const passthrough = ({ children }: { readonly children?: ReactNode }) => createElement('div', null, children);
  return {
    Content: passthrough,
    Description: passthrough,
    Overlay: passthrough,
    Portal: passthrough,
    Root: passthrough,
    Title: passthrough,
  };
});

vi.mock('../api/adapter-query.js', async () => {
  const actual = await vi.importActual<typeof AdapterQueryModule>('../api/adapter-query.js');
  return {
    ...actual,
    loadCustomAdapterExportData: actionState.export,
    useBindTrustedAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useCustomAdapterQuery: (_providerId: string, _fixture: boolean, enabled: boolean) => {
      actionState.queryEnabled.push(enabled);
      return query({ definition: currentDefinition });
    },
    useCustomAdapterRevisionQuery: (_providerId: string, _ref: unknown, _fixture: boolean, enabled: boolean) => {
      actionState.queryEnabled.push(enabled);
      return query({ definition: currentDefinition });
    },
    useCustomAdapterRevisionsQuery: (_providerId: string, _options: unknown, _fixture: boolean, enabled: boolean) => {
      actionState.queryEnabled.push(enabled);
      return query({ pages: [{ items: [currentDefinition], nextCursor: null }] });
    },
    useDeleteCustomAdapter: () => ({ mutateAsync: actionState.delete }),
    useDisableCustomAdapter: () => ({ mutateAsync: actionState.disable }),
    useDisableTrustedBinding: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useDryRunCustomAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useInstallTrustedAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    usePreviewCustomAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    usePreviewCustomAdapterCapabilities: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    usePutCustomAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useRemoveTrustedAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useSimulateCustomAdapter: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useTestCustomAdapterPath: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useTrustedAdapterQuery: () => query(undefined),
    useTrustedAdaptersQuery: () => query({ items: [] }),
    useTrustedBindingQuery: () => query({ binding: null }),
    useTrustedBindingsQuery: () => query({ pages: [{ items: [], nextCursor: null }] }),
    useUnbindTrustedBinding: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
    useValidateCustomAdapter: () => ({ mutateAsync: actionState.validate }),
  };
});

describe('custom adapter workspace revision actions', () => {
  it('rebounds SSR-captured actions to the active Provider and omits the workspace while closed', async () => {
    const { CustomAdapterWorkspaceContainer } = await import('./custom-adapter-workspace-container.js');
    const provider = (id: string) => ({
      id,
      name: `Custom provider ${id}`,
      type: 'custom-http-v1' as const,
      baseUrl: 'https://api.example.com',
      config: {},
      enabled: true,
      isDefault: false,
      hasApiKey: false,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    });
    const render = (id: string, open: boolean) => renderToStaticMarkup(createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(CustomAdapterWorkspaceContainer, {
        confirm: () => true,
        fixtureMode: false,
        onOpenChange: () => undefined,
        open,
        provider: provider(id),
      }),
    ));
    const payload = {
      format: 'json' as const,
      document: '{}',
      version: '1.0.0',
      request: { prompt: 'provider scoped' },
    };

    actionState.validate.mockReset().mockResolvedValue(undefined);
    actionState.workspaceProps = undefined;
    render('provider-1', true);
    const first = actionState.workspaceProps as unknown as { readonly actions: CustomAdapterWorkspaceActions };
    await first.actions.onValidate?.(payload);
    expect(actionState.validate).toHaveBeenLastCalledWith({
      providerId: 'provider-1',
      request: {
        format: payload.format,
        document: payload.document,
        request: payload.request,
      },
    });

    actionState.workspaceProps = undefined;
    render('provider-2', true);
    const second = actionState.workspaceProps as unknown as { readonly actions: CustomAdapterWorkspaceActions };
    await second.actions.onValidate?.(payload);
    expect(actionState.validate).toHaveBeenLastCalledWith({
      providerId: 'provider-2',
      request: {
        format: payload.format,
        document: payload.document,
        request: payload.request,
      },
    });

    actionState.workspaceProps = undefined;
    actionState.queryEnabled = [];
    const closedMarkup = render('provider-2', false);
    expect(actionState.workspaceProps).toBeUndefined();
    expect(closedMarkup).not.toContain('custom-adapter-workspace');
    expect(actionState.queryEnabled).toEqual([false, false, false]);
  });

  it('uses a fresh container identity and resets every session field on provider/open changes', async () => {
    const {
      createCustomAdapterWorkspaceContainerState,
      customAdapterWorkspaceContainerKey,
      reduceCustomAdapterWorkspaceContainerState,
    } = await import('./custom-adapter-workspace-container.js');
    const initial = createCustomAdapterWorkspaceContainerState();
    let active = reduceCustomAdapterWorkspaceContainerState(initial, {
      type: 'set-admin-available',
      value: false,
    });
    active = reduceCustomAdapterWorkspaceContainerState(active, {
      type: 'set-custom-local-draft',
      value: {
        format: 'yaml',
        baseUrl: 'https://old.example.test',
        requestJson: '{"prompt":"old"}',
      },
    });
    active = reduceCustomAdapterWorkspaceContainerState(active, { type: 'set-dirty', value: true });
    active = reduceCustomAdapterWorkspaceContainerState(active, { type: 'set-message', value: 'old message' });
    active = reduceCustomAdapterWorkspaceContainerState(active, { type: 'set-pending-action', value: 'Save' });
    active = reduceCustomAdapterWorkspaceContainerState(active, { type: 'set-selected-revision', value: exactRef });
    active = reduceCustomAdapterWorkspaceContainerState(active, { type: 'set-trusted-lookup-id', value: 'old-adapter' });

    expect(reduceCustomAdapterWorkspaceContainerState(active, { type: 'reset' })).toEqual(initial);
    expect(customAdapterWorkspaceContainerKey({ providerId: 'provider-1', providerType: 'custom-http-v1', open: true }))
      .not.toBe(customAdapterWorkspaceContainerKey({ providerId: 'provider-2', providerType: 'custom-http-v1', open: true }));
    expect(customAdapterWorkspaceContainerKey({ providerId: 'provider-1', providerType: 'custom-http-v1', open: true }))
      .not.toBe(customAdapterWorkspaceContainerKey({ providerId: 'provider-1', providerType: 'custom-http-v1', open: false }));
  });

  it('clears the selected exact revision and local test inputs only after Delete succeeds', async () => {
    const {
      createCustomAdapterWorkspaceContainerState,
      reduceCustomAdapterWorkspaceContainerState,
    } = await import('./custom-adapter-workspace-container.js');
    let state = createCustomAdapterWorkspaceContainerState();
    state = reduceCustomAdapterWorkspaceContainerState(state, { type: 'set-selected-revision', value: exactRef });
    state = reduceCustomAdapterWorkspaceContainerState(state, {
      type: 'set-custom-local-draft',
      value: { requestJson: '{"prompt":"keep until delete"}' },
    });
    state = reduceCustomAdapterWorkspaceContainerState(state, { type: 'set-dirty', value: true });
    state = reduceCustomAdapterWorkspaceContainerState(state, { type: 'set-message', value: 'pending delete' });

    const afterDelete = reduceCustomAdapterWorkspaceContainerState(state, { type: 'delete-current-success' });
    expect(afterDelete).toMatchObject({
      customLocalDraft: {},
      dirty: false,
      selectedRevision: null,
      message: 'pending delete',
    });
    expect(afterDelete.trustedLookupId).toBe('');
  });

  it('does not dispatch Delete cleanup or change state when the mutation rejects', async () => {
    const {
      createCustomAdapterWorkspaceContainerState,
      executeDeleteCurrentMutation,
      reduceCustomAdapterWorkspaceContainerState,
    } = await import('./custom-adapter-workspace-container.js');
    let state = createCustomAdapterWorkspaceContainerState();
    state = reduceCustomAdapterWorkspaceContainerState(state, { type: 'set-selected-revision', value: exactRef });
    state = reduceCustomAdapterWorkspaceContainerState(state, {
      type: 'set-custom-local-draft',
      value: {
        format: 'yaml',
        requestJson: '{"prompt":"keep after failed delete"}',
        simulationStatus: '202',
        simulationJson: '{"status":"pending"}',
        path: '/data/0/id',
        pathTestJson: '{"data":[{"id":"keep"}]}',
      },
    });
    state = reduceCustomAdapterWorkspaceContainerState(state, { type: 'set-dirty', value: true });
    const beforeFailure = state;
    const dispatch = vi.fn();
    const failure = new Error('delete failed');
    const mutation = vi.fn().mockRejectedValue(failure);

    await expect(executeDeleteCurrentMutation(mutation, dispatch)).rejects.toBe(failure);
    expect(mutation).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();

    const afterFailure = dispatch.mock.calls.reduce(
      (next, [action]) => reduceCustomAdapterWorkspaceContainerState(next, action),
      beforeFailure,
    );
    expect(afterFailure).toEqual(beforeFailure);
  });

  it('retains local test fields while a full immutable ref remounts the child workspace', async () => {
    const { customAdapterWorkspaceKey, mapCustomDefinitionToDraft } = await import('./custom-adapter-workspace-container.js');
    const nextRef = { ...exactRef, version: '1.0.1', digest: 'c'.repeat(64) };
    const localDraft = {
      format: 'yaml' as const,
      baseUrl: 'https://local.example.test',
      requestJson: '{"prompt":"keep across remount"}',
      simulationStatus: '202',
      simulationJson: '{"status":"pending"}',
      path: '/data/0/id',
      pathTestJson: '{"data":[{"id":"local"}]}',
    };
    const before = customAdapterWorkspaceKey({ providerId: 'provider-1', mode: 'custom-http', customRef: exactRef });
    const after = customAdapterWorkspaceKey({ providerId: 'provider-1', mode: 'custom-http', customRef: nextRef });
    expect(after).not.toBe(before);

    const remountedDraft = mapCustomDefinitionToDraft({ ...currentDefinition, ref: nextRef }, localDraft);
    expect(remountedDraft).toMatchObject(localDraft);
  });

  it('uses a strict exact ref for decorated Export, Load, Disable, and Delete revisions', async () => {
    actionState.workspaceProps = undefined;
    actionState.export.mockReset().mockResolvedValue({
      text: '{}',
      content: '{}',
      filename: null,
      contentType: 'application/json',
    });
    actionState.disable.mockReset().mockResolvedValue(undefined);
    actionState.delete.mockReset().mockResolvedValue(undefined);

    const { CustomAdapterWorkspaceContainer } = await import('./custom-adapter-workspace-container.js');
    const provider = {
      id: 'provider-1',
      name: 'Custom provider',
      type: 'custom-http-v1' as const,
      baseUrl: 'https://api.example.com',
      config: {},
      enabled: true,
      isDefault: false,
      hasApiKey: false,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    renderToStaticMarkup(createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(CustomAdapterWorkspaceContainer, {
        confirm: () => true,
        fixtureMode: false,
        onOpenChange: () => undefined,
        open: true,
        provider,
      }),
    ));

    const capturedProps = actionState.workspaceProps as unknown as { readonly actions: CustomAdapterWorkspaceActions };
    expect(capturedProps).toBeDefined();
    const actions = capturedProps.actions;

    await actions.onExport?.({ format: 'json', ref: displayedRevision });
    expect(actionState.export).toHaveBeenCalledWith(false, 'provider-1', { format: 'json', ref: exactRef });

    expect(() => actions.onLoadRevision?.(displayedRevision)).not.toThrow(/unrecognized_keys/u);

    await actions.onDisable?.(displayedRevision);
    expect(actionState.disable).toHaveBeenCalledWith({ providerId: 'provider-1', ref: exactRef });

    await actions.onDelete?.(displayedRevision);
    expect(actionState.delete).toHaveBeenCalledWith({ providerId: 'provider-1', ref: exactRef });
  });
});
