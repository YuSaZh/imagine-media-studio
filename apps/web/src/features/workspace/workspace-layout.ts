import { useSyncExternalStore } from 'react';

export type WorkspaceLayout = 'desktop' | 'mobile';
const desktopQuery = '(min-width: 761px)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function useWorkspaceLayout(): WorkspaceLayout {
  const desktop = useSyncExternalStore(subscribe, () => window.matchMedia(desktopQuery).matches, () => false);
  return desktop ? 'desktop' : 'mobile';
}
