import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthStatus } from '@imagine/shared';
import { AlertCircle, Aperture, LoaderCircle, LockKeyhole, LogIn, RotateCcw } from 'lucide-react';

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

const FIXTURE_AUTH_STATUS = { authenticated: true, required: false } as const satisfies AuthStatus;
const OFFLINE_AUTH_STATUS = { authenticated: true, required: true } as const satisfies AuthStatus;
const OFFLINE_PUBLIC_STATUS = { authenticated: false, required: false } as const satisfies AuthStatus;
let initialStatusRequest: Promise<AuthStatus> | undefined;

export interface InitialAuthResolution {
  readonly status: AuthStatus;
  readonly offlineBootstrap: boolean;
}

export async function resolveInitialAuthStatus(fixtureMode: boolean): Promise<InitialAuthResolution> {
  if (fixtureMode) return { status: FIXTURE_AUTH_STATUS, offlineBootstrap: false };
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
  initialStatusRequest ??= internalClient.getAuthStatus();
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

export async function loadInitialAuthStatus(fixtureMode: boolean): Promise<AuthStatus> {
  return (await resolveInitialAuthStatus(fixtureMode)).status;
}

export function resetInitialStatusRequest(): void {
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
          <p className="page-eyebrow">Protected workspace</p>
          <h2>Unlock</h2>
        </div>
        <label>
          <span>Application password</span>
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
          {pending ? 'Unlocking' : 'Unlock workspace'}
        </button>
      </form>
    </AuthFrame>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-gate">
      <header className="auth-gate-brand">
        <span aria-hidden="true"><Aperture size={22} /></span>
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
  fixtureMode,
}: {
  children: ReactNode;
  fixtureMode: boolean;
}) {
  const [status, setStatus] = useState<AuthStatus | null>(() =>
    fixtureMode ? FIXTURE_AUTH_STATUS : null,
  );
  const [, setOfflineBootstrap] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (fixtureMode) return;
    let active = true;
    setStatusError(false);
    void resolveInitialAuthStatus(false).then(
      (resolution) => {
        if (active) {
          setStatus(resolution.status);
          setOfflineBootstrap(resolution.offlineBootstrap);
        }
      },
      () => {
        if (active) setStatusError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, fixtureMode]);

  useEffect(() => {
    if (fixtureMode || typeof window === 'undefined') return;
    return subscribeToOnlineAuthRetry(() => {
      resetInitialStatusRequest();
      setOfflineBootstrap(false);
      setStatusError(false);
      setStatus(null);
      setAttempt((current) => current + 1);
    });
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    return subscribeToAuthRequired((reason) => {
      resetInitialStatusRequest();
      markOfflineBootstrapActive(false);
      setOfflineBootstrap(false);
      if (reason === 'login') {
        setStatus(null);
        setStatusError(false);
        setLoginError(null);
        setLoginPending(false);
        setPassword('');
        setAttempt((current) => current + 1);
        return;
      }
      setStatus({ authenticated: false, required: true });
      setStatusError(false);
      setLoginError(null);
      setLoginPending(false);
      setPassword('');
    });
  }, [fixtureMode]);

  const retryStatus = () => {
    resetInitialStatusRequest();
    setStatus(null);
    setAttempt((current) => current + 1);
  };
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError(null);
    setLoginPending(true);
    try {
      const response = await internalClient.login(password);
      initialStatusRequest = Promise.resolve(response);
      markOfflineBootstrapActive(false);
      setOfflineBootstrap(false);
      setStatus(response);
      setPassword('');
    } catch (error) {
      setPassword('');
      setLoginError(authErrorMessage(error));
    } finally {
      setLoginPending(false);
    }
  };

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
