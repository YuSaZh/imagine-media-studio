import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CustomAdapterWorkspace,
  DEFAULT_CUSTOM_HTTP_DRAFT,
  formatAdapterExportName,
  hasForbiddenAdapterFields,
  mapCustomHttpDraftToPayload,
  redactCustomHttpPreview,
  validateAdapterImportSecurity,
  validateCustomHttpDocument,
  validateTrustedJsManifest,
  type CustomHttpPreview,
} from './custom-adapter-workspace.js';

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
});

describe('CustomAdapterWorkspace mapping and validation', () => {
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
