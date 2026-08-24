import { registerSW } from 'virtual:pwa-register';

export interface PwaRegistrationState {
  readonly error: string | null;
  readonly offlineReady: boolean;
  readonly updating: boolean;
  readonly updateAvailable: boolean;
}

type Listener = () => void;

let state: PwaRegistrationState = {
  error: null,
  offlineReady: false,
  updating: false,
  updateAvailable: false,
};
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
const listeners = new Set<Listener>();

function publish(nextState: PwaRegistrationState): void {
  state = nextState;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToPwaState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPwaState(): PwaRegistrationState {
  return state;
}

export function dismissPwaNotice(): void {
  publish({ error: null, offlineReady: false, updating: false, updateAvailable: false });
}

export async function activatePwaUpdate(): Promise<void> {
  if (!updateServiceWorker || state.updating) {
    return;
  }

  publish({ ...state, error: null, updating: true });
  try {
    await updateServiceWorker(true);
  } catch {
    publish({
      ...state,
      error: 'The update could not be applied. Try again when the connection is stable.',
      updating: false,
    });
  }
}

export function registerPwa(): void {
  updateServiceWorker = registerSW({
    immediate: true,
    onOfflineReady() {
      publish({ ...state, offlineReady: true });
    },
    onNeedRefresh() {
      publish({ ...state, updateAvailable: true });
    },
    onRegisterError(error) {
      console.error('Service worker registration failed.', error);
      publish({
        ...state,
        error: 'Offline access is unavailable because registration failed.',
        updating: false,
      });
    },
  });
}
