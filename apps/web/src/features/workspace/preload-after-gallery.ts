/** Speculative modules yield to visible media, painting and user interaction. */
export function preloadAfterGallery(root: HTMLElement, tasks: readonly (() => Promise<unknown>)[]): () => void {
  const abort = new AbortController();
  const decoded = new WeakMap<HTMLImageElement, string>();
  const decoding = new WeakSet<HTMLImageElement>();
  let timer: number | undefined, idle: number | undefined, frame: number | undefined;
  let index = 0, running = false;
  const cancelScheduled = () => {
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    timer = idle = frame = undefined;
  };
  const visibleImages = () => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll<HTMLImageElement>('.study-open img')].filter(image => {
      const box = image.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > Math.max(0, bounds.top) && box.top < Math.min(innerHeight, bounds.bottom)
        && box.right > Math.max(0, bounds.left) && box.left < Math.min(innerWidth, bounds.right);
    });
  };
  const schedule = () => {
    cancelScheduled();
    if (abort.signal.aborted || running || index >= tasks.length || document.visibilityState !== 'visible' || !navigator.onLine) return;
    // Reset this quiet period on input/scroll; never force an idle callback by timeout.
    timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(() => { void run(); });
      else frame = window.requestAnimationFrame(() => { void run(); });
    }, 500);
  };
  const run = async () => {
    if (abort.signal.aborted || !root.isConnected || document.visibilityState !== 'visible' || !navigator.onLine) return;
    const images = visibleImages();
    if (images.some(image => !image.complete)) return;
    let ready = true;
    for (const image of images) {
      if (!image.naturalWidth || decoded.get(image) === image.currentSrc) continue;
      ready = false;
      if (decoding.has(image)) continue;
      decoding.add(image);
      const source = image.currentSrc;
      void image.decode().catch(() => undefined).then(() => {
        decoding.delete(image);
        if (image.currentSrc === source) decoded.set(image, source);
        schedule();
      });
    }
    if (!ready) return; // Re-enter on a later idle turn, after decoded images can paint.
    const task = tasks[index++];
    if (!task) return;
    running = true;
    try { await task(); } catch { /* Opening the editor retains normal load/error handling. */ }
    finally { running = false; schedule(); }
  };
  const options = { signal: abort.signal, capture: true, passive: true };
  root.addEventListener('load', schedule, options);
  root.addEventListener('error', schedule, options);
  for (const event of ['scroll', 'resize', 'pointerdown', 'keydown']) window.addEventListener(event, schedule, options);
  document.addEventListener('visibilitychange', schedule, options);
  window.addEventListener('online', schedule, options);
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  schedule();
  return () => { abort.abort(); observer.disconnect(); cancelScheduled(); };
}
