import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

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
      /@media \(max-width: 720px\)[\s\S]*?\.toast-notice\s*\{[\s\S]*?var\(--composer-height\) \+ 84px[\s\S]*?max-height: calc\([\s\S]*?var\(--keyboard-offset\)/u,
    );
  });
});
