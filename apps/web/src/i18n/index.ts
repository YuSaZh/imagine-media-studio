import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react';

export type Language = 'zh-CN' | 'en' | 'ja';
let language: Language = 'zh-CN';
let messages: Readonly<Record<string, string>> = {};
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLanguage = () => useSyncExternalStore(subscribe, () => language, () => 'zh-CN' as Language);

export async function setLanguage(next: Language): Promise<void> {
  const request = ++version;
  const translated = next === 'zh-CN' ? {} : next === 'en' ? (await import('./en')).default : (await import('./ja')).default;
  if (request !== version) return;
  messages = translated; language = next;
  document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

/** Translate only authored UI messages. Interpolated user content remains verbatim. */
export function t(message: string, values: readonly unknown[] = []): string {
  const translated = messages[message] ?? message;
  return translated.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token);
}

/** Preserve React icons and user-provided nodes when translating mixed JSX content. */
export function rich(message: string, values: readonly ReactNode[]): ReactNode {
  return (messages[message] ?? message).split(/(\{\d+\})/g).map((part, index) => {
    const match = /^\{(\d+)\}$/.exec(part);
    return createElement(Fragment, { key: index }, match ? values[Number(match[1])] : part);
  });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(language);
}
