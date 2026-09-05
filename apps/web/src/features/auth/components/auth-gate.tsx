import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthStatus } from '@imagine/shared';
import {
  AlertCircle,
  Sparkles,
  ArrowRight,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';

import {
  internalClient,
  InternalApiError,
  subscribeToAuthRequired,
} from '../../../api/internal-client.js';
import {
  isBrowserExplicitlyOffline,
  isNetworkFailure,
  markNetworkAvailable,
  markNetworkFailure,
  markOfflineBootstrapActive,
  offlineBootstrapMode,
} from '../../../pwa-offline-snapshot.js';

const OFFLINE_AUTH_STATUS = { authenticated: true, publicAccessWarning: false, required: true } as const satisfies AuthStatus;
const OFFLINE_PUBLIC_STATUS = { authenticated: false, publicAccessWarning: false, required: false } as const satisfies AuthStatus;
let initialStatusRequest: Promise<AuthStatus> | undefined;
let initialStatusRequestPending = false;

function getInitialStatusRequest(): Promise<AuthStatus> {
  if (initialStatusRequest !== undefined) return initialStatusRequest;
  let request: Promise<AuthStatus>;
  try {
    request = Promise.resolve(internalClient.getAuthStatus());
  } catch (error) {
    request = Promise.reject(error);
  }
  initialStatusRequest = request;
  initialStatusRequestPending = true;
  void request.then(
    () => {
      if (initialStatusRequest === request) initialStatusRequestPending = false;
    },
    () => {
      if (initialStatusRequest === request) initialStatusRequestPending = false;
    },
  );
  return request;
}

export interface InitialAuthResolution {
  readonly status: AuthStatus;
  readonly offlineBootstrap: boolean;
}

export async function resolveInitialAuthStatus(): Promise<InitialAuthResolution> {
  if (isBrowserExplicitlyOffline()) {
    markNetworkFailure();
    const bootstrapMode = offlineBootstrapMode();
    if (bootstrapMode === null) {
      throw new Error('Authentication status is unavailable while offline.');
    }
    markOfflineBootstrapActive(true);
    return {
      status: bootstrapMode === 'public' ? OFFLINE_PUBLIC_STATUS : OFFLINE_AUTH_STATUS,
      offlineBootstrap: true,
    };
  }
  initialStatusRequest ??= getInitialStatusRequest();
  try {
    const status = await initialStatusRequest;
    markNetworkAvailable();
    markOfflineBootstrapActive(false);
    return { status, offlineBootstrap: false };
  } catch (error) {
    resetInitialStatusRequest();
    const bootstrapMode = offlineBootstrapMode();
    if (!isNetworkFailure(error) || bootstrapMode === null) throw error;
    markNetworkFailure();
    markOfflineBootstrapActive(true);
    return {
      status: bootstrapMode === 'public' ? OFFLINE_PUBLIC_STATUS : OFFLINE_AUTH_STATUS,
      offlineBootstrap: true,
    };
  }
}


export function resetInitialStatusRequest(): void {
  if (initialStatusRequestPending) return;
  initialStatusRequest = undefined;
}

export function subscribeToOnlineAuthRetry(retry: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handleOnline = () => {
    markNetworkAvailable();
    markOfflineBootstrapActive(false);
    retry();
  };
  window.addEventListener('online', handleOnline);
  return () => window.removeEventListener('online', handleOnline);
}

interface AuthPromptProps {
  error: string | null;
  onPasswordChange: (password: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  password: string;
  pending: boolean;
}

export function AuthPrompt({
  error,
  onPasswordChange,
  onSubmit,
  password,
  pending,
}: AuthPromptProps) {
  return (
    <AuthFrame>
      <form aria-busy={pending} className="auth-gate-form" onSubmit={onSubmit}>
        <div>
          <p className="auth-caption">受保护的工作区</p>
          <h2>登录 Imagine</h2>
        </div>
        <label>
          <span>应用密码</span>
          <span className="auth-password-field">
            <LockKeyhole aria-hidden="true" size={17} />
            <input
              aria-invalid={error !== null}
              autoComplete="current-password"
              autoFocus
              disabled={pending}
              maxLength={1024}
              name="password"
              onChange={(event) => onPasswordChange(event.target.value)}
              required
              type="password"
              value={password}
            />
          </span>
        </label>
        {error && (
          <p className="auth-gate-error" role="alert">
            <AlertCircle aria-hidden="true" size={15} />
            {error}
          </p>
        )}
        <button disabled={pending || password.length === 0} type="submit">
          {pending
            ? <LoaderCircle aria-hidden="true" className="is-spinning" size={16} />
            : <LogIn aria-hidden="true" size={16} />}
          {pending ? '正在登录' : '进入工作区'}
        </button>
      </form>
    </AuthFrame>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-gate">
      <header className="auth-gate-brand">
        <span aria-hidden="true"><Sparkles size={22} /></span>
        <h1>Imagine Media Studio</h1>
      </header>
      {children}
    </main>
  );
}

function authErrorMessage(error: unknown): string {
  if (error instanceof InternalApiError && error.code === 'invalid_app_password') {
    return 'Password is incorrect.';
  }
  return 'Sign in failed. Try again.';
}

export function AuthGate({
  children,
}: {
  children: ReactNode;
}) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [offlineBootstrap, setOfflineBootstrap] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [publicAccessAcknowledged, setPublicAccessAcknowledged] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mountedRef = useRef(false);
  const authEpochRef = useRef(0);
  const loginEpochRef = useRef(0);
  const revalidationEpochRef = useRef(0);
  const backgroundStatusRequestRef = useRef<Promise<AuthStatus> | null>(null);
  const authStateRef = useRef({ status, offlineBootstrap, statusError });
  authStateRef.current = { status, offlineBootstrap, statusError };

  const updateAuthState = (nextStatus: AuthStatus | null, nextOfflineBootstrap: boolean) => {
    authStateRef.current = {
      status: nextStatus,
      offlineBootstrap: nextOfflineBootstrap,
      statusError: authStateRef.current.statusError,
    };
    setStatus(nextStatus);
    setOfflineBootstrap(nextOfflineBootstrap);
  };
  const updateStatusError = (nextStatusError: boolean) => {
    authStateRef.current = {
      ...authStateRef.current,
      statusError: nextStatusError,
    };
    setStatusError(nextStatusError);
  };
  const invalidateAuthRequests = () => {
    authEpochRef.current += 1;
    loginEpochRef.current += 1;
    revalidationEpochRef.current += 1;
  };
  const enterAuthGate = () => {
    invalidateAuthRequests();
    resetInitialStatusRequest();
    markOfflineBootstrapActive(false);
    setPublicAccessAcknowledged(false);
    updateAuthState({ authenticated: false, publicAccessWarning: false, required: true }, false);
    updateStatusError(false);
    setLoginError(null);
    setLoginPending(false);
    setPassword('');
  };
  const revalidateAuth = () => {
    if (backgroundStatusRequestRef.current !== null) return;
    resetInitialStatusRequest();
    const request = getInitialStatusRequest();
    backgroundStatusRequestRef.current = request;
    const revalidationEpoch = ++revalidationEpochRef.current;
    const authEpoch = ++authEpochRef.current;
    const finish = () => {
      if (backgroundStatusRequestRef.current !== request) return;
      backgroundStatusRequestRef.current = null;
      resetInitialStatusRequest();
    };
    void request.then(
      (nextStatus) => {
        if (
          !mountedRef.current ||
          revalidationEpoch !== revalidationEpochRef.current ||
          authEpoch !== authEpochRef.current
        ) return;
        if (nextStatus.required && !nextStatus.authenticated) {
          enterAuthGate();
          return;
        }
        updateAuthState(nextStatus, false);
        updateStatusError(false);
      },
      (error) => {
        if (
          !mountedRef.current ||
          revalidationEpoch !== revalidationEpochRef.current ||
          authEpoch !== authEpochRef.current
        ) return;
        if (error instanceof InternalApiError && error.status === 401) {
          enterAuthGate();
          return;
        }
        if (isNetworkFailure(error)) {
          markNetworkFailure();
          return;
        }
        updateAuthState(null, false);
        updateStatusError(true);
      },
    ).then(finish, finish);
  };
  const retryStatus = () => {
    invalidateAuthRequests();
    resetInitialStatusRequest();
    updateAuthState(null, false);
    updateStatusError(false);
    setAttempt((current) => current + 1);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateAuthRequests();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const authEpoch = authEpochRef.current;
    updateStatusError(false);
    void resolveInitialAuthStatus().then(
      (resolution) => {
        if (active && authEpoch === authEpochRef.current) {
          updateAuthState(resolution.status, resolution.offlineBootstrap);
          updateStatusError(false);
        }
      },
      () => {
        if (active && authEpoch === authEpochRef.current) updateStatusError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    return subscribeToOnlineAuthRetry(() => {
      const current = authStateRef.current;
      if (
        current.status !== null &&
        (current.status.authenticated || current.status.required === false) &&
        !current.offlineBootstrap &&
        !current.statusError
      ) {
        revalidateAuth();
        return;
      }
      retryStatus();
    });
  }, []);

  useEffect(() => {
    return subscribeToAuthRequired((reason) => {
      invalidateAuthRequests();
      resetInitialStatusRequest();
      markOfflineBootstrapActive(false);
      setPublicAccessAcknowledged(false);
      updateAuthState(
        reason === 'login'
          ? null
          : { authenticated: false, publicAccessWarning: false, required: true },
        false,
      );
      updateStatusError(false);
      if (reason === 'login') {
        setLoginError(null);
        setLoginPending(false);
        setPassword('');
        setAttempt((current) => current + 1);
        return;
      }
      setLoginError(null);
      setLoginPending(false);
      setPassword('');
    });
  }, []);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mountedRef.current) return;
    const loginEpoch = ++loginEpochRef.current;
    const loginIsCurrent = () => mountedRef.current && loginEpoch === loginEpochRef.current;
    setLoginError(null);
    setLoginPending(true);
    try {
      const response = await internalClient.login(password);
      if (!loginIsCurrent()) return;
      initialStatusRequestPending = false;
      initialStatusRequest = Promise.resolve(response);
      markOfflineBootstrapActive(false);
      updateAuthState(response, false);
      updateStatusError(false);
      setPassword('');
    } catch (error) {
      if (!loginIsCurrent()) return;
      setPassword('');
      setLoginError(authErrorMessage(error));
    } finally {
      if (loginIsCurrent()) setLoginPending(false);
    }
  };

  if (status?.required === false && status.publicAccessWarning && !publicAccessAcknowledged) {
    return (
      <AuthFrame>
        <div className="auth-gate-status auth-gate-security-warning" role="alert">
          <ShieldAlert aria-hidden="true" size={22} />
          <div>
            <strong>Set an application password</strong>
            <p>Set APP_PASSWORD and restart the server before continuing.</p>
            <button onClick={() => setPublicAccessAcknowledged(true)} type="button">
              <ArrowRight aria-hidden="true" size={15} />
              Continue without password
            </button>
          </div>
        </div>
      </AuthFrame>
    );
  }
  if (status?.authenticated || status?.required === false) return children;
  if (statusError) {
    return (
      <AuthFrame>
        <div className="auth-gate-status" role="alert">
          <AlertCircle aria-hidden="true" size={20} />
          <strong>Access check unavailable</strong>
          <button onClick={retryStatus} type="button">
            <RotateCcw aria-hidden="true" size={15} />Retry
          </button>
        </div>
      </AuthFrame>
    );
  }
  if (status === null) {
    return (
      <AuthFrame>
        <div aria-live="polite" className="auth-gate-status">
          <LoaderCircle aria-hidden="true" className="is-spinning" size={20} />
          <strong>Checking access</strong>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthPrompt
      key={loginError ?? 'login'}
      error={loginError}
      onPasswordChange={setPassword}
      onSubmit={(event) => void login(event)}
      password={password}
      pending={loginPending}
    />
  );
}
