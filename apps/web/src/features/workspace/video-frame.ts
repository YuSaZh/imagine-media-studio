/** Capture one decoded frame from the existing player; no decoder or playback dependency. */
export interface CapturedVideoFrame { file: File; timeSeconds: number; width: number; height: number }
const MAX_FRAME_PIXELS = 16_777_216;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

async function waitForFrame(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); for (const event of ['seeked', 'loadeddata', 'canplay']) video.removeEventListener(event, ready); video.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted); };
    const ready = () => { if (!video.seeking && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) { cleanup(); resolve(); } };
    const failed = () => { cleanup(); reject(new Error('视频画面无法读取，请等待视频加载后重试')); };
    const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(failed, 8000);
    for (const event of ['seeked', 'loadeddata', 'canplay']) video.addEventListener(event, ready);
    video.addEventListener('error', failed); signal?.addEventListener('abort', aborted, { once: true }); ready();
  });
}

export async function captureVideoFrame(video: HTMLVideoElement, signal?: AbortSignal): Promise<CapturedVideoFrame> {
  video.pause();
  if (video.error) throw new Error('视频无法播放，不能截取当前帧');
  await waitForFrame(video, signal);
  signal?.throwIfAborted();
  const width = video.videoWidth, height = video.videoHeight, timeSeconds = video.currentTime;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_FRAME_PIXELS) throw new Error('视频画面超过截图尺寸限制');
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0) throw new Error('视频播放位置无效');
  const canvas = video.ownerDocument.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法截取视频画面');
    try { context.drawImage(video, 0, 0, width, height); } catch { throw new Error('视频画面不允许截图，请使用可正常播放的本地视频'); }
    const blob = await new Promise<Blob>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('视频截图超时，请重试')); }, 8000);
      signal?.addEventListener('abort', aborted, { once: true });
      try { canvas.toBlob(value => { cleanup(); if (value) resolve(value); else reject(new Error('视频截图编码失败，请重试')); }, 'image/png'); }
      catch { cleanup(); reject(new Error('视频画面不允许截图，请使用可正常播放的本地视频')); }
    });
    signal?.throwIfAborted();
    if (blob.type !== 'image/png') throw new Error('视频截图编码格式不受支持');
    if (blob.size < 1 || blob.size > MAX_FRAME_BYTES) throw new Error('视频截图超过图片大小限制');
    return { file: new File([blob], `video-frame-${Math.round(timeSeconds * 1000)}ms.png`, { type: 'image/png' }), timeSeconds, width, height };
  } finally { canvas.width = 0; canvas.height = 0; }
}

export function videoFrameLabel(timeSeconds: number): string {
  const whole = Math.floor(timeSeconds), minutes = Math.floor(whole / 60);
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${Math.floor((timeSeconds - whole) * 10)}`;
}
