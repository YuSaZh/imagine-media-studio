import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { AuthPrompt, loadInitialAuthStatus } from './auth-gate.js';

describe('AuthGate', () => {
  it('bypasses auth status without an internal request in visual fixture mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(loadInitialAuthStatus(true)).resolves.toEqual({
      authenticated: true,
      required: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders a compact branded password form with autofocus and errors', () => {
    const markup = renderToStaticMarkup(
      <AuthPrompt
        error="Password is incorrect."
        onPasswordChange={() => undefined}
        onSubmit={() => undefined}
        password=""
        pending={false}
      />,
    );
    expect(markup).toContain('Imagine Media Studio');
    expect(markup).toContain('Protected workspace');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('Password is incorrect.');
    expect(markup).not.toContain('marketing');
  });

  it('disables the login command while a request is pending', () => {
    const markup = renderToStaticMarkup(
      <AuthPrompt
        error={null}
        onPasswordChange={() => undefined}
        onSubmit={() => undefined}
        password="entered-password"
        pending
      />,
    );
    expect(markup).toContain('Unlocking');
    expect(markup).toMatch(/<button[^>]*disabled=""/);
  });
});
