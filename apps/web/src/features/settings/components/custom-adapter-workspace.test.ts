import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CustomAdapterWorkspace,
  DEFAULT_CUSTOM_HTTP_DRAFT,
  adapterWorkspaceDisabledState,
  applyImportedAdapterDocument,
  applyImportedTrustedManifest,
  createLatestImportSequence,
  formatAdapterExportName,
  hasForbiddenAdapterFields,
  isAdapterRevisionDisabled,
  isFileImportSelectionDisabled,
  mapCustomHttpDraftToPayload,
  redactCustomHttpPreview,
  settleLatestImport,
  validateAdapterImportSecurity,
  validateCustomHttpDocument,
  validateTrustedJsManifest,
  type CustomHttpPreview,
} from './custom-adapter-workspace.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

const trustedManifest = JSON.stringify({
  schemaVersion: 1,
  id: 'trusted-image',
  version: '1.0.0',
  displayName: 'Trusted image adapter',
  sha256: 'a'.repeat(64),
  operations: ['image.generate'],
  capabilities: {
    providerType: 'trusted-image',
    models: [{ id: 'image-v1', displayName: 'Image v1', capabilities: { operations: ['image.generate'] } }],
  },
  allowedHosts: ['api.example.com'],
  requiredSecrets: ['apiKey'],
  resourceLimits: {
    timeoutMs: 5000,
    maxMessageBytes: 1048576,
    maxOutputBytes: 1048576,
    maxLogBytes: 65536,
    maxOldGenerationSizeMb: 64,
    maxYoungGenerationSizeMb: 16,
    stackSizeMb: 4,
  },
});

describe('CustomAdapterWorkspace SSR contract', () => {
  it('renders the custom HTTP document workflow with labeled controls', () => {
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      providerId: 'provider-1',
      preview: {
        method: 'POST',
        url: 'https://api.example.com/v1/generate',
        headers: { Authorization: '[redacted]' },
        query: { model: 'image-v1' },
        body: { type: 'json', value: { prompt: 'A studio still' } },
      },
      revisions: [{
        adapterId: 'custom-image',
        digest: 'b'.repeat(64),
        kind: 'declarative-http',
        version: '1.0.0',
      }],
      revisionsCursor: 'cursor-1',
    }));

    expect(markup).toContain('data-testid="custom-adapter-workspace"');
    expect(markup).toContain('aria-label="Adapter document"');
    expect(markup).toContain('aria-label="Generation request JSON"');
    expect(markup).toContain('aria-label="Document format"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('Redacted request preview');
    expect(markup).toContain('Load more revisions');
    expect(markup).toContain('Export JSON revision 1.0.0');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain('URL.createObjectURL');
    expect(markup).toContain('aria-label="Adapter version"');
  });

  it('uses a visible status fallback when an action message is empty', () => {
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      status: 'error',
      statusMessage: '',
    }));
    expect(markup).toContain('Adapter workspace error');
  });

  it('keeps trusted source outside rendered markup while exposing the manifest workflow', () => {
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      kind: 'trusted-javascript',
      trustedJs: { manifest: trustedManifest },
      status: 'admin-unavailable',
    }));

    expect(markup).toContain('Trusted JavaScript manifest');
    expect(markup).toContain('aria-label="Trusted JavaScript source file"');
    expect(markup).toContain('Select a source file before installing.');
    expect(markup).toContain('aria-label="Install trusted adapter" disabled=""');
    expect(markup).toContain('Allowed hosts');
    expect(markup).toContain('Required secrets');
    expect(markup).toContain('Resource limits');
    expect(markup).toContain('Administrator authorization is required');
    expect(markup).toContain('color:#8a4b00');
    expect(markup).toContain('aria-label="Trusted JavaScript source file"');
    expect(markup).not.toMatch(/<textarea[^>]*trusted-js-manifest[^>]*>[^<]*source-never-rendered-marker/u);
    expect(markup).not.toContain('name="source"');
    expect(markup).not.toContain('adminEnabled');
  });

  it('marks controls disabled for offline, disabled, and loading states', () => {
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      online: false,
      status: 'success',
    }));

    expect(markup).toContain('data-state="offline"');
    expect(markup).toContain('Offline - adapter management is unavailable');
    expect(markup).toContain('disabled=""');
  });

  it('keeps local fields visible while admin-unavailable disables remote commands', () => {
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      status: 'admin-unavailable',
    }));
    expect(markup).toContain('aria-label="Adapter document"');
    expect(markup).toContain('aria-label="Validate" disabled=""');
    expect(markup).toContain('Administrator access is unavailable');
  });

  it('keeps Trusted lifecycle actions available when the current binding is disabled', () => {
    const trustedRef = {
      kind: 'trusted-javascript' as const,
      adapterId: 'trusted-image',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    };
    const trustedSummary = {
      adapterId: trustedRef.adapterId,
      version: trustedRef.version,
      displayName: 'Trusted image adapter',
      ref: trustedRef,
      manifest: {
        id: trustedRef.adapterId,
        version: trustedRef.version,
        displayName: 'Trusted image adapter',
        allowedHosts: ['api.example.com'],
        requiredSecrets: [],
        resourceLimits: { timeoutMs: 5_000 },
      },
    };
    const markup = renderToStaticMarkup(createElement(CustomAdapterWorkspace, {
      mode: 'trusted-js',
      providerId: 'provider-1',
      status: 'disabled',
      trustedAdapters: [trustedSummary],
      trustedBinding: trustedSummary,
      trustedBindingDisabled: true,
      trustedBindingHistory: [{ ...trustedRef, current: true, disabled: true }],
      trustedBindingHistoryCursor: 'next',
    }));
    const buttonMarkup = (label: string): string => markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'u'))?.[0] ?? '';
    expect(buttonMarkup('Disable provider binding')).toContain('disabled=""');
    expect(buttonMarkup('Unbind provider')).not.toContain('disabled=""');
    expect(buttonMarkup(`Remove trusted adapter ${trustedRef.adapterId}`)).not.toContain('disabled=""');
    expect(buttonMarkup('Load more binding history')).not.toContain('disabled=""');
    expect(buttonMarkup('Bind adapter to provider')).toContain('disabled=""');
    expect(markup).toContain('data-state="disabled"');
    expect(markup).toContain('Disabled binding: Trusted image adapter');
  });
});

describe('CustomAdapterWorkspace mapping and validation', () => {
  it('applies imported document, format, and envelope version in one draft value', () => {
    const draft = applyImportedAdapterDocument({
      ...DEFAULT_CUSTOM_HTTP_DRAFT,
      format: 'json',
      version: '9.9.9',
    }, {
      document: 'schemaVersion: 1\nversion: 1.2.3\ndefinition:\n  id: imported\n',
      format: 'yaml',
      version: '1.2.3',
    });
    expect(draft).toMatchObject({
      document: 'schemaVersion: 1\nversion: 1.2.3\ndefinition:\n  id: imported\n',
      format: 'yaml',
      version: '1.2.3',
    });
    expect(draft).not.toBe(DEFAULT_CUSTOM_HTTP_DRAFT);
  });

  it('keeps edits made during file reads and ignores stale HTTP and Trusted imports', async () => {
    const httpSequence = createLatestImportSequence();
    const firstHttp = deferred<{ document: string; format: 'json'; version: string }>();
    const secondHttp = deferred<{ document: string; format: 'yaml'; version: string }>();
    let httpDraft = { ...DEFAULT_CUSTOM_HTTP_DRAFT, baseUrl: 'https://before.example' };
    const firstHttpTask = settleLatestImport(httpSequence, httpSequence.begin(), () => firstHttp.promise, (imported) => {
      httpDraft = applyImportedAdapterDocument(httpDraft, imported);
    });
    const secondHttpTask = settleLatestImport(httpSequence, httpSequence.begin(), () => secondHttp.promise, (imported) => {
      httpDraft = applyImportedAdapterDocument(httpDraft, imported);
    });
    httpDraft = { ...httpDraft, baseUrl: 'https://edited-while-reading.example' };
    secondHttp.resolve({ document: 'id: second', format: 'yaml', version: '2.0.0' });
    await expect(secondHttpTask).resolves.toEqual({ state: 'complete' });
    firstHttp.resolve({ document: '{"id":"first"}', format: 'json', version: '1.0.0' });
    await expect(firstHttpTask).resolves.toEqual({ state: 'stale' });
    expect(httpDraft).toMatchObject({
      baseUrl: 'https://edited-while-reading.example',
      document: 'id: second',
      format: 'yaml',
      version: '2.0.0',
    });

    const trustedSequence = createLatestImportSequence();
    const firstManifest = deferred<string>();
    const secondManifest = deferred<string>();
    let trustedDraft = { manifest: 'initial', providerId: 'provider-before' };
    const firstManifestTask = settleLatestImport(trustedSequence, trustedSequence.begin(), () => firstManifest.promise, (imported) => {
      trustedDraft = applyImportedTrustedManifest(trustedDraft, imported);
    });
    const secondManifestTask = settleLatestImport(trustedSequence, trustedSequence.begin(), () => secondManifest.promise, (imported) => {
      trustedDraft = applyImportedTrustedManifest(trustedDraft, imported);
    });
    trustedDraft = { ...trustedDraft, providerId: 'provider-edited-while-reading' };
    secondManifest.resolve('second manifest');
    await expect(secondManifestTask).resolves.toEqual({ state: 'complete' });
    firstManifest.resolve('first manifest');
    await expect(firstManifestTask).resolves.toEqual({ state: 'stale' });
    expect(trustedDraft).toEqual({
      manifest: 'second manifest',
      providerId: 'provider-edited-while-reading',
    });

    const errorSequence = createLatestImportSequence();
    const error = new Error('read failed');
    await expect(settleLatestImport(errorSequence, errorSequence.begin(), () => { throw error; }, () => undefined)).resolves.toEqual({
      error,
      state: 'error',
    });

    const invalidatedSequence = createLatestImportSequence();
    const invalidatedRead = deferred<string>();
    let invalidatedApplied = false;
    const invalidatedTask = settleLatestImport(
      invalidatedSequence,
      invalidatedSequence.begin(),
      () => invalidatedRead.promise,
      () => { invalidatedApplied = true; },
    );
    invalidatedSequence.invalidate();
    invalidatedRead.resolve('old workspace result');
    await expect(invalidatedTask).resolves.toEqual({ state: 'stale' });
    expect(invalidatedApplied).toBe(false);
  });

  it('treats every disabled history ref as terminal for Bind actions', () => {
    const disabled = {
      adapterId: 'disabled-adapter',
      digest: 'd'.repeat(64),
      kind: 'trusted-javascript' as const,
      version: '1.0.0',
    };
    const enabled = { ...disabled, adapterId: 'enabled-adapter', digest: 'e'.repeat(64) };
    const history = [
      { ...enabled, current: true, disabled: false },
      { ...disabled, current: false, disabled: true },
    ];
    expect(isAdapterRevisionDisabled(disabled, history)).toBe(true);
    expect(isAdapterRevisionDisabled(enabled, history)).toBe(false);
    expect(isAdapterRevisionDisabled(undefined, history)).toBe(false);
  });

  it('prevents another file selection while either import is reading', () => {
    expect(isFileImportSelectionDisabled(false, false, 'reading')).toBe(true);
    expect(isFileImportSelectionDisabled(false, false, 'complete')).toBe(false);
    expect(isFileImportSelectionDisabled(false, false, 'error')).toBe(false);
    expect(isFileImportSelectionDisabled(true, false, 'idle')).toBe(true);
    expect(isFileImportSelectionDisabled(false, true, 'idle')).toBe(true);
  });

  it('blocks remote commands during import without disabling ordinary fields', () => {
    expect(adapterWorkspaceDisabledState({
      adminAvailable: true,
      disabled: false,
      importPending: true,
      mode: 'custom-http',
      status: 'success',
    })).toEqual({ localDisabled: false, remoteDisabled: true });
    expect(adapterWorkspaceDisabledState({
      adminAvailable: true,
      disabled: false,
      importPending: true,
      mode: 'trusted-js',
      status: 'disabled',
    })).toEqual({ localDisabled: false, remoteDisabled: true });
  });

  it('rejects secret-like and administrator-only fields recursively', () => {
    expect(hasForbiddenAdapterFields({ request: { extra: { adminEnabled: true } } })).toBe(true);
    expect(hasForbiddenAdapterFields({ request: { extra: { apiKey: 'plaintext' } } })).toBe(true);
    expect(hasForbiddenAdapterFields({ headers: { Authorization: '{{ secret.apiKey }}' } })).toBe(false);
    expect(validateCustomHttpDocument('json', '{"adminEnabled":true}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('server-only'),
    });
    expect(validateCustomHttpDocument('yaml', 'adminEnabled: true')).toMatchObject({
      ok: false,
      error: expect.stringContaining('server-only'),
    });
  });

  it('rejects static imported credentials before accepting draft content but permits safe templates', () => {
    expect(validateAdapterImportSecurity('json', '{"headers":{"Authorization":"Bearer static-secret-value"}}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"headers":{"Authorization":"Bearer {{ secret.apiKey }}"}}')).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', '{"headers":{"Content-Type":"application/json"}}')).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', '{"apiKey":"plaintext"}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'Authorization: Bearer static-secret-value')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"headers":')).toMatchObject({ ok: false, error: expect.stringContaining('valid JSON') });
  });

  it('maps a draft without leaking optional values and preserves long documents', () => {
    const document = `${'{\n  "id": "long-adapter"\n}'.repeat(2_000)}`;
    const payload = mapCustomHttpDraftToPayload({
      ...DEFAULT_CUSTOM_HTTP_DRAFT,
      document: '{"id":"custom-image","version":"1.0.0"}',
      requestJson: '{"prompt":"test"}',
    }, ' provider-1 ');

    expect(payload).toMatchObject({
      providerId: 'provider-1',
      format: 'json',
      version: '1.0.0',
      document: '{"id":"custom-image","version":"1.0.0"}',
      request: { prompt: 'test' },
    });
    expect(document.length).toBeGreaterThan(20_000);
    expect(DEFAULT_CUSTOM_HTTP_DRAFT.document).not.toContain('"version"');
    expect(mapCustomHttpDraftToPayload({ ...DEFAULT_CUSTOM_HTTP_DRAFT, document: '{"id":"x"}', requestJson: '' })).not.toHaveProperty('request');
    expect(() => mapCustomHttpDraftToPayload({ ...DEFAULT_CUSTOM_HTTP_DRAFT, baseUrl: 'https://user:pass@example.com' })).toThrow('credentials');
    expect(() => mapCustomHttpDraftToPayload({ ...DEFAULT_CUSTOM_HTTP_DRAFT, baseUrl: 'https://example.com?secret=1' })).toThrow('query');
  });

  it('maps trusted manifest safety metadata without source bytes', () => {
    const result = validateTrustedJsManifest(trustedManifest);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.allowedHosts).toEqual(['api.example.com']);
      expect(result.value.requiredSecrets).toEqual(['apiKey']);
      expect(result.value.resourceLimits.timeoutMs).toBe(5000);
      expect(result.value).not.toHaveProperty('source');
    }
  });

  it('redacts preview values but keeps method, endpoint shape, and file metadata', () => {
    const preview: CustomHttpPreview = {
      method: 'POST',
      url: 'https://example.com/v1/generate?apiKey=plaintext&model=image-v1',
      headers: { Authorization: 'Bearer plaintext', 'X-Request': 'safe' },
      query: { token: 'plaintext', model: 'image-v1' },
      body: {
        type: 'multipart',
        fields: { password: 'plaintext', prompt: 'safe' },
        files: [{ field: 'image', filename: 'reference.png', contentType: 'image/png', assetId: 'asset-1', byteLength: 12 }],
      },
    };
    const redacted = redactCustomHttpPreview(preview);
    expect(redacted.method).toBe('POST');
    expect(redacted.url).toContain('apiKey=%5Bredacted%5D');
    expect(redacted.headers.Authorization).toBe('[redacted]');
    expect(redacted.query.token).toBe('[redacted]');
    expect(redacted.body.fields?.password).toBe('[redacted]');
    expect(redacted.body.files?.[0]).toMatchObject({ filename: 'reference.png', byteLength: 12 });
  });

  it('creates exact export filenames from immutable revision references', () => {
    expect(formatAdapterExportName({
      adapterId: 'custom/image',
      digest: 'c'.repeat(64),
      kind: 'declarative-http',
      version: '1.0.0+build',
    }, 'yaml')).toBe('adapter-custom_image-1.0.0+build.yaml');
  });
});
