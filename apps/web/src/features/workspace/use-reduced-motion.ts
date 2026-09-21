import { useSyncExternalStore } from 'react';

const snapshot = () => document.documentElement.dataset.reduceMotion === 'always' ||
  document.documentElement.dataset.reduceMotion !== 'never' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const subscribe = (notify: () => void) => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
  preference.addEventListener('change', notify);
  return () => { observer.disconnect(); preference.removeEventListener('change', notify); };
};

export const useReducedMotion = () => useSyncExternalStore(subscribe, snapshot, () => true);
