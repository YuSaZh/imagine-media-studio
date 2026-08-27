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
  findForbiddenAdapterFields,
  hasForbiddenAdapterFields,
  isAdapterRevisionDisabled,
  isFileImportSelectionDisabled,
  mapCustomHttpPathTestToPayload,
  mapCustomHttpDraftToPayload,
  redactCustomHttpPreview,
  resolveWorkspaceStatusMessage,
  runWorkspaceAction,
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

function customHttpSpecWithAuth(): Record<string, unknown> {
  const spec = JSON.parse(DEFAULT_CUSTOM_HTTP_DRAFT.document) as Record<string, unknown>;
  const submit = spec.submit as Record<string, unknown>;
  submit.auth = { type: 'bearer', secretRef: 'apiKey', location: 'header' };
  return spec;
}

function customHttpSpecWithSchemaMetadata(customFieldApiKey: unknown = { type: 'string', maxLength: 64 }): Record<string, unknown> {
  const spec = customHttpSpecWithAuth();
  const model = (spec.models as Array<Record<string, unknown>>)[0]!;
  model.requestSchema = {
    type: 'object',
    properties: {
      apiKey: { type: 'string', maxLength: 64 },
      authorization: { type: 'string' },
      secretary: { type: 'string' },
      mytoken: { type: 'string' },
    },
    required: [],
    additionalProperties: false,
  };
  const capabilities = model.capabilities as Record<string, unknown>;
  capabilities.customFields = { apiKey: customFieldApiKey };
  return spec;
}

function exportedJsonEnvelope(spec: Record<string, unknown>, version = '1.0.0'): string {
  return JSON.stringify({ schemaVersion: 1, version, definition: spec });
}

function exportedYamlEnvelope(secretRef = 'apiKey'): string {
  return [
    'definition:',
    '  submit:',
    '    auth:',
    '      location: header',
    `      secretRef: ${secretRef}`,
    '      type: bearer',
    '    body:',
    '      type: json',
    'schemaVersion: 1',
    'version: 1.0.0',
  ].join('\n');
}

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

  it('prioritizes local feedback, then durable container feedback, then status fallback', () => {
    expect(resolveWorkspaceStatusMessage('Canceled.', 'Save complete.', 'Adapter workspace ready.')).toBe('Canceled.');
    expect(resolveWorkspaceStatusMessage(null, 'Save complete.', 'Adapter workspace ready.')).toBe('Save complete.');
    expect(resolveWorkspaceStatusMessage(null, null, 'Adapter workspace ready.')).toBe('Adapter workspace ready.');
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
  it('maps path tests to the strict response-document contract', () => {
    const payload = mapCustomHttpPathTestToPayload({
      ...DEFAULT_CUSTOM_HTTP_DRAFT,
      baseUrl: 'https://api.example.test',
      document: '{"id":"adapter-definition"}',
      format: 'yaml',
      version: '9.9.9',
      path: '/data/0/id',
      pathTestJson: '{"data":[{"id":"path-result"}]}',
    }, 'provider-1');

    expect(payload).toEqual({
      providerId: 'provider-1',
      path: '/data/0/id',
      json: { data: [{ id: 'path-result' }] },
    });
    expect(payload).not.toHaveProperty('format');
    expect(payload).not.toHaveProperty('document');
    expect(payload).not.toHaveProperty('baseUrl');
    expect(payload).not.toHaveProperty('version');
  });

  it('reports synchronous schema failures as failures and emits one success message', async () => {
    const failureMessages: string[] = [];
    let requestStarted = false;
    await runWorkspaceAction(() => {
      const payload = mapCustomHttpPathTestToPayload({
        path: '/data/0/id',
        pathTestJson: '{invalid-json',
      });
      requestStarted = true;
      return payload;
    }, 'Path test', (message) => failureMessages.push(message));
    expect(requestStarted).toBe(false);
    expect(failureMessages).toEqual(['Path test JSON must be valid JSON.']);
    expect(failureMessages).not.toContain('Path test complete.');

    const successMessages: string[] = [];
    await runWorkspaceAction(() => {
      requestStarted = true;
    }, 'Path test', (message) => successMessages.push(message));
    expect(successMessages).toEqual(['Path test complete.']);
  });

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
    expect(hasForbiddenAdapterFields({ headers: { Authorization: '{{ secret.apiKey }}' } })).toBe(true);
    expect(validateCustomHttpDocument('json', '{"adminEnabled":true}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('server-only'),
    });
    expect(validateCustomHttpDocument('yaml', 'adminEnabled: true')).toMatchObject({
      ok: false,
      error: expect.stringContaining('server-only'),
    });
  });

  it('allows only schema-owned auth secret references through JSON and YAML boundaries', () => {
    const spec = customHttpSpecWithAuth();
    const json = exportedJsonEnvelope(spec);
    const yaml = exportedYamlEnvelope();

    expect(findForbiddenAdapterFields(spec)).toEqual([]);
    expect(findForbiddenAdapterFields(JSON.parse(json) as unknown)).toEqual([]);
    expect(validateCustomHttpDocument('json', JSON.stringify(spec))).toMatchObject({ ok: true });
    expect(validateCustomHttpDocument('yaml', 'schemaVersion: 1\nsubmit:\n  auth: { type: bearer, secretRef: apiKey, location: header }\n')).toMatchObject({ ok: true });
    expect(validateCustomHttpDocument('json', json)).toMatchObject({ ok: true });
    expect(validateCustomHttpDocument('yaml', yaml)).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', json)).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('yaml', yaml)).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', JSON.stringify(spec))).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('yaml', 'schemaVersion: 1\nsubmit:\n  auth: { type: bearer, secretRef: apiKey, location: header }\n')).toMatchObject({ ok: true });
  });

  it('allows credential-like request schema names and schema-shaped custom fields', () => {
    const document = JSON.stringify(customHttpSpecWithSchemaMetadata());
    expect(findForbiddenAdapterFields(JSON.parse(document) as unknown)).toEqual([]);
    expect(validateCustomHttpDocument('json', document)).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', document)).toMatchObject({ ok: true });
  });

  it('delegates null, empty, list, and descriptive custom fields to the shared guard', () => {
    for (const customFields of [null, {}, [], { description: 'A display-only note.' }]) {
      const spec = customHttpSpecWithAuth();
      const model = (spec.models as Array<Record<string, unknown>>)[0]!;
      (model.capabilities as Record<string, unknown>).customFields = customFields;
      const document = JSON.stringify(spec);
      expect(validateCustomHttpDocument('json', document)).toMatchObject({ ok: true });
      expect(validateAdapterImportSecurity('json', document)).toMatchObject({ ok: true });
    }
  });

  it('rejects credential-like custom fields unless they contain a strict request schema', () => {
    for (const customFieldApiKey of ['plaintext', '{{ secret.apiKey }}']) {
      const document = JSON.stringify(customHttpSpecWithSchemaMetadata(customFieldApiKey));
      expect(validateCustomHttpDocument('json', document)).toMatchObject({ ok: false });
      expect(validateAdapterImportSecurity('json', document)).toMatchObject({ ok: false });
    }
  });

  it('rejects secret references outside auth paths and unsafe reference values in both formats', () => {
    const spec = customHttpSpecWithAuth();
    const invalidJsonValues = [
      { ...spec, metadata: { secretRef: 'apiKey' } },
      { ...spec, submit: { ...(spec.submit as Record<string, unknown>), body: { type: 'json', value: { secretRef: 'apiKey' } } } },
      { ...spec, submit: { ...(spec.submit as Record<string, unknown>), auth: { type: 'bearer', secretRef: '{{ secret.apiKey }}', location: 'header' } } },
      { ...spec, submit: { ...(spec.submit as Record<string, unknown>), auth: { type: 'bearer', secretRef: '__proto__', location: 'header' } } },
      { ...spec, submit: { ...(spec.submit as Record<string, unknown>), auth: { type: 'bearer', secretRef: '   ', location: 'header' } } },
      { ...spec, submit: { ...(spec.submit as Record<string, unknown>), auth: { type: 'bearer', secretRef: 'x'.repeat(129), location: 'header' } } },
    ];
    for (const value of invalidJsonValues) {
      const document = exportedJsonEnvelope(value);
      expect(hasForbiddenAdapterFields(value)).toBe(true);
      expect(validateCustomHttpDocument('json', document)).toMatchObject({ ok: false });
      expect(validateAdapterImportSecurity('json', document)).toMatchObject({ ok: false });
    }

    expect(validateAdapterImportSecurity('yaml', exportedYamlEnvelope('Bearer abcdefgh'))).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('yaml', exportedYamlEnvelope('__proto__'))).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', [
      'schemaVersion: 1',
      'id: unsafe',
      'name: Unsafe',
      'operations: [image.generate]',
      'models: []',
      'submit:',
      '  headers:',
      '    Authorization: Bearer static-secret-value',
    ].join('\n'))).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', [
      'schemaVersion: 1',
      'version: 1.0.0',
      'definition:',
      '  metadata: { secretRef: apiKey }',
    ].join('\n'))).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', [
      'submit:',
      '  auth: &auth',
      '    type: bearer',
      '    secretRef: apiKey',
      '    location: header',
      'copy: *auth',
    ].join('\n'))).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', [
      'submit:',
      '  auth:',
      '    type: bearer',
      '    secretRef: apiKey',
      '    secretRef: otherKey',
      '    location: header',
    ].join('\n'))).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"submit":{"auth":{"secretRef":"apiKey","secretRef":"otherKey"}}}')).toMatchObject({ ok: false });
  });

  it('rejects static imported credentials and all secret templates except auth references', () => {
    for (const header of ['Authorization', 'X-API-Key', 'X-Goog-Api-Key']) {
      expect(validateAdapterImportSecurity('json', JSON.stringify({ headers: { [header]: '{{ secret.apiKey }}' } }))).toMatchObject({ ok: false });
    }
    expect(validateAdapterImportSecurity('json', '{"headers":{"Authorization":"Bearer static-secret-value"}}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"headers":{"X-Trace":"{{ secret.apiKey }}"}}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"query":{"model":"{{ secret.apiKey }}"}}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"body":{"value":{"prompt":"{{ secret.apiKey }}"}}}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"headers":{"Content-Type":"application/json"}}')).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', '{"apiKey":"plaintext"}')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'Authorization: Bearer static-secret-value')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'headers:\n  X-Trace: "{{ secret.apiKey }}"')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'query:\n  model: "{{ secret.apiKey }}"')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'body:\n  value:\n    prompt: "{{ secret.apiKey }}"')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('yaml', 'headers:\n  X-Goog-Api-Key: "{{ secret.apiKey }}"')).toMatchObject({ ok: false });
    expect(validateAdapterImportSecurity('json', '{"headers":')).toMatchObject({ ok: false, error: expect.stringContaining('valid JSON') });
  });

  it('accepts backend-compatible secret reference names across JSON and YAML', () => {
    const reference = ' tenant / $' + '\u03bb';
    const spec = customHttpSpecWithAuth();
    const submit = spec.submit as Record<string, unknown>;
    const value = { ...spec, submit: { ...submit, auth: { type: 'bearer', secretRef: reference, location: 'header' } } };
    expect(validateAdapterImportSecurity('json', exportedJsonEnvelope(value))).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('yaml', 'submit:\n  auth:\n    type: bearer\n    secretRef: " tenant / $\\u03bb "\n    location: header')).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', exportedJsonEnvelope({ ...value, submit: { ...value.submit as Record<string, unknown>, auth: { type: 'bearer', secretRef: 'Bearer abcdefgh', location: 'header' } } }))).toMatchObject({ ok: true });
    expect(validateAdapterImportSecurity('json', exportedJsonEnvelope({ ...value, submit: { ...value.submit as Record<string, unknown>, auth: { type: 'bearer', secretRef: 'constructor', location: 'header' } } }))).toMatchObject({ ok: false });
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
