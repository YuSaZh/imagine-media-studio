/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  TrustedAdapterManifestSchema,
  type CustomAdapterDefinitionDto,
  type TrustedAdapterBindingDto,
} from '@imagine/shared';

import {
  CustomAdapterWorkspaceContainer,
  mapCustomDefinitionToDraft,
  mapCustomRevisionToSummary,
  mapTrustedAdapterToSummary,
  mapTrustedBindingRevisionToSummary,
} from './custom-adapter-workspace-container.js';

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
  it('maps source-free current and revision DTOs into pure workspace values', () => {
    expect(mapCustomDefinitionToDraft(customDefinition).document).toContain('custom-fixture');
    expect(mapCustomRevisionToSummary(customDefinition)).toMatchObject({ adapterId: 'custom-fixture', current: true });
    expect(mapTrustedAdapterToSummary(binding.adapter)).toMatchObject({ adapterId: 'trusted-fixture', version: '1.0.0' });
    expect(mapTrustedBindingRevisionToSummary(binding)).toMatchObject({ kind: 'trusted-javascript', current: true });
    expect(mapTrustedAdapterToSummary(binding.adapter)).not.toHaveProperty('source');
  });

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

  it('keeps mobile sheet and touch-target rules in existing CSS', () => {
    const css = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.custom-adapter-dialog-content');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('max-height: calc(100dvh - var(--keyboard-offset))');
    expect(css).toContain('min-height: var(--control-touch)');
    expect(css).toContain('overflow: auto');
  });
});
