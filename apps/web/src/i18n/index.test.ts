import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import en from './en';
import ja from './ja';
import { rich, setLanguage, t } from './index';

beforeEach(() => vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } }));
afterEach(async () => { await setLanguage('zh-CN'); vi.unstubAllGlobals(); });

it('covers every authored message and preserves translation placeholders', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  for (const [key, english] of Object.entries(en)) {
    const placeholders = (value: string) => value.match(/\{\d+\}/g)?.sort() ?? [];
    expect(english.trim()).not.toBe('');
    expect(placeholders(english)).toEqual(placeholders(key));
    expect(placeholders(ja[key as keyof typeof ja])).toEqual(placeholders(key));
  }
  for (const directory of ['features/workspace', 'features/auth/components', 'features/settings/controllers']) {
    const root = resolve('apps/web/src', directory);
    for (const file of readdirSync(root).filter(file => /\.tsx?$/.test(file) && !file.includes('.test.'))) {
      const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ['t', 'rich'].includes(node.expression.getText(source)) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) expect(Object.hasOwn(en, node.arguments[0].text), `${file}: ${node.arguments[0].text}`).toBe(true);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
});

it('changes languages without translating or re-interpolating user content', async () => {
  const user = '生成设置 {1} <script> 日本語';
  await setLanguage('en');
  expect(t('查看 {0}', [user])).toBe(`View ${user}`);
  expect(t('界面主题')).toBe('Theme');
  await setLanguage('ja');
  expect(t('查看 {0}', [user])).toBe(`${user} を表示`);
  await setLanguage('zh-CN');
  expect(t('界面主题')).toBe('界面主题');
});

it('retains JSX nodes and escapes interpolated text', async () => {
  await setLanguage('en');
  const html = renderToStaticMarkup(createElement('span', null, rich('{0}应用更新', [createElement('b', null, '<user>')])));
  expect(html).toBe('<span><b>&lt;user&gt;</b>Apply update</span>');
  expect(html).not.toContain('[object Object]');
});

it('keeps the latest language when lazy resource loads race', async () => {
  await Promise.all([setLanguage('en'), setLanguage('ja')]);
  expect(t('界面主题')).toBe('テーマ');
  expect(document.documentElement.lang).toBe('ja');
});
