import { readFile } from 'node:fs/promises';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RouteLoading } from './route-loading.js';

describe('route loading boundaries', () => {
  it('keeps a library fallback in the page geometry and exposes a status', () => {
    const markup = renderToStaticMarkup(<RouteLoading label="Loading saved" />);

    expect(markup).toContain('class="page-scroll library-page"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading saved');
  });

  it('keeps settings navigation and content geometry while the page chunk loads', () => {
    const markup = renderToStaticMarkup(<RouteLoading label="Loading settings" settings />);

    expect(markup).toContain('class="settings-page route-loading-settings"');
    expect(markup).toContain('class="settings-navigation route-loading-settings__navigation"');
    expect(markup).toContain('class="settings-content route-loading-settings__content"');
    expect(markup).toContain('role="status"');
  });

  it('declares page-level lazy imports for every low-frequency route boundary', async () => {
    const source = await readFile(new URL('./app.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import('./features/library/components/library-page')");
    expect(source).toContain("import('./features/settings/components/settings-page')");
    expect(source).toContain("import('./features/image-editor/components/mask-editor-page')");
    expect(source).toContain('path="/saved"');
    expect(source).toContain('path="/folders/:folderId"');
    expect(source).toContain('path="/jobs"');
    expect(source).toContain('path="/settings/providers"');
  });
});

describe('build artifact budget parser', () => {
  it('finds the Vite module entry and keeps the raw budget explicit', async () => {
    const { entryAssetFromHtml, modulePreloadAssetsFromHtml, MAIN_ENTRY_MAX_BYTES } = await import(
      new URL('../scripts/check-build-budget.mjs', import.meta.url).href,
    );

    expect(entryAssetFromHtml(
      '<script type="module" crossorigin src="/assets/index-abc123.js"></script>',
    )).toBe('assets/index-abc123.js');
    expect(modulePreloadAssetsFromHtml(
      '<link rel="modulepreload" href="assets/shared.js"><link rel="modulepreload" href="/assets/other.js">',
    )).toEqual(['assets/shared.js', 'assets/other.js']);
    expect(MAIN_ENTRY_MAX_BYTES).toBe(500_000);
  });

  it('rejects an HTML artifact without exactly one local module entry', async () => {
    const { entryAssetFromHtml } = await import(
      new URL('../scripts/check-build-budget.mjs', import.meta.url).href,
    );

    expect(() => entryAssetFromHtml('<html><body></body></html>')).toThrow(
      'exactly one module entry script',
    );
    expect(() => entryAssetFromHtml(
      '<script type="module" src="/assets/one.js"></script><script type="module" src="/assets/two.js"></script>',
    )).toThrow('exactly one module entry script');
    expect(() => entryAssetFromHtml(
      '<script type="module" src="https://cdn.example.invalid/app.js"></script>',
    )).toThrow('must be a local asset path');
    expect(() => entryAssetFromHtml(
      '<script type="module" src="/assets/app.js?cache=1"></script>',
    )).toThrow('must not contain a query');
  });

  it('compares Service Worker precache URLs exactly instead of by substring', async () => {
    const { precachedAssetUrlsFromServiceWorker } = await import(
      new URL('../scripts/check-build-budget.mjs', import.meta.url).href,
    );

    const urls = precachedAssetUrlsFromServiceWorker(
      'precacheAndRoute([{url:"assets/index.js.map",revision:null},{"url":"/assets/other.js",revision:null}],{})',
    );
    expect(urls).toEqual(new Set(['assets/index.js.map', 'assets/other.js']));
    expect(urls.has('assets/index.js')).toBe(false);
    expect(() => precachedAssetUrlsFromServiceWorker(
      'precacheAndRoute([{url:"https://cdn.example.invalid/app.js",revision:null}],{})',
    )).toThrow('non-local URL');
    expect(() => precachedAssetUrlsFromServiceWorker('self.skipWaiting()')).toThrow(
      'no precache manifest array',
    );
  });
});
