export const VISUAL_FIXTURE_STORAGE_KEY = 'imagine.visual-fixtures';
export const VISUAL_FIXTURE_STORAGE_VALUE = 'pr1-v1';

export function isVisualFixtureMode(
  storage: Pick<Storage, 'getItem'> | null = typeof window === 'undefined' ? null : window.sessionStorage,
): boolean {
  return storage?.getItem(VISUAL_FIXTURE_STORAGE_KEY) === VISUAL_FIXTURE_STORAGE_VALUE;
}
