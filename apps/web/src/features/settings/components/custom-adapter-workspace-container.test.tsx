/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  TrustedAdapterManifestSchema,
  type CustomAdapterDefinitionDto,
  type TrustedAdapterBindingDto,
} from '@imagine/shared';

import {
  CustomAdapterWorkspaceContainer,
  customAdapterWorkspaceKey,
  executeAdapterAction,
  executeMutationWithEditGuard,
  mapCustomDefinitionToDraft,
  mapCustomRevisionToSummary,
  mapTrustedAdapterToSummary,
  mapTrustedBindingRevisionToSummary,
  projectAdapterRevisionRef,
  readImportedDocument,
  projectTrustedWorkspaceState,
  resolveAdapterWorkspaceStatus,
  resolveExactAdapterDefinition,
} from './custom-adapter-workspace-container.js';
import { InternalApiError } from '../../../api/internal-client.js';
import { resolveWorkspaceStatusMessage, type AdapterRevision } from './custom-adapter-workspace.js';

const manifest = TrustedAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'trusted-fixture',
  version: '1.0.0',
  displayName: 'Trusted Fixture',
  sha256: 'a'.repeat(64),
  operations: ['image.generate'],
  capabilities: { providerType: 'trusted-fixture', models: [{ id: 'fixture', displayName: 'Fixture', capabilities: { operations: ['image.generate'] } }] },
  allowedHosts: ['api.example.com'],
  requiredSecrets: ['apiKey'],
  resourceLimits: {
    timeoutMs: 5_000,
    maxMessageBytes: 1_048_576,
    maxOutputBytes: 1_048_576,
    maxLogBytes: 65_536,
    maxOldGenerationSizeMb: 64,
    maxYoungGenerationSizeMb: 16,
    stackSizeMb: 4,
  },
});

const ref = {
  kind: 'declarative-http' as const,
  adapterId: 'custom-fixture',
  version: '1.0.0',
  digest: 'b'.repeat(64),
};

const customDefinition = {
  providerId: 'provider-1',
  ref,
  definition: { schemaVersion: 1, id: 'custom-fixture', name: 'Fixture', operations: ['image.generate'] },
  isCurrent: true,
  disabled: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
} as CustomAdapterDefinitionDto;

const displayedRevision = {
  ...ref,
  current: false,
  disabled: true,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
  displayName: 'Custom fixture revision',
} satisfies AdapterRevision;

const binding = {
  providerId: 'provider-1',
  adapter: {
    manifest,
    ref: { kind: 'trusted-javascript' as const, adapterId: manifest.id, version: manifest.version, digest: manifest.sha256 },
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  },
  isCurrent: true,
  disabled: false,
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
} as TrustedAdapterBindingDto;

describe('custom adapter workspace container mappings', () => {
  it('rethrows pre-request failures after recording the container error', async () => {
    const messages: string[] = [];
    const schemaError = new Error('Path test JSON must be valid JSON.');
    const requestStarted = false;

    await expect(executeAdapterAction('Path test', async () => {
      throw schemaError;
    }, (message) => messages.push(message))).rejects.toBe(schemaError);

    expect(requestStarted).toBe(false);
    expect(messages).toEqual(['Path test JSON must be valid JSON.']);
    expect(messages).not.toContain('Path test complete.');
  });

  it('records a container success message for outer workspace actions', async () => {
    const messages: string[] = [];
    await expect(executeAdapterAction('Save', async () => undefined, (message) => messages.push(message))).resolves.toBeUndefined();
    expect(messages).toEqual(['Save complete.']);
  });

  it('turns an empty or mismatched exact revision response into a missing revision', () => {
    expect(resolveExactAdapterDefinition(null, ref)).toBeNull();
    expect(resolveExactAdapterDefinition(undefined, ref)).toBeNull();
    expect(resolveExactAdapterDefinition({ definition: { ...customDefinition, ref: { ...ref, version: '2.0.0' } } }, ref)).toBeNull();
    expect(resolveExactAdapterDefinition({ definition: customDefinition }, ref)).toBe(customDefinition);
  });

  it('keeps Save dirty when a newer edit arrives while the request is deferred', async () => {
    let revision = 0;
    let committed = false;
    let stillDirty = false;
    let resolveRequest: (() => void) | undefined;
    const request = new Promise<void>((resolve) => { resolveRequest = resolve; });
    const save = executeMutationWithEditGuard(
      () => request,
      revision,
      () => revision,
      () => { committed = true; },
      () => { stillDirty = true; },
    );

    revision += 1;
    resolveRequest?.();
    await save;

    expect(committed).toBe(false);
    expect(stillDirty).toBe(true);
  });

  it('keeps action failures separate from success status and clears the old success message', async () => {
    const messages: string[] = [];
    let actionError: string | null = null;
    await expect(executeAdapterAction(
      'Save',
      async () => { throw new Error('Save request failed.'); },
      (message) => messages.push(message),
      undefined,
      (message) => { actionError = message; },
    )).rejects.toThrow('Save request failed.');

    expect(messages).toEqual(['Save request failed.']);
    expect(actionError).toBe('Save request failed.');
    expect(resolveAdapterWorkspaceStatus({
      actionError,
      adminAvailable: true,
      disabled: false,
      hasData: true,
      loading: false,
      online: true,
      queryError: null,
    })).toBe('error');
  });

  it('classifies a structured administrator 403 and records its server message', async () => {
    const messages: string[] = [];
    const onAdminError = vi.fn();
    const error = new InternalApiError(403, 'administrator_required', 'Administrator authorization is required.');

    await expect(executeAdapterAction('Validate', async () => {
      throw error;
    }, (message) => messages.push(message), onAdminError)).rejects.toBe(error);

    expect(onAdminError).toHaveBeenCalledOnce();
    expect(messages).toEqual(['Administrator authorization is required.']);
  });

  it('keeps Save feedback when a full-ref key change remounts the child workspace', async () => {
    const beforeRef = ref;
    const afterRef = { ...ref, version: '1.0.1', digest: 'c'.repeat(64) };
    const beforeKey = customAdapterWorkspaceKey({ providerId: 'provider-1', mode: 'custom-http', customRef: beforeRef });
    const afterKey = customAdapterWorkspaceKey({ providerId: 'provider-1', mode: 'custom-http', customRef: afterRef });
    expect(afterKey).not.toBe(beforeKey);

    let containerMessage: string | null = null;
    await executeAdapterAction('Save', async () => undefined, (message) => { containerMessage = message; });

    // A key remount clears local command state, while the container state remains.
    expect(resolveWorkspaceStatusMessage(null, containerMessage, 'Adapter workspace ready.')).toBe('Save complete.');
  });

  it('maps source-free current and revision DTOs into pure workspace values', () => {
    expect(mapCustomDefinitionToDraft(customDefinition).document).toContain('custom-fixture');
    expect(mapCustomRevisionToSummary(customDefinition)).toMatchObject({ adapterId: 'custom-fixture', current: true });
    expect(mapTrustedAdapterToSummary(binding.adapter)).toMatchObject({ adapterId: 'trusted-fixture', version: '1.0.0' });
    expect(mapTrustedBindingRevisionToSummary(binding)).toMatchObject({ kind: 'trusted-javascript', current: true });
    expect(mapTrustedAdapterToSummary(binding.adapter)).not.toHaveProperty('source');
  });

  it('keeps local test inputs when a server revision changes the keyed workspace', () => {
    const requestJson = JSON.stringify({
      operation: 'image.generate',
      providerId: 'provider-1',
      modelId: 'custom-fixture',
      prompt: 'Keep this sample request',
      inputs: [],
    });
    const draft = mapCustomDefinitionToDraft(customDefinition, {
      baseUrl: 'https://api.example.com/v1',
      format: 'yaml',
      requestJson,
      simulationStatus: '202',
      simulationJson: '{"status":"pending"}',
      path: '/data/0/id',
      pathTestJson: '{"data":[{"id":"fixture"}]}',
    });

    expect(draft.document).toContain('custom-fixture');
    expect(draft.version).toBe(ref.version);
    expect(draft).toMatchObject({
      baseUrl: 'https://api.example.com/v1',
      format: 'yaml',
      requestJson,
      simulationStatus: '202',
      simulationJson: '{"status":"pending"}',
      path: '/data/0/id',
      pathTestJson: '{"data":[{"id":"fixture"}]}',
    });
  });

  it.each(['Export', 'Load', 'Disable', 'Delete'] as const)(
    'projects the exact ref before the %s revision action',
    () => {
      expect(() => projectAdapterRevisionRef(displayedRevision)).not.toThrow(/unrecognized_keys/u);
      expect(projectAdapterRevisionRef(displayedRevision)).toEqual(ref);
    },
  );

  it('keeps container SSR-safe and exposes the independent dialog contract', () => {
    const provider = {
      id: 'provider-1',
      name: 'Custom provider',
      type: 'custom-http-v1',
      baseUrl: 'https://api.example.com',
      config: {},
      enabled: true,
      isDefault: false,
      hasApiKey: false,
      hasCustomHeaders: false,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const queryClient = new QueryClient();
    expect(() => renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(CustomAdapterWorkspaceContainer, {
      fixtureMode: true,
      onOpenChange: () => undefined,
      open: false,
      provider,
    })))).not.toThrow();
  });

  it('reads JSON and YAML export envelopes with their document metadata', async () => {
    const json = await readImportedDocument(new File([JSON.stringify({
      schemaVersion: 1,
      version: '2.0.0',
      definition: { id: 'json-adapter', name: 'JSON adapter' },
    })], 'adapter.json', { type: 'application/json' }));
    expect(json).toEqual({
      document: JSON.stringify({ id: 'json-adapter', name: 'JSON adapter' }, null, 2),
      format: 'json',
      version: '2.0.0',
    });

    const yamlText = 'schemaVersion: 1\nversion: 3.0.0\ndefinition:\n  id: yaml-adapter\n';
    await expect(readImportedDocument(new File([yamlText], 'adapter.yaml', { type: 'application/yaml' }))).resolves.toEqual({
      document: yamlText,
      format: 'yaml',
      version: '3.0.0',
    });
  });

  it('uses the dedicated disabled binding query beyond the visible 50-row history page', () => {
    const visibleHistory = Array.from({ length: 50 }, (_, index) => ({
      ...binding,
      adapter: {
        ...binding.adapter,
        ref: {
          ...binding.adapter.ref,
          adapterId: `visible-${String(index).padStart(2, '0')}`,
          digest: index.toString(16).padStart(64, '0'),
        },
      },
      isCurrent: false,
    })) satisfies TrustedAdapterBindingDto[];
    const disabled = {
      ...binding,
      isCurrent: false,
      disabled: true,
      updatedAt: '2026-08-27T00:01:00.000Z',
    } satisfies TrustedAdapterBindingDto;
    const state = projectTrustedWorkspaceState(disabled, visibleHistory);
    expect(state.binding).toBe(disabled);
    expect(state.bindingHistory).toHaveLength(50);
    expect(state.bindingHistory.some((item) => item.adapterId === disabled.adapter.ref.adapterId)).toBe(false);
  });

  it('keys the workspace by provider, mode, and every immutable ref field', () => {
    const base = customAdapterWorkspaceKey({
      providerId: 'provider-1',
      mode: 'custom-http',
      customRef: ref,
    });
    expect(customAdapterWorkspaceKey({
      providerId: 'provider-1',
      mode: 'custom-http',
      customRef: { ...ref, version: '2.0.0' },
    })).not.toBe(base);
    expect(customAdapterWorkspaceKey({
      providerId: 'provider-1',
      mode: 'custom-http',
      customRef: { ...ref, adapterId: 'custom-fixture-other' },
    })).not.toBe(base);
    expect(customAdapterWorkspaceKey({
      providerId: 'provider-1',
      mode: 'trusted-js',
      trustedBindingRef: { ...ref, kind: 'trusted-javascript' },
    })).not.toBe(base);
    expect(customAdapterWorkspaceKey({
      providerId: 'provider-2',
      mode: 'custom-http',
      customRef: ref,
    })).not.toBe(base);
  });

  it('keeps mobile sheet and touch-target rules in existing CSS', () => {
    const css = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.custom-adapter-dialog-content');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('max-height: calc(100dvh - var(--keyboard-offset))');
    expect(css).toContain('min-height: var(--control-touch)');
    expect(css).toContain('overflow: auto');
  });
});
