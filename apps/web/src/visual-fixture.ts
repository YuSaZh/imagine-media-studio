export const VISUAL_FIXTURE_STORAGE_KEY = 'imagine.visual-fixtures';
export const VISUAL_FIXTURE_STORAGE_VALUE = 'pr1-v1';

function currentSessionStorage(): Pick<Storage, 'getItem'> | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function isVisualFixtureMode(
  storage: Pick<Storage, 'getItem'> | null = currentSessionStorage(),
): boolean {
  return storage?.getItem(VISUAL_FIXTURE_STORAGE_KEY) === VISUAL_FIXTURE_STORAGE_VALUE;
}
