import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadAfterGallery } from './preload-after-gallery';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(withIdle = true) {
  vi.useFakeTimers();
  const windowTarget = Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
    cancelAnimationFrame: clearTimeout,
    ...(withIdle ? { requestIdleCallback: (callback: () => void) => setTimeout(callback, 1), cancelIdleCallback: clearTimeout } : {}),
  });
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const connection = { onLine: true };
  const images: { complete: boolean; naturalWidth: number; currentSrc: string; decode: () => Promise<void>; getBoundingClientRect: () => object }[] = [];
  const root = Object.assign(new EventTarget(), {
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 400 }),
    querySelectorAll: () => images,
  });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('navigator', connection);
  vi.stubGlobal('innerHeight', 800);
  vi.stubGlobal('innerWidth', 400);
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
  return { window: windowTarget, document: documentTarget, connection, root: root as unknown as HTMLElement, images };
}

function image(top = 0) {
  return { complete: false, naturalWidth: 100, currentSrc: '/thumbnail', decode: vi.fn().mockResolvedValue(undefined), getBoundingClientRect: () => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 }) };
}

describe('editor background preload scheduling', () => {
  it('waits for visible images to load, decode and paint, then loads modules serially', async () => {
    const env = setup();
    const visible = image(), offscreen = image(1000);
    let decoded!: () => void, loaded!: () => void;
    visible.decode.mockReturnValue(new Promise<void>(resolve => { decoded = resolve; }));
    env.images.push(visible, offscreen);
    const workspace = vi.fn(() => new Promise<void>(resolve => { loaded = resolve; }));
    const mask = vi.fn().mockResolvedValue(undefined);
    cleanups.push(preloadAfterGallery(env.root, [workspace, mask]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(workspace).not.toHaveBeenCalled();
    visible.complete = true; env.root.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(visible.decode).toHaveBeenCalledOnce();
    expect(offscreen.decode).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    decoded(); await vi.advanceTimersByTimeAsync(0);
    expect(workspace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(workspace).toHaveBeenCalledOnce();
    expect(mask).not.toHaveBeenCalled();
    loaded(); await vi.advanceTimersByTimeAsync(600);
    expect(mask).toHaveBeenCalledOnce();
  });

  it('yields its quiet period to scroll and keyboard activity', async () => {
    const env = setup(), task = vi.fn().mockResolvedValue(undefined);
    cleanups.push(preloadAfterGallery(env.root, [task]));
    await vi.advanceTimersByTimeAsync(400); env.window.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(400); env.window.dispatchEvent(new Event('keydown'));
    await vi.advanceTimersByTimeAsync(400); expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); expect(task).toHaveBeenCalledOnce();
  });

  it('cancels pending work and never starts the next module after disposal', async () => {
    const env = setup();
    let finish!: () => void;
    const first = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const next = vi.fn().mockResolvedValue(undefined);
    const cancel = preloadAfterGallery(env.root, [first, next]); cleanups.push(cancel);
    await vi.advanceTimersByTimeAsync(600);
    expect(first).toHaveBeenCalledOnce();
    cancel(); finish(); await vi.advanceTimersByTimeAsync(5000);
    expect(next).not.toHaveBeenCalled();
    const never = vi.fn().mockResolvedValue(undefined);
    const earlyCancel = preloadAfterGallery(env.root, [never]); earlyCancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(never).not.toHaveBeenCalled();
  });

  it('defers hidden and offline tabs and supports browsers without idle callbacks', async () => {
    const env = setup(false), task = vi.fn().mockResolvedValue(undefined);
    env.document.visibilityState = 'hidden';
    cleanups.push(preloadAfterGallery(env.root, [task]));
    await vi.advanceTimersByTimeAsync(1000); expect(task).not.toHaveBeenCalled();
    env.document.visibilityState = 'visible'; env.connection.onLine = false;
    env.document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000); expect(task).not.toHaveBeenCalled();
    env.connection.onLine = true; env.window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(600); expect(task).toHaveBeenCalledOnce();
  });
});
