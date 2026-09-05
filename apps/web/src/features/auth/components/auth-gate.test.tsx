import { renderToStaticMarkup } from 'react-dom/server';
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { internalClient } from '../../../api/internal-client.js';
import {
  clearAuthenticatedSessionMarker,
  isOfflineBootstrapActive,
  isNetworkAvailable,
  markNetworkAvailable,
  markOfflineBootstrapActive,
  OFFLINE_PUBLIC_BOOTSTRAP_KEY,
  rememberAuthenticatedSession,
} from '../../../pwa-offline-snapshot.js';
import {
  AuthGate,
  AuthPrompt,
  resetInitialStatusRequest,
  resolveInitialAuthStatus,
  subscribeToOnlineAuthRetry,
} from './auth-gate.js';

interface TestStyle {
  cssText: string;
  setProperty: (name: string, value: string) => void;
  removeProperty: (name: string) => void;
  [name: string]: unknown;
}

class TestDocument extends EventTarget {
  readonly nodeType = 9;
  readonly nodeName = '#document';
  readonly ownerDocument = this;
  readonly documentElement: TestNode;
  readonly head: TestNode;
  readonly body: TestNode;
  readonly childNodes: TestNode[] = [];
  defaultView: TestWindow | null = null;
  activeElement: TestNode | null = null;

  public constructor() {
    super();
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }

  public createElement(name: string): TestNode {
    return new TestNode(1, name.toUpperCase(), this);
  }

  public appendChild(child: TestNode): TestNode {
    this.childNodes.push(child);
    return child;
  }

  public createElementNS(namespace: string, name: string): TestNode {
    const node = this.createElement(name);
    node.namespaceURI = namespace;
    return node;
  }

  public createTextNode(value: string): TestTextNode {
    return new TestTextNode(value, this);
  }

  public getElementsByTagName(): readonly TestNode[] {
    return [];
  }
}

class TestNode extends EventTarget {
  public readonly nodeType: number;
  public readonly nodeName: string;
  public readonly tagName: string;
  public readonly ownerDocument: TestDocument;
  public parentNode: TestNode | null = null;
  public readonly childNodes: TestNode[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly style: TestStyle = {
    cssText: '',
    setProperty: (name, value) => { this.style[name] = value; },
    removeProperty: (name) => { delete this.style[name]; },
  };
  public namespaceURI: string | null = null;
  public value = '';
  public checked = false;
  public disabled = false;

  public constructor(nodeType: number, name: string, ownerDocument: TestDocument) {
    super();
    this.nodeType = nodeType;
    this.nodeName = name;
    this.tagName = name;
    this.ownerDocument = ownerDocument;
  }

  public appendChild(child: TestNode): TestNode {
    return this.insertBefore(child, null);
  }

  public insertBefore(child: TestNode, before: TestNode | null): TestNode {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    if (index < 0) throw new Error('The reference child is not in this node.');
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  public removeChild(child: TestNode): TestNode {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error('The child is not in this node.');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  public override dispatchEvent(event: Event): boolean {
    const target = event.target ?? this;
    const result = super.dispatchEvent(event);
    if (event.bubbles && !event.cancelBubble && this.parentNode !== null) {
      Object.defineProperty(event, 'target', { configurable: true, value: target });
      this.parentNode.dispatchEvent(event);
    }
    return result;
  }

  public setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  public setAttributeNS(_namespace: string | null, name: string, value: unknown): void {
    this.setAttribute(name, value);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public removeAttributeNS(_namespace: string | null, name: string): void {
    this.removeAttribute(name);
  }

  public hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public focus(): void {
    this.ownerDocument.activeElement = this;
  }

  public contains(node: TestNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }

  public get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  public get nextSibling(): TestNode | null {
    if (this.parentNode === null) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  public get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  public set textContent(value: string | null) {
    this.childNodes.splice(0, this.childNodes.length);
    if (value !== null && value !== '') this.childNodes.push(this.ownerDocument.createTextNode(value));
  }
}

class TestTextNode extends TestNode {
  private textValue: string;

  public constructor(value: string, ownerDocument: TestDocument) {
    super(3, '#text', ownerDocument);
    this.textValue = value;
  }

  public override get textContent(): string {
    return this.textValue;
  }

  public override set textContent(value: string | null) {
    this.textValue = value ?? '';
  }
}

interface TestWindow extends EventTarget {
  document: TestDocument;
  HTMLIFrameElement: typeof TestNode;
}

function createTestDom(): { readonly rootElement: TestNode; readonly testWindow: TestWindow; readonly navigatorLike: { onLine: boolean } } {
  const testDocument = new TestDocument();
  const testWindow = new EventTarget() as TestWindow;
  testWindow.document = testDocument;
  testWindow.HTMLIFrameElement = TestNode;
  testDocument.defaultView = testWindow;
  const rootElement = testDocument.createElement('div');
  testDocument.body.appendChild(rootElement);
  const navigatorLike = { onLine: true };
  vi.stubGlobal('window', testWindow);
  vi.stubGlobal('document', testDocument);
  vi.stubGlobal('navigator', navigatorLike);
  vi.stubGlobal('self', testWindow);
  return { rootElement, testWindow, navigatorLike };
}

function findByAttribute(root: TestNode, name: string, value: string): TestNode | null {
  if (root.getAttribute(name) === value) return root;
  for (const child of root.childNodes) {
    const match = findByAttribute(child, name, value);
    if (match !== null) return match;
  }
  return null;
}

function findByTestId(root: TestNode, value: string): TestNode | null {
  return findByAttribute(root, 'data-testid', value);
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function authResponse(status: {
  authenticated: boolean;
  publicAccessWarning?: boolean;
  required: boolean;
}): Response {
  return new Response(JSON.stringify(status), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

function DialogLikeChild() {
  const [value, setValue] = useState('draft');
  useEffect(() => setValue('edited'), []);
  return <div data-testid="dialog-like">{value}</div>;
}

async function settleReact(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAuthenticatedSessionMarker();
  markNetworkAvailable();
  markOfflineBootstrapActive(false);
  resetInitialStatusRequest();
});

describe('AuthGate', () => {

  it('fails closed for an unknown device when explicitly offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const getAuthStatus = vi.spyOn(internalClient, 'getAuthStatus');

    await expect(resolveInitialAuthStatus()).rejects.toThrow('unavailable while offline');
    expect(getAuthStatus).not.toHaveBeenCalled();
  });

  it('allows a previously authenticated device to bootstrap while explicitly offline', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: false });
    const getAuthStatus = vi.spyOn(internalClient, 'getAuthStatus');

    await expect(resolveInitialAuthStatus()).resolves.toEqual({
      offlineBootstrap: true,
      status: { authenticated: true, publicAccessWarning: false, required: true },
    });
    expect(getAuthStatus).not.toHaveBeenCalled();
  });

  it('persists a public bootstrap only after an online required=false status', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => { storage.delete(key); },
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      authenticated: false,
      required: false,
    }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    }));

    await expect(resolveInitialAuthStatus()).resolves.toEqual({
      offlineBootstrap: false,
      status: { authenticated: false, publicAccessWarning: false, required: false },
    });
    expect(storage.has(OFFLINE_PUBLIC_BOOTSTRAP_KEY)).toBe(true);

    vi.stubGlobal('navigator', { onLine: false });
    await expect(resolveInitialAuthStatus()).resolves.toEqual({
      offlineBootstrap: true,
      status: { authenticated: false, publicAccessWarning: false, required: false },
    });
  });

  it('does not infer a public deployment before any online status response', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    await expect(resolveInitialAuthStatus()).rejects.toThrow('unavailable while offline');
  });

  it('does not bootstrap on an auth response or cleanup error disguised as a generic Error', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(internalClient, 'getAuthStatus').mockRejectedValue(new Error('invalid auth response'));

    await expect(resolveInitialAuthStatus()).rejects.toThrow('invalid auth response');
    expect(isOfflineBootstrapActive()).toBe(false);
  });

  it('uses the marker after an auth status transport failure and recovers on online', async () => {
    rememberAuthenticatedSession();
    vi.stubGlobal('navigator', { onLine: true });
    const authStatus = { authenticated: true, required: true };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify(authStatus), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      }));

    await expect(resolveInitialAuthStatus()).resolves.toMatchObject({ offlineBootstrap: true });
    expect(isOfflineBootstrapActive()).toBe(true);

    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    let recovered: Promise<unknown> | undefined;
    const unsubscribe = subscribeToOnlineAuthRetry(() => {
      recovered = resolveInitialAuthStatus();
    });
    windowTarget.dispatchEvent(new Event('online'));
    await expect(recovered).resolves.toMatchObject({
      offlineBootstrap: false,
      status: authStatus,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isNetworkAvailable()).toBe(true);
    expect(isOfflineBootstrapActive()).toBe(false);
    unsubscribe();
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
    expect(markup).toContain('受保护的工作区');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autofocus=""');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('Password is incorrect.');
    expect(markup).not.toContain('marketing');
  });

  it('renders a public access interstitial and only continues for the current mount', async () => {
    const { rootElement } = createTestDom();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse({
      authenticated: false,
      publicAccessWarning: true,
      required: false,
    }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(rootElement as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <AuthGate>
            <DialogLikeChild />
          </AuthGate>,
        );
        await settleReact();
      });

      const alert = findByAttribute(rootElement, 'role', 'alert');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain('Set an application password');
      expect(alert?.textContent).toContain('APP_PASSWORD');
      expect(alert?.textContent).toContain('restart the server');
      expect(alert?.textContent).not.toContain('example.com');
      expect(findByTestId(rootElement, 'dialog-like')).toBeNull();

      const continueButton = findByAttribute(rootElement, 'type', 'button');
      expect(continueButton?.textContent).toContain('Continue without password');
      continueButton?.dispatchEvent(new Event('click', { bubbles: true }));
      await act(async () => { await settleReact(); });

      expect(findByAttribute(rootElement, 'role', 'alert')).toBeNull();
      expect(findByTestId(rootElement, 'dialog-like')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it('does not render the public warning for a local status', async () => {
    const { rootElement } = createTestDom();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse({
      authenticated: false,
      publicAccessWarning: false,
      required: false,
    }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(rootElement as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <AuthGate>
            <DialogLikeChild />
          </AuthGate>,
        );
        await settleReact();
      });

      expect(findByAttribute(rootElement, 'role', 'alert')).toBeNull();
      expect(findByTestId(rootElement, 'dialog-like')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

  it('does not render the public warning when authentication is required', async () => {
    const { rootElement } = createTestDom();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(authResponse({
      authenticated: false,
      publicAccessWarning: true,
      required: true,
    }));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(rootElement as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <AuthGate>
            <DialogLikeChild />
          </AuthGate>,
        );
        await settleReact();
      });

      expect(findByAttribute(rootElement, 'role', 'alert')).toBeNull();
      expect(rootElement.textContent).toContain('进入工作区');
    } finally {
      await act(async () => { root.unmount(); });
    }
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
    expect(markup).toContain('正在登录');
    expect(markup).toMatch(/<button[^>]*disabled=""/);
  });

  it('keeps a mounted child and its local state across an online revalidation', async () => {
    const { rootElement, testWindow, navigatorLike } = createTestDom();
    const revalidation = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(authResponse({ authenticated: true, required: true }))
      .mockImplementationOnce(() => revalidation.promise);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(rootElement as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <AuthGate>
            <DialogLikeChild />
          </AuthGate>,
        );
        await settleReact();
      });
      const beforeReconnect = findByTestId(rootElement, 'dialog-like');
      expect(beforeReconnect).not.toBeNull();
      expect(beforeReconnect?.textContent).toBe('edited');

      navigatorLike.onLine = false;
      testWindow.dispatchEvent(new Event('offline'));
      navigatorLike.onLine = true;
      await act(async () => {
        testWindow.dispatchEvent(new Event('online'));
        testWindow.dispatchEvent(new Event('online'));
        await settleReact();
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(findByTestId(rootElement, 'dialog-like')).toBe(beforeReconnect);
      expect(findByTestId(rootElement, 'dialog-like')?.textContent).toBe('edited');

      await act(async () => {
        revalidation.resolve(authResponse({ authenticated: true, required: true }));
        await settleReact();
      });
      expect(findByTestId(rootElement, 'dialog-like')).toBe(beforeReconnect);
      expect(findByTestId(rootElement, 'dialog-like')?.textContent).toBe('edited');
    } finally {
      await act(async () => { root.unmount(); });
    }
  });

});
