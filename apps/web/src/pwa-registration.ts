import { registerSW } from 'virtual:pwa-register';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{
    readonly outcome: 'accepted' | 'dismissed';
    readonly platform: string;
  }>;
  prompt(): Promise<void>;
}

export type PwaErrorKind = 'registration' | 'update' | 'install';

export interface PwaRegistrationState {
  readonly error: string | null;
  readonly errorKind: PwaErrorKind | null;
  readonly offlineReady: boolean;
  readonly offlineReadyNoticeDismissed: boolean;
  readonly updating: boolean;
  readonly updateAvailable: boolean;
  readonly updateNoticeDismissed: boolean;
  readonly installPromptAvailable: boolean;
  readonly installPromptPending: boolean;
  readonly installed: boolean;
  readonly installOutcome: 'accepted' | 'dismissed' | null;
}

export type PwaDraftFlushHook = () => void | Promise<void>;

type Listener = () => void;

let state: PwaRegistrationState = {
  error: null,
  errorKind: null,
  offlineReady: false,
  offlineReadyNoticeDismissed: false,
  updating: false,
  updateAvailable: false,
  updateNoticeDismissed: false,
  installPromptAvailable: false,
  installPromptPending: false,
  installed: false,
  installOutcome: null,
};
let updateServiceWorker: ((reloadPage?: boolean) => Promise<void>) | undefined;
let deferredInstallPrompt: BeforeInstallPromptEvent | undefined;
let draftFlushHook: PwaDraftFlushHook = () => undefined;
let pwaEventTarget: EventTarget | undefined;
let beforeInstallPromptHandler: EventListener | undefined;
let appInstalledHandler: EventListener | undefined;
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
  publish({
    ...state,
    error: null,
    errorKind: null,
    offlineReadyNoticeDismissed: true,
    updateNoticeDismissed: true,
  });
}

export function dismissOfflineReadyNotice(): void {
  publish({
    ...state,
    offlineReadyNoticeDismissed: true,
  });
}

export function deferPwaUpdate(): void {
  publish({
    ...state,
    error: null,
    errorKind: null,
    updateNoticeDismissed: true,
  });
}

export function setPwaDraftFlushHook(hook: PwaDraftFlushHook): () => void {
  draftFlushHook = hook;
  return () => {
    if (draftFlushHook === hook) draftFlushHook = () => undefined;
  };
}

export const registerPwaDraftFlushHook = setPwaDraftFlushHook;

export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | null> {
  const prompt = deferredInstallPrompt;
  if (!prompt || state.installPromptPending || state.installed) return null;

  deferredInstallPrompt = undefined;
  publish({
    ...state,
    error: null,
    errorKind: null,
    installPromptAvailable: false,
    installPromptPending: true,
  });
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    const installed = choice.outcome === 'accepted';
    publish({
      ...state,
      error: null,
      errorKind: null,
      installPromptAvailable: false,
      installPromptPending: false,
      installed,
      installOutcome: choice.outcome,
    });
    return choice.outcome;
  } catch {
    deferredInstallPrompt = prompt;
    publish({
      ...state,
      error: 'The install prompt could not be opened. Try again from App settings.',
      errorKind: 'install',
      installPromptAvailable: true,
      installPromptPending: false,
    });
    return null;
  }
}

export async function activatePwaUpdate(): Promise<void> {
  if (!updateServiceWorker || state.updating) {
    return;
  }

  publish({ ...state, error: null, errorKind: null, updating: true });
  try {
    await draftFlushHook();
    await updateServiceWorker(true);
    publish({
      ...state,
      error: null,
      errorKind: null,
      updateAvailable: false,
      updateNoticeDismissed: false,
      updating: false,
    });
  } catch {
    publish({
      ...state,
      error: 'The update could not be applied. Try again when the connection is stable.',
      errorKind: 'update',
      updateAvailable: true,
      updateNoticeDismissed: false,
      updating: false,
    });
  }
}

function registerPwaEventListeners(): void {
  if (typeof window === 'undefined' || pwaEventTarget === window) return;
  if (pwaEventTarget !== undefined) {
    if (beforeInstallPromptHandler !== undefined) {
      pwaEventTarget.removeEventListener('beforeinstallprompt', beforeInstallPromptHandler);
    }
    if (appInstalledHandler !== undefined) {
      pwaEventTarget.removeEventListener('appinstalled', appInstalledHandler);
    }
  }

  pwaEventTarget = window;
  beforeInstallPromptHandler = (event) => {
    event.preventDefault();
    if (state.installed) return;
    deferredInstallPrompt = event as BeforeInstallPromptEvent;
    publish({
      ...state,
      error: null,
      errorKind: null,
      installPromptAvailable: true,
    });
  };
  appInstalledHandler = () => {
    deferredInstallPrompt = undefined;
    publish({
      ...state,
      error: null,
      errorKind: null,
      installPromptAvailable: false,
      installPromptPending: false,
      installed: true,
      installOutcome: 'accepted',
    });
  };
  window.addEventListener('beforeinstallprompt', beforeInstallPromptHandler);
  window.addEventListener('appinstalled', appInstalledHandler);
}

export function registerPwa(options: { readonly draftFlushHook?: PwaDraftFlushHook } = {}): void {
  if (options.draftFlushHook) draftFlushHook = options.draftFlushHook;
  registerPwaEventListeners();
  updateServiceWorker = registerSW({
    immediate: true,
    onOfflineReady() {
      publish({
        ...state,
        error: null,
        errorKind: null,
        offlineReady: true,
        offlineReadyNoticeDismissed: false,
      });
    },
    onNeedRefresh() {
      publish({
        ...state,
        error: null,
        errorKind: null,
        offlineReadyNoticeDismissed: true,
        updateAvailable: true,
        updateNoticeDismissed: false,
      });
    },
    onRegisterError(error) {
      console.error('Service worker registration failed.', error);
      publish({
        ...state,
        error: 'Offline access is unavailable because registration failed.',
        errorKind: 'registration',
        updating: false,
      });
    },
  });
}
