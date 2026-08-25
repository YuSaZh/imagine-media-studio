import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { AuthStatus } from '@imagine/shared';
import { AlertCircle, Aperture, LoaderCircle, LockKeyhole, LogIn, RotateCcw } from 'lucide-react';

import {
  internalClient,
  InternalApiError,
  subscribeToAuthRequired,
} from '../../../api/internal-client.js';

const FIXTURE_AUTH_STATUS = { authenticated: true, required: false } as const satisfies AuthStatus;
let initialStatusRequest: Promise<AuthStatus> | undefined;

export async function loadInitialAuthStatus(fixtureMode: boolean): Promise<AuthStatus> {
  if (fixtureMode) return FIXTURE_AUTH_STATUS;
  initialStatusRequest ??= internalClient.getAuthStatus();
  return initialStatusRequest;
}

function resetInitialStatusRequest(): void {
  initialStatusRequest = undefined;
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
  const [statusError, setStatusError] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (fixtureMode) return;
    let active = true;
    setStatusError(false);
    void loadInitialAuthStatus(false).then(
      (response) => {
        if (active) setStatus(response);
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
    if (fixtureMode) return;
    return subscribeToAuthRequired(() => {
      resetInitialStatusRequest();
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
