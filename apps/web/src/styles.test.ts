import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const tokenStylesheet = readFileSync(new URL('./styles/tokens.css', import.meta.url), 'utf8');

describe('PWA toast styles', () => {
  it('keeps passive notices and any accidental descendants pointer-transparent', () => {
    expect(stylesheet).toMatch(/\.toast-notice\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(stylesheet).toMatch(/\.toast-notice--passive\s*\{[\s\S]*?pointer-events:\s*none;/u);
    expect(stylesheet).toMatch(
      /\.toast-notice--passive \.toast-actions\s*\{[\s\S]*?pointer-events:\s*none;/u,
    );
  });

  it('keeps interactive actions enabled above mobile selection and Composer controls', () => {
    expect(stylesheet).toMatch(
      /\.toast-notice--interactive \.toast-actions\s*\{[\s\S]*?pointer-events:\s*auto;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.toast-notice\s*\{[\s\S]*?var\(--composer-height\) \+ 84px[\s\S]*?max-height: calc\([\s\S]*?var\(--visual-viewport-height\)[\s\S]*?var\(--safe-area-bottom\)\s*\)/u,
    );
    const mobileToastRule = stylesheet.match(
      /@media \(max-width: 720px\)[\s\S]*?\.toast-notice\s*\{([\s\S]*?)\n\s*\}/u,
    )?.[1] ?? '';
    const mobileToastMaxHeight = mobileToastRule.match(/max-height:\s*calc\(([\s\S]*?)\);/u)?.[1] ?? '';
    expect(mobileToastMaxHeight).not.toContain('var(--keyboard-offset)');
  });

  it('keeps Gallery selection controls touch-sized and long-press feedback non-interactive', () => {
    expect(stylesheet).toMatch(
      /\.selection-toggle\s*\{[\s\S]*?width:\s*var\(--control-touch\);[\s\S]*?height:\s*var\(--control-touch\);/u,
    );
    expect(stylesheet).toMatch(
      /\.long-press-feedback\s*\{[\s\S]*?pointer-events:\s*none;/u,
    );
    expect(stylesheet).toMatch(
      /\.media-card\.is-long-pressing \.long-press-feedback::after\s*\{[\s\S]*?520ms/u,
    );
    expect(stylesheet).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.media-card-actions\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transform:\s*none;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(pointer: coarse\)[\s\S]*?\.media-card-actions \.card-actions-more\s*\{[\s\S]*?display:\s*inline-grid;/u,
    );
  });
});

describe('Viewer touch affordances', () => {
  it('reserves custom gesture handling for the media stage and preserves native video controls', () => {
    expect(stylesheet).toMatch(/\.viewer-stage\s*\{[\s\S]*?touch-action:\s*none;/u);
    expect(stylesheet).toMatch(/\.viewer-stage\[data-media-kind='video'\]\s*\{[\s\S]*?touch-action:\s*auto;/u);
    expect(stylesheet).toMatch(/video\.viewer-media\s*\{[\s\S]*?touch-action:\s*auto;/u);
    expect(stylesheet).toMatch(/\.viewer-stage\s*\{[\s\S]*?overscroll-behavior:\s*contain;/u);
    expect(stylesheet).toMatch(/\.viewer-stage\[data-viewer-gesture='pan'\][\s\S]*?transition:\s*none;/u);
  });

  it('keeps mobile navigation and metadata visible with touch-sized controls', () => {
    expect(stylesheet).not.toMatch(/\.viewer-metadata\s*\{[^}]*display:\s*none;/u);
    expect(stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.viewer-metadata\s*\{[\s\S]*?display:\s*grid;/u,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.viewer-nav\s*\{[\s\S]*?display:\s*grid;/u,
    );
    expect(stylesheet).toMatch(/\.viewer-nav\s*\{[\s\S]*?width:\s*var\(--control-touch\);/u);
  });
});

describe('mobile viewport and accessibility styles', () => {
  it('defines overridable four-direction safe-area aliases', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(tokenStylesheet).toMatch(
        new RegExp(
          `--safe-area-${side}:\\s*var\\(--safe-area-inset-${side},\\s*env\\(safe-area-inset-${side}`,
          'u',
        ),
      );
    }
  });

  it('keeps mobile surfaces inside every safe-area edge', () => {
    expect(stylesheet).toMatch(/\.mobile-header[\s\S]*?var\(--safe-area-top\)[\s\S]*?var\(--safe-area-right\)[\s\S]*?var\(--safe-area-left\)/u);
    expect(stylesheet).toMatch(/\.composer[\s\S]*?var\(--safe-area-bottom\)/u);
    expect(stylesheet).toMatch(/\.reference-strip[\s\S]*?var\(--safe-area-right\)[\s\S]*?var\(--safe-area-left\)/u);
    expect(stylesheet).toMatch(/\.viewer-topbar[\s\S]*?var\(--safe-area-top\)[\s\S]*?var\(--safe-area-right\)[\s\S]*?var\(--safe-area-left\)/u);
    expect(stylesheet).toMatch(/\.mobile-menu-content[\s\S]*?var\(--safe-area-top\)[\s\S]*?var\(--safe-area-right\)[\s\S]*?var\(--safe-area-bottom\)[\s\S]*?var\(--safe-area-left\)/u);
  });

  it('keeps touch controls at least 44px across tablet and mobile layouts', () => {
    expect(stylesheet).toMatch(
      /@media \(max-width: 1024px\)[\s\S]*?\.icon-button,[\s\S]*?width: var\(--control-touch\);[\s\S]*?\.setting-control select,[\s\S]*?min-height: var\(--control-touch\);/u,
    );
    expect(stylesheet).toMatch(/\.reference-preview \{[\s\S]*?width: 76px;[\s\S]*?height: 76px;/u);
    expect(stylesheet).toMatch(/\.composer \.reference-preview \.icon-button \{[\s\S]*?width: var\(--control-touch\);/u);
  });

  it('disables motion while preserving visible status indicators for reduced motion', () => {
    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/u,
    );
    expect(stylesheet).toMatch(
      /\.is-spinning,[\s\S]*?\.job-state-spinner[\s\S]*?visibility: visible;[\s\S]*?opacity: 1;/u,
    );
  });
});
